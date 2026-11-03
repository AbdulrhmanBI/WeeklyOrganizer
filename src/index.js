import {
  SUBJECTS,
  GROUPS,
  MAIN_BUTTONS,
  MAIN_KEYBOARD,
  classifyTelegramMessage,
  buildPublishPlan,
  appendHashtagEntity,
  normalizeChannelTarget,
  formatWeekOrdinal,
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
    await showHome(env, chatId);
    return;
  }

  await env.DB.prepare(
    `INSERT INTO sessions (owner_id, owner_chat_id, status, created_at, updated_at)
     VALUES (?, ?, 'awaiting_week', ?, ?)`,
  ).bind(ownerId(env), String(chatId), nowIso(), nowIso()).run();

  await reply(env, chatId,
    "تم إنشاء أسبوع جديد.\nأرسل رقم أسبوع المحاضرات من 1 إلى 99.\nستحدد رقم أسبوع التمارين العملية لاحقًا عند تصنيف أول ملف في هذا القسم.",
  );
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
      ? `تم استلام ${saved.total} عناصر. يوجد ملف يحتاج إلى مراجعة تصنيفه.`
      : `تم استلام المحتوى بنجاح.\nعدد العناصر: ${saved.total}`;
    await reply(env, message.chat.id, text);
  }
}

async function showWelcome(env, chatId) {
  await reply(env, chatId, "مرحبًا بك في منظّم المحتوى الأسبوعي 📚\nيمكنك إدارة أسبوعك من القائمة التالية.");
  // Keep /start responsive even when D1 is temporarily unavailable.
  if (!env.DB) return;
  try {
    await showHome(env, chatId);
  } catch (error) {
    console.error("Could not load the home screen after /start:", error?.stack || error);
    await sendInline(env, chatId,
      "تعذر تحميل حالة الأسبوع حاليًا. تحقق من اتصال قاعدة البيانات ثم اضغط «الرئيسية» مرة أخرى.",
      [[{ text: "تحديث القائمة", callback_data: "home" }]],
    );
  }
}

/**
 * A single contextual home screen replaces the old eight-button keyboard.
 * The user only sees the actions that make sense for the current state.
 */
