import { Telegraf, Markup } from "telegraf";
import LocalSession from "telegraf-session-local";

import { registerHandlers } from "./handlers.js";

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error(
    "CRITICAL: TELEGRAM_BOT_TOKEN is not set. Telegram bot will not start.",
  );
} else {
  console.log("Initializing Telegram bot...");
  const bot = new Telegraf(token);

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

  bot
    .launch({ dropPendingUpdates: true })
    .then(() => console.log("✅ Telegram bot (Telegraf) started successfully."))
    .catch((err) => {
      console.error("❌ Failed to start Telegram bot:", err);
      process.exit(1);
    });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
