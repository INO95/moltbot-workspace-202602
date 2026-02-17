const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseFinanceEntry, handleFinanceCommand } = require('./personal_finance');

function makeTempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-finance-'));
    return {
        dir,
        dbPath: path.join(dir, 'personal.sqlite'),
    };
}

async function main() {
    const { dir, dbPath } = makeTempDb();
    try {
        const parsed = parseFinanceEntry('점심 1200엔 카드');
        assert.strictEqual(parsed.currency, 'JPY');
        assert.strictEqual(parsed.entryType, 'expense');
        assert.ok(Number.isFinite(parsed.amount));

        const record = await handleFinanceCommand('점심 1200엔 카드', { dbPath });
        assert.strictEqual(record.route, 'finance');
        assert.strictEqual(record.success, true);
        assert.strictEqual(record.action, 'record');
        assert.ok(record.entityId);

        const duplicate = await handleFinanceCommand('점심 1200엔 카드', { dbPath });
        assert.strictEqual(duplicate.success, true);
        assert.strictEqual(duplicate.action, 'duplicate');

        const summary = await handleFinanceCommand('통계', { dbPath });
        assert.strictEqual(summary.success, true);
        assert.strictEqual(summary.action, 'summary');
        assert.ok(summary.summary && summary.summary.totals);

        const list = await handleFinanceCommand('목록', { dbPath });
        assert.strictEqual(list.success, true);
        assert.strictEqual(list.action, 'list');

        const parseError = await handleFinanceCommand('점심 값 비쌈', { dbPath });
        assert.strictEqual(parseError.success, false);
        assert.strictEqual(parseError.action, 'parse_error');

        console.log('test_personal_finance: ok');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
