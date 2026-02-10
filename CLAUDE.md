# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Telegram bot for a church (Буча Центральна) that lets authorized users print documents via an Epson Email Printing service. Users send files through Telegram, the bot converts them to PDF, applies print settings (color, N-up, copies), and emails the final PDF to the printer.

The bot UI and all user-facing strings are in Ukrainian.

## Commands

```bash
# Run locally (requires .env with all secrets)
npm start            # or: node index.js

# Run ad-hoc tests (no test framework — just standalone scripts)
node test_env.js           # Test Telegram + Google Sheets connectivity
node gsheets/test.js       # Test gsheets module with missing credentials
node pdf/test_processor.js # Test PDF processing (image→PDF, N-up, page limit)

# Docker build (requires ghostscript, libreoffice, fonts in image)
docker build -t print-bot .
```

There is no test framework, linter, or build step. The project uses ES modules (`"type": "module"` in package.json).

## Architecture

**Entry point**: `index.js` — loads dotenv, starts an Express health-check server (PORT 8080 on Fly.io), and imports `bot/bot.js` which launches the Telegraf bot via long polling.

### Module responsibilities

- **`bot/bot.js`** — Creates Telegraf instance, attaches `telegraf-session-local` (persisted to `sessions.json`), registers handlers, handles graceful shutdown.
- **`bot/handlers.js`** — All bot interaction logic. Contains a multi-step print wizard (color → copies-per-page → pages-per-sheet → total copies → summary → print). Manages session state (`ctx.session`) for file handling, multi-image mode, and conflict resolution when users send new files mid-wizard.
- **`bot/auth.js`** — Simple hardcoded allow-list from `ADMIN_ID` env var (currently unused — actual auth goes through Google Sheets).
- **`gsheets/index.js`** — Google Sheets API integration. Handles user authorization (checks "Користувачі" sheet), print logging ("Логи" sheet), admin list ("Адміни" sheet), user stats, and quarterly reports. Auth via `service-account.json` file or `GOOGLE_SERVICE_ACCOUNT_JSON` env var.
- **`pdf/processor.js`** — Core PDF processing: image→PDF conversion (via sharp + pdf-lib), office doc→PDF (via libreoffice-convert), grayscale conversion (via Ghostscript), N-up layout (2-up/4-up), page duplication. Enforces 100-page limit.
- **`pdf/pdfUtils.js`** — Helper utilities: `convertToPDF`, `getPdfPageCount`, `generatePreview` (Ghostscript renders first page as JPEG, sharp compresses it).
- **`pdf/validate.js`** — Validates incoming files: converts to PDF, generates preview, counts pages.
- **`mail/sender.js`** — Applies all print options to PDF buffer, then sends via Nodemailer SMTP to the printer email address.
- **`mail/index.js`** — Re-exports from `sender.js`.
- **`stats/logger.js`** — Empty file (logging is handled in gsheets module).

### Key data flow

1. User sends file → `bot/handlers.js` downloads it, compresses images via sharp
2. File validated and converted to PDF → `pdf/validate.js` → `pdf/processor.js`
3. User configures print settings via inline keyboard wizard
4. On print: `mail/sender.js` calls `applyOptionsToPdf` (N-up, grayscale, copies) then emails the result
5. Print action logged to Google Sheets, admins notified via Telegram

### Session state

The bot uses `telegraf-session-local` persisted to `sessions.json`. Key session fields:
- `currentFile` — `{ path, name, pages, preview (base64), sourcePaths }`
- `printSettings` — `{ copies, color, duplex, pagesPerSheet, copiesPerPage, type }`
- `multiImageMode`, `multiImages` — for batching up to 20 images into one PDF
- `pendingFile` — holds a new file when there's a conflict with an in-progress wizard

## External Dependencies

- **Ghostscript (`gs`)** — Required at runtime for PDF preview generation and grayscale conversion
- **LibreOffice** — Required at runtime for DOC/DOCX/XLS/XLSX/PPT/PPTX conversion
- **sharp** — Image processing (compression, grayscale for images, format conversion)
- **pdf-lib** — PDF creation, page manipulation, N-up layout
- **Nodemailer** — SMTP email sending

## Environment Variables

See `.env.example`. Key vars: `TELEGRAM_BOT_TOKEN`, `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `SMTP_HOST/PORT/USER/PASS/FROM`, `PRINTER_EMAIL`, `ADMIN_ID`, `SENTRY_DSN`.

Google Sheets auth: either `service-account.json` file in project root or `GOOGLE_SERVICE_ACCOUNT_JSON` env var (JSON string).

## Deployment

Deployed on Fly.io (`fly.toml`). Node 24, Alpine-based Docker image with ghostscript, libreoffice, and fonts.
