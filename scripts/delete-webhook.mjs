const { BOT_TOKEN } = process.env;
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in .webhook.env");
  process.exit(1);
}
const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ drop_pending_updates: false }),
});
const data = await response.json();
if (!response.ok || !data.ok) {
  console.error("deleteWebhook failed:", data.description || response.statusText);
  process.exit(1);
}
console.log("Webhook removed. The bot will not receive updates until a new webhook is configured.");
