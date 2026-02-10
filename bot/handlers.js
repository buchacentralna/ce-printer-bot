import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { Markup } from "telegraf";

import {
  getUserStats,
  isUserAuthorized,
  logPrintAction,
  getAdminsList,
} from "../gsheets/index.js";
import { sendEmail, applyOptionsToPdf } from "../mail/index.js";
import { validateFile } from "../pdf/validate.js";
import { mergeImagesToPdf } from "../pdf/processor.js";
import { generatePreview } from "../pdf/pdfUtils.js";
import { fileExistsAsync } from "../utils/fs.js";

function getTempPath(fileName) {
  const safeName = fileName.replace(/[^a-z0-9.]/gi, "_");
  return path.join(os.tmpdir(), `printbot_${Date.now()}_${safeName}`);
}

async function compressImage(buffer) {
  try {
    return await sharp(buffer)
      .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (e) {
    console.error("Compression error:", e);
    return buffer; // Fallback to original if compression fails
  }
}

async function cleanupFiles(files) {
  if (!files) return;

  const list = Array.isArray(files) ? files : [files];
  for (const f of list) {
    try {
      const p = typeof f === "string" ? f : f.path || f.filePath;
      if (p && (await fileExistsAsync(p))) {
        await fs.unlink(p);
      }
    } catch (e) {
      console.error("Cleanup error:", e);
    }
  }
}

/**
 * Очищає поточну сесію друку та файли
 */
async function resetPrintSession(ctx) {
  if (ctx.session.currentFile) {
    if (ctx.session.currentFile.sourcePaths) {
      await cleanupFiles(ctx.session.currentFile.sourcePaths);
    }
    await cleanupFiles(ctx.session.currentFile.path);
  }
  if (ctx.session.multiImages) {
    await cleanupFiles(ctx.session.multiImages.map((img) => img.path));
  }
  if (ctx.session.pendingFile) {
    await cleanupFiles(ctx.session.pendingFile.path);
  }

  ctx.session.currentFile = null;
  ctx.session.multiImageMode = false;
  ctx.session.multiImages = [];
  ctx.session.lastMultiMsgId = null;
  ctx.session.lastWizardMsgId = null;
  ctx.session.pendingFile = null;
}

async function editWizardStep(ctx, text, keyboard, mediaBuffer = null) {
  const chatId = ctx.chat.id;
  const messageId =
    ctx.callbackQuery?.message?.message_id || ctx.session.lastWizardMsgId;

  if (!messageId) {
    if (mediaBuffer) {
      const res = await ctx.replyWithPhoto(
        { source: mediaBuffer },
        { caption: text, ...keyboard },
      );
      ctx.session.lastWizardMsgId = res.message_id;
    } else {
      const res = await ctx.reply(text, keyboard);
      ctx.session.lastWizardMsgId = res.message_id;
    }
    return;
  }

  const msg = ctx.callbackQuery?.message;
  // Якщо немає msg (виклик не з callback), припускаємо isMedia = true, якщо є mediaBuffer
  const isMedia = msg
    ? !!(msg.photo || msg.document)
    : !!mediaBuffer || !!ctx.session.currentFile?.preview;

  try {
    if (mediaBuffer && isMedia) {
      await ctx.telegram.editMessageMedia(
        chatId,
        messageId,
        null,
        {
          type: "photo",
          media: { source: mediaBuffer },
          caption: text,
          parse_mode: "Markdown",
        },
        { reply_markup: keyboard.reply_markup },
      );
    } else if (isMedia) {
      await ctx.telegram.editMessageCaption(chatId, messageId, null, text, {
        parse_mode: "Markdown",
        reply_markup: keyboard.reply_markup,
      });
    } else {
      await ctx.telegram.editMessageText(chatId, messageId, null, text, {
        parse_mode: "Markdown",
        reply_markup: keyboard.reply_markup,
      });
    }
  } catch (e) {
    if (!e.description?.includes("message is not modified")) {
      console.error("Wizard edit error:", e);
      try {
        if (mediaBuffer) {
          const res = await ctx.replyWithPhoto(
            { source: mediaBuffer },
            { caption: text, ...keyboard },
          );
          ctx.session.lastWizardMsgId = res.message_id;
        } else {
          const res = await ctx.reply(text, keyboard);
          ctx.session.lastWizardMsgId = res.message_id;
        }
      } catch (err) {
        console.error("Wizard fallback error:", err);
      }
    }
  }
}

/**
 * Допоміжна функція для генерації прев'ю на основі поточних налаштувань.
 */
async function getLivePreview(ctx) {
  const f = ctx.session.currentFile;
  const s = ctx.session.printSettings;
  if (!f || !f.path) return null;

  try {
    const pdfBuffer = await fs.readFile(f.path);
    // Застосовуємо тільки ті параметри, що впливають на візуальний вигляд однієї сторінки
    const processedBuffer = await applyOptionsToPdf(pdfBuffer, {
      ...s,
      sourcePaths: f.sourcePaths,
      fileName: f.name,
    });
    return await generatePreview(processedBuffer);
  } catch (err) {
    console.error("Live preview error:", err);
    return Buffer.from(f.preview, "base64");
  }
}

async function showWizardStep1(ctx) {
  ctx.session.currentWizardStep = "color";
  if (!ctx.session.printSettings) {
    ctx.session.printSettings = {
      copies: 1,
      color: true,
      duplex: "Ні",
      pagesPerSheet: 1,
      copiesPerPage: 1,
      type: "Служіння",
    };
  }
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⚪ Чорно-білий", "wizard_color_bw")],
    [Markup.button.callback("🔵 Кольоровий", "wizard_color_color")],
    [Markup.button.callback("❌ Скасувати друк", "action_cancel_print")],
  ]);
  const preview = await getLivePreview(ctx);
  await editWizardStep(ctx, "Крок 1/4: Оберіть колір:", keyboard, preview);
}

