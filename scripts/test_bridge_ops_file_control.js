const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureTestOpsIsolation } = require('./lib/test_ops_isolation');

ensureTestOpsIsolation('bridge-ops-file-control');

const opsCommandQueue = require('./ops_command_queue');

const ROOT = path.join(__dirname, '..');

function runBridge(message) {
    const res = spawnSync('node', ['scripts/bridge.js', 'auto', message], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, BRIDGE_ALLOWLIST_ENABLED: 'true' },
    });
    assert.strictEqual(res.status, 0, `bridge failed: ${res.stderr || res.stdout}`);
    const out = JSON.parse(String(res.stdout || '{}').trim());
    return out;
}

function listOutbox() {
    if (!fs.existsSync(opsCommandQueue.OUTBOX_DIR)) return [];
    return fs.readdirSync(opsCommandQueue.OUTBOX_DIR)
        .filter((name) => name.endsWith('.json'))
        .sort();
}

function main() {
    opsCommandQueue.ensureLayout();

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-opsfc-'));
    const srcDir = path.join(tmpRoot, 'src');
    const dstDir = path.join(tmpRoot, 'dst');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(dstDir, { recursive: true });
    const srcFile = path.join(srcDir, 'sample.txt');
    fs.writeFileSync(srcFile, 'hello', 'utf8');

    const before = new Set(listOutbox());
    const wrapped = `[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:00 UTC] 운영: 액션: 파일; 작업: move; 경로: ${srcFile}; 대상경로: ${dstDir} [message_id: 11]`;
    const out = runBridge(wrapped);

    assert.strictEqual(out.route, 'ops');
    assert.strictEqual(out.templateValid, true);
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.phase, 'plan');
    assert.strictEqual(out.queued, true);
    assert.strictEqual(out.intentAction, 'move');

    const after = listOutbox();
    const added = after.filter((name) => !before.has(name));
    assert.ok(added.length >= 1, 'expected new outbox file for PLAN request');
    const latest = path.join(opsCommandQueue.OUTBOX_DIR, added[added.length - 1]);
    const row = JSON.parse(fs.readFileSync(latest, 'utf8'));
    assert.strictEqual(row.phase, 'plan');
    assert.strictEqual(row.intent_action, 'move');
    assert.strictEqual(row.requested_by, '7704103236');
    assert.strictEqual(row.telegram_context.provider, 'telegram');
    assert.strictEqual(row.payload.path, srcFile);

    const blocked = runBridge(`운영: 액션: 파일; 작업: move; 경로: ${srcFile}; 대상경로: ${dstDir}`);
    assert.strictEqual(blocked.route, 'ops');
    assert.strictEqual(blocked.success, false);
    assert.strictEqual(blocked.errorCode, 'TELEGRAM_CONTEXT_REQUIRED');

    console.log('test_bridge_ops_file_control: ok');
}

main();
