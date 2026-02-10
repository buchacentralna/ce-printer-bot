import "dotenv/config";
import * as Sentry from "@sentry/node";

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

import "./bot/bot.js"; // бот буде запускатися, коли є секрет

const app = express();
const port = process.env.PORT || 8080; // Fly обов’язково використовує PORT

app.get("/", (req, res) => {
  res.send("Bot is running!");
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
