const assert = require('assert');
const rules = require('./ops_rules');

function run() {
    const now = new Date('2026-02-16T12:00:00+09:00');
    const baseIssue = {
        issue_id: 'bot-dev:fp_demo',
        severity: 'P2',
        consecutive_failures: 3,
        last_alert_ts: '2026-02-16T10:30:00+09:00',
    };

    const cooldownSuppressed = rules.shouldAlertNow(baseIssue, {
        now,
        timezone: 'Asia/Tokyo',
        cooldown_hours: 2,
        p2_consecutive_failures_threshold: 3,
        quiet_hours: { start: '23:00', end: '07:00' },
    });
    assert.strictEqual(cooldownSuppressed.send, false);
    assert.strictEqual(cooldownSuppressed.reason, 'cooldown');

    const afterCooldown = rules.shouldAlertNow({
        ...baseIssue,
        last_alert_ts: '2026-02-16T09:00:00+09:00',
    }, {
        now,
        timezone: 'Asia/Tokyo',
        cooldown_hours: 2,
        p2_consecutive_failures_threshold: 3,
        quiet_hours: { start: '23:00', end: '07:00' },
    });
    assert.strictEqual(afterCooldown.send, true);
}

run();
console.log('test_ops_issue_dedupe: ok');
