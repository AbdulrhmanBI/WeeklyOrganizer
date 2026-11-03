 import {
  SUBJECTS,
  GROUPS,
  MAIN_BUTTONS,
  MAIN_KEYBOARD,
  classifyTelegramMessage,
  buildPublishPlan,
  appendHashtagEntity,
  normalizeChannelTarget,
} from "./logic.js";
import { telegramApi, sendMessage, inlineKeyboard } from "./telegram.js";

const WEBHOOK_PATH = "/telegram/webhook";
const PUBLISH_BATCH_SIZE = 20;
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
      awaiting_week: active.awaiting_sections_week ? "لسه مستني رقم أسبوع السكاشن للعملية الحالية." : "لسه مستني رقم أسبوع المحاضرات للعملية الحالية.",
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

  await reply(env, chatId, "نبدأ أسبوعًا جديدًا ✅\n\nاكتب رقم أسبوع المحاضرات أولًا، مثل 6. بعده هسألك عن رقم أسبوع السكاشن بشكل منفصل.", {
    reply_markup: {
      ...MAIN_KEYBOARD,
      input_field_placeholder: "رقم أسبوع المحاضرات، مثال: 6",
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
  if (classification.looksLikeGeneratedLectureAnnouncement ||
      classification.looksLikeGeneratedGroupFooter ||
      classification.looksLikeDividerOnly) {
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
    await reply(env, message.chat.id, "استلمت رسالة تعريف أو فاصلًا من المحتوى القديم. هأنشئ الرسائل والفواصل من جديد وفق ترتيب الأسبوع الحالي.");
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
    "أهلًا بك في Weekly Telegram Organizer 📚\n\nابعت ملفات الأسبوع عن طريق Forward بعد الضغط على «أسبوع جديد». بعد إنهاء الاستقبال اضغط «معاينة الترتيب» لإرسال كل المحتوى مرتبًا في الشات. نشر المحتوى في القناة اختياري.\n\nاستخدم الأزرار الموجودة أسفل المحادثة للتحكم.",
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
    await sendFullPreview(env, chatId, active || await getLatestSession(env));
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

  if (active?.awaiting_destination) {
    const destination = normalizeChannelTarget(text);
    if (!destination) {
      await reply(env, chatId,
        "صيغة وجهة النشر غير صحيحة. ابعت @ChannelUsername أو Chat ID رقمي يبدأ عادةً بـ -100 أو رابط t.me لقناة عامة.",
      );
      return;
    }
    await env.DB.prepare(
      `UPDATE sessions SET target_chat_id = ?, awaiting_destination = 0, updated_at = ? WHERE id = ?`,
    ).bind(destination, nowIso(), active.id).run();
    const updatedSession = { ...active, target_chat_id: destination, awaiting_destination: 0 };
    await reply(env, chatId, `تم حفظ وجهة النشر: ${destination} ✅\nهجهز المعاينة النهائية الآن.`);
    await startPublishConfirmation(env, chatId, updatedSession);
    return;
  }

  if (active?.awaiting_sections_week) {
    if (!/^\d{1,3}$/.test(text)) {
      await reply(env, chatId, "اكتب رقم أسبوع السكاشن كرقم صحيح من 1 إلى 99، أو اضغط زر التخطي لو مفيش سكاشن الأسبوع ده.");
      return;
    }
    const sectionsWeek = Number(text);
    if (sectionsWeek < 1 || sectionsWeek > 99) {
      await reply(env, chatId, "رقم أسبوع السكاشن لازم يكون بين 1 و99، أو استخدم زر التخطي.");
      return;
    }
    await env.DB.prepare(
      `UPDATE sessions SET sections_week_number = ?, awaiting_sections_week = 0, status = 'collecting', updated_at = ? WHERE id = ?`,
    ).bind(sectionsWeek, nowIso(), active.id).run();
    await reply(env, chatId,
      `تم تحديد أسبوع المحاضرات ${active.week_number} وأسبوع السكاشن ${sectionsWeek} ✅\n\nابعت كل الملفات والرسائل عن طريق Forward بأي ترتيب.\n\nلما تخلص اضغط «إنهاء الاستقبال».`);
    return;
  }

  if (active?.status === "awaiting_week") {
    if (!/^\d{1,3}$/.test(text)) {
      await reply(env, chatId, "من فضلك اكتب رقم أسبوع المحاضرات كرقم صحيح، مثل 6.");
      return;
    }
    const week = Number(text);
    if (week < 1 || week > 99) {
      await reply(env, chatId, "رقم الأسبوع لازم يكون بين 1 و99.");
      return;
    }
    await env.DB.prepare(
      `UPDATE sessions SET week_number = ?, awaiting_sections_week = 1, updated_at = ? WHERE id = ?`,
    ).bind(week, nowIso(), active.id).run();
    await sendInline(env, chatId,
      `تم تحديد رقم أسبوع المحاضرات: ${week} ✅\n\nدلوقتي اكتب رقم أسبوع السكاشن بشكل مستقل.\nمثال: لو محاضراتك أسبوع 6 والسكاشن أسبوع 2، اكتب 2 هنا.\n\nرقم Sec الموجود في اسم الملف هيُستخدم لترتيب السكاشن فقط، مش لتحديد رقم الأسبوع.`,
      [[{ text: "تخطي رقم أسبوع السكاشن", callback_data: "skip_sections_week" }]],
    );
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
  if (session?.awaiting_sections_week) {
    await reply(env, chatId, "قبل استقبال الملفات، اكتب رقم أسبوع السكاشن أو اضغط زر «تخطي رقم أسبوع السكاشن».");
    return;
  }
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

  let preview = `معاينة المحاضرات: الأسبوع ${session.week_number}${session.sections_week_number ? `\nمعاينة السكاشن: الأسبوع ${session.sections_week_number}` : ""} ✅\n\n${sections.join("\n\n")}\n\n`;
  preview += `📦 إجمالي العناصر: ${activeItems.length}\n`;
  preview += `⚠️ عناصر تحتاج مراجعة: ${reviewItems.length}\n`;
  preview += `🔁 ملفات مكررة محتملة: ${duplicates.size}\n`;
  preview += `🗑 عناصر تم تجاهلها: ${items.length - activeItems.length}`;

  const buttons = [];
  if (reviewItems.length) {
    buttons.push([{ text: "🛠 تصحيح العناصر غير المصنفة", callback_data: "listc:0" }]);
  }
  if (["ready", "completed"].includes(session.status) && !reviewItems.length) {
    buttons.push([{ text: "📨 إرسال المحتوى كاملًا في الشات", callback_data: "preview_send:0" }]);
    if (session.status === "ready") {
      buttons.push([{ text: "🚀 نشر نسخة في القناة (اختياري)", callback_data: "prepare_publish" }]);
    }
  }
  buttons.push([{ text: "🔄 تحديث المعاينة", callback_data: "refresh_preview" }]);

  await sendInline(env, chatId, preview.slice(0, 3900), buttons);
  await reply(env, chatId, session.status === "collecting"
    ? "الاستقبال ما زال مفتوحًا. تقدر تكمل إرسال الملفات، وبعدها اضغط «إنهاء الاستقبال»."
    : session.status === "ready"
      ? (reviewItems.length ? "راجع العناصر غير المصنفة قبل النشر." : "المحتوى جاهز. اضغط «معاينة الترتيب» لإرسال كل الملفات هنا، والنشر في القناة اختياري.")
      : `حالة العملية: ${session.status}`);
}

async function sendFullPreview(env, chatId, session, offset = 0) {
  if (!session || !["ready", "completed"].includes(session.status)) {
    await reply(env, chatId, "أنهِي استقبال الملفات أولًا، وبعدها اضغط «معاينة الترتيب» لإرسال المحتوى كاملًا إلى الشات.");
    return;
  }

  const items = await getItems(env, session.id);
  const activeItems = items.filter((item) => !Number(item.ignored));
  const reviewItems = activeItems.filter((item) => !item.subject_code || item.classification_status === "review");
  if (reviewItems.length) {
    await sendInline(env, chatId,
      `لا يمكن إرسال المحتوى قبل تصحيح ${reviewItems.length} عنصر غير مصنف.`,
      [[{ text: "🛠 تصحيح التصنيف", callback_data: "listc:0" }], [{ text: "🔄 تحديث المعاينة", callback_data: "refresh_preview" }]],
    );
    return;
  }

  const plan = buildPublishPlan(activeItems, session.week_number, session.sections_week_number);
  if (!plan.length) {
    await reply(env, chatId, "لا توجد عناصر قابلة للإرسال في هذه العملية.");
    return;
  }

  const requestedOffset = Number(offset);
  const start = Number.isSafeInteger(requestedOffset)
    ? Math.max(0, Math.min(requestedOffset, plan.length))
    : 0;

  if (start === 0) {
    await reply(env, chatId,
      `إرسال المحتوى الكامل للأسبوع ${session.week_number} 📚\n\n` +
      "سيتم إرسال كل الملفات والرسائل هنا بنفس ترتيب النشر، مع تجميع ملفات PDF والتسجيلات المتجانسة في ألبومات.\n" +
      "ده إرسال فعلي كامل إلى محادثتك الخاصة، وليس عينة، ولن ينشر في القناة.",
    );
  }

  const result = await executePlanEntries(env, chatId, plan.slice(start), { persistPublishStatus: false });
  if (result.error) {
    const failedOffset = start + result.nextIndex;
    await sendInline(env, chatId,
      `وصل جزء من المحتوى، لكن تعذر إرسال العنصر رقم ${failedOffset + 1} من ${plan.length}.\n` +
      `الخطأ: ${String(result.error?.message || result.error).slice(0, 500)}\n\n` +
      "العناصر التي وصلت بالفعل لن نكرر إرسالها عند الاستكمال.",
      [[{ text: "🔁 استكمال من العنصر المتوقف", callback_data: `preview_send:${failedOffset}` }]],
    );
    return;
  }

  await sendInline(env, chatId,
    `اكتمل إرسال محتوى الأسبوع ${session.week_number} إلى الشات ✅\n` +
    `تم إرسال كل عناصر الخطة (${plan.length})، مع تجميع الملفات المتجانسة في ألبومات متى أمكن.\n\n` +
    "النشر في القناة اختياري ويمكنك تنفيذه بعد مراجعة المحتوى.",
    [
      ...(session.status === "ready" ? [[{ text: "🚀 نشر المحتوى في القناة (اختياري)", callback_data: "prepare_publish" }]] : []),
      [{ text: "🔄 إعادة إرسال المحتوى كاملًا", callback_data: "preview_send:0" }],
      [{ text: "رجوع للمعاينة", callback_data: "refresh_preview" }],
    ],
  );
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
    `أسبوع المحاضرات: ${session.week_number ?? "بانتظار الرقم"}\nأسبوع السكاشن: ${session.sections_week_number ?? "غير محدد"}\nالحالة: ${session.status}\n📦 العناصر المستلمة: ${count?.total || 0}\n✅ العناصر النشطة: ${count?.active || 0}\n⚠️ تحتاج مراجعة: ${count?.review || 0}${publishText}`);
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

function getPublishDestination(env, session) {
  // CHANNEL_ID is an optional deployment-wide default. When omitted, the
  // owner chooses a destination per week and it is persisted in D1.
  return String(env.CHANNEL_ID || session?.target_chat_id || "").trim();
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

  if (!getPublishDestination(env, session)) {
    await env.DB.prepare(
      `UPDATE sessions SET awaiting_destination = 1, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), session.id).run();
    await reply(env, chatId,
      "معرف القناة غير محدد في إعدادات المشروع، وده اختياري ✅\n\nابعت الآن وجهة النشر بإحدى الطرق التالية:\n• @ChannelUsername للقناة العامة\n• -1001234567890 للقناة الخاصة\n• رابط t.me للقناة العامة\n\nلازم تضيف البوت للقناة كمسؤول وتمنحه صلاحية نشر الرسائل. تقدر تلغي العملية من زر «إلغاء العملية».",
    );
    return;
  }

  const plan = buildPublishPlan(active, session.week_number, session.sections_week_number);
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
    `تم تجهيز خطة النشر للأسبوع ${session.week_number} ✅\n\nوجهة النشر: ${getPublishDestination(env, session)}\nعدد الرسائل والمنشورات: ${planCount}\nسيتم النشر بالترتيب: المحاضرات، ثم السكاشن، ثم الملخصات.\n\nهل تؤكد النشر؟`,
    [[{ text: "✅ تأكيد النشر", callback_data: "publish_yes" }], [{ text: "إلغاء والعودة", callback_data: "publish_no" }]],
  );
}

async function getItemForPlan(env, itemId) {
  return env.DB.prepare(`SELECT * FROM items WHERE id = ? LIMIT 1`).bind(itemId).first();
}

async function copyMessageWithFileIdFallback(env, item, payload, destinationChatId, extra = {}) {
  const source = { chat_id: item.source_chat_id, message_id: item.source_message_id };
  try {
    return await telegramApi(env, "copyMessage", { chat_id: destinationChatId, ...source, ...extra });
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
        const fallbackPayload = { chat_id: destinationChatId, [field]: item.file_id };
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
        chat_id: destinationChatId,
        text: payload.text,
        ...(payload.entities?.length ? { entities: payload.entities } : {}),
      });
    }
    throw copyError;
  }
}

async function executePlanEntry(env, destinationChatId, entry) {
  if (entry.kind === "text") {
    const text = entry.text_content || "";
    const firstLineEnd = text.indexOf("\n");
    if (entry.group_type === "lectures" && text.startsWith("☝🏻 ") && firstLineEnd > 0) {
      const sent = await telegramApi(env, "sendMessage", {
        chat_id: destinationChatId,
        text,
        entities: [{ type: "blockquote", offset: 0, length: firstLineEnd }],
      });
      return sent.message_id;
    }
    const sent = await sendMessage(env, destinationChatId, text);
    return sent.message_id;
  }

  if (entry.kind !== "copy" || !entry.item_id) throw new Error("خطة النشر تحتوي على عنصر غير صالح.");
  const item = await getItemForPlan(env, entry.item_id);
  if (!item) throw new Error(`العنصر رقم ${entry.item_id} غير موجود.`);

  let payload;
  try { payload = JSON.parse(item.payload_json); }
  catch { throw new Error(`تعذر قراءة بيانات العنصر رقم ${item.id}.`); }

  if (!Number(entry.add_hashtag)) {
    const copied = await copyMessageWithFileIdFallback(env, item, payload, destinationChatId);
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
        chat_id: destinationChatId,
        text: merged.text,
        ...(merged.entities.length ? { entities: merged.entities } : {}),
      });
      return sent.message_id;
    }
  }

  if (canUseCaption) {
    const merged = appendHashtagEntity(payload.caption_entities || [], caption, hashtag);
    if (merged.text.length <= 1024) {
      const copied = await copyMessageWithFileIdFallback(env, item, payload, destinationChatId, {
        caption: merged.text,
        ...(merged.entities.length ? { caption_entities: merged.entities } : {}),
      });
      return copied.message_id;
    }
  }

  // For media types that do not support captions (voice notes, video notes,
  // stickers, etc.), the plan contains a separate hashtag text item after the copy.
  const copied = await copyMessageWithFileIdFallback(env, item, payload, destinationChatId);
  return copied.message_id;
}


const MEDIA_GROUP_KINDS = new Set(["document", "audio", "photo", "video"]);
const MEDIA_GROUP_MAX = 10;

function normalizePlanEntry(entry) {
  return {
    ...entry,
    kind: entry.kind,
    text_content: entry.text_content ?? entry.text ?? null,
    item_id: entry.item_id ?? entry.itemId ?? null,
    add_hashtag: entry.add_hashtag ?? (entry.addHashtag ? 1 : 0),
    subject_code: entry.subject_code ?? entry.subjectCode ?? null,
    group_type: entry.group_type ?? entry.groupType ?? null,
  };
}

async function buildAlbumInput(env, rawEntry) {
  const entry = normalizePlanEntry(rawEntry);
  if (entry.kind !== "copy" || !entry.item_id) return null;
  const item = await getItemForPlan(env, entry.item_id);
  if (!item || !MEDIA_GROUP_KINDS.has(item.media_kind) || !item.file_id) return null;

  let payload;
  try { payload = JSON.parse(item.payload_json || "{}"); }
  catch { throw new Error(`تعذر قراءة بيانات العنصر رقم ${item.id}.`); }

  let caption = String(payload.caption || "");
  let captionEntities = Array.isArray(payload.caption_entities) ? payload.caption_entities : [];
  if (Number(entry.add_hashtag)) {
    const subject = SUBJECTS.find((value) => value.code === entry.subject_code);
    if (!subject) throw new Error("تعذر تحديد هاشتاج المادة أثناء تجميع الملفات.");
    const merged = appendHashtagEntity(captionEntities, caption, subject.hashtag);
    caption = merged.text;
    captionEntities = merged.entities;
  }
  if (caption.length > 1024) return null;

  const inputMedia = {
    type: item.media_kind,
    media: item.file_id,
  };
  if (caption) inputMedia.caption = caption;
  if (captionEntities.length) inputMedia.caption_entities = captionEntities;

  if (item.media_kind === "audio") {
    if (payload.audio?.title) inputMedia.title = payload.audio.title;
    if (payload.audio?.performer) inputMedia.performer = payload.audio.performer;
  }
  if (item.media_kind === "video" && payload.video?.supports_streaming) {
    inputMedia.supports_streaming = true;
  }
  if (item.media_kind === "photo" && payload.has_media_spoiler) {
    inputMedia.has_spoiler = true;
  }

  return {
    entry,
    item,
    inputMedia,
    key: [
      item.group_type,
      item.subject_code || "",
      item.media_kind,
      item.group_type === "sections" ? (item.section_number ?? "") : "",
      item.group_type === "sections" ? Number(item.is_answer || 0) : "",
      item.group_type === "summaries" ? (item.lecture_number ?? "") : "",
    ].join("|"),
  };
}

async function collectAlbum(env, entries, startIndex) {
  const first = await buildAlbumInput(env, entries[startIndex]);
  if (!first) return [];
  const album = [first];
  for (let i = startIndex + 1; i < entries.length && album.length < MEDIA_GROUP_MAX; i += 1) {
    const next = await buildAlbumInput(env, entries[i]);
    if (!next || next.key !== first.key) break;
    album.push(next);
  }
  return album.length >= 2 ? album : [];
}

async function updatePublishEntry(env, entry, status, messageId = null, error = null) {
  if (!entry?.id) return;
  await env.DB.prepare(
    `UPDATE publish_plan
     SET status = ?, telegram_message_id = ?, sent_at = ?, last_error = ?
     WHERE id = ?`,
  ).bind(
    status,
    messageId,
    status === "sent" ? nowIso() : null,
    error ? String(error?.message || error).slice(0, 1000) : null,
    entry.id,
  ).run();
}

/**
 * Sends a contiguous plan to a destination. Consecutive homogeneous documents,
 * audio tracks, photos or videos are delivered as Telegram media albums (2-10).
 * If Telegram rejects an album, it safely falls back to individual copies.
 */
async function executePlanEntries(env, destinationChatId, rawEntries, options = {}) {
  const entries = rawEntries.map(normalizePlanEntry);
  const persist = Boolean(options.persistPublishStatus);
  let index = 0;
  let fallbackAlbums = 0;

  while (index < entries.length) {
    const album = await collectAlbum(env, entries, index);
    if (album.length >= 2) {
      const albumEntries = album.map((part) => part.entry);
      if (persist) {
        for (const entry of albumEntries) {
          await env.DB.prepare(
            `UPDATE publish_plan SET status = 'sending', attempted_at = ?, last_error = NULL WHERE id = ?`,
          ).bind(nowIso(), entry.id).run();
        }
      }

      try {
        const sentMessages = await telegramApi(env, "sendMediaGroup", {
          chat_id: destinationChatId,
          media: album.map((part) => part.inputMedia),
        });
        if (!Array.isArray(sentMessages) || sentMessages.length !== album.length) {
          throw new Error("Telegram لم يرجع تأكيدًا لكل عناصر ألبوم الملفات.");
        }
        if (persist) {
          for (let i = 0; i < albumEntries.length; i += 1) {
            await updatePublishEntry(env, albumEntries[i], "sent", sentMessages[i]?.message_id || null);
          }
        }
        index += album.length;
        continue;
      } catch (albumError) {
        fallbackAlbums += 1;
        // sendMediaGroup is atomic from the caller's perspective. If it fails,
        // try each original item separately so no source file is silently lost.
        for (let i = 0; i < albumEntries.length; i += 1) {
          const entry = albumEntries[i];
          try {
            if (persist) {
              await env.DB.prepare(
                `UPDATE publish_plan SET status = 'sending', attempted_at = ?, last_error = NULL WHERE id = ?`,
              ).bind(nowIso(), entry.id).run();
            }
            const messageId = await executePlanEntry(env, destinationChatId, entry);
            if (persist) await updatePublishEntry(env, entry, "sent", messageId || null);
            index += 1;
          } catch (individualError) {
            if (persist) {
              await updatePublishEntry(env, entry, "failed", null, individualError);
              for (let j = i + 1; j < albumEntries.length; j += 1) {
                await env.DB.prepare(
                  `UPDATE publish_plan SET status = 'pending', telegram_message_id = NULL, sent_at = NULL WHERE id = ?`,
                ).bind(albumEntries[j].id).run();
              }
            }
            return { error: individualError, nextIndex: index, fallbackAlbums };
          }
        }
        continue;
      }
    }

    const entry = entries[index];
    try {
      if (persist) {
        await env.DB.prepare(
          `UPDATE publish_plan SET status = 'sending', attempted_at = ?, last_error = NULL WHERE id = ?`,
        ).bind(nowIso(), entry.id).run();
      }
      const messageId = await executePlanEntry(env, destinationChatId, entry);
      if (persist) await updatePublishEntry(env, entry, "sent", messageId || null);
      index += 1;
    } catch (error) {
      if (persist) await updatePublishEntry(env, entry, "failed", null, error);
      return { error, nextIndex: index, fallbackAlbums };
    }
  }

  return { error: null, nextIndex: index, fallbackAlbums };
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
    [[{ text: "▶️ متابعة النشر", callback_data: "continue_publish" }]],
  );
}

async function publishNextBatch(env, chatId, session) {
  if (!session) {
    await reply(env, chatId, "لا توجد عملية نشر حالية.");
    return;
  }

  const destinationChatId = getPublishDestination(env, session);
  if (!destinationChatId) {
    await reply(env, chatId, "وجهة النشر غير محددة. اضغط «نشر المحتوى» وحدد القناة أولًا.");
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

  const execution = await executePlanEntries(env, destinationChatId, entries, { persistPublishStatus: true });
  if (execution.error) {
    console.error("Publish batch stopped:", execution.error?.stack || execution.error);
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

  if (data === "skip_sections_week") {
    if (!active || active.status !== "awaiting_week" || !Number(active.awaiting_sections_week)) {
      await reply(env, chatId, "لا يوجد طلب حالي لتحديد رقم أسبوع السكاشن.");
      return;
    }
    await env.DB.prepare(
      `UPDATE sessions SET sections_week_number = NULL, awaiting_sections_week = 0, status = 'collecting', updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), active.id).run();
    await reply(env, chatId,
      `تم تخطي رقم أسبوع السكاشن. رقم المحاضرات هو ${active.week_number} ✅\n\nابعت الملفات عن طريق Forward، ولما تخلص اضغط «إنهاء الاستقبال».`);
    return;
  }

  if (data === "menu") {
    await reply(env, chatId, "استخدم أزرار لوحة التحكم.");
    return;
  }
  if (data === "refresh_preview") {
    await showPreview(env, chatId, active || await getLatestSession(env));
    return;
  }
  if (data.startsWith("preview_send:")) {
    const offset = Number(data.split(":")[1] || 0);
    await sendFullPreview(env, chatId, active || await getLatestSession(env), offset);
    return;
  }
  if (data === "prepare_publish") {
    await startPublishConfirmation(env, chatId, active);
    return;
  }
  if (data === "publish_yes") {
    if (!active || active.status !== "ready") {
      await reply(env, chatId, "لم تعد هناك عملية جاهزة للتأكيد. حدّث المعاينة أولًا.");
      return;
    }
    await env.DB.prepare(`UPDATE sessions SET status = 'publishing', updated_at = ? WHERE id = ?`).bind(nowIso(), active.id).run();
    await publishNextBatch(env, chatId, { ...active, status: "publishing" });
    return;
  }
  if (data === "publish_no") {
    if (active) await env.DB.prepare(`DELETE FROM publish_plan WHERE session_id = ?`).bind(active.id).run();
    await reply(env, chatId, "تم إلغاء تأكيد النشر. المحتوى ما زال محفوظًا ويمكنك معاينته أو تعديله.");
    return;
  }
  if (data === "continue_publish") {
    if (active) await publishNextBatch(env, chatId, active);
    else await reply(env, chatId, "لا توجد عملية نشر مستمرة.");
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
    const planEntry = active && await env.DB.prepare(`SELECT * FROM publish_plan WHERE id = ? AND session_id = ?`).bind(id, active.id).first();
    if (!planEntry) return;
    await env.DB.prepare(`UPDATE publish_plan SET status = 'pending', last_error = NULL WHERE id = ?`).bind(id).run();
    await env.DB.prepare(`UPDATE sessions SET status = 'publishing', updated_at = ? WHERE id = ?`).bind(nowIso(), active.id).run();
    await publishNextBatch(env, chatId, { ...active, status: "publishing" });
    return;
  }
  if (data.startsWith("skip:")) {
    const id = Number(data.split(":")[1]);
    const planEntry = active && await env.DB.prepare(`SELECT * FROM publish_plan WHERE id = ? AND session_id = ?`).bind(id, active.id).first();
    if (!planEntry) return;
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

const REQUIRED_D1_TABLES = ["sessions", "items", "publish_plan", "processed_updates"];

async function getHealthStatus(env, requestUrl) {
  const configuredOwner = ownerId(env);
  const ownerIdConfigured = Boolean(
    configuredOwner &&
    /^[0-9]{5,20}$/.test(configuredOwner) &&
    !configuredOwner.includes("REPLACE_WITH") &&
    !configuredOwner.includes("YOUR_"),
  );

  const health = {
    ok: false,
    service: "weekly-telegram-organizer",
    runtime: "cloudflare-workers",
    checks: {
      botTokenConfigured: Boolean(env.BOT_TOKEN),
      botTokenValid: false,
      webhookSecretConfigured: Boolean(env.WEBHOOK_SECRET),
      webhookUrlRegistered: false,
      webhookUrlMatchesWorker: false,
      ownerIdConfigured,
      databaseBindingConfigured: Boolean(env.DB),
      defaultChannelConfigured: Boolean(env.CHANNEL_ID),
      databaseReachable: false,
      requiredTablesPresent: false,
      optionalChannelMigrationApplied: false,
      sectionsWeekMigrationApplied: false,
    },
    missingTables: [],
    botUsername: null,
    webhookUrl: null,
  };

  if (env.BOT_TOKEN) {
    try {
      const bot = await telegramApi(env, "getMe");
      health.checks.botTokenValid = Boolean(bot?.id);
      health.botUsername = bot?.username || null;
    } catch (telegramError) {
      console.error("Telegram getMe health check failed:", telegramError?.message || telegramError);
    }

    try {
      const webhookInfo = await telegramApi(env, "getWebhookInfo");
      const expectedUrl = `${new URL(requestUrl).origin}${WEBHOOK_PATH}`;
      health.webhookUrl = webhookInfo?.url || null;
      health.checks.webhookUrlRegistered = Boolean(webhookInfo?.url);
      health.checks.webhookUrlMatchesWorker = webhookInfo?.url === expectedUrl;
    } catch (telegramError) {
      console.error("Telegram getWebhookInfo health check failed:", telegramError?.message || telegramError);
    }
  }

  if (env.DB) {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      health.checks.databaseReachable = true;

      const tableResult = await env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?)`,
      ).bind(...REQUIRED_D1_TABLES).all();
      const foundTables = new Set((tableResult.results || []).map((row) => row.name));
      health.missingTables = REQUIRED_D1_TABLES.filter((name) => !foundTables.has(name));
      health.checks.requiredTablesPresent = health.missingTables.length === 0;

      // The optional-channel feature requires these columns in migration 0002.
      try {
        await env.DB.prepare(
          "SELECT target_chat_id, awaiting_destination FROM sessions LIMIT 0",
        ).all();
        health.checks.optionalChannelMigrationApplied = true;
      } catch (migrationError) {
        console.error("D1 migration 0002 is missing or incomplete:", migrationError?.message || migrationError);
      }

      try {
        await env.DB.prepare(
          "SELECT sections_week_number, awaiting_sections_week FROM sessions LIMIT 0",
        ).all();
        health.checks.sectionsWeekMigrationApplied = true;
      } catch (migrationError) {
        console.error("D1 migration 0003 is missing or incomplete:", migrationError?.message || migrationError);
      }
    } catch (databaseError) {
      console.error("D1 health check failed:", databaseError?.stack || databaseError);
    }
  }

  health.ok = health.checks.botTokenConfigured &&
    health.checks.botTokenValid &&
    health.checks.webhookSecretConfigured &&
    health.checks.webhookUrlRegistered &&
    health.checks.webhookUrlMatchesWorker &&
    health.checks.ownerIdConfigured &&
    health.checks.databaseBindingConfigured &&
    health.checks.databaseReachable &&
    health.checks.requiredTablesPresent &&
    health.checks.optionalChannelMigrationApplied &&
    health.checks.sectionsWeekMigrationApplied;

  return health;
}

function isStartUpdate(update) {
  const text = String(update?.message?.text || "").trim();
  return /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text) || text === "ابدأ";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      const health = await getHealthStatus(env, request.url);
      return Response.json(health, { status: health.ok ? 200 : 503 });
    }

    if (url.pathname !== WEBHOOK_PATH || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (!env.WEBHOOK_SECRET) {
      console.error("WEBHOOK_SECRET is not configured in Worker secrets.");
      return new Response("Worker configuration error: WEBHOOK_SECRET is missing", { status: 503 });
    }
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      console.warn("Rejected Telegram webhook request: secret token mismatch.");
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

    // /start is deliberately handled without D1 so the owner can still receive
    // a welcome/setup response when the database binding or migrations are broken.
    if (isStartUpdate(update)) {
      try {
        await handleUpdate(env, update);
        return new Response("OK", { status: 200 });
      } catch (error) {
        console.error("Telegram /start handling failed:", error?.stack || error);
        return new Response("Could not send /start response. Check BOT_TOKEN and Worker logs.", { status: 502 });
      }
    }

    let markerCreated = false;
    try {
      if (!env.DB) throw new Error("D1 binding 'DB' is missing from this Worker deployment.");

      // The marker write is inside the try block. Missing D1 binding/tables now
      // produce an actionable log instead of an unhandled exception.
      const inserted = await env.DB.prepare(
        `INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)`,
      ).bind(update.update_id).run();
      if (inserted.meta?.changes === 0) return new Response("OK", { status: 200 });
      markerCreated = true;

      await handleUpdate(env, update);
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Webhook update failed:", error?.stack || error);
      if (markerCreated) {
        try {
          await env.DB.prepare(`DELETE FROM processed_updates WHERE update_id = ?`)
            .bind(update.update_id).run();
        } catch (cleanupError) {
          console.error("Failed to clear processed_updates marker:", cleanupError?.stack || cleanupError);
        }
      }
      // Acknowledge the webhook after notifying the owner. This avoids Telegram
      // retrying the same broken update forever when D1 configuration is wrong.
      // The user can retry the action after /health becomes green; source files
      // remain in the original Telegram chat and are never deleted.
      const ownerChatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
      if (ownerChatId) {
        try {
          await telegramApi(env, "sendMessage", {
            chat_id: ownerChatId,
            text: "⚠️ حصل خطأ أثناء معالجة الطلب، ولم تكتمل العملية. افتح رابط /health لمعرفة هل المشكلة في التوكن أو Webhook أو قاعدة D1، ثم أعد المحاولة بعد الإصلاح.",
            reply_markup: MAIN_KEYBOARD,
          });
        } catch (notifyError) {
          console.error("Could not notify owner about webhook failure:", notifyError?.stack || notifyError);
          return new Response("Temporary processing error. Check Cloudflare Worker logs.", { status: 500 });
        }
      }
      return new Response("OK", { status: 200 });
    }
  },
};
