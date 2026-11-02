export const SUBJECTS = [
  { code: "AIS", name: "AIS", order: 1, hashtag: "#AIS", aliases: ["ais"] },
  { code: "COST", name: "Cost System", order: 2, hashtag: "#cost_system", aliases: ["cost system", "cost", "costing", "cas"] },
  { code: "MA", name: "MA", order: 3, hashtag: "#Managerial_ACC", aliases: ["ma", "managerial acc", "managerial accounting", "management accounting"] },
  { code: "FR", name: "FR", order: 4, hashtag: "#FR", aliases: ["fr", "financial reporting"] },
  { code: "ADV", name: "Advanced", order: 5, hashtag: "#Advanced_Managerial_ACC", aliases: ["advanced", "ama", "advanced managerial", "advanced managerial acc"] },
  { code: "STUDIES", name: "دراسات محاسبية", order: 6, hashtag: "#دراسات_محاسبية", aliases: ["دراسات محاسبية", "دراسات"] },
];

export const GROUPS = [
  { code: "lectures", label: "المحاضرات" },
  { code: "sections", label: "السكاشن" },
  { code: "summaries", label: "الملخصات" },
];


/**
 * Normalize a Telegram destination supplied by the owner. Accept public
 * channel usernames, t.me links, or numeric chat IDs (including private
 * channel IDs such as -1001234567890).
 */
export function normalizeChannelTarget(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const usernameCandidate = raw.startsWith("@") ? raw.slice(1) : raw;
  const usernameMatch = usernameCandidate.match(/^(?:(?:https?:\/\/)?(?:www\.)?t\.me\/)?([A-Za-z][A-Za-z0-9_]{4,31})\/?$/);
  if (usernameMatch) return `@${usernameMatch[1]}`;

  if (/^-100\d{8,}$/.test(raw) || /^-\d{6,}$/.test(raw)) return raw;
  return null;
}

export const MAIN_BUTTONS = {
  newWeek: "🆕 أسبوع جديد",
  finish: "✅ إنهاء الاستقبال",
  preview: "👀 معاينة الترتيب",
  publish: "🚀 نشر المحتوى",
  classify: "🛠 تصحيح التصنيف",
  ignore: "🗑 تجاهل عنصر",
  status: "📊 حالة العملية",
  cancel: "❌ إلغاء العملية",
};

export const MAIN_KEYBOARD = {
  keyboard: [
    [MAIN_BUTTONS.newWeek, MAIN_BUTTONS.finish],
    [MAIN_BUTTONS.preview, MAIN_BUTTONS.publish],
    [MAIN_BUTTONS.classify, MAIN_BUTTONS.ignore],
    [MAIN_BUTTONS.status, MAIN_BUTTONS.cancel],
  ].map((row) => row.map((text) => ({ text }))),
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "استخدم أزرار التحكم أو أرسل ملفات الأسبوع",
};

export const GROUP_DIVIDERS = {
  lectures: "━━━━━━━━━━━━━━━━━━━━━━━━",
  sections: "━━━━━━━━━━━━━━━━━━━━━━━━",
  summaries: "━━━━━━━━━━━━━━━━━━━━━━━━",
};

const ARABIC_ORDINALS = {
  1: "الأول", 2: "الثاني", 3: "الثالث", 4: "الرابع", 5: "الخامس",
  6: "السادس", 7: "السابع", 8: "الثامن", 9: "التاسع", 10: "العاشر",
};

export function makeSectionsFooter(items) {
  const knownValues = items.map((item) => item.section_number).filter((value) => value != null);
  const numbers = [...new Set(knownValues.map(Number))].sort((a, b) => a - b);
  if (knownValues.length === items.length && numbers.length === 1) {
    const label = ARABIC_ORDINALS[numbers[0]] || String(numbers[0]);
    return `☝🏻 سكاشن الأسبوع ${label}`;
  }
  if (knownValues.length === items.length && numbers.length > 1) {
    return `☝🏻 سكاشن الأسابيع ${numbers.join("، ")}`;
  }
  return "☝🏻 سكاشن الأسبوع";
}