async function showWizardStepCPP(ctx) {
  ctx.session.currentWizardStep = "cpp";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("1 копія", "wizard_cpp_1")],
    [Markup.button.callback("2 копії", "wizard_cpp_2")],
    [Markup.button.callback("4 копії", "wizard_cpp_4")],
    [Markup.button.callback("⬅️ Назад", "wizard_start")],
  ]);
  const preview = await getLivePreview(ctx);
  await editWizardStep(
    ctx,
    "Крок 2/4: Копій кожної сторінки на аркуші:",
    keyboard,
    preview,
  );
}

async function showWizardStepPPS(ctx) {
  ctx.session.currentWizardStep = "pps";
  const cpp = ctx.session.printSettings.copiesPerPage;
  const options = [
    { id: 1, label: "1 сторінка" },
    { id: 2, label: "2 сторінки" },
    { id: 4, label: "4 сторінки" },
  ];

  const filteredOptions = options.filter((opt) => opt.id >= cpp);
  const buttons = filteredOptions.map((opt) => [
    Markup.button.callback(opt.label, `wizard_pps_${opt.id}`),
  ]);
  buttons.push([Markup.button.callback("⬅️ Назад", "wizard_back_to_cpp")]);

  const keyboard = Markup.inlineKeyboard(buttons);
  const preview = await getLivePreview(ctx);
  await editWizardStep(
    ctx,
    "Крок 3/4: Сторінок на аркуші (унікальних):",
    keyboard,
    preview,
  );
}

async function showWizardStepCopies(ctx) {
  ctx.session.currentWizardStep = "copies";
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("1", "wizard_copies_1"),
      Markup.button.callback("2", "wizard_copies_2"),
    ],
    [
      Markup.button.callback("5", "wizard_copies_5"),
      Markup.button.callback("10", "wizard_copies_10"),
    ],
    [Markup.button.callback("🔢 Інше", "wizard_copies_other")],
    [Markup.button.callback("⬅️ Назад", "wizard_back_to_layout")],
  ]);
  const preview = await getLivePreview(ctx);
  await editWizardStep(
    ctx,
    "Крок 4/4: Загальна кількість тиражу (копій):",
    keyboard,
    preview,
  );
}

async function renderCurrentWizardStep(ctx) {
  const step = ctx.session.currentWizardStep || "color";
  switch (step) {
    case "color":
      return showWizardStep1(ctx);
    case "cpp":
      return showWizardStepCPP(ctx);
    case "pps":
      return showWizardStepPPS(ctx);
    case "copies":
      return showWizardStepCopies(ctx);
    case "summary":
      return showFinalSummary(ctx);
    default:
      return showWizardStep1(ctx);
  }
}

