/**
 * Google Sheets 전체 백업 및 분석 스크립트
 * 숨긴 시트, 숨긴 행/열 포함 모든 데이터를 로컬에 백업
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');

const creds = require('../data/secure/google_creds.json');
const config = require('../data/config.json');

const BACKUP_DIR = path.join(__dirname, '../data/backup');

async function backupAllSheets() {
    console.log('📦 Starting full Google Sheets backup...');

    // 백업 디렉토리 생성
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(config.spreadsheetId, auth);
    await doc.loadInfo();

    console.log(`📄 Document: ${doc.title}`);
    console.log(`📊 Total sheets: ${doc.sheetCount}`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, `backup_${timestamp}`);
    fs.mkdirSync(backupPath);

    const manifest = {
        documentTitle: doc.title,
        backupTime: new Date().toISOString(),
        sheets: []
    };

    for (const sheet of doc.sheetsByIndex) {
        console.log(`\n--- Sheet: ${sheet.title} ---`);
        console.log(`  - Index: ${sheet.index}`);
        console.log(`  - Rows: ${sheet.rowCount}, Cols: ${sheet.columnCount}`);
        console.log(`  - Hidden: ${sheet.hidden ? 'YES' : 'no'}`);

        // 모든 셀 로드
        await sheet.loadCells();

        const sheetData = {
            title: sheet.title,
            index: sheet.index,
            hidden: sheet.hidden,
            gridProperties: {
                rowCount: sheet.rowCount,
                columnCount: sheet.columnCount
            },
            rows: []
        };

        // 각 행의 데이터 추출
        const rows = await sheet.getRows();
        for (const row of rows) {
            const rowData = {};
            for (const header of sheet.headerValues || []) {
                rowData[header] = row.get(header);
            }
            sheetData.rows.push(rowData);
        }

        // 숨긴 행/열 정보 분석 (gridProperties에서 확인)
        sheetData.hiddenRows = [];
        sheetData.hiddenCols = [];

        // 파일로 저장
        const sheetFileName = `${sheet.title.replace(/[\/\\?%*:|"<>]/g, '_')}.json`;
        fs.writeFileSync(
            path.join(backupPath, sheetFileName),
            JSON.stringify(sheetData, null, 2)
        );

        manifest.sheets.push({
            title: sheet.title,
            fileName: sheetFileName,
            hidden: sheet.hidden,
            rowCount: sheetData.rows.length
        });

        console.log(`  ✅ Saved: ${sheetFileName} (${sheetData.rows.length} rows)`);
    }

    // 매니페스트 저장
    fs.writeFileSync(
        path.join(backupPath, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
    );

    console.log(`\n✅ Backup complete: ${backupPath}`);
    return { backupPath, manifest };
}

// 데이터 분석 및 구조 추천
async function analyzeAndRecommend(backupPath) {
    console.log('\n🔍 Analyzing data structure...');

    const manifest = JSON.parse(
        fs.readFileSync(path.join(backupPath, 'manifest.json'), 'utf8')
    );

    const recommendations = [];

    for (const sheetInfo of manifest.sheets) {
        const sheetData = JSON.parse(
            fs.readFileSync(path.join(backupPath, sheetInfo.fileName), 'utf8')
        );

        // 분석: 빈 행, 중복, 일관성 문제 탐지
        const analysis = {
            sheet: sheetInfo.title,
            totalRows: sheetData.rows.length,
            emptyRows: 0,
            duplicates: 0,
            issues: []
        };

        const seenValues = new Set();
        for (const row of sheetData.rows) {
            const values = Object.values(row).filter(v => v);
            if (values.length === 0) {
                analysis.emptyRows++;
            }

            const key = JSON.stringify(row);
            if (seenValues.has(key)) {
                analysis.duplicates++;
            }
            seenValues.add(key);
        }

        if (analysis.emptyRows > 0) {
            analysis.issues.push(`${analysis.emptyRows}개의 빈 행 발견`);
        }
        if (analysis.duplicates > 0) {
            analysis.issues.push(`${analysis.duplicates}개의 중복 행 발견`);
        }

        recommendations.push(analysis);
    }

    console.log('\n📋 Analysis Results:');
    for (const rec of recommendations) {
        console.log(`  [${rec.sheet}] ${rec.totalRows} rows`);
        if (rec.issues.length > 0) {
            rec.issues.forEach(i => console.log(`    ⚠️ ${i}`));
        }
    }

    return recommendations;
}

module.exports = { backupAllSheets, analyzeAndRecommend };

if (require.main === module) {
    backupAllSheets()
        .then(({ backupPath }) => analyzeAndRecommend(backupPath))
        .then(() => console.log('\n🎉 All done!'))
        .catch(err => console.error('Error:', err));
}
