import * as Sentry from "@sentry/node";
import nodemailer from "nodemailer";
import { PDFDocument } from "pdf-lib";

import { processPdf } from "../pdf/processor.js";

/**
 * Застосовує параметри до PDF (копії, ч/б, n-up).
 * @param {Buffer} pdfBuffer
 * @param {Object} options
 * @returns {Promise<Buffer>}
 */
export async function applyOptionsToPdf(pdfBuffer, options) {
  let currentBuffer = pdfBuffer;

  // 1. Обробка кольору та N-up (через наш модуль pdf/processor.js)
  // Це покриває grayscale та 2-up/4-up
  const processed = await processPdf(currentBuffer, {
    grayscale: !options.color,
    nUp: parseInt(options.pagesPerSheet) || 1,
    copiesPerPage: parseInt(options.copiesPerPage) || 1,
    sourcePaths: options.sourcePaths,
    fileName: options.fileName,
  });
  currentBuffer = processed.pdf;

  // 2. Кількість копій через pdf-lib (дублювання сторінок)
  if (options.copies && options.copies > 1) {
    const pdfDoc = await PDFDocument.load(currentBuffer);
    const newPdfDoc = await PDFDocument.create();

    const pageIndices = pdfDoc.getPageIndices();
    for (let i = 0; i < options.copies; i++) {
      const copiedPages = await newPdfDoc.copyPages(pdfDoc, pageIndices);
      copiedPages.forEach((page) => newPdfDoc.addPage(page));
    }

    currentBuffer = Buffer.from(await newPdfDoc.save());

    // Перевірка на ліміт 100 сторінок після дублювання копій
    const finalDoc = await PDFDocument.load(currentBuffer);
    if (finalDoc.getPageCount() > 100) {
      throw new Error(
        `Результат перевищує 100 сторінок (${finalDoc.getPageCount()}). Зменште кількість копій або обсяг файлу.`,
      );
    }
  }

  return currentBuffer;
}

/**
 * Формує тему листа з параметрами друку.
 */
function buildSubject(fileName, options) {
  const parts = [`Print: ${fileName}`];
  if (options.copies) parts.push(`Copies: ${options.copies}`);
  if (typeof options.color === 'boolean')
    parts.push(`Color: ${options.color ? "Color" : "B&W"}`);
  if (options.duplex) parts.push(`Duplex: ${options.duplex}`);
  
  return parts.join(" | ");
}

/**
 * Надсилає PDF на пошту принтера.
 * @param {Buffer} pdfBuffer
 * @param {string} fileName
 * @param {Object} options
 */
export async function sendPrintEmail(pdfBuffer, fileName, options = {}) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "465"),
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  try {
    // Застосовуємо параметри до самого файлу
    const processedBuffer = await applyOptionsToPdf(pdfBuffer, options);

    // Формуємо тему листа (для деяких принтерів це важливо)
    const subject = buildSubject(fileName, options);

    const mailOptions = {
      from: process.env.SMTP_FROM,
      to: process.env.PRINTER_EMAIL,
      subject: subject,
      attachments: [
        {
          filename: fileName.endsWith(".pdf") ? fileName : `${fileName}.pdf`,
          content: processedBuffer,
        },
      ],
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Failed to send print email:", error);
    Sentry.captureException(error);
    return { success: false, error: error.message };
  }
}
