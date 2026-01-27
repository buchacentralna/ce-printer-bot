import { isUserAuthorized, logPrintAction, getUserStats, generateQuarterlyReport } from './index.js';

// Mocking the gsheets module for testing would require dependency injection or a complex mock setup.
// Since we are in a live environment, we can't easily mock imports in ESM without extra tools.
// However, we can at least check if the exports are correct and the logic handles missing credentials gracefully.

async function runTests() {
    console.log('--- Testing Google Sheets Module ---');

    // Test with missing SPREADSHEET_ID
    console.log('Test: isUserAuthorized (no ID)');
    const auth1 = await isUserAuthorized(12345);
    console.log('Result:', auth1 === false ? 'PASS' : 'FAIL');

    console.log('Test: getUserStats (no ID)');
    const stats1 = await getUserStats(12345);
    console.log('Result:', stats1 === 0 ? 'PASS' : 'FAIL');

    console.log('Test: generateQuarterlyReport (no ID)');
    const report1 = await generateQuarterlyReport();
    console.log('Result:', report1 === 'Error generating report' ? 'PASS' : 'FAIL');

    console.log('--- Test Finished ---');
}

runTests().catch(console.error);
