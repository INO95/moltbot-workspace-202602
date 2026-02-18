const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const opsCommandQueue = require('./ops_command_queue');
const opsApprovalStore = require('./ops_approval_store');

function runWorker() {
    const res = spawnSync('node', ['scripts/ops_host_worker.js'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            SKILL_FEEDBACK_AUTORUN: '0',
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

function enqueueCapabilityCleanup(requestId, requesterId, rootPath) {
    opsCommandQueue.enqueueCommand({
        schema_version: '1.0',
        request_id: requestId,
        command_kind: 'capability',
        phase: 'plan',
        capability: 'photo',
        action: 'cleanup',
        intent_action: 'capability:photo:cleanup',
        requested_by: requesterId,
        payload: {
            path: rootPath,
            older_than_hours: 1,
        },
        created_at: new Date().toISOString(),
    });
}

function enqueueExecute(requestId, requesterId, token) {
    opsCommandQueue.enqueueCommand({
        schema_version: '1.0',
        request_id: requestId,
        phase: 'execute',
        intent_action: 'execute',
        requested_by: requesterId,
        payload: {
            token,
            approval_flags: ['force'],
        },
        created_at: new Date().toISOString(),
    });
}

function getResultByRequestId(requestId) {
    const rows = readResults();
    return rows.find((row) => row && row.request_id === requestId) || null;
}

function touchOldFile(filePath) {
    fs.writeFileSync(filePath, 'x', 'utf8');
    const old = new Date(Date.now() - (2 * 60 * 60 * 1000));
    fs.utimesSync(filePath, old, old);
}

function main() {
    opsCommandQueue.ensureLayout();
    opsApprovalStore.ensureLayout();

    const requesterId = `test-approval-grant-${Date.now()}`;
    opsApprovalStore.clearApprovalGrant(requesterId);

    const photoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-grant-photo-'));
    touchOldFile(path.join(photoRoot, 'old-1.jpg'));

    const firstPlanId = `test-grant-plan1-${Date.now()}`;
    enqueueCapabilityCleanup(firstPlanId, requesterId, photoRoot);
    runWorker();

    const firstPlanRow = getResultByRequestId(firstPlanId);
    assert.ok(firstPlanRow, 'first cleanup plan result should exist');
    assert.strictEqual(firstPlanRow.ok, true);
    assert.ok(firstPlanRow.token_id, 'first cleanup plan should mint approval token');

    const executeId = `test-grant-exec-${Date.now()}`;
    enqueueExecute(executeId, requesterId, firstPlanRow.token_id);
    runWorker();

    const executeRow = getResultByRequestId(executeId);
    assert.ok(executeRow, 'execute result should exist');
    assert.strictEqual(executeRow.ok, true);

    const grantState = opsApprovalStore.hasActiveApprovalGrant({
        requestedBy: requesterId,
        scope: 'all',
    });
    assert.strictEqual(grantState.active, true, 'approval grant should be active after execute approval');
    assert.ok(grantState.record && grantState.record.expires_at, 'grant record should include expires_at');

    touchOldFile(path.join(photoRoot, 'old-2.jpg'));
    const secondPlanId = `test-grant-plan2-${Date.now()}`;
    enqueueCapabilityCleanup(secondPlanId, requesterId, photoRoot);
    runWorker();

    const secondPlanRow = getResultByRequestId(secondPlanId);
    assert.ok(secondPlanRow, 'second cleanup result should exist');
    assert.strictEqual(secondPlanRow.ok, true);
    assert.strictEqual(secondPlanRow.token_id, null, 'second cleanup should bypass token with active grant');
    assert.ok(Array.isArray(secondPlanRow.executed_steps) && secondPlanRow.executed_steps.length > 0, 'second cleanup should execute immediately');

    opsApprovalStore.clearApprovalGrant(requesterId);
    console.log('test_ops_approval_grant_flow: ok');
}

main();
