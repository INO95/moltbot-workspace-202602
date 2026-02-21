const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { handleRoutineCommand } = require('./personal_routine');

function makeTempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-routine-'));
    return {
        dir,
        dbPath: path.join(dir, 'personal.sqlite'),
    };
}

async function main() {
    const { dir, dbPath } = makeTempDb();
    try {
        const add = await handleRoutineCommand('등록 물 2L', { dbPath });
        assert.strictEqual(add.route, 'routine');
        assert.strictEqual(add.success, true);
        assert.strictEqual(add.action, 'add');
        assert.ok(add.entityId);

        const list = await handleRoutineCommand('목록', { dbPath });
        assert.strictEqual(list.success, true);
        assert.strictEqual(list.action, 'list');
        assert.ok(Array.isArray(list.templates));
        assert.ok(list.templates.length >= 1);

        const checkin = await handleRoutineCommand('체크 물 2L', { dbPath });
        assert.strictEqual(checkin.success, true);
        assert.strictEqual(checkin.action, 'checkin');

        const deactivate = await handleRoutineCommand('비활성 물 2L', { dbPath });
        assert.strictEqual(deactivate.success, true);
        assert.strictEqual(deactivate.action, 'deactivate');

        const activate = await handleRoutineCommand('활성 물 2L', { dbPath });
        assert.strictEqual(activate.success, true);
        assert.strictEqual(activate.action, 'activate');

        const summary = await handleRoutineCommand('요약', { dbPath });
        assert.strictEqual(summary.success, true);
        assert.strictEqual(summary.action, 'summary');

        console.log('test_personal_routine: ok');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
