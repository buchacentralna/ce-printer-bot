import path from "node:path";

import * as Sentry from "@sentry/node";
import { google } from "googleapis";

import { fileExistsAsync } from "../utils/fs.js";

if (process.env.NODE_ENV === "development") {
  await import("dotenv/config");
}

const GOOGLE_SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const SERVICE_ACCOUNT_PATH = path.resolve(
  process.cwd(),
  "service-account.json",
);

let auth;
if (await fileExistsAsync(SERVICE_ACCOUNT_PATH)) {
  auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
} else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
} else {
  console.warn(
    "Warning: Google Service Account credentials not found. Using local auth if available.",
  );
  auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

const sheets = google.sheets({ version: "v4", auth });

/**
 * Перевіряє, чи авторизований користувач (чи є його telegramId в аркуші "Користувачі").
 * @param {string|number} telegramId ID користувача
 * @returns {Promise<boolean>}
 */
export async function isUserAuthorized(telegramId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "Користувачі!B:C", // Припускаємо, що ID у першій колонці
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) return false;

    return rows.some(
      ([id, role]) =>
        id?.toString() === telegramId.toString() &&
        (role?.toString() === "Адмін" || role?.toString() === "Авторизований"),
    );
  } catch (error) {
    console.error("Error checking authorization:", error);
    Sentry.captureException(error);
    return false;
  }
}

/**
 * Отримує список ID адміністраторів з аркуша "Користувачі".
 * @returns {Promise<string[]>}
 */
export async function getAdminsList() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "Користувачі!B2:C",
    });

    const admins = response.data.values
      // Повертаємо тільки непорожні значення з роллю Адмін
      .filter(([id, role]) => role?.toString() === "Адмін" && id)
      .map(([id]) => id);

    return admins ?? [];
  } catch (error) {
    console.error("Error getting admin list:", error);
    Sentry.captureException(error);
    return [];
  }
}

/**
 * Записує лог про друк в аркуш "Логи".
 * @param {Object} data Дані про друк (chatId, fileName, pages, copies, printType, isColor)
 */
export async function logPrintAction(data) {
  const { chatId, fileName, pages, copies, printType, isColor } = data;
  const date = new Date().toISOString().split("T")[0];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "Логи!A1:F1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            date,
            chatId.toString(),
            fileName,
            pages,
            copies,
            printType,
            isColor,
          ],
        ],
      },
    });
  } catch (error) {
    console.error("Error logging print action:", error);
    Sentry.captureException(error);
  }
}

/**
 * Повертає статистику користувача за поточний місяць.
 * @param {string|number} chatId ID чату користувача
 * @returns {Promise<number>} Сумарна кількість сторінок
 */
export async function getUserStats(chatId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "Логи!A:D", // Дата, ID, Назва, Сторінки
    });

    const rows = response.data.values;
    if (!rows || rows.length <= 1) return 0; // Пусто або тільки заголовок

    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

    const totalPages = rows
      .slice(1) // Пропускаємо заголовок
      .filter((row) => {
        const rowDate = row[0]; // Припускаємо формат YYYY-MM-DD
        const rowChatId = row[1];
        return (
          rowChatId?.toString() === chatId.toString() &&
          rowDate?.startsWith(currentMonth)
        );
      })
      .reduce((sum, row) => sum + (parseInt(row[3]) || 0), 0);

    return totalPages;
  } catch (error) {
    console.error("Error getting user stats:", error);
    Sentry.captureException(error);
    return 0;
  }
}

/**
 * Генерує CSV звіт за останні 3 місяці.
 * @returns {Promise<string>} CSV дані
 */
export async function generateQuarterlyReport() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: "Логи!A:F",
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0)
      return "Дата,ID,Файл,Сторінки,Копії,Тип,Колір\n";

    const now = new Date();
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(now.getMonth() - 3); // TODO refactor (use actual quarter instead of last 3 monthes)

    const filteredRows = rows.slice(1).filter((row) => {
      const rowDate = new Date(row[0]);
      return rowDate >= threeMonthsAgo;
    });

    const csvContent = [
      rows[0].join(","), // Заголовок
      ...filteredRows.map((row) => row.join(",")),
    ].join("\n");

    return csvContent;
  } catch (error) {
    console.error("Error generating quarterly report:", error);
    Sentry.captureException(error);
    return "Error generating report";
  }
}
