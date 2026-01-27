import { PDFDocument, PageSizes, degrees } from 'pdf-lib';
import sharp from 'sharp';
import libre from 'libreoffice-convert';
import { promisify } from 'util';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const convertAsync = promisify(libre.convert);
const execAsync = promisify(exec);

// 5мм у пунктах PDF (1мм = 2.83465pt)
const GAP_POINTS = 14.17;

/**
 * pdf/processor.js
 * Модуль для обробки PDF, зображень та офісних документів.
 */

/**
 * Основна функція обробки.
 * @param {Buffer} fileBuffer - Буфер файлу.
 * @param {Object} options - Опції: { nUp: number, grayscale: boolean, fileName: string }.
 * @returns {Promise<{ pdf: Buffer, pages: number }>}
 */
export async function processPdf(fileBuffer, options = {}) {
    const { nUp = 1, grayscale = false, fileName = 'file.pdf', copiesPerPage = 1 } = options;
    const ext = fileName.toLowerCase().split('.').pop();

    let currentBuffer = fileBuffer;
    let pdfDoc;
    let isImage = false;

    // 1. Конвертація в PDF, якщо це не PDF або якщо ми хочемо перезібрати з оригіналів (для ч/б)
    if (options.sourcePaths && options.sourcePaths.length > 0) {
        if (options.sourcePaths.length === 1) {
            // Один оригінал (зображення)
            const imgBuffer = fs.readFileSync(options.sourcePaths[0]);
            pdfDoc = await createPdfFromImage(imgBuffer, grayscale);
        } else {
            // Багато оригіналів
            const imageBuffers = options.sourcePaths.map(p => fs.readFileSync(p));
            const mergeResult = await mergeImagesToPdf(imageBuffers, grayscale);
            pdfDoc = await PDFDocument.load(mergeResult.pdf);
        }
    } else if (ext === 'pdf' || currentBuffer.toString('ascii', 0, 4) === '%PDF') {
        pdfDoc = await PDFDocument.load(currentBuffer);
    } else if (['jpg', 'jpeg', 'png', 'webp', 'tiff', 'heic', 'heif'].includes(ext)) {
        isImage = true;
        pdfDoc = await createPdfFromImage(currentBuffer, grayscale);
    } else if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pages', 'numbers', 'key', 'odt', 'ods', 'odp', 'txt', 'rtf'].includes(ext)) {
        try {
            currentBuffer = await convertDocToPdf(currentBuffer, ext);
            pdfDoc = await PDFDocument.load(currentBuffer);
        } catch (err) {
            console.error('Office conversion error:', err);
            throw new Error(`Помилка конвертації ${ext.toUpperCase()} у PDF. Перевірте, чи встановлено LibreOffice.`);
        }
    } else {
        // Спробуємо як зображення, якщо розширення невідоме, але може бути картинкою
        try {
            isImage = true;
            pdfDoc = await createPdfFromImage(currentBuffer, grayscale);
        } catch (err) {
            throw new Error('Непідтримуваний формат файлу.');
        }
    }

    // 2. Дублювання кожної сторінки (якщо обрано Copies per Page)
    if (copiesPerPage > 1) {
        pdfDoc = await duplicatePages(pdfDoc, copiesPerPage);
    }

    // 3. Якщо обрано N-up (2 або 4 сторінки на аркуш)
    if (nUp === 2 || nUp === 4) {
        pdfDoc = await applyNUp(pdfDoc, nUp);
    }

    const pagesCount = pdfDoc.getPageCount();

    // Перевірка на ліміт сторінок (100 сторінок)
    if (pagesCount > 100) {
        throw new Error(`Занадто багато сторінок (${pagesCount}). Максимально дозволено 100.`);
    }

    let pdfBytes = await pdfDoc.save();
    let finalBuffer = Buffer.from(pdfBytes);

    // 3. Якщо обрано ч/б і ми не зробили це раніше (через sharp) - використовуємо Ghostscript
    // Ми НЕ робимо це ще раз, якщо вже перезібрали з оригіналів (sourcePaths)
    if (grayscale && (!options.sourcePaths || options.sourcePaths.length === 0)) {
        try {
            finalBuffer = await grayscalePdfUsingGS(finalBuffer);
        } catch (err) {
            console.error('GS grayscale error:', err.message);
            // Ми вже зробили все що могли
        }
    }

    return {
        pdf: finalBuffer,
        pages: pagesCount
    };
}

/**
 * Перетворює PDF у чорно-білий за допомогою Ghostscript.
 * Це найбільш надійний метод для векторів, тексту та зображень всередині PDF.
 */
