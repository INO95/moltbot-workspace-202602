const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureTestOpsIsolation } = require('./lib/test_ops_isolation');

ensureTestOpsIsolation('bridge-approve-command');

const { routeByPrefix } = require('./bridge');
const opsApprovalStore = require('./ops_approval_store');

const ROOT = path.join(__dirname, '..');
const LAST_APPROVAL_HINTS_PATH = String(process.env.OPS_LAST_APPROVAL_HINTS_PATH || '').trim()
    || path.join(ROOT, 'data', 'runtime', 'ops_last_approval_hints.json');

function runBridge(message) {
    const res = spawnSync('node', ['scripts/bridge.js', 'auto', message], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            BRIDGE_ALLOWLIST_ENABLED: 'true',
            MOLTBOT_DISABLE_APPROVAL_TOKENS: '0',
        },
    });
    assert.strictEqual(res.status, 0, `bridge failed: ${res.stderr || res.stdout}`);
    return JSON.parse(String(res.stdout || '{}').trim());
}

function readHintsSnapshot() {
    try {
        if (!fs.existsSync(LAST_APPROVAL_HINTS_PATH)) return null;
        return fs.readFileSync(LAST_APPROVAL_HINTS_PATH, 'utf8');
    } catch (_) {
        return null;
    }
}

function writeHint(ownerKey, requestId, capability = 'exec', action = 'run') {
    const payload = {
        [ownerKey]: {
            owner_key: ownerKey,
            request_id: requestId,
            capability,
            action,
            updated_at: new Date().toISOString(),
        },
    };
    fs.mkdirSync(path.dirname(LAST_APPROVAL_HINTS_PATH), { recursive: true });
    fs.writeFileSync(LAST_APPROVAL_HINTS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function main() {
    const token = 'apv_deadbeefdeadbeef';
    const wrapped = `[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:05 UTC] APPROVE ${token} --force --push [message_id: 12]`;
    const plain = `APPROVE ${token} --force`;
    const denyWrapped = `[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:06 UTC] /deny ${token} [message_id: 13]`;
    const noToken = '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:07 UTC] 운영: 액션: 승인 [message_id: 14]';
    const naturalApprove = '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:08 UTC] 응 승인해 [message_id: 15]';

    const routed = routeByPrefix(wrapped);
    assert.strictEqual(routed.route, 'ops');
    assert.ok(routed.payload.includes('액션: 승인'));
    assert.ok(routed.payload.includes(`토큰: ${token}`));

    const out = runBridge(wrapped);
    assert.strictEqual(out.route, 'ops');
    assert.strictEqual(out.templateValid, true);
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.action, 'approve');
    assert.strictEqual(out.phase, 'execute');
    assert.strictEqual(out.token, token);
    assert.deepStrictEqual(out.approvalFlags, ['force', 'push']);

    const plainOut = runBridge(plain);
    assert.strictEqual(plainOut.route, 'ops');
    assert.strictEqual(plainOut.templateValid, true);
    assert.strictEqual(plainOut.success, true);
    assert.strictEqual(plainOut.action, 'approve');
    assert.strictEqual(plainOut.phase, 'execute');
    assert.strictEqual(plainOut.token, token);
    assert.deepStrictEqual(plainOut.approvalFlags, ['force']);

    const denyOut = runBridge(denyWrapped);
    assert.strictEqual(denyOut.route, 'ops');
    assert.strictEqual(denyOut.templateValid, true);
    assert.strictEqual(denyOut.success, true);
    assert.strictEqual(denyOut.action, 'deny');
    assert.strictEqual(denyOut.phase, 'execute');
    assert.strictEqual(denyOut.token, token);

    const autoTokenRecord = opsApprovalStore.createApprovalToken({
        requestedBy: '7704103236',
        requestId: `test-approve-notoken-${Date.now()}`,
        actionType: 'exec',
        riskLevel: 'HIGH',
        requiredFlags: [],
        plan: {
            command_kind: 'capability',
            capability: 'exec',
            action: 'run',
            intent_action: 'capability:exec:run',
            payload: { command: 'pwd' },
            risk_tier: 'HIGH',
            mutating: true,
            required_flags: [],
        },
    });
    const prevHints = readHintsSnapshot();
    try {
        writeHint('7704103236', autoTokenRecord.request_id || `test-approve-notoken-${Date.now()}`);
        const noTokenOut = runBridge(noToken);
        assert.strictEqual(noTokenOut.route, 'ops');
        assert.strictEqual(noTokenOut.templateValid, true);
        assert.strictEqual(noTokenOut.success, true);
        assert.strictEqual(noTokenOut.action, 'approve');
        assert.strictEqual(noTokenOut.phase, 'execute');
        assert.strictEqual(noTokenOut.token, autoTokenRecord.token);

        // 자연어 승인 문구도 동일하게 승인 라우팅되어야 한다.
        writeHint('7704103236', autoTokenRecord.request_id || `test-approve-notoken-${Date.now()}`);
        const naturalOut = runBridge(naturalApprove);
        assert.strictEqual(naturalOut.route, 'ops');
        assert.strictEqual(naturalOut.templateValid, true);
        assert.strictEqual(naturalOut.success, true);
        assert.strictEqual(naturalOut.action, 'approve');
        assert.strictEqual(naturalOut.phase, 'execute');
        assert.strictEqual(naturalOut.token, autoTokenRecord.token);
    } finally {
        fs.rmSync(path.join(opsApprovalStore.APPROVAL_PENDING_DIR, `${autoTokenRecord.token}.json`), { force: true });
        fs.rmSync(path.join(opsApprovalStore.APPROVAL_CONSUMED_DIR, `${autoTokenRecord.token}.json`), { force: true });
        opsApprovalStore.syncPendingApprovalsMirror();
        if (prevHints == null) {
            fs.rmSync(LAST_APPROVAL_HINTS_PATH, { force: true });
        } else {
            fs.writeFileSync(LAST_APPROVAL_HINTS_PATH, prevHints, 'utf8');
        }
    }

    console.log('test_bridge_approve_command: ok');
}

main();
