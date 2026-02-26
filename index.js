import * as Sentry from "@sentry/node";

if (process.env.NODE_ENV === "development") {
  await import("dotenv/config");
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: !!process.env.SENTRY_DSN,
});

process.on("unhandledRejection", (reason) => {
  Sentry.captureException(reason);
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  Sentry.captureException(err);
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

import express from "express";
import { bot } from "./bot/bot.js";

const app = express();
console.log("process.env", process.env);
const port = process.env.PORT ?? 3000; // Fly обов’язково використовує PORT

app.get("/", (req, res) => {
  res.send("Bot is running!");
});

app.get("/status/mem", (req, res) => {
  res.json({ rss: (process.memoryUsage().rss / 1024 / 1024).toFixed(1) });
});

app.get("/status", (req, res) => {
  const startedAt = Date.now() - process.uptime() * 1000;
  const mode = process.env.NODE_ENV === "production" ? "Webhook" : "Polling";
  const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

  res.send(`<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Print Bot Status</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#1e293b;border-radius:16px;padding:40px;max-width:420px;width:90%;box-shadow:0 25px 50px rgba(0,0,0,.3)}
    .status{display:flex;align-items:center;gap:12px;margin-bottom:24px}
    .dot{width:14px;height:14px;border-radius:50%;background:#22c55e;box-shadow:0 0 12px #22c55e80;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
    h1{font-size:1.5rem;font-weight:600}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:20px}
    .metric{background:#0f172a;border-radius:10px;padding:16px}
    .metric .label{font-size:.75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}
    .metric .value{font-size:1.25rem;font-weight:600;margin-top:4px;color:#f8fafc}
    .footer{margin-top:24px;text-align:center;font-size:.8rem;color:#475569}
  </style>
</head>
<body>
  <div class="card">
    <div class="status">
      <div class="dot"></div>
      <h1>Print Bot Online</h1>
    </div>
    <div class="grid">
      <div class="metric"><div class="label">Uptime</div><div class="value" id="uptime"></div></div>
      <div class="metric"><div class="label">Mode</div><div class="value">${mode}</div></div>
      <div class="metric"><div class="label">Memory</div><div class="value" id="memory">${memMB} MB</div></div>
      <div class="metric"><div class="label">Node</div><div class="value">${process.version}</div></div>
    </div>
    <div class="footer">Буча Центральна • Church Printer Bot</div>
  </div>
  <script>
    const startedAt=${Math.floor(startedAt)};
    function tick(){const s=Math.floor((Date.now()-startedAt)/1000);const h=Math.floor(s/3600);const m=Math.floor(s%3600/60);const sec=s%60;document.getElementById("uptime").textContent=h+"h "+m+"m "+sec+"s"}
    tick();setInterval(tick,1000);
    async function updateMem(){try{const r=await fetch("/status/mem");const d=await r.json();document.getElementById("memory").textContent=d.rss+" MB"}catch(e){}}
    updateMem();setInterval(updateMem,5000);
  </script>
</body>
</html>`);
});

// Configure bot startup based on environment
if (bot) {
  if (process.env.NODE_ENV === "production" && process.env.FLY_APP_NAME) {
    const webhookPath = `webhook/${process.env.TELEGRAM_BOT_TOKEN}`;
    const webhookUrl = `https://${process.env.FLY_APP_NAME}.fly.dev/${webhookPath}`;

    console.log(`Setting up webhook: ${webhookUrl}`);
    app.use(bot.webhookCallback(`/${webhookPath}`));

    bot.telegram
      .setWebhook(webhookUrl)
      .then(() => console.log("✅ Webhook set successfully"))
      .catch((err) => console.error("❌ Failed to set webhook:", err));
  } else {
    // Development mode or missing webhook config -> use polling
    console.log("Starting bot in polling mode (Development)...");
    bot
      .launch()
      .then(() => console.log("✅ Bot started in polling mode"))
      .catch((err) =>
        console.error("❌ Failed to start bot in polling mode:", err),
      );
  }
}

app.listen(port, () => {
  const hostname = `${process.env.FLY_APP_NAME}.fly.dev`;
  // console.log(`Server running at http://${hostname}:${port}`);
  console.log(`Server is listening port ${port}`);
});