async function showHome(env, chatId) {
  const session = await getActiveSession(env);

  if (!session) {
    const latest = await getLatestSession(env);
    const previous = latest
      ? `\nآخر عملية: الأسبوع ${latest.week_number ?? "غير محدد"} — ${latest.status === "completed" ? "مكتملة" : latest.status === "cancelled" ? "ملغاة" : latest.status}.`
      : "";
    await sendInline(env, chatId,
      `القائمة الرئيسية\n\nابدأ أسبوعًا جديدًا، ثم أرسل الملفات. بعد انتهاء الاستقبال يمكنك إرسال المحتوى كاملًا إلى هذه المحادثة. النشر في القناة اختياري.${previous}`,
      [[{ text: "➕ بدء أسبوع جديد", callback_data: "start_week" }]],
    );
    return;
  }

  if (session.status === "awaiting_week") {
    await sendInline(env, chatId,
      "الأسبوع الجديد قيد الإعداد. أرسل رقم أسبوع المحاضرات من 1 إلى 99.",
      [[{ text: "إلغاء الأسبوع", callback_data: "cancel_session" }]],
    );
    return;
  }

  if (session.awaiting_sections_week) {
    const rows = [];
    if (Number(session.sections_week_number) && Number(session.pending_section_item_id)) {
      rows.push([{ text: `استخدام أسبوع التمارين الحالي (${session.sections_week_number})`, callback_data: `use_sections_week:${session.pending_section_item_id}` }]);
    }
    rows.push([{ text: "إلغاء تصنيف هذا الملف", callback_data: "cancel_section_week_input" }]);
    rows.push([{ text: "إلغاء الأسبوع بالكامل", callback_data: "cancel_session" }]);
    await sendInline(env, chatId,
      `بانتظار رقم أسبوع التمارين العملية من 1 إلى 99.${session.pending_section_item_id ? "\nأرسل الرقم في المحادثة، أو استخدم الرقم المحفوظ." : ""}`,
      rows,
    );
    return;
  }

  if (session.status === "collecting") {
    const items = await getItems(env, session.id);
    const activeItems = items.filter((item) => !Number(item.ignored));
    const needsReview = activeItems.filter((item) => !item.subject_code || item.classification_status === "review").length;
    const lines = [
      `استقبال الأسبوع ${formatWeekOrdinal(session.week_number) || session.week_number}`,
      `تم استلام ${activeItems.length} عنصر حتى الآن.`,
      needsReview ? `يوجد ${needsReview} عنصر يحتاج إلى مراجعة التصنيف.` : "التصنيفات الحالية سليمة.",
      "يمكنك متابعة إرسال الملفات، ثم إنهاء الاستقبال عند الانتهاء.",
    ];
    const rows = [[{ text: "إنهاء استقبال الملفات", callback_data: "finish_receiving" }]];
    if (needsReview) rows.push([{ text: "مراجعة الملفات غير المصنفة", callback_data: "listc:0" }]);
    rows.push([{ text: "إلغاء الأسبوع", callback_data: "cancel_session" }]);
    await sendInline(env, chatId, lines.join("\n\n"), rows);
    return;
  }

  if (session.status === "ready") {
    await showPreview(env, chatId, session);
    return;
  }

  if (session.status === "publishing") {
    await sendInline(env, chatId,
      `يجري نشر الأسبوع ${formatWeekOrdinal(session.week_number) || session.week_number} في القناة. يمكنك متابعة النشر أو إيقاف ما تبقى.`,
      [[{ text: "متابعة النشر", callback_data: "continue_publish" }], [{ text: "عرض الحالة", callback_data: "show_status" }], [{ text: "إيقاف النشر وإلغاء الأسبوع", callback_data: "cancel_session" }]],
    );
    return;
  }

  if (session.status === "publish_failed") {
    await resumeFailedPublish(env, chatId, session);
    return;
  }

  await sendInline(env, chatId, `حالة الأسبوع: ${session.status}`, [[{ text: "تحديث القائمة", callback_data: "home" }]]);
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

  if (text === MAIN_BUTTONS.home || text === "القائمة الرئيسية" || text === "/menu") {
    await showHome(env, chatId);
    return;
  }
  // Backward compatibility for messages generated by older reply keyboards.
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
        "صيغة وجهة النشر غير صحيحة. أرسل @ChannelUsername أو رقم Chat ID يبدأ عادةً بـ -100 أو رابط t.me للقناة العامة.",
      );
      return;
    }
    await env.DB.prepare(
      `UPDATE sessions SET target_chat_id = ?, awaiting_destination = 0, updated_at = ? WHERE id = ?`,
    ).bind(destination, nowIso(), active.id).run();
    const updatedSession = { ...active, target_chat_id: destination, awaiting_destination: 0 };
    await reply(env, chatId, `تم حفظ وجهة النشر: ${destination} ✅\nيجري الآن إعداد خطة النشر.`);
    await startPublishConfirmation(env, chatId, updatedSession);
    return;
  }

  if (active?.awaiting_sections_week) {
    if (!/^\d{1,2}$/.test(text)) {
      await reply(env, chatId, "أرسل رقم أسبوع التمارين العملية كعدد صحيح من 1 إلى 99.");
      return;
    }
    const sectionsWeek = Number(text);
    if (sectionsWeek < 1 || sectionsWeek > 99) {
      await reply(env, chatId, "يجب أن يكون رقم أسبوع التمارين العملية بين 1 و99.");
      return;
    }
    const pendingItemId = Number(active.pending_section_item_id || 0);
    await env.DB.prepare(
      `UPDATE sessions SET sections_week_number = ?, awaiting_sections_week = 0, pending_section_item_id = NULL, updated_at = ? WHERE id = ?`,
    ).bind(sectionsWeek, nowIso(), active.id).run();

    if (pendingItemId) {
      const pendingItem = await getItem(env, active.id, pendingItemId);
      if (!pendingItem || Number(pendingItem.ignored)) {
        await reply(env, chatId, "حُفظ رقم أسبوع التمارين العملية، لكن الملف المطلوب لم يعد متاحًا. افتح مراجعة التصنيف واختر الملف مرة أخرى.");
        return;
      }
      await reply(env, chatId, `تم حفظ رقم أسبوع التمارين العملية: ${formatWeekOrdinal(sectionsWeek)} ✅`);
      await showSubjectPicker(env, chatId, pendingItem, "sections", sectionsWeek);
      return;
    }

    await reply(env, chatId, `تم حفظ رقم أسبوع التمارين العملية: ${formatWeekOrdinal(sectionsWeek)} ✅`);
    await finishReceiving(env, chatId, { ...active, sections_week_number: sectionsWeek, awaiting_sections_week: 0 });
    return;
  }

  if (active?.status === "awaiting_week") {
    if (!/^\d{1,3}$/.test(text)) {
      await reply(env, chatId, "أرسل رقم أسبوع المحاضرات كعدد صحيح من 1 إلى 99، مثل 6.");
      return;
    }
    const week = Number(text);
    if (week < 1 || week > 99) {
      await reply(env, chatId, "يجب أن يكون رقم الأسبوع بين 1 و99.");
      return;
    }
    await env.DB.prepare(
      `UPDATE sessions SET week_number = ?, status = 'collecting', awaiting_sections_week = 0, updated_at = ? WHERE id = ?`,
    ).bind(week, nowIso(), active.id).run();
    await sendInline(env, chatId,
      `بدأ استقبال محتوى الأسبوع ${formatWeekOrdinal(week)} ✅\n\nأرسل جميع الملفات والرسائل بأي ترتيب؛ سأرتبها تلقائيًا.\nعند الانتهاء، اضغط «إنهاء استقبال الملفات».`,
      [
        [{ text: "إنهاء استقبال الملفات", callback_data: "finish_receiving" }],
        [{ text: "عرض حالة الأسبوع", callback_data: "show_status" }],
      ],
    );
    return;
  }

  if (active?.status === "collecting") {
    await handleIncomingContent(env, active, message);
    return;
  }

  if (message.document || message.audio || message.voice || message.video || message.animation || message.photo || message.text || message.caption) {
    await reply(env, chatId, "لا يوجد أسبوع مفتوح حاليًا. ابدأ أسبوعًا جديدًا من القائمة الرئيسية قبل إرسال الملفات.");
    return;
  }
}

