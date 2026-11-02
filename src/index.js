import {
  SUBJECTS,
  GROUPS,
  MAIN_BUTTONS,
  MAIN_KEYBOARD,
  classifyTelegramMessage,
  buildPublishPlan,
  appendHashtagEntity,
} from "./logic.js";
import { telegramApi, sendMessage, inlineKeyboard } from "./telegram.js";

const WEBHOOK_PATH = "/telegram/webhook";
const PUBLISH_BATCH_SIZE = 4;
const ITEM_PAGE_SIZE = 8;

function nowIso() {
  return new Date().toISOString();
}

function ownerId(env) {
  return String(env.BOT_OWNER_ID || "");
}

function isOwner(user, env) {
  return Boolean(user?.id) && String(user.id) === ownerId(env);
}

async function getActiveSession(env) {
  return env.DB.prepare(
    `SELECT * FROM sessions
     WHERE owner_id = ? AND status IN ('awaiting_week','collecting','ready','publishing','publish_failed')
     ORDER BY id DESC LIMIT 1`,
  ).bind(ownerId(env)).first();
}

async function getLatestSession(env) {
  return env.DB.prepare(
    `SELECT * FROM sessions WHERE owner_id = ? ORDER BY id DESC LIMIT 1`,
  ).bind(ownerId(env)).first();
}

async function getItems(env, sessionId) {
  const result = await env.DB.prepare(
    `SELECT * FROM items WHERE session_id = ? ORDER BY received_order ASC, id ASC`,
  ).bind(sessionId).all();
  return result.results || [];
}

async function getItem(env, sessionId, itemId) {
  return env.DB.prepare(
    `SELECT * FROM items WHERE id = ? AND session_id = ? LIMIT 1`,
  ).bind(itemId, sessionId).first();
}

async function reply(env, chatId, text, extra = {}) {
  const payload = { chat_id: chatId, text: String(text).slice(0, 4096), reply_markup: MAIN_KEYBOARD, ...extra };
  return telegramApi(env, "sendMessage", payload);
}

async function sendInline(env, chatId, text, keyboardRows) {
  return telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 4096),
    reply_markup: inlineKeyboard(keyboardRows),
  });
}

async function answerCallback(env, callbackId, text = "") {
  try {
    await telegramApi(env, "answerCallbackQuery", {
      callback_query_id: callbackId,
      ...(text ? { text: text.slice(0, 180) } : {}),
    });
  } catch (error) {
    console.warn("answerCallbackQuery failed:", error.message);
  }
}

async function createWeekSession(env, chatId) {
  const active = await getActiveSession(env);
  if (active) {
    const statusText = {
      awaiting_week: "لسه مستني رقم الأسبوع للعملية الحالية.",
      collecting: "فيه أسبوع مفتوح لاستقبال الملفات. أنهِ الاستقبال أو ألغِ العملية الحالية أولًا.",
      ready: "فيه أسبوع جاهز للمعاينة أو النشر. انشره أو ألغِه قبل بدء أسبوع جديد.",
      publishing: "فيه عملية نشر جارية. استكمل النشر أو ألغِه قبل بدء أسبوع جديد.",
      publish_failed: "فيه عملية نشر متوقفة بسبب خطأ. عالجها أو ألغِها قبل بدء أسبوع جديد.",
    };
    await reply(env, chatId, statusText[active.status] || "هناك عملية أسبوعية نشطة بالفعل.");
    return;
  }

  await env.DB.prepare(
    `INSERT INTO sessions (owner_id, owner_chat_id, status, created_at, updated_at)
     VALUES (?, ?, 'awaiting_week', ?, ?)`,
  ).bind(ownerId(env), String(chatId), nowIso(), nowIso()).run();

  await reply(env, chatId, "نبدأ أسبوعًا جديدًا ✅\n\nاكتب رقم الأسبوع مرة واحدة. نفس الرقم سيُستخدم في رسائل المحاضرات والسكاشن والملخصات عند الحاجة.", {
    reply_markup: {
      ...MAIN_KEYBOARD,
      input_field_placeholder: "مثال: 6",
    },
  });
}

function getMessageSource(message) {
  const classification = classifyTelegramMessage(message);
  return {
    classification,
    sourceChatId: String(message.chat.id),
    sourceMessageId: Number(message.message_id),
    payloadJson: JSON.stringify(message),
  };
}