async function grayscalePdfUsingGS(buffer) {
    const tempIn = path.join(os.tmpdir(), `gs_in_${Date.now()}.pdf`);
    const tempOut = path.join(os.tmpdir(), `gs_out_${Date.now()}.pdf`);

    fs.writeFileSync(tempIn, buffer);

    try {
        // Команда GS для перетворення в Gray. 
        // Видалили -dQUIET щоб бачити помилки в логах якщо вони є.
        const cmd = `gs -sDEVICE=pdfwrite -sColorConversionStrategy=Gray -dProcessColorModel=/DeviceGray -dCompatibilityLevel=1.4 -dNOPAUSE -dBATCH -sOutputFile="${tempOut}" "${tempIn}"`;
        console.log(`Executing GS command: ${cmd}`);
        const { stdout, stderr } = await execAsync(cmd);
        if (stderr) console.warn('GS warnings:', stderr);

        if (fs.existsSync(tempOut)) {
            return fs.readFileSync(tempOut);
        } else {
            throw new Error('GS did not produce output file');
        }
    } catch (err) {
        console.error('CRITICAL GS error:', err.message);
        throw err;
    } finally {
        if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
        if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
    }
}

/**
 * Конвертує офісний документ у PDF за допомогою LibreOffice.
 */
async function convertDocToPdf(buffer, ext) {
    // Встановлюємо фільтр для конвертації
    const format = '.pdf';
    return await convertAsync(buffer, format, undefined);
}

/**
 * Створює PDF A4 з зображення.
 * @param {Buffer} imageBuffer 
 * @param {boolean} grayscale 
 * @returns {Promise<PDFDocument>}
 */
async function createPdfFromImage(imageBuffer, grayscale) {
    let sharpInstance = sharp(imageBuffer);
    if (grayscale) {
        sharpInstance = sharpInstance.grayscale();
    }

    const metadata = await sharpInstance.metadata();
    const { width: iWidth, height: iHeight } = metadata;

    // Конвертуємо в PNG для стабільності вставки в PDF
    const pngBuffer = await sharpInstance.png().toBuffer();

    const pdfDoc = await PDFDocument.create();

    // Визначаємо орієнтацію: якщо ширина більша за висоту - альбомна (landscape)
    const isLandscape = iWidth > iHeight;
    const pageSize = isLandscape ? [PageSizes.A4[1], PageSizes.A4[0]] : PageSizes.A4;

    const page = pdfDoc.addPage(pageSize);
    const { width: pWidth, height: pHeight } = page.getSize();

    const image = await pdfDoc.embedPng(pngBuffer);

    // Центруємо та вписуємо в сторінку
    const scale = Math.min(pWidth / iWidth, pHeight / iHeight);
    const scaledWidth = iWidth * scale;
    const scaledHeight = iHeight * scale;

    page.drawImage(image, {
        x: (pWidth - scaledWidth) / 2,
        y: (pHeight - scaledHeight) / 2,
        width: scaledWidth,
        height: scaledHeight,
    });

    return pdfDoc;
}

/**
 * Перекомпоновує PDF: 2 або 4 сторінки на 1 аркуш A4.
 * @param {PDFDocument} srcDoc 
 * @param {number} nUp 
 * @returns {Promise<PDFDocument>}
 */
async function applyNUp(srcDoc, nUp) {
    const nUpDoc = await PDFDocument.create();
    const srcPages = srcDoc.getPages();
    const [a4Width, a4Height] = PageSizes.A4;

    if (nUp === 2) {
        // Landscape A4 (841.89 x 595.28)
        // 2 слоти з проміжком GAP_POINTS
        const slotW = (a4Height - GAP_POINTS) / 2;
        const slotH = a4Width;

        for (let i = 0; i < srcPages.length; i += 2) {
            const newPage = nUpDoc.addPage([a4Height, a4Width]);

            await embedPageToGrid(srcDoc, nUpDoc, newPage, i, 0, 0, slotW, slotH);
            if (i + 1 < srcPages.length) {
                await embedPageToGrid(srcDoc, nUpDoc, newPage, i + 1, slotW + GAP_POINTS, 0, slotW, slotH);
            }
        }
    } else if (nUp === 4) {
        // Portrait A4 (595.28 x 841.89)
        // 2x2 сітка з проміжками
        const slotW = (a4Width - GAP_POINTS) / 2;
        const slotH = (a4Height - GAP_POINTS) / 2;

        for (let i = 0; i < srcPages.length; i += 4) {
            const newPage = nUpDoc.addPage([a4Width, a4Height]);

            // Top row
            await embedPageToGrid(srcDoc, nUpDoc, newPage, i, 0, slotH + GAP_POINTS, slotW, slotH);
            if (i + 1 < srcPages.length)
                await embedPageToGrid(srcDoc, nUpDoc, newPage, i + 1, slotW + GAP_POINTS, slotH + GAP_POINTS, slotW, slotH);

            // Bottom row
            if (i + 2 < srcPages.length)
                await embedPageToGrid(srcDoc, nUpDoc, newPage, i + 2, 0, 0, slotW, slotH);
            if (i + 3 < srcPages.length)
                await embedPageToGrid(srcDoc, nUpDoc, newPage, i + 3, slotW + GAP_POINTS, 0, slotW, slotH);
        }
    }

    return nUpDoc;
}

