const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function run() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-missing-'));
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

    writeJson(path.join(tmpRoot, 'logs', 'bot-dev', 'latest.json'), {
        schema_version: '1.0',
        bot_id: 'bot-dev',
        run_id: 'dev-run-1',
        last_event_ts: '2026-02-16T08:00:00+09:00',
        status: 'ok',
        severity: 'P3',
        last_success_ts: '2026-02-16T08:00:00+09:00',
        consecutive_failures_by_issue: {},
    });
    writeJson(path.join(tmpRoot, 'logs', 'bot-dev', 'heartbeat.json'), {
        schema_version: '1.0',
        bot_id: 'bot-dev',
        run_id: 'dev-run-1',
        ts: '2026-02-16T08:00:00+09:00',
        state: 'idle',
    });

    // bot-anki intentionally misses latest.json
    writeJson(path.join(tmpRoot, 'logs', 'bot-anki', 'heartbeat.json'), {
        schema_version: '1.0',
        bot_id: 'bot-anki',
        run_id: 'anki-run-1',
        ts: '2026-02-16T08:00:00+09:00',
        state: 'idle',
    });

    // bot-research has heartbeat stall while running
    writeJson(path.join(tmpRoot, 'logs', 'bot-research', 'latest.json'), {
        schema_version: '1.0',
        bot_id: 'bot-research',
        run_id: 'research-run-1',
        last_event_ts: '2026-02-16T07:50:00+09:00',
        status: 'error',
        severity: 'P2',
        last_success_ts: '2026-02-16T07:00:00+09:00',
        consecutive_failures_by_issue: {},
    });
    writeJson(path.join(tmpRoot, 'logs', 'bot-research', 'heartbeat.json'), {
        schema_version: '1.0',
        bot_id: 'bot-research',
        run_id: 'research-run-1',
        ts: '2026-02-16T07:30:00+09:00',
        state: 'running',
    });

    const supervisor = require('./ops_daily_supervisor');
    const scanTimes = [
        '2026-02-16T08:00:00+09:00',
        '2026-02-16T08:30:00+09:00',
        '2026-02-16T09:00:00+09:00',
    ];
    for (const ts of scanTimes) {
        supervisor.runScan({
            now: ts,
            configPath,
            sendEnabled: false,
        });
    }

    const issuesPath = path.join(tmpRoot, 'ops', 'state', 'issues.json');
    const issues = JSON.parse(fs.readFileSync(issuesPath, 'utf8')).issues;
    const missingLatest = issues['bot-anki:missing_latest_json'];
    assert.ok(missingLatest, 'missing latest issue must exist');
    assert.ok(missingLatest.consecutive_failures >= 3, 'missing latest must reach threshold');

    const heartbeatStall = issues['bot-research:heartbeat_stall'];
    assert.ok(heartbeatStall, 'heartbeat stall issue must exist');
    assert.strictEqual(heartbeatStall.severity, 'P2');
}

run();
console.log('test_ops_missing_latest_and_heartbeat: ok');