async function saveIncomingMessage(env, session, message) {
  const { classification, sourceChatId, sourceMessageId, payloadJson } = getMessageSource(message);
  if (classification.looksLikeGeneratedLectureAnnouncement || classification.looksLikeGeneratedGroupFooter || classification.looksLikeDividerOnly) {
    return { skippedAnnouncement: true };
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM items WHERE session_id = ? AND source_chat_id = ? AND source_message_id = ? LIMIT 1`,
  ).bind(session.id, sourceChatId, sourceMessageId).first();
  if (existing) return { duplicateUpdate: true };

  const orderResult = await env.DB.prepare(
    `SELECT COALESCE(MAX(received_order), 0) + 1 AS next_order FROM items WHERE session_id = ?`,
  ).bind(session.id).first();
  const receivedOrder = Number(orderResult?.next_order || 1);
  const classificationStatus = classification.subjectCode ? "auto" : "review";

  const result = await env.DB.prepare(
    `INSERT INTO items (
      session_id, source_chat_id, source_message_id, file_id, file_unique_id,
      file_name, media_kind, display_name, group_type, subject_code, is_audio,
      section_number, lecture_number, is_answer, received_order,
      classification_status, ignored, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).bind(
    session.id,
    sourceChatId,
    sourceMessageId,
    classification.fileId,
    classification.fileUniqueId,
    classification.fileName,
    classification.mediaKind,
    classification.displayName,
    classification.groupType,
    classification.subjectCode,
    classification.isAudio ? 1 : 0,
    classification.sectionNumber,
    classification.lectureNumber,
    classification.isAnswer ? 1 : 0,
    receivedOrder,
    classificationStatus,
    payloadJson,
  ).run();

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM items WHERE session_id = ? AND ignored = 0`,
  ).bind(session.id).first();

  return {
    itemId: result.meta?.last_row_id || null,
    total: Number(count?.total || receivedOrder),
    needsReview: classification.needsReview,
    displayName: classification.displayName,
  };
}

async function handleIncomingContent(env, session, message) {
  const saved = await saveIncomingMessage(env, session, message);
  if (saved.skippedAnnouncement) {
    await reply(env, message.chat.id, "تعرفت على رسالة تعريف أو فاصل قديم. هأنشئ النسخة المناسبة تلقائيًا أثناء النشر، ولن أكرر الرسالة القديمة.");
    return;
  }
  if (saved.duplicateUpdate) return;
  if (saved.total === 1 || saved.total % 5 === 0) {
    const text = saved.needsReview
      ? `استلمت ${saved.total} عناصر حتى الآن.\n\n⚠️ فيه عنصر محتاج تحديد المادة من زر «تصحيح التصنيف».`
      : `تم استلام المحتوى ✅\nعدد العناصر المستلمة: ${saved.total}`;
    await reply(env, message.chat.id, text);
  }
}

async function showWelcome(env, chatId) {
  await reply(
    env,
    chatId,
    "أهلًا بك في Weekly Telegram Organizer 📚\n\nابعت ملفات الأسبوع عن طريق Forward بعد الضغط على «أسبوع جديد». هرتب المحاضرات والسكاشن والملخصات، وأعرض لك معاينة قبل النشر.\n\nاستخدم الأزرار الموجودة أسفل المحادثة للتحكم.",
  );
}

async function handleMessage(env, message) {
  if (!message?.chat || message.chat.type !== "private" || !isOwner(message.from, env)) return;

  const chatId = message.chat.id;
  const text = String(message.text || "").trim();

  if (text === "/start" || text === "/start@" || text === "ابدأ") {
    await showWelcome(env, chatId);
    return;
  }

  const active = await getActiveSession(env);

  if (text === MAIN_BUTTONS.newWeek) {
    await createWeekSession(env, chatId);
    return;
  }
  if (text === MAIN_BUTTONS.finish) {
    await finishReceiving(env, chatId, active);
    return;
  }
  if (text === MAIN_BUTTONS.preview) {
    await showPreview(env, chatId, active);
    return;
  }
  if (text === MAIN_BUTTONS.publish) {
    await startPublishConfirmation(env, chatId, active);
    return;
  }
  if (text === MAIN_BUTTONS.classify) {
    await showItemPicker(env, chatId, active, "classify", 0);
    return;
  }
  if (text === MAIN_BUTTONS.ignore) {
    await showItemPicker(env, chatId, active, "ignore", 0);
    return;
  }
  if (text === MAIN_BUTTONS.status) {
    await showStatus(env, chatId, active);
    return;
  }
  if (text === MAIN_BUTTONS.cancel) {
    await cancelCurrentSession(env, chatId, active);
    return;
  }

  if (active?.status === "awaiting_week") {
    if (!/^\d{1,3}$/.test(text)) {
      await reply(env, chatId, "من فضلك اكتب رقم الأسبوع كرقم صحيح، مثل 6.");
      return;
    }
    const week = Number(text);
    if (week < 1 || week > 99) {
      await reply(env, chatId, "رقم الأسبوع لازم يكون بين 1 و99.");
      return;
    }
    await env.DB.prepare(
      `UPDATE sessions SET week_number = ?, status = 'collecting', updated_at = ? WHERE id = ?`,
    ).bind(week, nowIso(), active.id).run();
    await reply(env, chatId,
      `تم فتح استقبال الأسبوع ${week} ✅\n\nابعت كل الملفات والرسائل عن طريق Forward بأي ترتيب.\n\nلما تخلص اضغط «إنهاء الاستقبال».`);
    return;
  }

  if (active?.status === "collecting") {
    await handleIncomingContent(env, active, message);
    return;
  }

  if (message.document || message.audio || message.voice || message.video || message.animation || message.photo || message.text || message.caption) {
    await reply(env, chatId, "مفيش أسبوع مفتوح حاليًا. اضغط «أسبوع جديد» الأول، وبعدها ابعت الملفات.");
    return;
  }
}

async function finishReceiving(env, chatId, session) {
  if (!session) {
    await reply(env, chatId, "مفيش أسبوع مفتوح لإنهاء استقباله. اضغط «أسبوع جديد».");
    return;
  }
  if (session.status !== "collecting") {
    await reply(env, chatId, `حالة العملية الحالية: ${session.status}. لا يمكن إنهاء الاستقبال في هذه المرحلة.`);
    return;
  }

  const items = await getItems(env, session.id);
  if (!items.length) {
    await reply(env, chatId, "لسه ما استلمتش أي ملفات أو رسائل. ابعت المحتوى الأول، أو ألغِ العملية.");
    return;
  }

  await env.DB.prepare(
    `UPDATE sessions SET status = 'ready', updated_at = ? WHERE id = ?`,
  ).bind(nowIso(), session.id).run();
  const readySession = { ...session, status: "ready" };
  await showPreview(env, chatId, readySession);
}

function subjectName(code) {
  return SUBJECTS.find((subject) => subject.code === code)?.name || "غير محدد";
}

function groupName(code) {
  return GROUPS.find((group) => group.code === code)?.label || code;
}

function formatCounts(items, groupType) {
  const groupItems = items.filter((item) => item.group_type === groupType && !Number(item.ignored));
  const counts = new Map();
  for (const item of groupItems) {
    const key = item.subject_code || "UNKNOWN";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const lines = [...counts.entries()]
    .sort((a, b) => {
      const ao = SUBJECTS.find((subject) => subject.code === a[0])?.order ?? 999;
      const bo = SUBJECTS.find((subject) => subject.code === b[0])?.order ?? 999;
      return ao - bo;
    })
    .map(([code, count]) => `  • ${code === "UNKNOWN" ? "غير مصنف" : subjectName(code)}: ${count}`);
  return { total: groupItems.length, lines };
}

async function showPreview(env, chatId, session) {
  if (!session) {
    await reply(env, chatId, "مفيش عملية أسبوعية حاليًا. اضغط «أسبوع جديد».");
    return;
  }
  if (session.status === "awaiting_week") {
    await reply(env, chatId, "لسه محتاج تدخل رقم الأسبوع الأول.");
    return;
  }

  const items = await getItems(env, session.id);
  const activeItems = items.filter((item) => !Number(item.ignored));
  const reviewItems = activeItems.filter((item) => !item.subject_code || item.classification_status === "review");
  const duplicates = new Set();
  const seen = new Set();
  for (const item of activeItems) {
    if (!item.file_unique_id) continue;
    if (seen.has(item.file_unique_id)) duplicates.add(item.file_unique_id);
    seen.add(item.file_unique_id);
  }

  const sections = ["lectures", "sections", "summaries"].map((group) => {
    const result = formatCounts(activeItems, group);
    return `${group === "lectures" ? "📚" : group === "sections" ? "📝" : "📌"} ${groupName(group)}: ${result.total}\n${result.lines.join("\n") || "  • لا توجد ملفات"}`;
  });

  let summary = `معاينة محتوى الأسبوع ${session.week_number} ✅\n\n${sections.join("\n\n")}\n\n`;
  summary += `📦 إجمالي العناصر: ${activeItems.length}\n`;
  summary += `⚠️ عناصر تحتاج مراجعة: ${reviewItems.length}\n`;
  summary += `🔁 ملفات مكررة محتملة: ${duplicates.size}\n`;
  summary += `🗑 عناصر تم تجاهلها: ${items.length - activeItems.length}`;

  const buttons = [];
  if (reviewItems.length) {
    buttons.push([{ text: "🛠 تصحيح العناصر غير المصنفة", callback_data: "listc:0" }]);
  }
  if (session.status === "ready" && !reviewItems.length) {
    buttons.push([{ text: "🚀 تجهيز النشر", callback_data: "prepare_publish" }]);
  }
  buttons.push([{ text: "🔄 تحديث المعاينة", callback_data: "refresh_preview" }]);

  // Build a human-readable list from the very same ordered plan that will be
  // published, so the preview reflects the actual order, including generated posts.
  const knownItems = activeItems.filter((item) => item.subject_code);
  const orderedPlan = buildPublishPlan(knownItems, session.week_number);
  const byId = new Map(activeItems.map((item) => [Number(item.id), item]));
  const detailLines = ["الترتيب الفعلي للنشر:"];
  let currentGroup = null;
  for (const entry of orderedPlan) {
    if (entry.groupType !== currentGroup) {
      currentGroup = entry.groupType;
      detailLines.push(`\n${currentGroup === "lectures" ? "📚 المحاضرات" : currentGroup === "sections" ? "📝 السكاشن" : "📌 الملخصات"}`);
    }
    if (entry.kind === "copy") {
      const item = byId.get(Number(entry.itemId));
      if (!item) continue;
      const subject = subjectName(item.subject_code);
      const audioMark = Number(item.is_audio) ? "🎧 " : "";
      const tagMark = ["sections", "summaries"].includes(item.group_type)
        ? ` · ${SUBJECTS.find((value) => value.code === item.subject_code)?.hashtag || ""}`
        : "";
      detailLines.push(`  ${audioMark}• ${subject}: ${item.display_name}${tagMark}`);
    } else if (entry.text_content || entry.text) {
      const text = String(entry.text_content || entry.text || "").replace(/\n+/g, " / ");
      if (text.includes("━")) detailLines.push("  ───────────────");
      else detailLines.push(`  ↳ ${text}`);
    }
  }

  if (reviewItems.length) {
    detailLines.push("\n⚠️ عناصر تحتاج تصنيفًا يدويًا:");
    for (const item of reviewItems.slice(0, 15)) detailLines.push(`  • ${item.display_name}`);
    if (reviewItems.length > 15) detailLines.push(`  • وهناك ${reviewItems.length - 15} عناصر أخرى`);
  }

  const detailText = detailLines.join("\n");
  const chunks = [];
  let currentChunk = "";
  for (const line of detailText.split("\n")) {
    const candidate = currentChunk ? `${currentChunk}\n${line}` : line;
    if (candidate.length > 3300 && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk = candidate;
    }
  }
  if (currentChunk) chunks.push(currentChunk);

  await sendInline(env, chatId, summary.slice(0, 3900), buttons);
  for (const chunk of chunks) {
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: chunk.slice(0, 3900) });
  }

  await reply(env, chatId, session.status === "collecting"
    ? "الاستقبال ما زال مفتوحًا. تقدر تكمل إرسال الملفات، وبعدها اضغط «إنهاء الاستقبال»."
    : session.status === "ready"
      ? (reviewItems.length ? "راجع العناصر غير المصنفة قبل النشر." : "المحتوى جاهز للمراجعة والنشر.")
      : `حالة العملية: ${session.status}`);
}

async function showStatus(env, chatId, session) {
  if (!session) {
    const latest = await getLatestSession(env);
    if (!latest) {
      await reply(env, chatId, "لم تبدأ أي عملية أسبوعية حتى الآن.");
      return;
    }
    await reply(env, chatId, `آخر عملية: الأسبوع ${latest.week_number ?? "غير محدد"}\nالحالة: ${latest.status}`);
    return;
  }

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN ignored = 0 THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN ignored = 0 AND (subject_code IS NULL OR classification_status = 'review') THEN 1 ELSE 0 END) AS review
     FROM items WHERE session_id = ?`,
  ).bind(session.id).first();

  let publishText = "";
  if (["publishing", "publish_failed", "completed"].includes(session.status)) {
    const progress = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('sent','skipped') THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM publish_plan WHERE session_id = ?`,
    ).bind(session.id).first();
    publishText = `\n📤 تقدم النشر: ${progress?.done || 0}/${progress?.total || 0}\n❌ عناصر بها خطأ: ${progress?.failed || 0}`;
  }

  await reply(env, chatId,
    `الأسبوع: ${session.week_number ?? "بانتظار الرقم"}\nالحالة: ${session.status}\n📦 العناصر المستلمة: ${count?.total || 0}\n✅ العناصر النشطة: ${count?.active || 0}\n⚠️ تحتاج مراجعة: ${count?.review || 0}${publishText}`);
}

async function showItemPicker(env, chatId, session, mode, page) {
  if (!session || !["collecting", "ready"].includes(session.status)) {
    await reply(env, chatId, "يمكن تصحيح التصنيف أو تجاهل العناصر أثناء استقبال المحتوى أو بعد إنهائه وقبل النشر.");
    return;
  }
  const items = await getItems(env, session.id);
  const available = items.filter((item) => !Number(item.ignored));
  const pages = Math.max(1, Math.ceil(available.length / ITEM_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const pageItems = available.slice(safePage * ITEM_PAGE_SIZE, (safePage + 1) * ITEM_PAGE_SIZE);

  if (!pageItems.length) {
    await reply(env, chatId, mode === "classify" ? "مفيش عناصر متاحة لتصحيحها." : "مفيش عناصر متاحة لتجاهلها.");
    return;
  }

  const title = mode === "classify" ? "اختر الملف أو الرسالة التي تريد تصحيح تصنيفها:" : "اختر العنصر الذي تريد تجاهله:";
  const rows = pageItems.map((item) => [{
    text: `${item.id}. ${String(item.display_name).slice(0, 42)}${item.subject_code ? ` · ${item.subject_code}` : " · غير مصنف"}`.slice(0, 60),
    callback_data: `${mode === "classify" ? "ci" : "ii"}:${item.id}`,
  }]);
  const nav = [];
  if (safePage > 0) nav.push({ text: "⬅️ السابق", callback_data: `${mode === "classify" ? "listc" : "listi"}:${safePage - 1}` });
  if (safePage < pages - 1) nav.push({ text: "التالي ➡️", callback_data: `${mode === "classify" ? "listc" : "listi"}:${safePage + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "رجوع للوحة التحكم", callback_data: "menu" }]);
  await sendInline(env, chatId, `${title}\nصفحة ${safePage + 1} من ${pages}`, rows);
}