async function finishReceiving(env, chatId, session) {
  if (session?.awaiting_sections_week) {
    await reply(env, chatId, "يوجد ملف قيد تصنيف التمارين العملية. أرسل رقم الأسبوع من 1 إلى 99 أولًا.");
    return;
  }
  if (!session) {
    await showHome(env, chatId);
    return;
  }
  if (session.status !== "collecting") {
    await reply(env, chatId, `حالة العملية الحالية: ${session.status}. لا يمكن إنهاء الاستقبال في هذه المرحلة.`);
    return;
  }

  const items = await getItems(env, session.id);
  if (!items.length) {
    await reply(env, chatId, "لم يُستلم أي ملف بعد. أرسل الملفات أولًا، ثم أنهِ الاستقبال.");
    return;
  }

  const hasSections = items.some((item) => item.group_type === "sections" && !Number(item.ignored));
  if (hasSections && !Number(session.sections_week_number)) {
    await env.DB.prepare(
      `UPDATE sessions SET awaiting_sections_week = 1, pending_section_item_id = NULL, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), session.id).run();
    await sendInline(env, chatId,
      "تم تصنيف ملفات ضمن التمارين العملية، لكن رقم أسبوعها غير محدد.\n\nأرسل رقم أسبوع التمارين العملية من 1 إلى 99.\nرقم Sec في اسم الملف مخصص لترتيب الملفات فقط، ولا يحدد رقم الأسبوع.",
      [],
    );
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
    await showHome(env, chatId);
    return;
  }
  if (session.status === "awaiting_week") {
    await sendInline(env, chatId, "أرسل رقم أسبوع المحاضرات أولًا.", [[{ text: "إلغاء الأسبوع", callback_data: "cancel_session" }]]);
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

  const groups = ["lectures", "sections", "summaries"].map((group) => {
    const result = formatCounts(activeItems, group);
    const icon = group === "lectures" ? "📚" : group === "sections" ? "📝" : "📌";
    return `${icon} ${groupName(group)}: ${result.total}`;
  });

  const lectureWeek = formatWeekOrdinal(session.week_number) || session.week_number;
  const sectionsWeek = formatWeekOrdinal(session.sections_week_number) || session.sections_week_number;
  let preview = `ملخص الأسبوع ${lectureWeek} ✅\n`;
  if (activeItems.some((item) => item.group_type === "sections")) {
    preview += `أسبوع التمارين العملية: ${sectionsWeek || "لم يُحدد"}\n`;
  }
  preview += `\n${groups.join("\n")}\n\n`;
  preview += `إجمالي العناصر: ${activeItems.length}\n`;
  preview += `تحتاج إلى مراجعة: ${reviewItems.length}\n`;
  preview += `ملفات مكررة محتملة: ${duplicates.size}\n`;
  preview += `عناصر مستبعدة: ${items.length - activeItems.length}`;

  const buttons = [];
  if (reviewItems.length) {
    buttons.push([{ text: `مراجعة التصنيف (${reviewItems.length})`, callback_data: "listc:0" }]);
  }
  if (activeItems.length && ["ready", "completed"].includes(session.status)) {
    if (!reviewItems.length) {
      buttons.push([{ text: "📨 إرسال المحتوى كاملًا إلى هذه المحادثة", callback_data: "preview_send:0" }]);
    }
    if (session.status === "ready" && !reviewItems.length) {
      buttons.push([{ text: "📢 النشر في القناة (اختياري)", callback_data: "prepare_publish" }]);
    }
    buttons.push([
      { text: "تصحيح ملف", callback_data: "listc:0" },
      { text: "استبعاد ملف", callback_data: "listi:0" },
    ]);
    if (session.status === "ready") {
      buttons.push([{ text: "🗑 إلغاء هذا الأسبوع وبدء أسبوع جديد", callback_data: "cancel_session" }]);
    }
  }
  if (session.status === "collecting") {
    buttons.push([{ text: "إنهاء استقبال الملفات", callback_data: "finish_receiving" }]);
    if (reviewItems.length) buttons.push([{ text: `مراجعة التصنيف (${reviewItems.length})`, callback_data: "listc:0" }]);
  }
  buttons.push([{ text: "🏠 الرئيسية", callback_data: "home" }]);

  await sendInline(env, chatId, preview.slice(0, 3900), buttons);
}

async function sendFullPreview(env, chatId, session, offset = 0) {
  if (!session || !["ready", "completed"].includes(session.status)) {
    await reply(env, chatId, "أنهِي استقبال الملفات أولًا، ثم اختر إرسال المحتوى كاملًا إلى هذه المحادثة.");
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

  await sendInline(env, chatId,
    `أسبوع المحاضرات: ${formatWeekOrdinal(session.week_number) || "بانتظار الرقم"}\nأسبوع التمارين العملية: ${formatWeekOrdinal(session.sections_week_number) || "غير محدد"}\nالحالة: ${session.status}\nالعناصر المستلمة: ${count?.total || 0}\nالعناصر النشطة: ${count?.active || 0}\nتحتاج مراجعة: ${count?.review || 0}${publishText}`,
    [[{ text: "🏠 الرئيسية", callback_data: "home" }]],
  );
}

async function showItemPicker(env, chatId, session, mode, page) {
  if (!session || !["collecting", "ready"].includes(session.status)) {
    await reply(env, chatId, "يمكنك مراجعة التصنيف أو استبعاد الملفات أثناء الاستقبال أو بعد إنهائه وقبل النشر.");
    return;
  }
  const items = await getItems(env, session.id);
  const available = items.filter((item) => !Number(item.ignored));
  const pages = Math.max(1, Math.ceil(available.length / ITEM_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const pageItems = available.slice(safePage * ITEM_PAGE_SIZE, (safePage + 1) * ITEM_PAGE_SIZE);

  if (!pageItems.length) {
    await reply(env, chatId, mode === "classify" ? "لا توجد ملفات متاحة لمراجعة تصنيفها." : "لا توجد ملفات متاحة للاستبعاد.");
    return;
  }

  const title = mode === "classify" ? "اختر الملف الذي تريد مراجعة تصنيفه:" : "اختر الملف الذي تريد استبعاده:";
  const rows = pageItems.map((item) => [{
    text: `${item.id}. ${String(item.display_name).slice(0, 42)}${item.subject_code ? ` · ${item.subject_code}` : " · غير مصنف"}`.slice(0, 60),
    callback_data: `${mode === "classify" ? "ci" : "ii"}:${item.id}`,
  }]);
  const nav = [];
  if (safePage > 0) nav.push({ text: "⬅️ السابق", callback_data: `${mode === "classify" ? "listc" : "listi"}:${safePage - 1}` });
  if (safePage < pages - 1) nav.push({ text: "التالي ➡️", callback_data: `${mode === "classify" ? "listc" : "listi"}:${safePage + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "🏠 الرئيسية", callback_data: "home" }]);
  await sendInline(env, chatId, `${title}\nصفحة ${safePage + 1} من ${pages}`, rows);
}

