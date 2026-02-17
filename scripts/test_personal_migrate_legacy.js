const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runMigration } = require('./personal_migrate_legacy');

function makeTempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-migrate-'));
    return {
        dir,
        dbPath: path.join(dir, 'personal.sqlite'),
    };
}

function assertIdempotent(sourceResult1, sourceResult2, label) {
    assert.ok(sourceResult1);
    assert.ok(sourceResult2);
    assert.ok(Number(sourceResult2.inserted || 0) <= Number(sourceResult1.inserted || 0), `${label} second inserted should be <= first`);
    if (Number(sourceResult1.rows || 0) > 0) {
        assert.strictEqual(Number(sourceResult2.inserted || 0), 0, `${label} second inserted should be 0 with same source`);
    }
}

function main() {
    const { dir, dbPath } = makeTempDb();
    try {
        const dry = runMigration({ apply: false, dbPath });
        assert.strictEqual(dry.ok, true);
        assert.strictEqual(dry.apply, false);
        assert.ok(dry.sources && dry.sources.finance_db_json && dry.sources.expenses_csv && dry.sources.memo_jsonl);

        const first = runMigration({ apply: true, dbPath });
        assert.strictEqual(first.ok, true);
        assert.strictEqual(first.apply, true);

        const second = runMigration({ apply: true, dbPath });
        assert.strictEqual(second.ok, true);
        assert.strictEqual(second.apply, true);

        assertIdempotent(first.sources.finance_db_json, second.sources.finance_db_json, 'finance_db_json');
        assertIdempotent(first.sources.expenses_csv, second.sources.expenses_csv, 'expenses_csv');
        assertIdempotent(first.sources.memo_jsonl, second.sources.memo_jsonl, 'memo_jsonl');

        console.log('test_personal_migrate_legacy: ok');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

main();
