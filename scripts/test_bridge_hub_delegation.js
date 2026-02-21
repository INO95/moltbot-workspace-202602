const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureTestOpsIsolation } = require('./lib/test_ops_isolation');

ensureTestOpsIsolation('bridge-hub-delegation');

const opsCommandQueue = require('./ops_command_queue');

const ROOT = path.join(__dirname, '..');

function listOutbox() {
    if (!fs.existsSync(opsCommandQueue.OUTBOX_DIR)) return [];
    return fs.readdirSync(opsCommandQueue.OUTBOX_DIR)
        .filter((name) => name.endsWith('.json'))
        .sort();
}

function runAuto(message, env = {}) {
    const res = spawnSync('node', ['scripts/bridge.js', 'auto', message], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            MOLTBOT_BOT_ROLE: 'supervisor',
            MOLTBOT_BOT_ID: 'bot-daily',
            BRIDGE_ALLOWLIST_ENABLED: 'true',
            BRIDGE_ALLOWLIST_DIRECT_COMMANDS: 'auto',
            BRIDGE_ALLOWLIST_AUTO_ROUTES: 'word,memo,news,report,work,inspect,deploy,project,prompt,link,status,ops,finance,todo,routine,workout,media,place',
            ...env,
        },
    });
    assert.strictEqual(res.status, 0, `bridge failed: ${res.stderr || res.stdout}`);
    return JSON.parse(String(res.stdout || '{}').trim());
}

function findAddedRowByRequestId(beforeSet, requestId) {
    assert.ok(requestId, 'expected requestId in bridge response');
    const added = listOutbox().filter((name) => !beforeSet.has(name));
    for (let i = added.length - 1; i >= 0; i -= 1) {
        const queuePath = path.join(opsCommandQueue.OUTBOX_DIR, added[i]);
        const row = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        if (String(row.request_id || '') === String(requestId)) {
            return { queuePath, row };
        }
    }
    assert.fail(`expected queue row for request_id=${requestId}`);
}

function main() {
    opsCommandQueue.ensureLayout();
    const before = new Set(listOutbox());

    const delegated = runAuto('작업: 요청: hub test; 대상: repo; 완료기준: done');
    assert.strictEqual(delegated.route, 'work');
    assert.strictEqual(delegated.delegated, true);
    assert.strictEqual(delegated.capability, 'bot');
    assert.strictEqual(delegated.capabilityAction, 'dispatch');
    assert.strictEqual(delegated.targetProfile, 'dev');
    assert.strictEqual(delegated.queued, true);

    const queued = findAddedRowByRequestId(before, delegated.requestId);
    const row = queued.row;
    assert.strictEqual(row.command_kind, 'capability');
    assert.strictEqual(row.capability, 'bot');
    assert.strictEqual(row.action, 'dispatch');
    assert.strictEqual(row.payload.target_profile, 'dev');
    assert.strictEqual(row.payload.route, 'work');
    assert.ok(String(row.payload.original_message || '').startsWith('작업:'), 'original message must be forwarded');

    const statusOut = runAuto('상태:');
    assert.strictEqual(statusOut.route, 'status');
    assert.ok(!statusOut.delegated, 'status route must stay local on daily hub');

    const financeOut = runAuto('가계: 점심 1200엔');
    assert.strictEqual(financeOut.route, 'finance');
    assert.ok(!financeOut.delegated, 'finance route must stay local on daily hub');

    fs.rmSync(queued.queuePath, { force: true });

    console.log('test_bridge_hub_delegation: ok');
}

main();
