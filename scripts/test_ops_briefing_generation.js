const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function run() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-briefing-'));
    process.env.OPS_WORKSPACE_ROOT = tmpRoot;
    process.env.BRIDGE_DIR = path.join(tmpRoot, 'data', 'bridge');

    const configPath = path.join(tmpRoot, 'ops', 'config', 'daily_ops_mvp.json');
    writeJson(configPath, {
        schema_version: '1.0',
        timezone: 'Asia/Tokyo',
        alerting: {
            enabled: false,
            transport: 'bridge_queue',
            p2_consecutive_failures_threshold: 3,
            cooldown_hours: 2,
            quiet_hours: { start: '23:00', end: '07:00' },
        },
        briefings: { morning_time: '08:30', evening_time: '18:30', send: false },
        workers: {
            'bot-dev': { active: true },
            'bot-anki': { active: true },
            'bot-research': { active: true },
        },
    });

    writeJson(path.join(tmpRoot, 'ops', 'state', 'state.json'), {
        schema_version: '1.0',
        updated_at: '2026-02-16T08:00:00+09:00',
        timezone: 'Asia/Tokyo',
        scan_cursor_ts_by_bot: {},
        bot_health: {
            'bot-dev': {
                status: 'OK',
                last_success_ts: '2026-02-16T07:59:00+09:00',
                last_run_ts: '2026-02-16T07:59:00+09:00',
                staleness_minutes: 1,
                runs_observed: 1,
                retries_recovered: 0,
            },
            'bot-anki': {
                status: 'WARN',
                last_success_ts: '2026-02-16T07:40:00+09:00',
                last_run_ts: '2026-02-16T07:50:00+09:00',
                staleness_minutes: 20,
                runs_observed: 2,
                retries_recovered: 1,
            },
            'bot-research': {
                status: 'ERROR',
                last_success_ts: '2026-02-16T06:30:00+09:00',
                last_run_ts: '2026-02-16T07:30:00+09:00',
                staleness_minutes: 60,
                runs_observed: 2,
                retries_recovered: 0,
            },
        },
        last_briefing_sent: {
            morning: null,
            evening: null,
        },
    });
    writeJson(path.join(tmpRoot, 'ops', 'state', 'issues.json'), {
        schema_version: '1.0',
        updated_at: '2026-02-16T08:00:00+09:00',
        issues: {
            'bot-research:fp_test_1': {
                issue_id: 'bot-research:fp_test_1',
                bot_id: 'bot-research',
                fingerprint: 'fp_test_1',
                status: 'open',
                severity: 'P2',
                first_seen_ts: '2026-02-16T07:00:00+09:00',
                last_seen_ts: '2026-02-16T07:30:00+09:00',
                consecutive_failures: 3,
                last_alert_ts: null,
                quiet_hours_suppressed_count: 1,
                evidence: {
                    run_ids: ['research-run-1'],
                    log_paths: ['/tmp/log-a'],
                },
                summary: 'Upstream service returned 503.',
                resolved_at: null,
            },
            'bot-anki:fp_resolved': {
                issue_id: 'bot-anki:fp_resolved',
                bot_id: 'bot-anki',
                fingerprint: 'fp_resolved',
                status: 'resolved',
                severity: 'P2',
                first_seen_ts: '2026-02-16T05:00:00+09:00',
                last_seen_ts: '2026-02-16T07:20:00+09:00',
                consecutive_failures: 0,
                last_alert_ts: '2026-02-16T06:00:00+09:00',
                quiet_hours_suppressed_count: 0,
                evidence: {
                    run_ids: ['anki-run-9'],
                    log_paths: ['/tmp/log-b'],
                },
                summary: 'Resolved after dependency recovery.',
                resolved_at: '2026-02-16T07:20:00+09:00',
            },
        },
    });

    const supervisor = require('./ops_daily_supervisor');
    const morning = supervisor.runBriefing('morning', {
        now: '2026-02-16T08:30:00+09:00',
        configPath,
        sendEnabled: false,
    });
    assert.strictEqual(morning.ok, true);
    assert.ok(morning.result && morning.result.reportPath, 'morning report path should exist');
    const morningText = fs.readFileSync(morning.result.reportPath, 'utf8');
    assert.ok(morningText.includes('Morning Briefing'));
    assert.ok(morningText.includes('bot-research:fp_test_1'));

    const evening = supervisor.runBriefing('evening', {
        now: '2026-02-16T18:30:00+09:00',
        configPath,
        sendEnabled: false,
    });
    assert.strictEqual(evening.ok, true);
    const eveningText = fs.readFileSync(evening.result.reportPath, 'utf8');
    assert.ok(eveningText.includes('Evening Briefing'));
    assert.ok(eveningText.includes('Open Issues Carrying Over'));
}

run();
console.log('test_ops_briefing_generation: ok');
