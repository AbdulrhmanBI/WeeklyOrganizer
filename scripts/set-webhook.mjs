const { BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL } = process.env;

if (!BOT_TOKEN || !WEBHOOK_SECRET || !WORKER_URL) {
  console.error("Missing BOT_TOKEN, WEBHOOK_SECRET, or WORKER_URL in .webhook.env");
  process.exit(1);
}

if (!/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET)) {
  console.error("WEBHOOK_SECRET may contain only A-Z, a-z, 0-9, underscore and hyphen.");
  process.exit(1);
}

const baseUrl = WORKER_URL.replace(/\/+$/, "");
const url = `${baseUrl}/telegram/webhook`;
const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    max_connections: 1,
    drop_pending_updates: false,
  }),
});
const data = await response.json();
if (!response.ok || !data.ok) {
  console.error("Telegram setWebhook failed:", data.description || response.statusText);
  process.exit(1);
}
console.log("Webhook configured successfully:", url);
