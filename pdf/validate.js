import fs from 'node:fs';
import path from 'node:path';

import { convertToPDF, generatePreview, getPdfPageCount } from './pdfUtils.js'; // твої утиліти для конвертації та превʼю

/**
 * validateFile
 * Основна функція валідації файлу, конвертації в PDF A4 та підготовки повідомлення з кнопками.
 * 
 * @param {Buffer} fileBuffer - вхідний файл
 * @param {string} fileName - назва файлу
 * @returns {Promise<object>} - об'єкт з даними для відправки користувачу
 */
export async function validateFile(fileBuffer, fileName) {
  // 1. Конвертація в PDF A4
  const pdfBuffer = await convertToPDF(fileBuffer, { fileName });

  // 2. Генерація превʼю (заглушка або реальна логіка)
  const previewBuffer = await generatePreview(pdfBuffer);

  // 3. Отримуємо кількість сторінок
  const numPages = await getPdfPageCount(pdfBuffer);

  // 4. Формуємо базові параметри
  const basicParams = {
    pages: numPages
  };

  // 5. Повертаємо результат
  return {
    pdf: pdfBuffer,
    preview: previewBuffer,
    basicParams
  };
}