async function cancelCurrentSession(env, chatId, session) {
  if (!session) {
    await reply(env, chatId, "لا توجد عملية حالية لإلغائها.");
    return;
  }
  if (session.status === "publishing" || session.status === "publish_failed") {
    await sendInline(env, chatId,
      "تنبيه: قد يكون جزء من المحتوى نُشر بالفعل. إلغاء العملية سيوقف ما تبقى فقط، ولن يحذف المنشورات التي وصلت للقناة. هل تؤكد؟",
      [[{ text: "نعم، أوقف باقي النشر", callback_data: `cancelconfirm:${session.id}` }], [{ text: "رجوع", callback_data: "menu" }]],
    );
    return;
  }
  await env.DB.prepare(
    `UPDATE sessions SET status = 'cancelled', updated_at = ? WHERE id = ?`,
  ).bind(nowIso(), session.id).run();
  await reply(env, chatId, `تم إلغاء عملية الأسبوع ${session.week_number ?? "الجديد"}. تقدر تبدأ عملية جديدة في أي وقت.`);
}

async function startPublishConfirmation(env, chatId, session) {
  if (!session) {
    await reply(env, chatId, "مفيش محتوى جاهز للنشر. ابدأ أسبوعًا جديدًا أولًا.");
    return;
  }
  if (session.status === "publishing") {
    await publishNextBatch(env, chatId, session);
    return;
  }
  if (session.status === "publish_failed") {
    await resumeFailedPublish(env, chatId, session);
    return;
  }
  if (session.status !== "ready") {
    await reply(env, chatId, "لازم تنهي استقبال الملفات الأول من زر «إنهاء الاستقبال».");
    return;
  }

  const items = await getItems(env, session.id);
  const active = items.filter((item) => !Number(item.ignored));
  const review = active.filter((item) => !item.subject_code || item.classification_status === "review");
  if (review.length) {
    await sendInline(env, chatId,
      `لا يمكن تجهيز النشر حاليًا؛ يوجد ${review.length} عنصر غير مصنف. صحح تصنيفها أو تجاهلها أولًا.`,
      [[{ text: "🛠 تصحيح التصنيف", callback_data: "listc:0" }], [{ text: "🗑 تجاهل عنصر", callback_data: "listi:0" }]],
    );
    return;
  }

  const plan = buildPublishPlan(active, session.week_number);
  if (!plan.length) {
    await reply(env, chatId, "لا توجد عناصر قابلة للنشر في هذه العملية.");
    return;
  }

  await env.DB.prepare(`DELETE FROM publish_plan WHERE session_id = ?`).bind(session.id).run();
  const statements = plan.map((entry) => env.DB.prepare(
    `INSERT INTO publish_plan (session_id, sequence_no, kind, group_type, text_content, item_id, add_hashtag, subject_code, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).bind(
    session.id,
    entry.sequence,
    entry.kind,
    entry.groupType,
    entry.text,
    entry.itemId,
    entry.addHashtag ? 1 : 0,
    entry.subjectCode,
  ));
  for (let i = 0; i < statements.length; i += 40) {
    await env.DB.batch(statements.slice(i, i + 40));
  }

  const planCount = plan.length;
  await sendInline(env, chatId,
    `تم تجهيز خطة النشر للأسبوع ${session.week_number} ✅\n\nعدد الرسائل والمنشورات: ${planCount}\nسيتم النشر بالترتيب: المحاضرات، ثم السكاشن، ثم الملخصات.\n\nهل تؤكد النشر في القناة؟`,
    [[{ text: "✅ تأكيد النشر", callback_data: `publish_yes:${session.id}` }], [{ text: "إلغاء والعودة", callback_data: `publish_no:${session.id}` }]],
  );
}

async function getItemForPlan(env, itemId) {
  return env.DB.prepare(`SELECT * FROM items WHERE id = ? LIMIT 1`).bind(itemId).first();
}

async function copyMessageWithFileIdFallback(env, item, payload, extra = {}) {
  const source = { chat_id: item.source_chat_id, message_id: item.source_message_id };
  try {
    return await telegramApi(env, "copyMessage", { chat_id: env.CHANNEL_ID, ...source, ...extra });
  } catch (copyError) {
    // The original private-chat message may have been deleted after intake.
    // Reuse the stored file_id as a fallback for ordinary media types.
    if (item.file_id) {
      const methodByKind = {
        document: ["sendDocument", "document"],
        photo: ["sendPhoto", "photo"],
        audio: ["sendAudio", "audio"],
        voice: ["sendVoice", "voice"],
        video: ["sendVideo", "video"],
        animation: ["sendAnimation", "animation"],
        video_note: ["sendVideoNote", "video_note"],
        sticker: ["sendSticker", "sticker"],
      };
      const media = methodByKind[item.media_kind];
      if (media) {
        const [method, field] = media;
        const fallbackPayload = { chat_id: env.CHANNEL_ID, [field]: item.file_id };
        const caption = extra.caption ?? payload.caption;
        const captionEntities = extra.caption_entities ?? payload.caption_entities;
        if (caption && ["document", "photo", "audio", "voice", "video", "animation"].includes(item.media_kind)) {
          fallbackPayload.caption = caption;
          if (captionEntities?.length) fallbackPayload.caption_entities = captionEntities;
        }
        return telegramApi(env, method, fallbackPayload);
      }
    }

    // Text messages can also be reconstructed from their saved Telegram payload.
    if (payload.text) {
      return telegramApi(env, "sendMessage", {
        chat_id: env.CHANNEL_ID,
        text: payload.text,
        ...(payload.entities?.length ? { entities: payload.entities } : {}),
      });
    }
    throw copyError;
  }
}

async function executePlanEntry(env, chatId, entry) {
  if (entry.kind === "text") {
    const sent = await sendMessage(env, env.CHANNEL_ID, entry.text_content || "");
    return sent.message_id;
  }

  if (entry.kind !== "copy" || !entry.item_id) throw new Error("خطة النشر تحتوي على عنصر غير صالح.");
  const item = await getItemForPlan(env, entry.item_id);
  if (!item) throw new Error(`العنصر رقم ${entry.item_id} غير موجود.`);

  let payload;
  try { payload = JSON.parse(item.payload_json); }
  catch { throw new Error(`تعذر قراءة بيانات العنصر رقم ${item.id}.`); }

  if (!Number(entry.add_hashtag)) {
    const copied = await copyMessageWithFileIdFallback(env, item, payload);
    return copied.message_id;
  }

  const subject = SUBJECTS.find((value) => value.code === entry.subject_code);
  if (!subject) throw new Error("تعذر تحديد هاشتاج المادة.");
  const hashtag = subject.hashtag;
  const text = payload.text || "";
  const caption = payload.caption || "";
  const canUseCaption = ["photo", "document", "audio", "video", "animation"].includes(item.media_kind);

  if (text) {
    const merged = appendHashtagEntity(payload.entities || [], text, hashtag);
    if (merged.text.length <= 4096) {
      const sent = await telegramApi(env, "sendMessage", {
        chat_id: env.CHANNEL_ID,
        text: merged.text,
        ...(merged.entities.length ? { entities: merged.entities } : {}),
      });
      return sent.message_id;
    }
  }

  if (canUseCaption) {
    const merged = appendHashtagEntity(payload.caption_entities || [], caption, hashtag);
    if (merged.text.length <= 1024) {
      const copied = await copyMessageWithFileIdFallback(env, item, payload, {
        caption: merged.text,
        ...(merged.entities.length ? { caption_entities: merged.entities } : {}),
      });
      return copied.message_id;
    }
  }

  // For media types that do not support captions (voice notes, video notes,
  // stickers, etc.), the plan contains a separate hashtag text item after the copy.
  const copied = await copyMessageWithFileIdFallback(env, item, payload);
  return copied.message_id;
}

async function sendPublishProgress(env, chatId, sessionId) {
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status IN ('sent','skipped') THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending
     FROM publish_plan WHERE session_id = ?`,
  ).bind(sessionId).first();

  const total = Number(counts?.total || 0);
  const done = Number(counts?.done || 0);
  const pending = Number(counts?.pending || 0);
  const failed = Number(counts?.failed || 0);
  const sending = Number(counts?.sending || 0);

  if (done >= total && total > 0) {
    await env.DB.prepare(`UPDATE sessions SET status = 'completed', updated_at = ? WHERE id = ?`).bind(nowIso(), sessionId).run();
    await reply(env, chatId, `اكتمل نشر الأسبوع ✅\n\nتم نشر ${done} من ${total} رسالة/منشور في القناة.\nتقدر تبدأ أسبوعًا جديدًا من الزر الموجود بالأسفل.`);
    return;
  }

  if (failed || sending) {
    await env.DB.prepare(`UPDATE sessions SET status = 'publish_failed', updated_at = ? WHERE id = ?`).bind(nowIso(), sessionId).run();
    const problem = await env.DB.prepare(
      `SELECT * FROM publish_plan WHERE session_id = ? AND status IN ('failed','sending') ORDER BY sequence_no LIMIT 1`,
    ).bind(sessionId).first();
    if (problem) {
      const uncertain = problem.status === "sending";
      await sendInline(env, chatId,
        `${uncertain ? "⚠️ توقفت العملية أثناء إرسال عنصر. قد يكون وصل للقناة بالفعل، فراجع القناة قبل إعادة المحاولة." : "❌ Telegram رفض نشر أحد العناصر."}\n\nالتقدم: ${done}/${total}\nالخطأ: ${(problem.last_error || "توقف غير متوقع").slice(0, 500)}`,
        [[{ text: "🔁 إعادة المحاولة", callback_data: `retry:${problem.id}` }], [{ text: "⏭ تخطي هذا العنصر", callback_data: `skip:${problem.id}` }]],
      );
    }
    return;
  }

  await env.DB.prepare(`UPDATE sessions SET status = 'publishing', updated_at = ? WHERE id = ?`).bind(nowIso(), sessionId).run();
  await sendInline(env, chatId,
    `جارٍ نشر الأسبوع.\n\n✅ تم: ${done}/${total}\n⏳ متبقٍ: ${pending}\n\nاضغط متابعة لاستكمال الدفعة التالية.`,
    [[{ text: "▶️ متابعة النشر", callback_data: `continue_publish:${sessionId}` }]],
  );
}

async function publishNextBatch(env, chatId, session) {
  if (!session) {
    await reply(env, chatId, "لا توجد عملية نشر حالية.");
    return;
  }

  const uncertain = await env.DB.prepare(
    `SELECT * FROM publish_plan WHERE session_id = ? AND status = 'sending' ORDER BY sequence_no LIMIT 1`,
  ).bind(session.id).first();
  if (uncertain) {
    await sendPublishProgress(env, chatId, session.id);
    return;
  }

  const failed = await env.DB.prepare(
    `SELECT * FROM publish_plan WHERE session_id = ? AND status = 'failed' ORDER BY sequence_no LIMIT 1`,
  ).bind(session.id).first();
  if (failed) {
    await sendPublishProgress(env, chatId, session.id);
    return;
  }

  const result = await env.DB.prepare(
    `SELECT * FROM publish_plan WHERE session_id = ? AND status = 'pending' ORDER BY sequence_no LIMIT ?`,
  ).bind(session.id, PUBLISH_BATCH_SIZE).all();
  const entries = result.results || [];

  if (!entries.length) {
    await sendPublishProgress(env, chatId, session.id);
    return;
  }

  for (const entry of entries) {
    await env.DB.prepare(
      `UPDATE publish_plan SET status = 'sending', attempted_at = ?, last_error = NULL WHERE id = ?`,
    ).bind(nowIso(), entry.id).run();

    try {
      const messageId = await executePlanEntry(env, chatId, entry);
      await env.DB.prepare(
        `UPDATE publish_plan SET status = 'sent', telegram_message_id = ?, sent_at = ?, last_error = NULL WHERE id = ?`,
      ).bind(messageId || null, nowIso(), entry.id).run();
    } catch (error) {
      await env.DB.prepare(
        `UPDATE publish_plan SET status = 'failed', last_error = ? WHERE id = ?`,
      ).bind(String(error?.message || error).slice(0, 1000), entry.id).run();
      break;
    }
  }

  await sendPublishProgress(env, chatId, session.id);
}

async function resumeFailedPublish(env, chatId, session) {
  const problem = await env.DB.prepare(
    `SELECT * FROM publish_plan WHERE session_id = ? AND status IN ('failed','sending') ORDER BY sequence_no LIMIT 1`,
  ).bind(session.id).first();
  if (!problem) {
    await env.DB.prepare(`UPDATE sessions SET status = 'publishing', updated_at = ? WHERE id = ?`).bind(nowIso(), session.id).run();
    await publishNextBatch(env, chatId, { ...session, status: "publishing" });
    return;
  }
  const uncertain = problem.status === "sending";
  await sendInline(env, chatId,
    `${uncertain ? "وجدت عنصرًا توقفت العملية أثناء إرساله. راجع القناة أولًا؛ قد يكون تم نشره." : "وجدت عنصرًا فشل نشره."}\n\nاختر إعادة المحاولة أو تخطي العنصر.`,
    [[{ text: "🔁 إعادة المحاولة", callback_data: `retry:${problem.id}` }], [{ text: "⏭ تخطي هذا العنصر", callback_data: `skip:${problem.id}` }]],
  );
}

async function handleCallback(env, callback) {
  if (!isOwner(callback.from, env)) {
    await answerCallback(env, callback.id, "غير مصرح لك باستخدام البوت.");
    return;
  }
  await answerCallback(env, callback.id);

  const chatId = callback.message?.chat?.id || Number(ownerId(env));
  const data = String(callback.data || "");
  const active = await getActiveSession(env);

  if (data === "menu") {
    await reply(env, chatId, "استخدم أزرار لوحة التحكم.");
    return;
  }
  if (data === "refresh_preview") {
    await showPreview(env, chatId, active || await getLatestSession(env));
    return;
  }
  if (data === "prepare_publish") {
    await startPublishConfirmation(env, chatId, active);
    return;
  }
  if (data.startsWith("publish_yes:")) {
    const requestedSessionId = Number(data.split(":")[1]);
    if (!active || active.id !== requestedSessionId || active.status !== "ready") {
      await reply(env, chatId, "لم تعد هذه العملية جاهزة للتأكيد. حدّث المعاينة للعملية الحالية.");
      return;
    }
    await env.DB.prepare(`UPDATE sessions SET status = 'publishing', updated_at = ? WHERE id = ?`).bind(nowIso(), active.id).run();
    await publishNextBatch(env, chatId, { ...active, status: "publishing" });
    return;
  }
  if (data.startsWith("publish_no:")) {
    const requestedSessionId = Number(data.split(":")[1]);
    if (active && active.id === requestedSessionId && active.status === "ready") {
      await env.DB.prepare(`DELETE FROM publish_plan WHERE session_id = ?`).bind(active.id).run();
      await reply(env, chatId, "تم إلغاء تأكيد النشر. المحتوى ما زال محفوظًا ويمكنك معاينته أو تعديله.");
    } else {
      await reply(env, chatId, "هذه المعاينة لم تعد مرتبطة بالعملية الحالية.");
    }
    return;
  }
  if (data.startsWith("continue_publish:")) {
    const requestedSessionId = Number(data.split(":")[1]);
    if (active && active.id === requestedSessionId && active.status === "publishing") {
      await publishNextBatch(env, chatId, active);
    } else {
      await reply(env, chatId, "لا توجد عملية نشر مستمرة مطابقة لهذا الزر.");
    }
    return;
  }

  if (data.startsWith("listc:")) {
    await showItemPicker(env, chatId, active, "classify", Number(data.split(":")[1] || 0));
    return;
  }
  if (data.startsWith("listi:")) {
    await showItemPicker(env, chatId, active, "ignore", Number(data.split(":")[1] || 0));
    return;
  }
  if (data.startsWith("ci:")) {
    if (!active || !["collecting", "ready"].includes(active.status)) {
      await reply(env, chatId, "لا يمكن تعديل التصنيف بعد بدء النشر أو انتهاء العملية.");
      return;
    }
    const id = Number(data.split(":")[1]);
    const item = active && await getItem(env, active.id, id);
    if (!item || Number(item.ignored)) {
      await reply(env, chatId, "العنصر غير موجود أو تم تجاهله.");
      return;
    }
    const groupRows = [
      [{ text: "📚 المحاضرات", callback_data: `cg:${id}:lectures` }],
      [{ text: "📝 السكاشن", callback_data: `cg:${id}:sections` }],
      [{ text: "📌 الملخصات", callback_data: `cg:${id}:summaries` }],
    ];
    await sendInline(env, chatId, `تصحيح العنصر:\n${item.display_name}\n\nاختر القسم الصحيح:`, groupRows);
    return;
  }
  if (data.startsWith("cg:")) {
    if (!active || !["collecting", "ready"].includes(active.status)) {
      await reply(env, chatId, "لا يمكن تعديل التصنيف بعد بدء النشر أو انتهاء العملية.");
      return;
    }
    const [, idRaw, groupType] = data.split(":");
    const id = Number(idRaw);
    if (!active || !["lectures", "sections", "summaries"].includes(groupType)) return;
    const item = await getItem(env, active.id, id);
    if (!item || Number(item.ignored)) return;
    const buttons = [];
    for (let i = 0; i < SUBJECTS.length; i += 2) {
      const row = SUBJECTS.slice(i, i + 2).map((subject) => ({
        text: subject.name,
        callback_data: `cs:${id}:${groupType}:${subject.code}`,
      }));
      buttons.push(row);
    }
    await sendInline(env, chatId, `اختر المادة الصحيحة للعنصر:\n${item.display_name}`, buttons);
    return;
  }
  if (data.startsWith("cs:")) {
    if (!active || !["collecting", "ready"].includes(active.status)) {
      await reply(env, chatId, "لا يمكن تعديل التصنيف بعد بدء النشر أو انتهاء العملية.");
      return;
    }
    const [, idRaw, groupType, subjectCode] = data.split(":");
    const id = Number(idRaw);
    const subject = SUBJECTS.find((value) => value.code === subjectCode);
    if (!active || !subject || !["lectures", "sections", "summaries"].includes(groupType)) return;
    const item = await getItem(env, active.id, id);
    if (!item || Number(item.ignored)) return;
    await env.DB.prepare(
      `UPDATE items SET group_type = ?, subject_code = ?, classification_status = 'manual' WHERE id = ? AND session_id = ?`,
    ).bind(groupType, subjectCode, id, active.id).run();
    await reply(env, chatId, `تم تصنيف العنصر ✅\n${item.display_name}\nالقسم: ${groupName(groupType)}\nالمادة: ${subject.name}`);
    return;
  }
  if (data.startsWith("ii:")) {
    if (!active || !["collecting", "ready"].includes(active.status)) {
      await reply(env, chatId, "لا يمكن تجاهل عناصر بعد بدء النشر أو انتهاء العملية.");
      return;
    }
    const id = Number(data.split(":")[1]);
    const item = active && await getItem(env, active.id, id);
    if (!item) return;
    await sendInline(env, chatId,
      `هل أنت متأكد أنك تريد تجاهل العنصر التالي؟\n\n${item.display_name}\n\nلن يتم نشره، لكنه سيظل محفوظًا في سجل العملية.`,
      [[{ text: "نعم، تجاهل", callback_data: `iy:${id}` }, { text: "رجوع", callback_data: "listi:0" }]],
    );
    return;
  }
  if (data.startsWith("iy:")) {
    if (!active || !["collecting", "ready"].includes(active.status)) {
      await reply(env, chatId, "لا يمكن تجاهل عناصر بعد بدء النشر أو انتهاء العملية.");
      return;
    }
    const id = Number(data.split(":")[1]);
    if (!active) return;
    const item = await getItem(env, active.id, id);
    if (!item) return;
    await env.DB.prepare(`UPDATE items SET ignored = 1 WHERE id = ? AND session_id = ?`).bind(id, active.id).run();
    await reply(env, chatId, `تم تجاهل العنصر: ${item.display_name}`);
    return;
  }
  if (data.startsWith("cancelconfirm:")) {
    const id = Number(data.split(":")[1]);
    if (!active || active.id !== id) return;
    await env.DB.prepare(`UPDATE sessions SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
    await reply(env, chatId, "تم إيقاف النشر. الرسائل التي نُشرت بالفعل ستظل موجودة في القناة، ولم يتم حذفها.");
    return;
  }
  if (data.startsWith("retry:")) {
    const id = Number(data.split(":")[1]);
    if (!active || active.status !== "publish_failed") {
      await reply(env, chatId, "زر إعادة المحاولة لم يعد صالحًا للعملية الحالية.");
      return;
    }
    const planEntry = await env.DB.prepare(`SELECT * FROM publish_plan WHERE id = ? AND session_id = ?`).bind(id, active.id).first();
    if (!planEntry || !["failed", "sending"].includes(planEntry.status)) return;
    await env.DB.prepare(`UPDATE publish_plan SET status = 'pending', last_error = NULL WHERE id = ?`).bind(id).run();
    await env.DB.prepare(`UPDATE sessions SET status = 'publishing', updated_at = ? WHERE id = ?`).bind(nowIso(), active.id).run();
    await publishNextBatch(env, chatId, { ...active, status: "publishing" });
    return;
  }
  if (data.startsWith("skip:")) {
    const id = Number(data.split(":")[1]);
    if (!active || active.status !== "publish_failed") {
      await reply(env, chatId, "زر التخطي لم يعد صالحًا للعملية الحالية.");
      return;
    }
    const planEntry = await env.DB.prepare(`SELECT * FROM publish_plan WHERE id = ? AND session_id = ?`).bind(id, active.id).first();
    if (!planEntry || !["failed", "sending"].includes(planEntry.status)) return;
    await env.DB.prepare(`UPDATE publish_plan SET status = 'skipped', last_error = 'Skipped manually' WHERE id = ?`).bind(id).run();
    await env.DB.prepare(`UPDATE sessions SET status = 'publishing', updated_at = ? WHERE id = ?`).bind(nowIso(), active.id).run();
    await publishNextBatch(env, chatId, { ...active, status: "publishing" });
    return;
  }
}

async function handleUpdate(env, update) {
  if (update.message) {
    await handleMessage(env, update.message);
  } else if (update.callback_query) {
    await handleCallback(env, update.callback_query);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "weekly-telegram-organizer", runtime: "cloudflare-workers" });
    }

    if (url.pathname !== WEBHOOK_PATH || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    if (!Number.isSafeInteger(update?.update_id)) {
      return new Response("Bad Update", { status: 400 });
    }

    // Dedupe Telegram webhook retries. If processing fails, remove the marker so
    // Telegram can retry the update instead of silently losing it.
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)`,
    ).bind(update.update_id).run();
    if (inserted.meta?.changes === 0) return new Response("OK", { status: 200 });

    try {
      await handleUpdate(env, update);
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Webhook update failed:", error?.stack || error);
      await env.DB.prepare(`DELETE FROM processed_updates WHERE update_id = ?`).bind(update.update_id).run();
      return new Response("Temporary processing error", { status: 500 });
    }
  },
};
