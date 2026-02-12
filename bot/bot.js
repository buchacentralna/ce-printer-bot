import * as Sentry from "@sentry/node";
import { Markup, Telegraf } from "telegraf";
import LocalSession from "telegraf-session-local";

import { registerHandlers } from "./handlers.js";

if (process.env.NODE_ENV === "development") {
  await import("dotenv/config");
}

const token = process.env.TELEGRAM_BOT_TOKEN;

export const bot = token ? new Telegraf(token) : null;

if (!bot) {
  console.error(
    "CRITICAL: TELEGRAM_BOT_TOKEN is not set. Telegram bot will not start.",
  );
} else {
  console.log("Initializing Telegram bot...");

  const session = new LocalSession({ database: "sessions.json" });
  bot.use(session.middleware());

  console.log("Registering handlers...");
  registerHandlers(bot);

  // Глобальний обробник помилок, щоб бот не падав при помилках Telegram API
  bot.catch((err, ctx) => {
    console.error(
      `❌ Помилка в обробнику для оновлення ${ctx.updateType}:`,
      err,
    );
    if (
      err.description &&
      err.description.includes("message is not modified")
    ) {
      return; // Ігноруємо цю помилку, вона не критична
    }
    Sentry.captureException(err);
    // Можна додати сповіщення користувачу, якщо це доречно
    try {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Почати спочатку", "action_print_next")],
      ]);
      ctx.reply(
        "❌ Сталася помилка при обробці вашого запиту. Спробуйте ще раз або зверніться до адміністратора.",
        keyboard,
      );
    } catch (e) {
      console.error("Не вдалося надіслати повідомлення про помилку:", e);
    }
  });

  // No automatic launch here - it will be handled in index.js depending on environment

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