export function registerHandlers(bot) {
  // --- MIDDLEWARE ТА ТАЙМАУТ ---
  bot.use(async (ctx, next) => {
    if (ctx.session) {
      const now = Date.now();
      const hour = 3600000;

      if (
        ctx.session.lastActivity &&
        now - ctx.session.lastActivity > hour &&
        ctx.session.currentFile
      ) {
        resetPrintSession(ctx);
        await ctx.reply(
          "Вибачте, час очікування сплив 😔",
          Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "🔄 Почати заново",
                "type_selection_restart",
              ),
            ],
          ]),
        );
        // Не повертаємо return, дозволяємо обробити поточну команду, якщо це /start
      }
      ctx.session.lastActivity = now;
    }
    return next();
  });

  // --- КОМАНДА /START ---
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    const isAllowed = await isUserAuthorized(chatId);

    if (!isAllowed) {
      return ctx.reply(
        "На жаль, у вас немає доступу до цього бота. Зверніться до адміністратора.",
      );
    }

    resetPrintSession(ctx);
    // Видаляємо стару клавіатуру, якщо вона була
    await ctx.reply("Вітаю у боті друку!", Markup.removeKeyboard());

    await showStartMenu(ctx);
  });

  async function showStartMenu(ctx) {
    await ctx.reply(
      "Привіт! Я бот для друку. Оберіть тип друку:",
      Markup.inlineKeyboard([
        [Markup.button.callback("💼 Служіння", "type_service")],
        [Markup.button.callback("🏠 Особисте", "type_personal")],
      ]),
    );
  }

  // --- ВИБІР ТИПУ ---
  bot.action(["type_service", "type_personal"], async (ctx) => {
    const type = ctx.match[0] === "type_service" ? "Служіння" : "Особисте";
    if (!ctx.session.printSettings) {
      ctx.session.printSettings = {
        copies: 1,
        color: true,
        duplex: "Ні",
        pagesPerSheet: 1,
        copiesPerPage: 1,
        type: null,
      };
    }
    ctx.session.printSettings.type = type;
    await ctx.editMessageText(
      `Ви обрали: ${type}. Тепер надішліть файл або до 20 зображень для друку.`,
    );
  });

  bot.hears(["Служіння", "Особисте"], async (ctx) => {
    if (!ctx.session.printSettings) {
      ctx.session.printSettings = {
        copies: 1,
        color: true,
        duplex: "Ні",
        pagesPerSheet: 1,
        copiesPerPage: 1,
        type: null,
      };
    }
    ctx.session.printSettings.type = ctx.message.text;
    await ctx.reply(
      `Ви обрали: ${ctx.message.text}. Тепер надішліть файл (фото або документ) для друку або оберіть декілька зображень.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🖼️ Друкувати багато картинок",
            "multi_image_start",
          ),
        ],
      ]),
    );
  });

  // --- ОБРОБКА ФАЙЛІВ ---
  bot.on(["photo", "document", "sticker"], async (ctx) => {
    if (!ctx.session.printSettings || !ctx.session.printSettings.type) {
      return ctx.reply("Будь ласка, спочатку оберіть тип друку (/start).");
    }

    let progressMsgId = null;
    let statusMsg = null; // Оголошуємо статус за межами блоку для доступу нижче

    if (!ctx.session.multiImageMode && !ctx.session.currentFile) {
      statusMsg = await ctx.reply("⏳ Обробляю ваш файл, зачекайте...");
      progressMsgId = statusMsg.message_id;
    } else if (ctx.session.multiImageMode) {
      const count = (ctx.session.multiImages?.length || 0) + 1;
      const statusText = `⏳ Обробляю файл ${count}/20, зачекайте...`;
      try {
        if (ctx.session.lastMultiMsgId) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            ctx.session.lastMultiMsgId,
            null,
            statusText,
          );
          progressMsgId = ctx.session.lastMultiMsgId;
        } else {
          statusMsg = await ctx.reply(statusText);
          ctx.session.lastMultiMsgId = statusMsg.message_id;
          progressMsgId = statusMsg.message_id;
        }
      } catch (e) {
        statusMsg = await ctx.reply(statusText);
        ctx.session.lastMultiMsgId = statusMsg.message_id;
        progressMsgId = statusMsg.message_id;
      }
    }

    try {
      let fileId;
      let fileName = "file";

      if (ctx.message.document) {
        fileId = ctx.message.document.file_id;
        fileName = ctx.message.document.file_name;
      } else if (ctx.message.photo) {
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        fileName = `photo_${Date.now()}.jpg`;
      } else if (ctx.message.sticker) {
        fileId = ctx.message.sticker.file_id;
        fileName = `sticker_${Date.now()}.webp`;
      }

      if (!fileId) return;

      const fileLink = await ctx.telegram.getFileLink(fileId);
      let buffer = await downloadFile(fileLink.href);

      // Примусове стиснення для зображень
      const isPhoto =
        !!ctx.message.photo ||
        !!ctx.message.sticker ||
        (ctx.message.document &&
          ctx.message.document.mime_type?.startsWith("image/")) ||
        fileName.toLowerCase().match(/\.(jpg|jpeg|png|webp|heic|heif)$/);
      if (isPhoto) {
        try {
          buffer = await compressImage(buffer);
        } catch (err) {
          console.warn(
            "Compression failed, using original buffer:",
            err.message,
          );
        }
      }

      const filePath = getTempPath(fileName);
      await fs.writeFile(filePath, buffer);

      // --- КОНФЛІКТИ ТА ДОДАВАННЯ ---

      // 1. Якщо ми вже в майстрі (є currentFile), але надсилаємо новий файл
      if (ctx.session.currentFile && !ctx.session.multiImageMode) {
        const hasPrevImages = !!ctx.session.currentFile.sourcePaths;

        // Випадок А: Надсилаємо картинку до картинки (додаємо до PDF)
        if (isPhoto && hasPrevImages) {
          if (ctx.session.currentFile.sourcePaths.length >= 20) {
            cleanupFiles(filePath);
            return ctx.reply("⚠️ Максимальна кількість зображень — 20.");
          }

          await ctx.reply("🖼️ Додаю зображення до поточного завдання...");
          ctx.session.currentFile.sourcePaths.push(filePath);

          // Перезібрати PDF
          const imageBuffers = await Promise.all(
            ctx.session.currentFile.sourcePaths.map(
              async (p) => await fs.readFile(p),
            ),
          );
          const mergeResult = await mergeImagesToPdf(imageBuffers, false);

          // Оновити файл
          const oldPath = ctx.session.currentFile.path;
          const newPath = getTempPath(ctx.session.currentFile.name);
          await fs.writeFile(newPath, mergeResult.pdf);
          cleanupFiles(oldPath);

          const previewBuffer = await generatePreview(mergeResult.pdf);

          ctx.session.currentFile.path = newPath;
          ctx.session.currentFile.pages = mergeResult.pages;
          ctx.session.currentFile.preview = previewBuffer.toString("base64");

          // Видаляємо старе повідомлення майстра і залишаємось на поточному кроці
          if (ctx.session.lastWizardMsgId) {
            await ctx.telegram
              .deleteMessage(ctx.chat.id, ctx.session.lastWizardMsgId)
              .catch(() => {});
            ctx.session.lastWizardMsgId = null;
          }

          await renderCurrentWizardStep(ctx);
          return;
        }

        // Випадок Б: Конфлікт (надсилаємо документ під час налаштування іншого)
        ctx.session.pendingFile = { buffer, fileName, isPhoto, path: filePath };
        return ctx.reply(
          `⚠️ Ви ще не завершили з попереднім файлом "${ctx.session.currentFile.name}". Що зробити?`,
          Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "✅ Продовжити зі старим",
                "conflict_keep_old",
              ),
            ],
            [
              Markup.button.callback(
                "🆕 Розпочати з новим",
                "conflict_start_new",
              ),
            ],
          ]),
        );
      }

      // Якщо це зображення - автоматично вмикаємо/продовжуємо режим багатьох картинок
      if (isPhoto) {
        ctx.session.multiImageMode = true;
        if (!ctx.session.multiImages) ctx.session.multiImages = [];

        if (ctx.session.multiImages.length >= 20) {
          cleanupFiles(filePath);
          return ctx.reply("⚠️ Максимальна кількість зображень — 20.");
        }

        ctx.session.multiImages.push({
          path: filePath,
          name: fileName,
        });

        const count = ctx.session.multiImages.length;
        const doneText = `✅ Додано зображення ${count}/20. Можете надсилати ще або натисніть "Це все".`;
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            ctx.session.lastMultiMsgId,
            null,
            doneText,
            Markup.inlineKeyboard([
              [Markup.button.callback("✅ Це все", "multi_image_done")],
            ]),
          );
        } catch (e) {
          const statusMsg = await ctx.reply(
            doneText,
            Markup.inlineKeyboard([
              [Markup.button.callback("✅ Це все", "multi_image_done")],
            ]),
          );
          ctx.session.lastMultiMsgId = statusMsg.message_id;
        }
        return;
      }

      // Якщо це НЕ зображення, але режим був увімкнений - скидаємо його
      ctx.session.multiImageMode = false;
      ctx.session.multiImages = [];
      ctx.session.lastMultiMsgId = null;

      // Валідація та підготовка (конвертація в A4, підрахунок сторінок)
      const result = await validateFile(buffer, fileName);

      // Зберігаємо тільки шлях до файлу в сесії
      ctx.session.currentFile = {
        path: filePath,
        name: fileName,
        pages: result.basicParams.pages,
        preview: result.preview.toString("base64"),
        sourcePaths: isPhoto ? [filePath] : null, // Зберігаємо оригінал для фото
      };

      ctx.session.printSettings = {
        ...ctx.session.printSettings,
        copies: 1,
        color: true,
        duplex: "Ні",
        pagesPerSheet: 1,
        copiesPerPage: 1,
      };

      const pages = result.basicParams.pages;
      const text = `📄 Файл: ${fileName}\n📏 Сторінок: ${pages}\n\nОберіть наступну дію:`;

      const buttons = [];
      if (pages <= 20) {
        buttons.push([
          Markup.button.callback(
            "🚀 Просто надрукуй це",
            "action_print_direct",
          ),
        ]);
      }
      buttons.push([
        Markup.button.callback("⚙️ Налаштувати друк", "wizard_start"),
      ]);
      buttons.push([
        Markup.button.callback("❌ Скасувати друк", "action_cancel_print"),
      ]);

      if (statusMsg) {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
        } catch (e) {}
      }

      let finalMsg;
      if (result.preview) {
        finalMsg = await ctx.replyWithPhoto(
          { source: result.preview },
          { caption: text, ...Markup.inlineKeyboard(buttons) },
        );
      } else {
        finalMsg = await ctx.reply(text, Markup.inlineKeyboard(buttons));
      }
      ctx.session.lastWizardMsgId = finalMsg.message_id;
    } catch (error) {
      console.error("Error processing file:", error);
      const supportedFormats =
        "✅ **Зображення**: JPG, PNG, WEBP, TIFF, HEIC/HEIF\n" +
        "✅ **Документи**: PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, TXT, RTF";

      const errorMsg =
        `❌ Помилка обробки: ${error.message}\n\n` +
        `Переконайтеся, що ви надсилаєте підтримуваний формат:\n${supportedFormats}`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Почати спочатку", "action_print_next")],
      ]);

      if (statusMsg) {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            null,
            errorMsg,
            { parse_mode: "Markdown", ...keyboard },
          );
        } catch (e) {
          await ctx.reply(errorMsg, { parse_mode: "Markdown", ...keyboard });
        }
      } else {
        await ctx.reply(errorMsg, { parse_mode: "Markdown", ...keyboard });
      }
    }
  });

  // --- WIZARD: STEP 1 - COLOR ---
  bot.action("wizard_start", async (ctx) => {
    await showWizardStep1(ctx);
  });

  bot.action(/wizard_color_(.+)/, async (ctx) => {
    if (!ctx.session.printSettings)
      return ctx.reply("Помилка сесії. Почніть спочатку: /start");
    ctx.session.printSettings.color = ctx.match[1] !== "bw";
    await showWizardStepCPP(ctx);
  });

  // --- WIZARD: STEP 2 - CPP ---
  bot.action(/wizard_cpp_(\d)/, async (ctx) => {
    if (!ctx.session.printSettings)
      return ctx.reply("Помилка сесії. Почніть спочатку: /start");
    const cpp = parseInt(ctx.match[1]);
    ctx.session.printSettings.copiesPerPage = cpp;

    // Автоматично корегуємо PPS, якщо він став меншим за CPP
    if (ctx.session.printSettings.pagesPerSheet < cpp) {
      ctx.session.printSettings.pagesPerSheet = cpp;
    }

    await showWizardStepPPS(ctx);
  });

  bot.action("wizard_back_to_cpp", async (ctx) => {
    await showWizardStepCPP(ctx);
  });

  bot.action("wizard_back_to_color", async (ctx) => {
    await showWizardStep1(ctx);
  });

  // --- WIZARD: STEP 3 - PPS ---
  bot.action(/wizard_pps_(\d)/, async (ctx) => {
    if (!ctx.session.printSettings)
      return ctx.reply("Помилка сесії. Почніть спочатку: /start");
    const pps = parseInt(ctx.match[1]);
    const cpp = ctx.session.printSettings.copiesPerPage;

    if (pps < cpp) {
      return ctx.answerCbQuery(
        `Помилка: Неможливо розмістити ${cpp} копій на ${pps} комірках!`,
        { show_alert: true },
      );
    }

    ctx.session.printSettings.pagesPerSheet = pps;
    await showWizardStepCopies(ctx);
  });

  bot.action("wizard_back_to_layout", async (ctx) => {
    await showWizardStepPPS(ctx);
  });

  // --- WIZARD: STEP 4 - COPIES ---
  bot.action(/wizard_copies_(\d+)/, async (ctx) => {
    if (!ctx.session.printSettings)
      return ctx.reply("Помилка сесії. Почніть спочатку: /start");
    ctx.session.printSettings.copies = parseInt(ctx.match[1]);
    await showFinalSummary(ctx);
  });

  bot.action("wizard_copies_other", async (ctx) => {
    ctx.session.awaitingCopies = true;
    await ctx.editMessageText("Введіть кількість копій (1-50):");
  });

  bot.on("text", async (ctx, next) => {
    if (ctx.session.awaitingCopies) {
      const copies = parseInt(ctx.message.text);
      if (isNaN(copies) || copies <= 0 || copies > 50) {
        return ctx.reply("Будь ласка, введіть число від 1 до 50.");
      }
      if (!ctx.session.printSettings)
        return ctx.reply("Помилка сесії. Почніть спочатку: /start");
      ctx.session.printSettings.copies = copies;
      ctx.session.awaitingCopies = false;
      await showFinalSummary(ctx);
      return;
    }
    return next();
  });

  bot.action("wizard_back_to_copies", async (ctx) => {
    await showWizardStepCopies(ctx);
  });

  async function generateAndSendCheckPdf(ctx) {
    const statusMsg = await ctx.reply("⏳ Формую файл для перевірки...");

    try {
      const f = ctx.session.currentFile;
      const s = ctx.session.printSettings;

      const filePath = f.path;
      if (!(await fileExistsAsync(filePath))) {
        throw new Error("Файл не знайдено на сервері.");
      }

      const pdfBuffer = await fs.readFile(filePath);
      const processedBuffer = await applyOptionsToPdf(pdfBuffer, {
        ...s,
        sourcePaths: f.sourcePaths,
        fileName: f.name,
      });

      const summary =
        `🏁 **Перевірка налаштувань**\n\n` +
        `📂 Тип: ${s.type}\n` +
        `🎨 Колір: ${s.color ? 'Так' : 'Ні'}\n` +
        `👯‍♂️ Копій кожної сторінки: ${s.copiesPerPage}\n` +
        `📏 Сторінок на аркуші: ${s.pagesPerSheet}\n` +
        `👥 Загальний тираж: ${s.copies}\n` +
        `🔄 Двосторонній: ${s.duplex}\n\n` +
        `Я надіслав вам файл, який буде роздруковано. Перевірте його!`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🚀 ВСЕ ВІРНО, ДРУКУЙ", "action_print")],
        [Markup.button.callback("⬅️ Назад", "wizard_back_to_duplex")],
        [Markup.button.callback("⚙️ Почати спочатку", "wizard_start")],
      ]);

      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

      await ctx.replyWithDocument(
        { source: processedBuffer, filename: `check_${f.name}.pdf` },
        { caption: summary, parse_mode: "Markdown", ...keyboard },
      );
    } catch (error) {
      console.error("Error generating check PDF:", error);
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Спробувати ще раз", "action_print_next")],
      ]);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `❌ Помилка при генерації прев'ю: ${error.message}`,
        keyboard,
      );
      // await showFinalSummary(ctx); // Removed fallback to avoid confusion
    }
  }

  bot.action("wizard_back_to_duplex", async (ctx) => {
    await showWizardStepCopies(ctx);
  });

  async function showFinalSummary(ctx) {
    ctx.session.currentWizardStep = "summary";
    const s = ctx.session.printSettings;
    const f = ctx.session.currentFile;

    const summary =
      `✅ Налаштування завершено!\n\n` +
      `📄 Файл: ${f.name}\n` +
      `👥 Тип: ${s.type}\n` +
      `🎨 Колір: ${s.color ? 'Так' : 'Ні'}\n` +
      `👯‍♂️ Копій на сторінку: ${s.copiesPerPage}\n` +
      `📏 На аркуші: ${s.pagesPerSheet}\n` +
      `🔢 Копій: ${s.copies}\n` +
      `🔄 Двосторонній: ${s.duplex}\n\n` +
      `Бажаєте відправити на друк?`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("✅ Все вірно, друкуй", "action_print")],
      [Markup.button.callback("⚙️ Почати спочатку", "wizard_start")],
      [Markup.button.callback("❌ Скасувати друк", "action_cancel_print")],
    ]);

    const isMockPreview =
      f.preview === Buffer.from("mock-preview-data").toString("base64") ||
      f.preview === Buffer.from("error-preview").toString("base64");

    if (f.preview && !isMockPreview) {
      const previewBuffer = Buffer.from(f.preview, "base64");
      if (ctx.callbackQuery) {
        await editWizardStep(ctx, summary, keyboard, previewBuffer);
      } else {
        const res = await ctx.replyWithPhoto(
          { source: previewBuffer },
          { caption: summary, ...keyboard },
        );
        ctx.session.lastWizardMsgId = res.message_id;
      }
    } else {
      if (ctx.callbackQuery) {
        await editWizardStep(ctx, summary, keyboard);
      } else {
        const res = await ctx.reply(summary, keyboard);
        ctx.session.lastWizardMsgId = res.message_id;
      }
    }
  }

  // --- ДІЯ "ПРЯМИЙ ДРУК" ---
  bot.action("action_print_direct", async (ctx) => {
    ctx.session.printSettings = {
      ...ctx.session.printSettings,
      copies: 1,
      color: true,
      duplex: "Ні",
      pagesPerSheet: 1,
    };
    return handlePrint(ctx);
  });

  // --- ДІЯ "ДРУК" (Фінальна) ---
  bot.action("action_print", async (ctx) => {
    return handlePrint(ctx);
  });

  async function handlePrint(ctx) {
    if (!ctx.session.currentFile) {
      return ctx.answerCbQuery("Файл не знайдено.", { show_alert: true });
    }

    await ctx.answerCbQuery("Відправляю на друк...");

    const feedbackText = "⏳ Відправка на принтер... Будь ласка, зачекайте.";
    const msg = ctx.callbackQuery.message;
    const isMedia = msg.photo || msg.document || msg.video;

    if (isMedia) {
      await ctx.editMessageCaption(feedbackText, { reply_markup: null });
    } else {
      await ctx.editMessageText(feedbackText, { reply_markup: null });
    }

    const totalPages = await getUserStats(ctx.chat.id);
    try {
      const filePath = ctx.session.currentFile.path;
      if (!(await fileExistsAsync(filePath))) {
        throw new Error("Файл не знайдено на сервері. Надішліть його ще раз.");
      }
      const pdfBuffer = await fs.readFile(filePath);
      const settings = ctx.session.printSettings;

      const result = await sendEmail(pdfBuffer, ctx.session.currentFile.name, {
        ...settings,
        sourcePaths: ctx.session.currentFile.sourcePaths,
        fileName: ctx.session.currentFile.name,
      });

      if (result.success) {
        await logPrintAction({
          chatId: ctx.chat.id,
          fileName: ctx.session.currentFile.name,
          pages: ctx.session.currentFile.pages,
          copies: settings.copies,
          printType: settings.type,
          isColor: settings.color,
        });

        const feedback =
          `✅ Завдання відправлено на друк!\n\n` +
          `Статистика за місяць: ${totalPages} стор.`;

        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "➕ Надрукувати наступне",
              "action_print_next",
            ),
          ],
        ]);

        try {
          if (isMedia) {
            await ctx.editMessageCaption(feedback, keyboard);
          } else {
            await ctx.editMessageText(feedback, keyboard);
          }
        } catch (e) {
          if (!e.description?.includes("message is not modified")) {
            await ctx.reply(feedback, keyboard);
          }
        }

        // --- СПОВІЩЕННЯ АДМІНІСТРАТОРІВ ---
        try {
          const admins = await getAdminsList();
          if (admins.length > 0) {
            const adminMsg =
              `🔔 Звіт про друк:\n` +
              `📄 Сторінок: ${ctx.session.currentFile.pages}\n` +
              `👥 Копій: ${settings.copies}\n` +
              `📂 Тип: ${settings.type}\n` +
              `🎨 Колір: ${settings.color ? 'Так' : 'Ні'}`;

            for (const adminId of admins) {
              try {
                await ctx.telegram.sendMessage(adminId, adminMsg);
              } catch (err) {
                console.error(
                  `Failed to notify admin ${adminId}:`,
                  err.message,
                );
              }
            }
          }
        } catch (adminErr) {
          console.error("Error in admin notification flow:", adminErr);
        }
      } else {
        const errMsg = `❌ Помилка: ${result.error || "невідома помилка"}`;
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Почати спочатку", "action_print_next")],
        ]);
        if (isMedia) {
          await ctx.editMessageCaption(errMsg, keyboard);
        } else {
          await ctx.editMessageText(errMsg, keyboard);
        }
      }

      resetPrintSession(ctx);
    } catch (error) {
      console.error("Print action error:", error);
      const errMsg = `❌ Критична помилка: ${error.message}`;
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Почати спочатку", "action_print_next")],
      ]);
      if (isMedia) {
        await ctx.editMessageCaption(errMsg, keyboard);
      } else {
        await ctx.editMessageText(errMsg, keyboard);
      }
    }
  }

  bot.action("action_print_next", async (ctx) => {
    resetPrintSession(ctx);
    await showStartMenu(ctx);
  });

  // --- КОНФЛІКТИ ТА СКАСУВАННЯ ---

  bot.action("action_cancel_print", async (ctx) => {
    resetPrintSession(ctx);
    await ctx.answerCbQuery("Друк скасовано");
    await ctx.editMessageText(
      "❌ Друк скасовано. Надішліть новий файл для початку.",
      Markup.inlineKeyboard([
        [Markup.button.callback("🏠 Головне меню", "type_selection_restart")],
      ]),
    );
  });

  bot.action("type_selection_restart", async (ctx) => {
    resetPrintSession(ctx);
    await showStartMenu(ctx);
  });

  bot.action("conflict_keep_old", async (ctx) => {
    if (ctx.session.pendingFile) {
      cleanupFiles(ctx.session.pendingFile.path);
      ctx.session.pendingFile = null;
    }
    await ctx.answerCbQuery("Продовжуємо зі старим файлом");
    await ctx.editMessageText(
      `✅ ОК, продовжуємо з файлом "${ctx.session.currentFile.name}".\nОстаннє повідомлення майстра актуальне.`,
    );
  });

  bot.action("conflict_start_new", async (ctx) => {
    if (!ctx.session.pendingFile)
      return ctx.answerCbQuery("Помилка: файл не знайдено.");

    await ctx.answerCbQuery("Починаємо з новим файлом");
    const pending = ctx.session.pendingFile;

    // Скидаємо стару сесію
    resetPrintSession(ctx);

    // Запускаємо процес для нового файлу (pending)
    try {
      if (pending.isPhoto) {
        ctx.session.multiImageMode = true;
        ctx.session.multiImages = [
          { path: pending.path, name: pending.fileName },
        ];
        const count = 1;
        const doneText = `✅ Додано зображення ${count}/20. Можете надсилати ще або натисніть "Це все".`;
        const statusMsg = await ctx.reply(
          doneText,
          Markup.inlineKeyboard([
            [Markup.button.callback("✅ Це все", "multi_image_done")],
          ]),
        );
        ctx.session.lastMultiMsgId = statusMsg.message_id;
      } else {
        // Читаємо буфер з файлу, оскільки в сесії він міг побитись через JSON-серіалізацію
        const fileBuffer = await fs.readFile(pending.path);
        const result = await validateFile(fileBuffer, pending.fileName);
        ctx.session.currentFile = {
          path: pending.path,
          name: pending.fileName,
          pages: result.basicParams.pages,
          preview: result.preview.toString("base64"),
          sourcePaths: pending.isPhoto ? [pending.path] : null,
        };
        ctx.session.printSettings = {
          ...ctx.session.printSettings,
          copies: 1,
          color: true,
          duplex: "Ні",
        };

        const wizardText = `📄 Файл: ${pending.fileName}\n📏 Сторінок: ${result.basicParams.pages}\n\nОберіть наступну дію:`;
        const buttons = [
          [
            Markup.button.callback(
              "🚀 Просто надрукуй це",
              "action_print_direct",
            ),
          ],
          [Markup.button.callback("⚙️ Налаштувати друк", "wizard_start")],
          [Markup.button.callback("❌ Скасувати друк", "action_cancel_print")],
        ];

        let finalMsg;
        if (result.preview) {
          finalMsg = await ctx.replyWithPhoto(
            { source: result.preview },
            { caption: wizardText, ...Markup.inlineKeyboard(buttons) },
          );
        } else {
          finalMsg = await ctx.reply(
            wizardText,
            Markup.inlineKeyboard(buttons),
          );
        }
        ctx.session.lastWizardMsgId = finalMsg.message_id;
      }
    } catch (err) {
      console.error("Conflict switch error:", err);
      await ctx.reply(`❌ Помилка при перемиканні: ${err.message}`);
    }

    ctx.session.pendingFile = null;
    await ctx.deleteMessage().catch(() => {});
  });

  bot.action("multi_image_done", async (ctx) => {
    if (!ctx.session.multiImages || ctx.session.multiImages.length === 0) {
      return ctx.answerCbQuery("Ви не додали жодного зображення!", {
        show_alert: true,
      });
    }

    await ctx.answerCbQuery("Обʼєдную зображення...");
    const statusMsg = await ctx.reply("⏳ Створюю PDF з ваших зображень...");

    try {
      const images = await Promise.all(
        ctx.session.multiImages.map(async (img) => await fs.readFile(img.path)),
      );
      const mergeResult = await mergeImagesToPdf(images, false); // Завжди об'єднуємо в кольорі

      const fileName = `merged_${Date.now()}.pdf`;
      const filePath = getTempPath(fileName);
      await fs.writeFile(filePath, mergeResult.pdf);

      // Очищаємо ID повідомлення (фото видалимо після друку)
      ctx.session.lastMultiMsgId = null;

      const previewBuffer = await generatePreview(mergeResult.pdf);

      ctx.session.currentFile = {
        path: filePath,
        name: fileName,
        pages: mergeResult.pages,
        preview: previewBuffer.toString("base64"),
        sourcePaths: ctx.session.multiImages.map((img) => img.path), // Зберігаємо шляхи до всіх фото
      };

      // Скидаємо режим
      ctx.session.multiImageMode = false;
      ctx.session.multiImages = [];

      const text = `📄 Об'єднано ${mergeResult.pages} стор. у файл: ${fileName}\n\nОберіть наступну дію:`;
      const buttons = [
        [
          Markup.button.callback(
            "🚀 Просто надрукуй це",
            "action_print_direct",
          ),
        ],
        [Markup.button.callback("⚙️ Налаштувати друк", "wizard_start")],
      ];

      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

      let finalMsg;
      if (previewBuffer) {
        finalMsg = await ctx.replyWithPhoto(
          { source: previewBuffer },
          { caption: text, ...Markup.inlineKeyboard(buttons) },
        );
      } else {
        finalMsg = await ctx.reply(text, Markup.inlineKeyboard(buttons));
      }
      ctx.session.lastWizardMsgId = finalMsg.message_id;
    } catch (error) {
      console.error("Multi-image merge error:", error);
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Почати спочатку", "action_print_next")],
      ]);
      await ctx.reply(
        "❌ Помилка при створенні PDF: " + error.message,
        keyboard,
      );
    }
  });
}

async function downloadFile(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await new Promise((resolve, reject) => {
        https
          .get(url, (res) => {
            if (res.statusCode !== 200) {
              return reject(
                new Error(`Failed to download file: ${res.statusCode}`),
              );
            }
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
          })
          .on("error", reject);
      });
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`Retrying download... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
