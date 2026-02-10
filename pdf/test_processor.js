import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, PageSizes } from 'pdf-lib';
import sharp from 'sharp';

import { processPdf } from './processor.js';
import { fileExistsAsync } from '../utils/fs.js';

async function runTests() {
    console.log('--- Starting PDF Processor Tests ---');

    // 1. Створимо моковий PDF (2 сторінки)
    const mockPdfDoc = await PDFDocument.create();
    mockPdfDoc.addPage(PageSizes.A4).drawText('Page 1');
    mockPdfDoc.addPage(PageSizes.A4).drawText('Page 2');
    const mockPdfBuffer = Buffer.from(await mockPdfDoc.save());

    // 2. Створимо мокове зображення (червоний квадрат)
    const mockImageBuffer = await sharp({
        create: {
            width: 100,
            height: 100,
            channels: 3,
            background: { r: 255, g: 0, b: 0 }
        }
    }).png().toBuffer();

    const testDir = './test_output';
    if (!await fileExistsAsync(testDir)) {
        await fs.mkdir(testDir);
    }

    // Test Case 1: Image to PDF (Plain)
    console.log('Test 1: Image to PDF...');
    const res1 = await processPdf(mockImageBuffer);
    await fs.writeFile(path.join(testDir, 'test1_img.pdf'), res1.pdf);
    console.log(`  Pages: ${res1.pages} (Expected 1)`);

    // Test Case 2: Image to PDF (Grayscale)
    console.log('Test 2: Image to PDF (Grayscale)...');
    const res2 = await processPdf(mockImageBuffer, { grayscale: true });
    await fs.writeFile(path.join(testDir, 'test2_img_gs.pdf'), res2.pdf);
    console.log(`  Pages: ${res2.pages} (Expected 1)`);

    // Test Case 3: PDF N-up (2 pages -> 1 sheet)
    console.log('Test 3: PDF 2-up (2 pages -> 1 sheet)...');
    const res3 = await processPdf(mockPdfBuffer, { nUp: 2 });
    await fs.writeFile(path.join(testDir, 'test3_2up.pdf'), res3.pdf);
    console.log(`  Pages: ${res3.pages} (Expected 1)`);

    // Test Case 4: PDF N-up (4 pages -> 1 sheet)
    console.log('Test 4: PDF 4-up (4 pages -> 1 sheet)...');
    const mockPdf4Doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) mockPdf4Doc.addPage(PageSizes.A4).drawText(`Page ${i + 1}`);
    const mockPdf4Buffer = Buffer.from(await mockPdf4Doc.save());
    const res4 = await processPdf(mockPdf4Buffer, { nUp: 4 });
    await fs.writeFile(path.join(testDir, 'test4_4up.pdf'), res4.pdf);
    console.log(`  Pages: ${res4.pages} (Expected 1)`);

    // Test Case 5: Page Limit (101 pages)
    console.log('Test 5: Page Limit (101 pages)...');
    const mockPdfLargeDoc = await PDFDocument.create();
    for (let i = 0; i < 101; i++) mockPdfLargeDoc.addPage(PageSizes.A4);
    const mockPdfLargeBuffer = Buffer.from(await mockPdfLargeDoc.save());
    try {
        await processPdf(mockPdfLargeBuffer);
        console.error('  Test 5 Failed: Exception expected but not thrown.');
    } catch (e) {
        console.log(`  Test 5 Passed: ${e.message}`);
    }

    console.log('--- Tests Completed ---');
    console.log('Check test_output/ directory for generated PDFs.');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
