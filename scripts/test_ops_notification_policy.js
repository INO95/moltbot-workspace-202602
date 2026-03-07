const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean);
}

function runWorker(bridgeDir) {
    const res = spawnSync('node', ['scripts/ops_host_worker.js'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            SKILL_FEEDBACK_AUTORUN: '0',
            TELEGRAM_FINALIZER_ECHO_ONLY: 'true',
            BRIDGE_DIR: bridgeDir,
            OPS_WORKSPACE_ROOT: process.env.OPS_WORKSPACE_ROOT,
            OPS_COMMANDS_ROOT: process.env.OPS_COMMANDS_ROOT,
            MOLTBOT_BOT_ID: 'bot-daily',
        },
    });
    assert.strictEqual(res.status, 0, `ops_host_worker failed: ${res.stderr || res.stdout}`);
}

function enqueueUnsupportedPlanRequest(opsCommandQueue, { requestId, requestedBy, telegramContext }) {
    opsCommandQueue.enqueueCommand({
        schema_version: '1.0',
        request_id: requestId,
        command_kind: 'file_control',
        phase: 'plan',
        intent_action: 'not_supported_action',
        requested_by: requestedBy,
        telegram_context: telegramContext || null,
        payload: {},
        created_at: new Date().toISOString(),
    });
}

function main() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-notify-policy-root-'));
    process.env.OPS_WORKSPACE_ROOT = tmpRoot;
    process.env.OPS_COMMANDS_ROOT = path.join(tmpRoot, 'ops', 'commands');

    const opsCommandQueue = require('./ops_command_queue');
    opsCommandQueue.ensureLayout();

    const bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-notify-bridge-'));
    const testRequestId = `test-notify-policy-${Date.now()}-a`;
    const userRequestId = `ops-notify-policy-${Date.now()}-b`;

    enqueueUnsupportedPlanRequest(opsCommandQueue, {
        requestId: testRequestId,
        requestedBy: `test-suite:${Date.now()}`,
        telegramContext: null,
    });
    enqueueUnsupportedPlanRequest(opsCommandQueue, {
        requestId: userRequestId,
        requestedBy: 'telegram:7704103236',
        telegramContext: {
            provider: 'telegram',
            userId: '7704103236',
            groupId: '',
        },
    });

    runWorker(bridgeDir);

    const inboxRows = readJsonl(path.join(bridgeDir, 'inbox.jsonl'));
    const userRows = inboxRows.filter((row) => String(row.requestId || '') === userRequestId);
    assert.ok(userRows.length >= 1, 'user request row should be written to inbox');
    const userRow = userRows[userRows.length - 1];
    assert.strictEqual(userRow.command, 'ops:file-control:plan');
    assert.strictEqual(userRow.status, 'failed');
    assert.strictEqual(
        String(userRow.metadata && userRow.metadata.errorCode ? userRow.metadata.errorCode : ''),
        'UNSUPPORTED_ACTION',
    );

    const testRows = inboxRows.filter((row) => String(row.requestId || '') === testRequestId);
    assert.ok(testRows.length >= 1, 'test request row should also be persisted for audit trail');
}

main();
console.log('test_ops_notification_policy: ok');
