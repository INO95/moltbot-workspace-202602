const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const creds = require('../data/secure/google_creds.json');

const SHEET_ID = '113henz01mG2pyGB8XsgoHMhVRTLscEdzcfcmzlCcC-M';

async function analyzeSheets() {
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    
    const doc = new GoogleSpreadsheet(SHEET_ID, auth);
    await doc.loadInfo();
    
    console.log('='.repeat(60));
    console.log('📊 스프레드시트 정보');
    console.log('='.repeat(60));
    console.log(`제목: ${doc.title}`);
    console.log(`시트 수: ${doc.sheetCount}`);
    console.log('');
    
    // 모든 시트 목록
    console.log('📋 시트 목록:');
    for (const sheet of doc.sheetsByIndex) {
        console.log(`  - ${sheet.title} (${sheet.rowCount} rows x ${sheet.columnCount} cols)`);
    }
    console.log('');
    
    // 각 시트별 상세 분석
    for (const sheet of doc.sheetsByIndex) {
        console.log('='.repeat(60));
        console.log(`📄 시트: ${sheet.title}`);
        console.log('='.repeat(60));
        
        await sheet.loadHeaderRow();
        console.log('헤더:', sheet.headerValues.join(' | '));
        
        const rows = await sheet.getRows({ limit: 5 });
        console.log(`\n샘플 데이터 (처음 ${rows.length}행):`);
        
        rows.forEach((row, i) => {
            const values = sheet.headerValues.map(h => row.get(h) || '');
            console.log(`  ${i + 1}: ${values.join(' | ')}`);
        });
        
        // 마지막 5행도 확인
        const allRows = await sheet.getRows();
        if (allRows.length > 5) {
            console.log(`\n마지막 5행 (총 ${allRows.length}행 중):`);
            allRows.slice(-5).forEach((row, i) => {
                const values = sheet.headerValues.map(h => row.get(h) || '');
                console.log(`  ${allRows.length - 4 + i}: ${values.join(' | ')}`);
            });
        }
        console.log('');
    }
}

analyzeSheets().catch(console.error);
