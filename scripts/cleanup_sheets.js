/**
 * Legacy Sheets Cleanup Script
 * Hides old sheets and keeps only the Final versions visible
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../data/secure/google_creds.json');
const config = require('../data/config.json');

async function cleanupSheets() {
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(config.spreadsheetId, auth);
    await doc.loadInfo();

    // Keep these visible
    const keepVisible = ['가계부_파이널', '체크리스트_파이널', '가계부요약_파이널'];

    // Hide legacy sheets
    const toHide = [
        'checkList', 'checkList의 사본', 'old_체크리스트', 'old_체크리스트의 사본',
        '가계부', '가계부의 사본', '가계부_V2', '가계부_2025',
        '가계부_월별요약', '가계부_월별요약의 사본', '체크리스트_V2', 'old_식단'
    ];

    let hidden = 0;
    for (const title of toHide) {
        const sheet = doc.sheetsByTitle[title];
        if (sheet) {
            await sheet.updateProperties({ hidden: true });
            console.log(`🙈 Hidden: ${title}`);
            hidden++;
        }
    }

    console.log(`\n✅ Cleanup complete! Hidden ${hidden} legacy sheets.`);
    console.log(`📊 Visible sheets: ${keepVisible.join(', ')}`);
}

cleanupSheets().catch(console.error);
