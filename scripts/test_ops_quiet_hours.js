const assert = require('assert');
const rules = require('./ops_rules');

function run() {
    const quietTime = new Date('2026-02-16T14:30:00Z'); // 23:30 JST
    const dayTime = new Date('2026-02-16T00:30:00Z'); // 09:30 JST

    assert.strictEqual(rules.isQuietHours(quietTime, {
        timezone: 'Asia/Tokyo',
        quiet_hours: { start: '23:00', end: '07:00' },
    }), true);

    assert.strictEqual(rules.isQuietHours(dayTime, {
        timezone: 'Asia/Tokyo',
        quiet_hours: { start: '23:00', end: '07:00' },
    }), false);
}

run();
console.log('test_ops_quiet_hours: ok');
