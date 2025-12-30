const ALLOWED_USERS = [
  Number(process.env.ADMIN_ID)
];

export function isAllowed(chatId) {
  return ALLOWED_USERS.includes(chatId);
}
