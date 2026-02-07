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

    const sheet = doc.sheetsByTitle['가계부요약_파이널'];
    if (!sheet) throw new Error('가계부요약_파이널 not found');
    await sheet.loadHeaderRow();

    const headers = sheet.headerValues;
    const rows = await sheet.getRows();
    const selected = rows
        .filter((r) => ['월말 스미토모', '월말 라쿠텐', '월말 현금'].includes(r.get(headers[0])))
        .map((r) => {
            const out = { [headers[0]]: r.get(headers[0]) };
            for (const h of headers.slice(1)) out[h] = r.get(h);
            return out;
        });

    console.log(JSON.stringify({ headers, selected }, null, 2));
}

if (require.main === module) {
    run().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

