const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { routeByPrefix } = require('./bridge');
const opsCommandQueue = require('./ops_command_queue');

const ROOT = path.join(__dirname, '..');

function runBridge(message) {
    const res = spawnSync('node', ['scripts/bridge.js', 'auto', message], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, BRIDGE_ALLOWLIST_ENABLED: 'true' },
    });
    assert.strictEqual(res.status, 0, `bridge failed: ${res.stderr || res.stdout}`);
    return JSON.parse(String(res.stdout || '{}').trim());
}

function listOutbox() {
    if (!fs.existsSync(opsCommandQueue.OUTBOX_DIR)) return [];
    return fs.readdirSync(opsCommandQueue.OUTBOX_DIR)
        .filter((name) => name.endsWith('.json'))
        .sort();
}

function main() {
    const token = 'apv_deadbeefdeadbeef';
    const wrapped = `[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:05 UTC] APPROVE ${token} --force --push [message_id: 12]`;

    const routed = routeByPrefix(wrapped);
    assert.strictEqual(routed.route, 'ops');
    assert.ok(routed.payload.includes('액션: 승인'));
    assert.ok(routed.payload.includes(`토큰: ${token}`));

    const before = new Set(listOutbox());
    const out = runBridge(wrapped);

    assert.strictEqual(out.route, 'ops');
    assert.strictEqual(out.templateValid, true);
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.phase, 'execute');
    assert.strictEqual(out.token, token);
    assert.deepStrictEqual(out.approvalFlags, ['force', 'push']);

    const after = listOutbox();
    const added = after.filter((name) => !before.has(name));
    assert.ok(added.length >= 1, 'expected new execute outbox file');
    const latest = path.join(opsCommandQueue.OUTBOX_DIR, added[added.length - 1]);
    const row = JSON.parse(fs.readFileSync(latest, 'utf8'));
    assert.strictEqual(row.phase, 'execute');
    assert.strictEqual(row.payload.token, token);
    assert.deepStrictEqual(row.payload.approval_flags, ['force', 'push']);

    console.log('test_bridge_approve_command: ok');
}

main();
