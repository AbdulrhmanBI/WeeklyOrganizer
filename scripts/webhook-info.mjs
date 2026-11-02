const { BOT_TOKEN } = process.env;
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in .webhook.env");
  process.exit(1);
}
const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
const data = await response.json();
if (!response.ok || !data.ok) {
  console.error("getWebhookInfo failed:", data.description || response.statusText);
  process.exit(1);
}
console.log(JSON.stringify(data.result, null, 2));
