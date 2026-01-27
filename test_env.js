import 'dotenv/config';
import { google } from 'googleapis';
import { Telegraf } from 'telegraf';
import fs from 'fs';
import path from 'path';

async function testConnections() {
    console.log('--- Connection Test ---');

    // 1. Test Telegram Bot
    try {
        const bot = new Telegraf(process.env.BOT_TOKEN);
        const me = await bot.telegram.getMe();
        console.log(`✅ Telegram Bot: @${me.username} (ID: ${me.id})`);
    } catch (error) {
        console.error('❌ Telegram Bot failed:', error.message);
    }

    // 2. Test Google Sheets
    try {
        const SERVICE_ACCOUNT_PATH = path.resolve(process.cwd(), 'service-account.json');
        const auth = new google.auth.GoogleAuth({
            keyFile: SERVICE_ACCOUNT_PATH,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
        });
        console.log(`✅ Google Sheets: "${response.data.properties.title}"`);
    } catch (error) {
        console.error('❌ Google Sheets failed:', error.message);
    }

    console.log('--- Test Completed ---');
}

testConnections();