async function cancelCurrentSession(env, chatId, session) {
  if (!session) {
    await showHome(env, chatId);
    return;
  }

  if (session.status === "publishing" || session.status === "publish_failed") {
    await sendInline(env, chatId,
      "هل تريد إيقاف النشر وإلغاء الأسبوع الحالي؟\n\nقد تكون بعض الرسائل وصلت إلى القناة بالفعل؛ إيقاف العملية لن يحذف ما نُشر سابقًا. ستظل الملفات الأصلية محفوظة في سجل الأسبوع.",
      [
        [{ text: "نعم، أوقف النشر وألغِ الأسبوع", callback_data: `cancelconfirm:${session.id}` }],
        [{ text: "العودة إلى الأسبوع", callback_data: "home" }],
      ],
    );
    return;
  }

  await sendInline(env, chatId,
    `هل تريد إلغاء الأسبوع ${formatWeekOrdinal(session.week_number) || session.week_number || "الجديد"}؟\n\nلن تُحذف الملفات من سجل البوت، لكن لن تتم متابعة هذا الأسبوع. بعد الإلغاء يمكنك بدء أسبوع جديد.`,
    [
      [{ text: "نعم، إلغاء الأسبوع", callback_data: "confirm_cancel_session" }],
      [{ text: "إلغاء الأسبوع وبدء أسبوع جديد", callback_data: "cancel_and_start_week" }],
      [{ text: "العودة إلى الأسبوع", callback_data: "home" }],
    ],
  );
}

