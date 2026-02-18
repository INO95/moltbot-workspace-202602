const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const config = require('../data/config.json');
const opsCommandQueue = require('./ops_command_queue');
const opsApprovalStore = require('./ops_approval_store');
const approvalAuditLog = require('./approval_audit_log');

function runWorker() {
    const res = spawnSync('node', ['scripts/ops_host_worker.js'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            SKILL_FEEDBACK_AUTORUN: '0',
            TELEGRAM_FINALIZER_ECHO_ONLY: 'true',
        },
    });
    assert.strictEqual(res.status, 0, `ops_host_worker failed: ${res.stderr || res.stdout}`);
}

function readResults() {
    if (!fs.existsSync(opsCommandQueue.RESULTS_PATH)) return [];
    return fs.readFileSync(opsCommandQueue.RESULTS_PATH, 'utf8')
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

function enqueueCapabilityPlan(requestId, requesterId, capability, action, payload) {
    opsCommandQueue.enqueueCommand({
        schema_version: '1.0',
        request_id: requestId,
        command_kind: 'capability',
        phase: 'plan',
        capability,
        action,
        intent_action: `capability:${capability}:${action}`,
        requested_by: requesterId,
        payload: payload || {},
        created_at: new Date().toISOString(),
    });
}

function enqueueDenyExecute(requestId, requesterId, token) {
    opsCommandQueue.enqueueCommand({
        schema_version: '1.0',
        request_id: requestId,
        phase: 'execute',
        intent_action: 'execute',
        requested_by: requesterId,
        payload: {
            token,
            decision: 'deny',
        },
        created_at: new Date().toISOString(),
    });
}

function findResultRow(requestId) {
    return readResults().find((row) => row && row.request_id === requestId) || null;
}

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

function resolvePendingStatePath() {
    const section = (config && typeof config.opsUnifiedApprovals === 'object')
        ? config.opsUnifiedApprovals
        : {};
    const raw = String(section.pendingStatePath || 'data/state/pending_approvals.json').trim();
    return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

function main() {
    opsCommandQueue.ensureLayout();
    opsApprovalStore.ensureLayout();
    opsApprovalStore.syncPendingApprovalsMirror();

    const requesterId = `test-exec-allow-${Date.now()}`;
    const pendingStatePath = resolvePendingStatePath();
    const auditPath = approvalAuditLog.logPathForDate(new Date().toISOString(), approvalAuditLog.resolveSettings());
    const auditBefore = readJsonl(auditPath).length;

    const safeId = `test-exec-safe-${Date.now()}`;
    enqueueCapabilityPlan(safeId, requesterId, 'exec', 'run', { command: 'pwd' });
    runWorker();
    const safeRow = findResultRow(safeId);
    assert.ok(safeRow, 'safe exec result should exist');
    assert.strictEqual(safeRow.command_kind, 'capability');
    assert.strictEqual(safeRow.capability, 'exec');
    assert.strictEqual(safeRow.action, 'run');
    assert.strictEqual(safeRow.ok, true);
    assert.strictEqual(safeRow.token_id, null, 'safe exec must run without approval token');

    const riskyId = `test-exec-risky-${Date.now()}`;
    enqueueCapabilityPlan(riskyId, requesterId, 'exec', 'run', { command: 'git push origin main' });
    runWorker();
    const riskyRow = findResultRow(riskyId);
    assert.ok(riskyRow, 'risky exec plan result should exist');
    assert.strictEqual(riskyRow.ok, true);
    assert.ok(riskyRow.token_id, 'risky exec plan must mint approval token');

    const riskyToken = String(riskyRow.token_id || '');
    const riskyPending = opsApprovalStore.readPendingToken(riskyToken);
    assert.ok(riskyPending, 'risky exec token must exist in pending store');
    assert.strictEqual(String(riskyPending.action_type || ''), 'exec');

    const pendingStateAfterRisky = JSON.parse(fs.readFileSync(pendingStatePath, 'utf8'));
    const pendingRisky = Array.isArray(pendingStateAfterRisky.pending)
        ? pendingStateAfterRisky.pending.find((row) => row && row.id === riskyToken)
        : null;
    assert.ok(pendingRisky, 'risky token must appear in pending approvals mirror');
    assert.strictEqual(pendingRisky.action_type, 'exec');
    assert.strictEqual(pendingRisky.status, 'pending');

    const denyId = `test-exec-deny-${Date.now()}`;
    enqueueDenyExecute(denyId, requesterId, riskyToken);
    runWorker();
    const denyRow = findResultRow(denyId);
    assert.ok(denyRow, 'deny execute result should exist');
    assert.strictEqual(denyRow.ok, true);
    assert.strictEqual(String((denyRow.details && denyRow.details.action) || ''), 'deny');

    const deniedConsumed = opsApprovalStore.readConsumedToken(riskyToken);
    assert.ok(deniedConsumed, 'denied token must exist in consumed store');
    assert.strictEqual(String(deniedConsumed.status || ''), 'denied');

    opsApprovalStore.syncPendingApprovalsMirror();
    const pendingStateAfterDeny = JSON.parse(fs.readFileSync(pendingStatePath, 'utf8'));
    const deniedPending = Array.isArray(pendingStateAfterDeny.pending)
        ? pendingStateAfterDeny.pending.find((row) => row && row.id === riskyToken)
        : null;
    assert.strictEqual(deniedPending, undefined, 'denied token must be removed from pending mirror');

    const ttlToken = opsApprovalStore.createApprovalToken({
        requestedBy: requesterId,
        requestId: `test-expire-${Date.now()}`,
        ttlSeconds: 1,
        requiredFlags: ['force'],
        actionType: 'exec',
        riskLevel: 'HIGH',
        plan: {
            command_kind: 'capability',
            capability: 'exec',
            action: 'run',
            intent_action: 'capability:exec:run',
            payload: { command: 'git push origin main' },
            risk_tier: 'HIGH',
            mutating: true,
            required_flags: ['force'],
        },
    });
    const ttlPath = path.join(opsApprovalStore.APPROVAL_PENDING_DIR, `${ttlToken.token}.json`);
    const forcedExpired = JSON.parse(fs.readFileSync(ttlPath, 'utf8'));
    forcedExpired.expires_at = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(ttlPath, `${JSON.stringify(forcedExpired, null, 2)}\n`, 'utf8');
    let expiredCode = '';
    try {
        opsApprovalStore.validateApproval({
            token: ttlToken.token,
            requestedBy: requesterId,
            providedFlags: ['force'],
        });
    } catch (error) {
        expiredCode = String(error && error.code ? error.code : '');
    }
    assert.strictEqual(expiredCode, 'TOKEN_EXPIRED', 'expired token should be rejected');
    const expiredConsumed = opsApprovalStore.readConsumedToken(ttlToken.token);
    assert.ok(expiredConsumed, 'expired token must be moved to consumed');
    assert.strictEqual(String(expiredConsumed.status || ''), 'expired');

    const browserId = `test-browser-risky-${Date.now()}`;
    enqueueCapabilityPlan(browserId, requesterId, 'browser', 'send', {
        url: 'https://example.com',
        method: 'POST',
        content: 'hello',
    });
    runWorker();
    const browserRow = findResultRow(browserId);
    assert.ok(browserRow, 'browser risky plan result should exist');
    assert.ok(browserRow.token_id, 'browser risky plan must mint approval token');
    const browserPending = opsApprovalStore.readPendingToken(browserRow.token_id);
    assert.ok(browserPending, 'browser pending token should exist');
    assert.strictEqual(String(browserPending.action_type || ''), 'browser');

    const auditAfterRows = readJsonl(auditPath).slice(auditBefore);
    assert.ok(auditAfterRows.length > 0, 'approval audit log rows should be appended');
    assert.ok(auditAfterRows.some((row) => row && row.event_type === 'auto_execute_decision' && row.request_id === safeId));
    assert.ok(auditAfterRows.some((row) => row && row.event_type === 'approval_request_created' && row.request_id === riskyId));
    assert.ok(auditAfterRows.some((row) => row && row.event_type === 'approval_decision' && row.decision === 'denied'));
    assert.ok(auditAfterRows.some((row) => row && row.event_type === 'execution_result' && row.request_id === safeId));

    const appendedRaw = auditAfterRows.map((row) => JSON.stringify(row)).join('\n');
    assert.ok(!appendedRaw.includes(riskyToken), 'raw approval token must not be logged');

    fs.rmSync(path.join(opsApprovalStore.APPROVAL_PENDING_DIR, `${browserRow.token_id}.json`), { force: true });
    fs.rmSync(path.join(opsApprovalStore.APPROVAL_CONSUMED_DIR, `${browserRow.token_id}.json`), { force: true });
    fs.rmSync(path.join(opsApprovalStore.APPROVAL_CONSUMED_DIR, `${ttlToken.token}.json`), { force: true });
    fs.rmSync(path.join(opsApprovalStore.APPROVAL_CONSUMED_DIR, `${riskyToken}.json`), { force: true });
    opsApprovalStore.clearApprovalGrant(requesterId);
    opsApprovalStore.syncPendingApprovalsMirror();

    console.log('test_exec_allowlist_approvals: ok');
}

main();
