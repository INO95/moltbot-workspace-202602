const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function listOutbox(opsCommandQueue) {
    if (!fs.existsSync(opsCommandQueue.OUTBOX_DIR)) return [];
    return fs.readdirSync(opsCommandQueue.OUTBOX_DIR)
        .filter((name) => name.endsWith('.json'))
        .sort();
}

function run() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-remediation-'));
    process.env.OPS_WORKSPACE_ROOT = tmpRoot;
    process.env.OPS_COMMANDS_ROOT = path.join(tmpRoot, 'ops', 'commands');
    process.env.OPS_PENDING_APPROVALS_STATE_PATH = path.join(tmpRoot, 'data', 'state', 'pending_approvals.json');
    process.env.BRIDGE_DIR = path.join(tmpRoot, 'data', 'bridge');
    const opsCommandQueue = require('./ops_command_queue');

    const configPath = path.join(tmpRoot, 'ops', 'config', 'daily_ops_mvp.json');
    const remediationPath = path.join(tmpRoot, 'ops', 'config', 'remediation_policy.json');

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
            'bot-research': {
                active: true,
                logical_bot_id: 'bot-c',
                profile: 'research',
                container: 'moltbot-research',
            },
        },
    });

    writeJson(remediationPath, {
        schema_version: '1.0',
        mode: 'low_risk_auto',
        defaults: {
            cooldown_minutes: 30,
            max_attempts: 1,
            rearm_on_recovery: true,
        },
        rules: [
            {
                issue_pattern: ':heartbeat_stall$',
                enabled: true,
                auto_actions: [
                    {
                        capability: 'bot',
                        action: 'restart',
                        target: 'worker_container',
                    },
                ],
                cooldown_minutes: 30,
                max_attempts: 1,
                escalation_rule: 'alert_if_repeated',
            },
        ],
    });

    writeJson(path.join(tmpRoot, 'logs', 'bot-research', 'latest.json'), {
        schema_version: '1.0',
        bot_id: 'bot-research',
        run_id: 'research-run-1',
        last_event_ts: '2026-02-16T09:50:00+09:00',
        status: 'error',
        severity: 'P2',
        last_success_ts: '2026-02-16T08:30:00+09:00',
        consecutive_failures_by_issue: {},
    });
    writeJson(path.join(tmpRoot, 'logs', 'bot-research', 'heartbeat.json'), {
        schema_version: '1.0',
        bot_id: 'bot-research',
        run_id: 'research-run-1',
        ts: '2026-02-16T09:30:00+09:00',
        state: 'running',
    });

    const supervisor = require('./ops_daily_supervisor');
    opsCommandQueue.ensureLayout();

    const outboxBefore = new Set(listOutbox(opsCommandQueue));
    const first = supervisor.runScan({
        now: '2026-02-16T10:00:00+09:00',
        configPath,
        remediationPolicyPath: remediationPath,
        sendEnabled: false,
    });
    const outboxAfterFirst = listOutbox(opsCommandQueue);
    const addedFirst = outboxAfterFirst.filter((name) => !outboxBefore.has(name));

    assert.ok(first.remediations.some((item) => item.issue_id === 'bot-research:heartbeat_stall' && item.status === 'queued'));
    assert.ok(addedFirst.length >= 1, 'first scan should enqueue remediation command');

    const second = supervisor.runScan({
        now: '2026-02-16T10:40:00+09:00',
        configPath,
        remediationPolicyPath: remediationPath,
        sendEnabled: false,
    });
    const outboxAfterSecond = listOutbox(opsCommandQueue);
    const addedSecond = outboxAfterSecond.filter((name) => !outboxBefore.has(name));

    assert.ok(second.remediations.some((item) => item.issue_id === 'bot-research:heartbeat_stall' && item.reason === 'max_attempts_reached'));
    assert.strictEqual(addedSecond.length, addedFirst.length, 'max-attempt lock must block additional remediation commands');

    // Recovery: heartbeat goes fresh and stall issue should resolve.
    writeJson(path.join(tmpRoot, 'logs', 'bot-research', 'heartbeat.json'), {
        schema_version: '1.0',
        bot_id: 'bot-research',
        run_id: 'research-run-1',
        ts: '2026-02-16T11:00:00+09:00',
        state: 'running',
    });
    supervisor.runScan({
        now: '2026-02-16T11:01:00+09:00',
        configPath,
        remediationPolicyPath: remediationPath,
        sendEnabled: false,
    });

    // Regress again after recovery: attempts should be re-armed and queued again.
    writeJson(path.join(tmpRoot, 'logs', 'bot-research', 'heartbeat.json'), {
        schema_version: '1.0',
        bot_id: 'bot-research',
        run_id: 'research-run-2',
        ts: '2026-02-16T10:00:00+09:00',
        state: 'running',
    });
    const third = supervisor.runScan({
        now: '2026-02-16T11:40:00+09:00',
        configPath,
        remediationPolicyPath: remediationPath,
        sendEnabled: false,
    });
    const outboxAfterThird = listOutbox(opsCommandQueue);
    const addedThird = outboxAfterThird.filter((name) => !outboxBefore.has(name));
    assert.ok(third.remediations.some((item) => item.issue_id === 'bot-research:heartbeat_stall' && item.status === 'queued'));
    assert.ok(addedThird.length > addedSecond.length, 're-armed issue should enqueue remediation again after recovery');

    // cleanup outbox rows added by this test
    for (const name of addedThird) {
        fs.rmSync(path.join(opsCommandQueue.OUTBOX_DIR, name), { force: true });
    }
}

run();
console.log('test_ops_auto_remediation: ok');