/**
 * Дублює кожну сторінку PDF задану кількість разів послідовно.
 * (A, B -> A, A, B, B)
 * @param {PDFDocument} srcDoc 
 * @param {number} copies 
 * @returns {Promise<PDFDocument>}
 */
async function duplicatePages(srcDoc, copies) {
    const dupDoc = await PDFDocument.create();
    const pages = srcDoc.getPages();
    const pageIndices = srcDoc.getPageIndices();

    for (const index of pageIndices) {
        for (let i = 0; i < copies; i++) {
            const [copiedPage] = await dupDoc.copyPages(srcDoc, [index]);
            dupDoc.addPage(copiedPage);
        }
    }
    return dupDoc;
}

/**
 * Допоміжна функція для вставки сторінки в конкретний "слот" сітки.
 */
async function embedPageToGrid(srcDoc, dstDoc, dstPage, pageIndex, xOffset, yOffset, slotW, slotH) {
    const srcPage = srcDoc.getPage(pageIndex);
    const { width: sW, height: sH } = srcPage.getSize();

    // Всі наші слоти (для 2-up і 4-up) мають Portrait-орієнтацію (H > W).
    // Обертаємо горизонтальні зображення на 90 градусів.
    const isImageLandscape = sW > sH;
    let rotation = 0;
    let effectiveW = sW;
    let effectiveH = sH;

    if (isImageLandscape) {
        rotation = 90;
        effectiveW = sH;
        effectiveH = sW;
    }

    const [embeddedPage] = await dstDoc.embedPages([srcPage]);

    // Масштабуємо так, щоб вписати ТРАНСФОРМОВАНЕ зображення в слот
    const scale = Math.min(slotW / effectiveW, slotH / effectiveH);

    // Розміри контенту мають зберігати оригінальні пропорції
    const contentW = sW * scale;
    const contentH = sH * scale;

    // Візуальні розміри після обертання
    const visualW = effectiveW * scale;
    const visualH = effectiveH * scale;

    // Розраховуємо позицію для центрування візуального боксу в слоті
    const centeredX = xOffset + (slotW - visualW) / 2;
    const centeredY = yOffset + (slotH - visualH) / 2;

    // Для rotation=90 (counter-clockwise), origin (0,0) стає правим нижнім кутом візуального боксу.
    const drawX = centeredX + (rotation === 90 ? visualW : 0);
    const drawY = centeredY;

    dstPage.drawPage(embeddedPage, {
        x: drawX,
        y: drawY,
        width: contentW,
        height: contentH,
        rotate: degrees(rotation)
    });
}

/**
 * Об'єднує декілька зображень в один PDF файл.
 * @param {Buffer[]} images - Масив буферів зображень.
 * @param {boolean} grayscale - Чи конвертувати в ч/б.
 * @returns {Promise<{pdf: Buffer, pages: number}>}
 */
export async function mergeImagesToPdf(images, grayscale = false) {
    const pdfDoc = await PDFDocument.create();

    for (const imgBuffer of images) {
        await addImagePageToPdf(pdfDoc, imgBuffer, grayscale);
    }

    const pagesCount = pdfDoc.getPageCount();
    if (pagesCount > 100) {
        throw new Error(`Занадто багато сторінок (${pagesCount}). Максимально дозволено 100.`);
    }

    const pdfBytes = await pdfDoc.save();
    return {
        pdf: Buffer.from(pdfBytes),
        pages: pagesCount
    };
}

/**
 * Додає нову сторінку з зображенням до існуючого PDF документа з урахуванням орієнтації.
 */
async function addImagePageToPdf(pdfDoc, imageBuffer, grayscale) {
    let sharpInstance = sharp(imageBuffer);
    if (grayscale) {
        sharpInstance = sharpInstance.grayscale();
    }

    const metadata = await sharpInstance.metadata();
    const { width: iWidth, height: iHeight } = metadata;
    const pngBuffer = await sharpInstance.png().toBuffer();

    const isLandscape = iWidth > iHeight;
    const pageSize = isLandscape ? [PageSizes.A4[1], PageSizes.A4[0]] : PageSizes.A4;

    const page = pdfDoc.addPage(pageSize);
    const { width: pWidth, height: pHeight } = page.getSize();
    const image = await pdfDoc.embedPng(pngBuffer);

    const scale = Math.min(pWidth / iWidth, pHeight / iHeight);
    const scaledWidth = iWidth * scale;
    const scaledHeight = iHeight * scale;

    page.drawImage(image, {
        x: (pWidth - scaledWidth) / 2,
        y: (pHeight - scaledHeight) / 2,
        width: scaledWidth,
        height: scaledHeight,
    });
}
