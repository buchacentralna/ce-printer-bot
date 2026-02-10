import { exec } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import { processPdf } from "./processor.js";
import { fileExistsAsync } from "../utils/fs.js";

const execAsync = promisify(exec);

/**
 * pdf/pdfUtils.js
 * Утиліти для роботи з PDF.
 */

export async function convertToPDF(fileBuffer, options) {
  const { pdf } = await processPdf(fileBuffer, options);

  return pdf;
}

export async function getPdfPageCount(pdfBuffer) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);

  return pdfDoc.getPageCount();
}

/**
 * Генерує візуальне прев'ю першої сторінки PDF за допомогою Ghostscript.
 * Використовує Sharp для додаткового стиснення.
 */
export async function generatePreview(pdfBuffer) {
  console.log("Generating visual preview...");

  // Якщо це заглушка із сесії (іноді буває при помилках)
  if (pdfBuffer.toString() === "mock-preview-data") {
    return pdfBuffer;
  }

  const tempId = Math.random().toString(36).substring(7);
  const inputPath = path.join(os.tmpdir(), `input_${tempId}.pdf`);
  const outputPath = path.join(os.tmpdir(), `preview_${tempId}.jpg`);

  try {
    await fs.writeFile(inputPath, pdfBuffer);

    // Команда GS для рендеру першої сторінки в JPEG
    // -r72 (низька роздільна здатність для швидкості), -dFirstPage=1, -dLastPage=1
    const gsCmd = `gs -sDEVICE=jpeg -dFirstPage=1 -dLastPage=1 -dNOPAUSE -dBATCH -dSAFER -dJPEGQ=60 -r72 -sOutputFile="${outputPath}" "${inputPath}"`;
    await execAsync(gsCmd, { stdio: "ignore" });

    if (!(await fileExistsAsync(outputPath))) {
      throw new Error("Ghostscript failed to generate preview.");
    }

    // Додаткове стиснення через Sharp (робимо прев'ю маленьким для швидкої передачі в Telegram)
    const previewBuffer = await sharp(outputPath)
      .resize(600) // ширина 600px достатня для мобільного
      .jpeg({ quality: 60, progressive: true })
      .toBuffer();

    return previewBuffer;
  } catch (err) {
    console.error("Error in generatePreview:", err);

    // Повертаємо заглушку, щоб робот не "падав" повністю
    return Buffer.from("error-preview");
  } finally {
    // Очищаємо тимчасові файли
    if (await fileExistsAsync(inputPath)) {
      await fs.unlink(inputPath);
    }
    if (await fileExistsAsync(outputPath)) {
      await fs.unlink(outputPath);
    }
  }
}
