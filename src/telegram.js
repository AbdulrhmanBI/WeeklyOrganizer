export async function telegramApi(env, method, payload = {}) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN is not configured.");
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram returned a non-JSON response (${response.status}).`);
  }

  if (!response.ok || !result?.ok) {
    const description = result?.description || `Telegram API error ${response.status}`;
    const retryAfter = result?.parameters?.retry_after;
    const error = new Error(retryAfter ? `${description} (retry after ${retryAfter}s)` : description);
    error.retryAfter = retryAfter || null;
    throw error;
  }
  return result.result;
}

export async function sendMessage(env, chatId, text, replyMarkup = undefined) {
  const payload = { chat_id: chatId, text: String(text).slice(0, 4096) };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramApi(env, "sendMessage", payload);
}

export function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}