export const SUMMARIES_FOOTER = "☝🏻 ملخص محاضرة كل مادة الأسبوع ده";

export function normalizeText(value = "") {
  return String(value)
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/[ـ]/g, "")
    .toLowerCase();
}

function containsPattern(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function detectSubject(value = "") {
  const text = normalizeText(value);

  // Detect Advanced before MA because "Advanced Managerial ACC" includes "Managerial".
  if (containsPattern(text, [/#?advanced(?:\s+managerial)?(?:\s+acc)?\b/i, /\bama\b/i])) return "ADV";
  if (containsPattern(text, [/#?ais\b/i])) return "AIS";
  if (containsPattern(text, [/#?cost\s*system\b/i, /\bcas\b/i, /\bcosting\b/i, /\bcost\b/i])) return "COST";
  if (containsPattern(text, [/#?managerial\s+acc\b/i, /\bmanagerial\s+accounting\b/i, /\bmanagement\s+accounting\b/i, /(^|[^a-z])ma([^a-z]|$)/i])) return "MA";
  if (containsPattern(text, [/#?financial\s+reporting\b/i, /(^|[^a-z])fr([^a-z]|$)/i])) return "FR";
  if (containsPattern(text, [/دراسات\s+محاسبية/, /دراسات/])) return "STUDIES";
  return null;
}

export function detectGroup(value = "") {
  const text = normalizeText(value);
  if (containsPattern(text, [/\bsections?\s*\d*\b/, /\bsec\s*\d*\b/, /سكاشن?/, /تمارين\s+السكشن/])) return "sections";
  if (containsPattern(text, [/\bsummaries\b/, /\bsummary\b/, /ملخصات?/, /تلخيص/])) return "summaries";
  // Assignments, handouts, worksheets and supplementary PDFs stay in Lectures unless
  // the file clearly identifies itself as a Section or Summary.
  return "lectures";
}

export function extractSectionNumber(value = "") {
  const text = normalizeText(value);
  const match = text.match(/(?:\bsec(?:tion)?\s*|سكشن\s*)(\d{1,3})/i);
  return match ? Number(match[1]) : null;
}

export function extractLectureNumber(value = "") {
  const text = normalizeText(value);
  const match = text.match(/(?:\blec(?:ture)?\s*|محاضرة\s*)(\d{1,3})/i);
  return match ? Number(match[1]) : null;
}

export function getMediaInfo(message) {
  const candidates = [
    ["document", message.document],
    ["audio", message.audio],
    ["voice", message.voice],
    ["video", message.video],
    ["animation", message.animation],
    ["video_note", message.video_note],
    ["sticker", message.sticker],
  ];

  for (const [kind, media] of candidates) {
    if (media?.file_id) {
      return {
        mediaKind: kind,
        fileId: media.file_id,
        fileUniqueId: media.file_unique_id || null,
        fileName: media.file_name || null,
        mimeType: media.mime_type || null,
        isAudio: kind === "audio" || kind === "voice" || kind === "video_note",
      };
    }
  }

  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    return {
      mediaKind: "photo",
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id || null,
      fileName: null,
      mimeType: "image/jpeg",
      isAudio: false,
    };
  }

  return { mediaKind: "text", fileId: null, fileUniqueId: null, fileName: null, mimeType: null, isAudio: false };
}

export function classifyTelegramMessage(message) {
  const media = getMediaInfo(message);
  const caption = message.caption || "";
  const text = message.text || "";
  const fileName = media.fileName || "";
  const searchable = [fileName, caption, text].filter(Boolean).join(" ");
  const subjectCode = detectSubject(searchable);
  const groupType = detectGroup(searchable);
  const extensionAudio = /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i.test(fileName);
  const isAudio = media.isAudio || extensionAudio;
  const sectionNumber = extractSectionNumber(searchable);
  const lectureNumber = extractLectureNumber(searchable);
  const isAnswer = /\banswers?\b|\bsolutions?\b|إجابات|الاجابة|الإجابة|حلول|حل\b/i.test(normalizeText(searchable));

  const displayName = fileName || caption || text || (media.mediaKind === "text" ? "رسالة نصية" : `ملف ${media.mediaKind}`);
  const looksLikeGeneratedLectureAnnouncement =
    media.mediaKind === "text" &&
    /محاضرة\s*\d+/i.test(text) &&
    Boolean(subjectCode) &&
    /#/.test(text);
  const looksLikeGeneratedGroupFooter = media.mediaKind === "text" && (
    /سكاشن\s+الأسبوع/.test(text) ||
    /ملخص\s+محاضرة\s+كل\s+مادة/.test(text)
  );
  const looksLikeDividerOnly = media.mediaKind === "text" && /^[\s━─—_-]{8,}$/.test(text);

  return {
    ...media,
    subjectCode,
    groupType,
    isAudio,
    sectionNumber,
    lectureNumber,
    isAnswer,
    displayName: String(displayName).replace(/\s+/g, " ").slice(0, 180),
    needsReview: !subjectCode,
    looksLikeGeneratedLectureAnnouncement,
    looksLikeGeneratedGroupFooter,
    looksLikeDividerOnly,
  };
}

function subjectByCode(code) {
  return SUBJECTS.find((subject) => subject.code === code) || null;
}

export function compareBySubject(a, b) {
  const aOrder = subjectByCode(a.subject_code)?.order ?? 999;
  const bOrder = subjectByCode(b.subject_code)?.order ?? 999;
  return aOrder - bOrder;
}

function compareLectures(a, b) {
  // Documents/notes/assignments/handouts first, then the recording, preserving
  // the received order within each bucket.
  return compareBySubject(a, b) || Number(Boolean(a.is_audio)) - Number(Boolean(b.is_audio)) || Number(a.received_order) - Number(b.received_order);
}

function compareSections(a, b) {
  const subject = compareBySubject(a, b);
  if (subject !== 0) return subject;
  const aNumber = a.section_number == null ? 9999 : Number(a.section_number);
  const bNumber = b.section_number == null ? 9999 : Number(b.section_number);
  return aNumber - bNumber || Number(Boolean(a.is_answer)) - Number(Boolean(b.is_answer)) || Number(a.received_order) - Number(b.received_order);
}

function compareSummaries(a, b) {
  const subject = compareBySubject(a, b);
  if (subject !== 0) return subject;
  const aNumber = a.lecture_number == null ? 9999 : Number(a.lecture_number);
  const bNumber = b.lecture_number == null ? 9999 : Number(b.lecture_number);
  return aNumber - bNumber || Number(a.received_order) - Number(b.received_order);
}

export function buildPublishPlan(items, weekNumber) {
  const active = items.filter((item) => !Number(item.ignored));
  const plan = [];
  let sequence = 1;

  const pushDivider = (groupType) => {
    plan.push({
      sequence: sequence++,
      kind: "text",
      groupType,
      text: GROUP_DIVIDERS[groupType],
      itemId: null,
      addHashtag: false,
      subjectCode: null,
    });
  };

  const pushCopy = (item, addHashtag) => {
    plan.push({
      sequence: sequence++,
      kind: "copy",
      groupType: item.group_type,
      text: null,
      itemId: Number(item.id),
      addHashtag,
      subjectCode: item.subject_code,
    });
  };

  const pushSubjectTagIfNeeded = (item) => {
    const subject = subjectByCode(item.subject_code);
    if (!subject) return;
    let message = {};
    try { message = JSON.parse(item.payload_json || "{}"); } catch { message = {}; }
    const originalText = message.text || "";
    const originalCaption = message.caption || "";
    const tag = subject.hashtag;
    const hasTag = `${originalText}\n${originalCaption}`.includes(tag);
    if (hasTag) {
      pushCopy(item, false);
      return;
    }

    const inlineCaptionKinds = new Set(["photo", "document", "audio", "video", "animation"]);
    if (item.media_kind === "text" && originalText && originalText.length + tag.length + 2 <= 4096) {
      pushCopy(item, true);
      return;
    }
    if (inlineCaptionKinds.has(item.media_kind) && originalCaption.length + tag.length + 2 <= 1024) {
      pushCopy(item, true);
      return;
    }

    // Some Telegram message types cannot have a caption (for example voice
    // notes, video notes and stickers). Keep the media intact, then post its
    // subject hashtag as a separate text message.
    pushCopy(item, false);
    plan.push({
      sequence: sequence++,
      kind: "text",
      groupType: item.group_type,
      text: tag,
      itemId: null,
      addHashtag: false,
      subjectCode: item.subject_code,
    });
  };

  // 1) Lectures: all non-audio content for a subject, then its recording,
  // then the generated announcement. Assignments/handouts remain ordinary
  // lecture documents and are not filtered out.
  const lectures = active.filter((item) => item.group_type === "lectures").sort(compareLectures);
  if (lectures.length) {
    pushDivider("lectures");
    for (const subject of SUBJECTS) {
      const subjectItems = lectures.filter((item) => item.subject_code === subject.code);
      if (!subjectItems.length) continue;
      for (const item of subjectItems) pushCopy(item, false);
      plan.push({
        sequence: sequence++,
        kind: "text",
        groupType: "lectures",
        text: makeLectureAnnouncement(weekNumber, subject.code),
        itemId: null,
        addHashtag: false,
        subjectCode: subject.code,
      });
    }
  }

  // 2) Sections: same subject order; section numbers ascending; answers after
  // the corresponding non-answer materials. Missing subjects are simply skipped.
  const sections = active.filter((item) => item.group_type === "sections").sort(compareSections);
  if (sections.length) {
    pushDivider("sections");
    for (const item of sections) pushSubjectTagIfNeeded(item);
    plan.push({
      sequence: sequence++,
      kind: "text",
      groupType: "sections",
      text: makeSectionsFooter(sections),
      itemId: null,
      addHashtag: false,
      subjectCode: null,
    });
  }

  // 3) Summaries: same subject order, then extracted lecture number when available.
  const summaries = active.filter((item) => item.group_type === "summaries").sort(compareSummaries);
  if (summaries.length) {
    pushDivider("summaries");
    for (const item of summaries) pushSubjectTagIfNeeded(item);
    plan.push({
      sequence: sequence++,
      kind: "text",
      groupType: "summaries",
      text: SUMMARIES_FOOTER,
      itemId: null,
      addHashtag: false,
      subjectCode: null,
    });
  }

  return plan;
}

export function makeLectureAnnouncement(weekNumber, subjectCode) {
  const subject = subjectByCode(subjectCode);
  if (!subject) throw new Error(`Unknown subject code: ${subjectCode}`);
  const labels = {
    AIS: "AIS",
    COST: "Cost System",
    MA: "MA",
    FR: "FR",
    ADV: "Advanced",
    STUDIES: "دراسات محاسبية",
  };
  const label = labels[subjectCode];
  const spacer = subjectCode === "MA" ? "" : " ";
  return `محاضرة ${weekNumber} (${label})${spacer}👆🏻\n\n${subject.hashtag}`;
}

export function appendHashtagToText(text = "", hashtag = "") {
  const cleanText = String(text || "").trimEnd();
  if (!hashtag) return cleanText;
  const escaped = hashtag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exists = new RegExp(`(^|\\s)${escaped}(?=$|\\s)`, "m").test(cleanText);
  return exists ? cleanText : `${cleanText}${cleanText ? "\n\n" : ""}${hashtag}`;
}

export function appendHashtagEntity(entities = [], originalText = "", hashtag = "") {
  const text = appendHashtagToText(originalText, hashtag);
  if (!hashtag || text === originalText || text === String(originalText || "").trimEnd()) {
    return { text, entities: Array.isArray(entities) ? entities : [] };
  }
  const offset = text.length - hashtag.length;
  return {
    text,
    entities: [...(Array.isArray(entities) ? entities : []), { type: "hashtag", offset, length: hashtag.length }],
  };
}
