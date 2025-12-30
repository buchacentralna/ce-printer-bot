export function registerHandlers(bot) {
  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Бот працює ✅");
  });
}
