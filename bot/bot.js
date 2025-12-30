import TelegramBot from "node-telegram-bot-api";
import { isAllowed } from "./auth.js";
import { registerHandlers } from "./handlers.js";

const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  throw new Error("BOT_TOKEN is missing");
}

export function initBot() {
  const bot = new TelegramBot(TOKEN, { polling: true });

  bot.on("message", (msg) => {
    if (!isAllowed(msg.chat.id)) {
      return bot.sendMessage(
        msg.chat.id,
        "Unauthorized access detected"
      );
    }
  });

  registerHandlers(bot);

  console.log("Telegram bot started");
}
