const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const creds = require('../data/secure/google_creds.json');
const config = require('../data/config.json');

const TARGET_SHEETS = ['가계부_파이널', '체크리스트_파이널', '가계부요약_파이널'];

async function exportSheet(doc, title) {
    const sheet = doc.sheetsByTitle[title];
    if (!sheet) {
        return { title, exists: false, rowCount: 0, headers: [], rows: [] };
    }
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues || [];
    const rows = await sheet.getRows();
    return {
        title,
        exists: true,
        rowCount: rows.length,
        headers,
        rows: rows.map((r) => r.toObject()),
    };
}

async function run() {
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const doc = new GoogleSpreadsheet(config.spreadsheetId, auth);
    await doc.loadInfo();

    const exported = [];
    for (const title of TARGET_SHEETS) {
        // Sequential export keeps API behavior predictable on large sheets.
        exported.push(await exportSheet(doc, title));
    }

    const snapshot = {
        createdAt: new Date().toISOString(),
        spreadsheetId: config.spreadsheetId,
        spreadsheetTitle: doc.title,
        sheets: exported,
    };

    const backupDir = path.join(__dirname, '../data/backups');
    fs.mkdirSync(backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `final_sheet_snapshot_${stamp}.json`;
    const target = path.join(backupDir, filename);
    const latest = path.join(backupDir, 'final_sheet_snapshot_latest.json');

    fs.writeFileSync(target, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.writeFileSync(latest, JSON.stringify(snapshot, null, 2), 'utf8');

    console.log(
        JSON.stringify(
            {
                ok: true,
                file: target,
                latest,
                rowCounts: exported.map((s) => ({ title: s.title, exists: s.exists, rows: s.rowCount })),
            },
            null,
            2,
        ),
    );
}

if (require.main === module) {
    run().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