function getPublishDestination(env, session) {
  // CHANNEL_ID is an optional deployment-wide default. When omitted, the
  // owner chooses a destination per week and it is persisted in D1.
  return String(env.CHANNEL_ID || session?.target_chat_id || "").trim();
}

async function startPublishConfirmation(env, chatId, session) {
  if (!session) {
    await reply(env, chatId, "لا يوجد محتوى جاهز للنشر. ابدأ أسبوعًا جديدًا أولًا.");
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
      "لم تُحدد وجهة النشر بعد. أرسل أحد الخيارات التالية:\n• @ChannelUsername للقناة العامة\n• -1001234567890 للقناة الخاصة\n• رابط t.me للقناة العامة\n\nتأكد من إضافة البوت إلى القناة ومنحه صلاحية نشر الرسائل. النشر اختياري، ويمكنك العودة إلى القائمة الرئيسية.",
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
    `تم تجهيز خطة النشر للأسبوع ${session.week_number} ✅\n\nوجهة النشر: ${getPublishDestination(env, session)}\nعدد الرسائل والمنشورات: ${planCount}\nسيتم النشر بالترتيب: المحاضرات، ثم التمارين العملية، ثم الملخصات.\n\nهل تؤكد النشر؟`,
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
    await reply(env, chatId, `اكتمل نشر الأسبوع ✅\n\nتم نشر ${done} من ${total} رسالة أو منشور في القناة. يمكنك بدء أسبوع جديد من القائمة الرئيسية.`);
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
    `جارٍ نشر الأسبوع.\n\nتم: ${done}/${total}\nالمتبقي: ${pending}\n\nاضغط «متابعة النشر» لاستكمال الدفعة التالية.`,
    [[{ text: "▶️ متابعة النشر", callback_data: "continue_publish" }]],
  );
}

async function publishNextBatch(env, chatId, session) {
  if (!session) {
    await reply(env, chatId, "لا توجد عملية نشر جارية.");
    return;
  }

  const destinationChatId = getPublishDestination(env, session);
  if (!destinationChatId) {
    await reply(env, chatId, "لم تُحدد وجهة النشر بعد. افتح خيار النشر في القناة لتحديدها.");
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
    [
      [{ text: "🔁 إعادة المحاولة", callback_data: `retry:${problem.id}` }],
      [{ text: "⏭ تخطي هذا العنصر", callback_data: `skip:${problem.id}` }],
      [{ text: "إيقاف النشر وإلغاء الأسبوع", callback_data: "cancel_session" }],
      [{ text: "🏠 الرئيسية", callback_data: "home" }],
    ],
  );
}

