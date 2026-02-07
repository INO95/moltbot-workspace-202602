const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const creds = require('../data/secure/google_creds.json');
const config = require('../data/config.json');

async function run() {
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const doc = new GoogleSpreadsheet(config.spreadsheetId, auth);
    await doc.loadInfo();

    const sheet = doc.sheetsByTitle['가계부_파이널'];
    if (!sheet) throw new Error('가계부_파이널 not found');

    await sheet.loadHeaderRow();
    const [hDate, hItem, hIncome, hExpense, hMethod, hCategory] = sheet.headerValues;
    const rows = await sheet.getRows();

    const map = new Map();
    for (const row of rows) {
        const key = [row.get(hDate) || '', row.get(hItem) || '', row.get(hIncome) || '', row.get(hExpense) || ''].join('|');
        const arr = map.get(key) || [];
        arr.push({
            method: row.get(hMethod) || '',
            category: row.get(hCategory) || '',
        });
        map.set(key, arr);
    }

    const duplicates = [...map.entries()]
        .filter(([, list]) => list.length > 1)
        .slice(0, 12);

    console.log(
        JSON.stringify(
            {
                rows: rows.length,
                duplicateKeys: [...map.entries()].filter(([, list]) => list.length > 1).length,
                sample: duplicates,
            },
            null,
            2,
        ),
    );
}

if (require.main === module) {
    run().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

