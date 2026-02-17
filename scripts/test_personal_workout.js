const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { handleRoutineCommand } = require('./personal_routine');
const { handleWorkoutCommand } = require('./personal_workout');

function makeTempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-workout-'));
    return {
        dir,
        dbPath: path.join(dir, 'personal.sqlite'),
    };
}

async function main() {
    const { dir, dbPath } = makeTempDb();
    try {
        await handleRoutineCommand('등록 운동루틴', { dbPath });

        const record = await handleWorkoutCommand('러닝 30분 5km', { dbPath });
        assert.strictEqual(record.route, 'workout');
        assert.strictEqual(record.success, true);
        assert.strictEqual(record.action, 'record');
        assert.ok(record.entityId);
        assert.ok(record.autoRoutine);

        const duplicate = await handleWorkoutCommand('러닝 30분 5km', { dbPath });
        assert.strictEqual(duplicate.success, true);
        assert.strictEqual(duplicate.action, 'duplicate');

        const list = await handleWorkoutCommand('목록', { dbPath });
        assert.strictEqual(list.success, true);
        assert.strictEqual(list.action, 'list');

        const summary = await handleWorkoutCommand('통계', { dbPath });
        assert.strictEqual(summary.success, true);
        assert.strictEqual(summary.action, 'summary');

        console.log('test_personal_workout: ok');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
