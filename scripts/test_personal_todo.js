const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { handleTodoCommand } = require('./personal_todo');

function makeTempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-todo-'));
    return {
        dir,
        dbPath: path.join(dir, 'personal.sqlite'),
    };
}

async function main() {
    const { dir, dbPath } = makeTempDb();
    try {
        const add = await handleTodoCommand('추가 장보기', { dbPath });
        assert.strictEqual(add.route, 'todo');
        assert.strictEqual(add.success, true);
        assert.strictEqual(add.action, 'add');
        assert.ok(add.entityId);

        const list = await handleTodoCommand('목록', { dbPath });
        assert.strictEqual(list.success, true);
        assert.strictEqual(list.action, 'list');
        assert.ok(Array.isArray(list.rows));

        const done = await handleTodoCommand(`완료 ${add.entityId}`, { dbPath });
        assert.strictEqual(done.success, true);
        assert.strictEqual(done.action, 'done');

        const reopen = await handleTodoCommand(`재개 ${add.entityId}`, { dbPath });
        assert.strictEqual(reopen.success, true);
        assert.strictEqual(reopen.action, 'reopen');

        const remove = await handleTodoCommand(`삭제 ${add.entityId}`, { dbPath });
        assert.strictEqual(remove.success, true);
        assert.strictEqual(remove.action, 'remove');

        const duplicate = await handleTodoCommand('추가 장보기', { dbPath });
        assert.strictEqual(duplicate.success, true);
        assert.strictEqual(duplicate.action, 'duplicate');

        console.log('test_personal_todo: ok');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
