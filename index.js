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
const port = process.env.PORT || 8080; // Fly обов’язково використовує PORT

app.get("/", (req, res) => {
  res.send("Bot is running!");
});

// Configure bot startup based on environment
if (bot) {
  if (process.env.NODE_ENV === "production" && process.env.WEBHOOK_DOMAIN) {
    const webhookPath = process.env.BOT_WEBHOOK_PATH || "bot-webhook";
    const webhookUrl = `${process.env.WEBHOOK_DOMAIN}/${webhookPath}`;

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
      .launch({ dropPendingUpdates: true })
      .then(() => console.log("✅ Bot started in polling mode"))
      .catch((err) => console.error("❌ Failed to start bot in polling mode:", err));
  }
}

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
