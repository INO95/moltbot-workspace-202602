const assert = require('assert');
const rules = require('./ops_rules');

function run() {
    const valid = rules.validateEventSchema({
        schema_version: '1.0',
        ts: '2026-02-16T09:10:23+09:00',
        bot_id: 'bot-dev',
        run_id: 'run-123',
        event_type: 'start',
        status: 'ok',
        severity: 'P3',
        message: 'Run started.',
        component: 'bridge',
    });
    assert.strictEqual(valid.valid, true);
    assert.deepStrictEqual(valid.missing, []);

    const invalid = rules.validateEventSchema({
        schema_version: '1.0',
        bot_id: 'bot-dev',
    });
    assert.strictEqual(invalid.valid, false);
    assert.ok(invalid.missing.includes('ts'));
    assert.ok(invalid.missing.includes('run_id'));
}

run();
console.log('test_ops_schema_validation: ok');
