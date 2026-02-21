const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function appendJsonl(filePath, rows) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const body = rows.map((row) => JSON.stringify(row)).join('\n');
    fs.writeFileSync(filePath, `${body}\n`, 'utf8');
}

function run() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-e2e-'));
    process.env.OPS_WORKSPACE_ROOT = tmpRoot;
    process.env.BRIDGE_DIR = path.join(tmpRoot, 'data', 'bridge');

    const configPath = path.join(tmpRoot, 'ops', 'config', 'daily_ops_mvp.json');
    writeJson(configPath, {
        schema_version: '1.0',
        timezone: 'Asia/Tokyo',
        alerting: {
            enabled: true,
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

    const now = '2026-02-16T10:00:00+09:00';
    writeJson(path.join(tmpRoot, 'logs', 'bot-dev', 'latest.json'), {
        schema_version: '1.0',
        bot_id: 'bot-dev',
        run_id: 'dev-run-1',
        last_event_ts: '2026-02-16T09:58:00+09:00',
        status: 'ok',
        severity: 'P3',
        last_success_ts: '2026-02-16T09:58:00+09:00',
        consecutive_failures_by_issue: {},
    });
    writeJson(path.join(tmpRoot, 'logs', 'bot-dev', 'heartbeat.json'), {
        schema_version: '1.0',
        bot_id: 'bot-dev',
        run_id: 'dev-run-1',
        ts: '2026-02-16T09:58:00+09:00',
        state: 'idle',
    });

    writeJson(path.join(tmpRoot, 'logs', 'bot-anki', 'latest.json'), {
        schema_version: '1.0',
        bot_id: 'bot-anki',
        run_id: 'anki-run-1',
        last_event_ts: '2026-02-16T09:57:00+09:00',
        status: 'ok',
        severity: 'P3',
        last_success_ts: '2026-02-16T09:57:00+09:00',
        consecutive_failures_by_issue: {},
    });
    writeJson(path.join(tmpRoot, 'logs', 'bot-anki', 'heartbeat.json'), {
        schema_version: '1.0',
        bot_id: 'bot-anki',
        run_id: 'anki-run-1',
        ts: '2026-02-16T09:57:00+09:00',
        state: 'idle',
    });

    writeJson(path.join(tmpRoot, 'logs', 'bot-research', 'latest.json'), {
        schema_version: '1.0',
        bot_id: 'bot-research',
        run_id: 'research-run-3',
        last_event_ts: '2026-02-16T09:59:30+09:00',
        status: 'error',
        severity: 'P2',
        last_success_ts: '2026-02-16T08:30:00+09:00',
        consecutive_failures_by_issue: {},
    });
    writeJson(path.join(tmpRoot, 'logs', 'bot-research', 'heartbeat.json'), {
        schema_version: '1.0',
        bot_id: 'bot-research',
        run_id: 'research-run-3',
        ts: '2026-02-16T09:59:30+09:00',
        state: 'running',
    });
    appendJsonl(path.join(tmpRoot, 'logs', 'bot-research', 'events', '2026-02-16.jsonl'), [
        {
            schema_version: '1.0',
            ts: '2026-02-16T09:40:00+09:00',
            bot_id: 'bot-research',
            run_id: 'research-run-1',
            event_type: 'end',
            status: 'error',
            severity: 'P2',
            component: 'publisher',
            message: 'Run failed after maximum retries.',
            error: {
                type: 'HttpError',
                code: 'UPSTREAM_503',
                message: 'Upstream service returned 503.',
                fingerprint: 'fp_bot_research_upstream_503',
            },
        },
        {
            schema_version: '1.0',
            ts: '2026-02-16T09:50:00+09:00',
            bot_id: 'bot-research',
            run_id: 'research-run-2',
            event_type: 'end',
            status: 'error',
            severity: 'P2',
            component: 'publisher',
            message: 'Run failed after maximum retries.',
            error: {
                type: 'HttpError',
                code: 'UPSTREAM_503',
                message: 'Upstream service returned 503.',
                fingerprint: 'fp_bot_research_upstream_503',
            },
        },
        {
            schema_version: '1.0',
            ts: '2026-02-16T09:59:30+09:00',
            bot_id: 'bot-research',
            run_id: 'research-run-3',
            event_type: 'end',
            status: 'error',
            severity: 'P2',
            component: 'publisher',
            message: 'Run failed after maximum retries.',
            error: {
                type: 'HttpError',
                code: 'UPSTREAM_503',
                message: 'Upstream service returned 503.',
                fingerprint: 'fp_bot_research_upstream_503',
            },
        },
    ]);

    const supervisor = require('./ops_daily_supervisor');
    const result = supervisor.runScan({
        now,
        configPath,
        sendEnabled: true,
    });

    assert.strictEqual(result.ok, true);
    const issuesPath = path.join(tmpRoot, 'ops', 'state', 'issues.json');
    const issues = JSON.parse(fs.readFileSync(issuesPath, 'utf8'));
    const key = 'bot-research:fp_bot_research_upstream_503';
    assert.ok(issues.issues[key], 'issue should exist');
    assert.ok(issues.issues[key].consecutive_failures >= 3, 'issue should have failure streak >= 3');

    const sentDir = path.join(tmpRoot, 'ops', 'alerts', 'sent');
    const sentFiles = fs.existsSync(sentDir) ? fs.readdirSync(sentDir).filter((name) => name.endsWith('.json')) : [];
    assert.ok(sentFiles.length >= 1, 'expected at least one sent alert file');
}

run();
console.log('test_ops_daily_supervisor_e2e: ok');
