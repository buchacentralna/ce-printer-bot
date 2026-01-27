/**
 * mail/index.js
 * Експорт модуля відправки пошти.
 */

import { sendPrintEmail, applyOptionsToPdf } from './sender.js';

export { sendPrintEmail as sendEmail, sendPrintEmail, applyOptionsToPdf };