async function showSubjectPicker(env, chatId, item, groupType, sectionsWeekNumber = null) {
  const buttons = [];
  for (let i = 0; i < SUBJECTS.length; i += 2) {
    buttons.push(SUBJECTS.slice(i, i + 2).map((subject) => ({
      text: subject.name,
      callback_data: `cs:${item.id}:${groupType}:${subject.code}`,
    })));
  }
  let prompt = `اختر المادة الصحيحة للعنصر:\n${item.display_name}`;
  if (groupType === "sections") {
    prompt += sectionsWeekNumber
      ? `\n\nأسبوع التمارين العملية: ${formatWeekOrdinal(sectionsWeekNumber) || sectionsWeekNumber}`
      : "\n\nلم يُحدد أسبوع التمارين العملية بعد.";
    buttons.push([{ text: "تغيير أسبوع التمارين العملية", callback_data: `sw:${item.id}` }]);
  }
  await sendInline(env, chatId, prompt, buttons);
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

  if (data.startsWith("sw:")) {
    if (!active || !["collecting", "ready"].includes(active.status)) return;
    const itemId = Number(data.split(":")[1]);
    const item = await getItem(env, active.id, itemId);
    if (!item || Number(item.ignored)) {
      await reply(env, chatId, "ملف التمارين العملية غير موجود أو تم استبعاده.");
      return;
    }
    await env.DB.prepare(
      `UPDATE sessions SET awaiting_sections_week = 1, pending_section_item_id = ?, updated_at = ? WHERE id = ?`,
    ).bind(itemId, nowIso(), active.id).run();
    await sendInline(env, chatId,
      `أرسل رقم أسبوع التمارين العملية لهذا الملف (من 1 إلى 99):\n${item.display_name}\n\nرقم Sec في اسم الملف مخصص لترتيب الملفات فقط.`,
      [
        ...(Number(active.sections_week_number) ? [[{ text: `الإبقاء على الأسبوع ${formatWeekOrdinal(active.sections_week_number)}`, callback_data: `use_sections_week:${itemId}` }]] : []),
        [{ text: "إلغاء التصنيف", callback_data: "cancel_section_week_input" }],
      ],
    );
    return;
  }

  if (data.startsWith("use_sections_week:")) {
    if (!active || !Number(active.awaiting_sections_week) || !Number(active.sections_week_number)) {
      await reply(env, chatId, "لا يوجد رقم أسبوع محفوظ. أرسل رقم أسبوع التمارين العملية في المحادثة.");
      return;
    }
    const itemId = Number(data.split(":")[1]);
    if (Number(active.pending_section_item_id) !== itemId) {
      await reply(env, chatId, "تغير الملف قيد التصنيف. افتح مراجعة التصنيف واختر الملف مرة أخرى.");
      return;
    }
    await env.DB.prepare(
      `UPDATE sessions SET awaiting_sections_week = 0, pending_section_item_id = NULL, updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), active.id).run();
    const item = await getItem(env, active.id, itemId);
    if (!item || Number(item.ignored)) {
      await reply(env, chatId, "ملف التمارين العملية غير موجود أو تم استبعاده.");
      return;
    }
    await showSubjectPicker(env, chatId, item, "sections", active.sections_week_number);
    return;
  }

  if (data === "home" || data === "menu") {
    await showHome(env, chatId);
    return;
  }
  if (data === "start_week") {
    await createWeekSession(env, chatId);
    return;
  }
  if (data === "finish_receiving") {
    await finishReceiving(env, chatId, active);
    return;
  }
  if (data === "show_status") {
    await showStatus(env, chatId, active);
    return;
  }
  if (data === "cancel_session") {
    await cancelCurrentSession(env, chatId, active);
    return;
  }
  if (data === "confirm_cancel_session" || data === "cancel_and_start_week") {
    if (!active) {
      await showHome(env, chatId);
      return;
    }
    if (["publishing", "publish_failed"].includes(active.status)) {
      await reply(env, chatId, "استخدم تأكيد إيقاف النشر الظاهر في رسالة إيقاف النشر.");
      return;
    }
    await env.DB.prepare(
      `UPDATE sessions SET status = 'cancelled', updated_at = ? WHERE id = ?`,
    ).bind(nowIso(), active.id).run();
    if (data === "cancel_and_start_week") {
      await reply(env, chatId, "أُلغي الأسبوع السابق، وسنبدأ أسبوعًا جديدًا الآن.");
      await createWeekSession(env, chatId);
    } else {
      await reply(env, chatId, "أُلغي الأسبوع الحالي بنجاح. يمكنك بدء أسبوع جديد من القائمة الرئيسية.");
      await showHome(env, chatId);
    }
    return;
  }
  if (data === "cancel_section_week_input") {
    if (active && Number(active.awaiting_sections_week)) {
      await env.DB.prepare(
        `UPDATE sessions SET awaiting_sections_week = 0, pending_section_item_id = NULL, updated_at = ? WHERE id = ?`,
      ).bind(nowIso(), active.id).run();
      const message = Number(active.sections_week_number)
        ? "أُلغي تغيير أسبوع التمارين العملية، وظل الأسبوع السابق محفوظًا."
        : "أُلغي تصنيف الملف، ولم يُحفظ رقم أسبوع للتمارين العملية.";
      await sendInline(env, chatId, message, [[{ text: "مراجعة التصنيف", callback_data: "listc:0" }], [{ text: "🏠 الرئيسية", callback_data: "home" }]]);
    }
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
      await reply(env, chatId, "لم تعد هناك عملية جاهزة للتأكيد. افتح ملخص الأسبوع أولًا.");
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
      [{ text: "📝 التمارين العملية", callback_data: `cg:${id}:sections` }],
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

    if (groupType === "sections" && !Number(active.sections_week_number)) {
      await env.DB.prepare(
        `UPDATE sessions SET awaiting_sections_week = 1, pending_section_item_id = ?, updated_at = ? WHERE id = ?`,
      ).bind(id, nowIso(), active.id).run();
      await sendInline(env, chatId,
        `هذا الملف من التمارين العملية:\n${item.display_name}\n\nأرسل رقم الأسبوع الذي تنتمي إليه التمارين (من 1 إلى 99).\nرقم Sec في اسم الملف يُستخدم لترتيب الملفات فقط.`,
        [[{ text: "إلغاء التصنيف", callback_data: "cancel_section_week_input" }]],
      );
      return;
    }

    await showSubjectPicker(env, chatId, item, groupType, active.sections_week_number);
    return;
  }
  if (data.startsWith("cs:")) {
    const [, idRaw, groupType, subjectCode] = data.split(":");
    const id = Number(idRaw);
    const subject = SUBJECTS.find((value) => value.code === subjectCode);
    if (!active || !subject || !["lectures", "sections", "summaries"].includes(groupType)) return;
    const item = await getItem(env, active.id, id);
    if (!item || Number(item.ignored)) return;
    if (groupType === "sections" && !Number(active.sections_week_number)) {
      await env.DB.prepare(
        `UPDATE sessions SET awaiting_sections_week = 1, pending_section_item_id = ?, updated_at = ? WHERE id = ?`,
      ).bind(id, nowIso(), active.id).run();
      await sendInline(env, chatId, "أرسل رقم أسبوع التمارين العملية من 1 إلى 99 أولًا.", [[{ text: "إلغاء التصنيف", callback_data: "cancel_section_week_input" }]]);
      return;
    }
    await env.DB.prepare(
      `UPDATE items SET group_type = ?, subject_code = ?, classification_status = 'manual' WHERE id = ? AND session_id = ?`,
    ).bind(groupType, subjectCode, id, active.id).run();
    await reply(env, chatId, `تم تحديث التصنيف ✅\n${item.display_name}\nالقسم: ${groupName(groupType)}\nالمادة: ${subject.name}`);
    await showHome(env, chatId);
    return;
  }
  if (data.startsWith("ii:")) {
    const id = Number(data.split(":")[1]);
    const item = active && await getItem(env, active.id, id);
    if (!item) return;
    await sendInline(env, chatId,
      `هل أنت متأكد أنك تريد تجاهل العنصر التالي؟\n\n${item.display_name}\n\nلن يتم نشره، لكنه سيظل محفوظًا في سجل العملية.`,
      [[{ text: "نعم، استبعاد الملف", callback_data: `iy:${id}` }, { text: "رجوع", callback_data: "listi:0" }]],
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
    await reply(env, chatId, "تم إيقاف النشر وإلغاء الأسبوع. الرسائل التي نُشرت بالفعل ستظل موجودة في القناة، ولم يتم حذفها.");
    await showHome(env, chatId);
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
          "SELECT sections_week_number, awaiting_sections_week, pending_section_item_id FROM sessions LIMIT 0",
        ).all();
        health.checks.sectionsWeekMigrationApplied = true;
      } catch (migrationError) {
        console.error("D1 section-week migration is missing or incomplete:", migrationError?.message || migrationError);
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
