import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SERVICE_ACCOUNT_PATH = path.resolve(process.cwd(), 'service-account.json');

let auth;
if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    auth = new google.auth.GoogleAuth({
        keyFile: SERVICE_ACCOUNT_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
} else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
} else {
    console.warn('Warning: Google Service Account credentials not found. Using local auth if available.');
    auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
}

const sheets = google.sheets({ version: 'v4', auth });

/**
 * Перевіряє, чи авторизований користувач (чи є його chatId в аркуші "Користувачі").
 * @param {string|number} chatId ID чату користувача
 * @returns {Promise<boolean>}
 */
export async function isUserAuthorized(chatId) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Користувачі!A:A', // Припускаємо, що ID у першій колонці
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) return false;

        return rows.some(row => row[0]?.toString() === chatId.toString());
    } catch (error) {
        console.error('Error checking authorization:', error);
        return false;
    }
}

// Alias for backward compatibility
export const checkAccess = isUserAuthorized;

/**
 * Отримує список ID адміністраторів з аркуша "Адміни".
 * @returns {Promise<string[]>}
 */
export async function getAdminList() {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Адміни!A:A',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) return [];

        // Повертаємо тільки непорожні значення, конвертовані в рядок
        return rows
            .map(row => row[0]?.toString())
            .filter(id => !!id);
    } catch (error) {
        console.error('Error getting admin list:', error);
        return [];
    }
}

/**
 * Записує лог про друк в аркуш "Логи".
 * @param {Object} data Дані про друк (chatId, fileName, pages, copies, printType)
 */
export async function logPrintAction(data) {
    const { chatId, fileName, pages, copies, printType } = data;
    const date = new Date().toISOString().split('T')[0];

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Логи!A:F',
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [[date, chatId.toString(), fileName, pages, copies, printType]],
            },
        });
    } catch (error) {
        console.error('Error logging print action:', error);
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
            spreadsheetId: SPREADSHEET_ID,
            range: 'Логи!A:D', // Дата, ID, Назва, Сторінки
        });

        const rows = response.data.values;
        if (!rows || rows.length <= 1) return 0; // Пусто або тільки заголовок

        const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

        const totalPages = rows
            .slice(1) // Пропускаємо заголовок
            .filter(row => {
                const rowDate = row[0]; // Припускаємо формат YYYY-MM-DD
                const rowChatId = row[1];
                return rowChatId?.toString() === chatId.toString() && rowDate?.startsWith(currentMonth);
            })
            .reduce((sum, row) => sum + (parseInt(row[3]) || 0), 0);

        return totalPages;
    } catch (error) {
        console.error('Error getting user stats:', error);
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
            spreadsheetId: SPREADSHEET_ID,
            range: 'Логи!A:F',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) return 'Дата,ID,Файл,Сторінки,Копії,Тип\n';

        const now = new Date();
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(now.getMonth() - 3);

        const filteredRows = rows.slice(1).filter(row => {
            const rowDate = new Date(row[0]);
            return rowDate >= threeMonthsAgo;
        });

        const csvContent = [
            rows[0].join(','), // Заголовок
            ...filteredRows.map(row => row.join(','))
        ].join('\n');

        return csvContent;
    } catch (error) {
        console.error('Error generating quarterly report:', error);
        return 'Error generating report';
    }
}
