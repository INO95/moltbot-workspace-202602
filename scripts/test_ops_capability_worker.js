const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const opsCommandQueue = require('./ops_command_queue');
const opsApprovalStore = require('./ops_approval_store');
const finalizer = require('./finalizer');
const { finalizeOpsTelegramReply } = require('./ops_host_worker');

const ROOT = path.join(__dirname, '..');

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
    return JSON.parse(String(res.stdout || '{}').trim());
}

function main() {
    opsCommandQueue.ensureLayout();
    opsApprovalStore.ensureLayout();
    const requesterId = `test-opsc-${Date.now()}`;
    opsApprovalStore.clearApprovalGrant(requesterId);

    const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opsc-photo-'));
    fs.writeFileSync(path.join(photoDir, 'a.jpg'), 'x', 'utf8');

    const photoRequestId = `test-opsc-photo-${Date.now()}`;
    opsCommandQueue.enqueueCommand({
        schema_version: '1.0',
        request_id: photoRequestId,
        command_kind: 'capability',
        phase: 'plan',
        capability: 'photo',
        action: 'list',
        intent_action: 'capability:photo:list',
        requested_by: requesterId,
        payload: {
            path: photoDir,
        },
        created_at: new Date().toISOString(),
    });

    const beforeRows = readResults().length;
    runWorker();
    const afterRows = readResults();
    const photoRow = afterRows.find((row) => row && row.request_id === photoRequestId);
    assert.ok(photoRow, 'photo capability result should exist');
    assert.strictEqual(photoRow.command_kind, 'capability');
    assert.strictEqual(photoRow.capability, 'photo');
    assert.strictEqual(photoRow.action, 'list');
    assert.strictEqual(photoRow.ok, true);
    assert.ok(afterRows.length > beforeRows, 'worker should append at least one result row');

    const mailRequestId = `test-opsc-mail-${Date.now()}`;
    opsCommandQueue.enqueueCommand({
        schema_version: '1.0',
        request_id: mailRequestId,
        command_kind: 'capability',
        phase: 'plan',
        capability: 'mail',
        action: 'send',
        intent_action: 'capability:mail:send',
        requested_by: requesterId,
        payload: {
            recipient: 'ops@example.com',
            subject: 'test subject',
            body: 'test body',
        },
        created_at: new Date().toISOString(),
    });

    runWorker();
    const rowsAfterMail = readResults();
    const mailRow = rowsAfterMail.find((row) => row && row.request_id === mailRequestId);
    assert.ok(mailRow, 'mail capability plan result should exist');
    assert.strictEqual(mailRow.command_kind, 'capability');
    assert.strictEqual(mailRow.capability, 'mail');
    assert.strictEqual(mailRow.action, 'send');
    assert.strictEqual(mailRow.ok, true);
    assert.ok(mailRow.token_id, 'mail send plan should mint approval token');

    const pendingTokenPath = path.join(opsApprovalStore.APPROVAL_PENDING_DIR, `${mailRow.token_id}.json`);
    assert.ok(fs.existsSync(pendingTokenPath), 'pending approval token file should exist');

    const browserRequestId = `test-opsc-browser-${Date.now()}`;
    opsCommandQueue.enqueueCommand({
        schema_version: '1.0',
        request_id: browserRequestId,
        command_kind: 'capability',
        phase: 'plan',
        capability: 'browser',
        action: 'send',
        intent_action: 'capability:browser:send',
        requested_by: requesterId,
        payload: {
            url: 'https://example.com',
            method: 'POST',
            content: 'hello',
        },
        created_at: new Date().toISOString(),
    });

    runWorker();
    const rowsAfterBrowser = readResults();
    const browserRow = rowsAfterBrowser.find((row) => row && row.request_id === browserRequestId);
    assert.ok(browserRow, 'browser capability plan result should exist');
    assert.strictEqual(browserRow.command_kind, 'capability');
    assert.strictEqual(browserRow.capability, 'browser');
    assert.strictEqual(browserRow.action, 'send');
    assert.strictEqual(browserRow.ok, true);
    assert.ok(browserRow.token_id, 'browser send plan should mint approval token');

    const browserTokenPath = path.join(opsApprovalStore.APPROVAL_PENDING_DIR, `${browserRow.token_id}.json`);
    assert.ok(fs.existsSync(browserTokenPath), 'browser pending approval token file should exist');

    const execSafeRequestId = `test-opsc-exec-safe-${Date.now()}`;
    opsCommandQueue.enqueueCommand({
      schema_version: '1.0',
      request_id: execSafeRequestId,
      command_kind: 'capability',
      phase: 'plan',
      capability: 'exec',
      action: 'run',
      intent_action: 'capability:exec:run',
      requested_by: requesterId,
      payload: {
        command: 'pwd',
      },
      created_at: new Date().toISOString(),
    });

    runWorker();
    const rowsAfterExecSafe = readResults();
    const execSafeRow = rowsAfterExecSafe.find((row) => row && row.request_id === execSafeRequestId);
    assert.ok(execSafeRow, 'exec safe capability result should exist');
    assert.strictEqual(execSafeRow.command_kind, 'capability');
    assert.strictEqual(execSafeRow.capability, 'exec');
    assert.strictEqual(execSafeRow.action, 'run');
    assert.strictEqual(execSafeRow.ok, true);
    assert.strictEqual(execSafeRow.token_id, null, 'safe exec should not mint approval token');

    const execRiskyRequestId = `test-opsc-exec-risky-${Date.now()}`;
    opsCommandQueue.enqueueCommand({
      schema_version: '1.0',
      request_id: execRiskyRequestId,
      command_kind: 'capability',
      phase: 'plan',
      capability: 'exec',
      action: 'run',
      intent_action: 'capability:exec:run',
      requested_by: requesterId,
      payload: {
        command: 'git push origin main',
      },
      created_at: new Date().toISOString(),
    });

    runWorker();
    const rowsAfterExecRisky = readResults();
    const execRiskyRow = rowsAfterExecRisky.find((row) => row && row.request_id === execRiskyRequestId);
    assert.ok(execRiskyRow, 'exec risky capability plan result should exist');
    assert.strictEqual(execRiskyRow.command_kind, 'capability');
    assert.strictEqual(execRiskyRow.capability, 'exec');
    assert.strictEqual(execRiskyRow.action, 'run');
    assert.strictEqual(execRiskyRow.ok, true);
    assert.ok(execRiskyRow.token_id, 'risky exec plan should mint approval token');

    const execRiskyTokenPath = path.join(opsApprovalStore.APPROVAL_PENDING_DIR, `${execRiskyRow.token_id}.json`);
    assert.ok(fs.existsSync(execRiskyTokenPath), 'exec risky pending approval token file should exist');

    finalizer.__setModelCallerForTest((params) => `요약\\n${String(params.draft || '')}`);
    const bypass = finalizeOpsTelegramReply({
      command_kind: 'capability',
      capability: 'browser',
      action: 'send',
      telegram_context: { provider: 'telegram', userId: '7704103236', groupId: '' },
      requested_by: requesterId,
    }, 'HEARTBEAT_OK', 'plan');
    assert.strictEqual(bypass, 'HEARTBEAT_OK');

    const preserved = finalizeOpsTelegramReply({
      command_kind: 'capability',
      capability: 'browser',
      action: 'send',
      telegram_context: { provider: 'telegram', userId: '7704103236', groupId: '' },
      requested_by: requesterId,
    }, '/approve 123\\n```json\\n{\"ok\":true}\\n```\\nURL https://example.com', 'execute');
    assert.ok(preserved.includes('/approve 123'));
    assert.ok(preserved.includes('```json\\n{\"ok\":true}\\n```'));

    // Cleanup only the token minted by this test.
    fs.rmSync(pendingTokenPath, { force: true });
    fs.rmSync(browserTokenPath, { force: true });
    fs.rmSync(execRiskyTokenPath, { force: true });
    opsApprovalStore.clearApprovalGrant(requesterId);
    finalizer.__setModelCallerForTest(null);

    console.log('test_ops_capability_worker: ok');
}

main();
