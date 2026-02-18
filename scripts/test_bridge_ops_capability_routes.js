const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const opsCommandQueue = require('./ops_command_queue');

const ROOT = path.join(__dirname, '..');

function runBridge(message, env = {}) {
    const res = spawnSync('node', ['scripts/bridge.js', 'auto', message], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            BRIDGE_ALLOWLIST_ENABLED: 'true',
            BRIDGE_ALLOWLIST_AUTO_ROUTES: 'ops,status,report,link',
            ...env,
        },
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

function findAddedRowByRequestId(beforeSet, requestId) {
    assert.ok(requestId, 'expected requestId in bridge response');
    const added = listOutbox().filter((name) => !beforeSet.has(name));
    for (let i = added.length - 1; i >= 0; i -= 1) {
        const filePath = path.join(opsCommandQueue.OUTBOX_DIR, added[i]);
        const row = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (String(row.request_id || '') === String(requestId)) {
            return { filePath, row };
        }
    }
    assert.fail(`expected outbox row for request_id=${requestId}`);
}

function main() {
    opsCommandQueue.ensureLayout();

    const mailWrapped = '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:10 UTC] 운영: 액션: 메일; 작업: send; 수신자: ops@example.com; 제목: test; 본문: hello [message_id: 21]';
    const beforeMail = new Set(listOutbox());
    const outMail = runBridge(mailWrapped);

    assert.strictEqual(outMail.route, 'ops');
    assert.strictEqual(outMail.templateValid, true);
    assert.strictEqual(outMail.success, true);
    assert.strictEqual(outMail.capability, 'mail');
    assert.strictEqual(outMail.capabilityAction, 'send');
    assert.strictEqual(outMail.requiresApproval, true);
    assert.strictEqual(outMail.riskTier, 'HIGH');

    const mailQueued = findAddedRowByRequestId(beforeMail, outMail.requestId);
    const mailRow = mailQueued.row;
    assert.strictEqual(mailRow.command_kind, 'capability');
    assert.strictEqual(mailRow.capability, 'mail');
    assert.strictEqual(mailRow.action, 'send');
    assert.strictEqual(mailRow.requires_approval, true);
    assert.strictEqual(mailRow.risk_tier, 'HIGH');

    const photoWrapped = '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:11 UTC] 운영: 액션: 사진; 작업: list; 경로: /tmp [message_id: 22]';
    const beforePhoto = new Set(listOutbox());
    const outPhoto = runBridge(photoWrapped);

    assert.strictEqual(outPhoto.route, 'ops');
    assert.strictEqual(outPhoto.templateValid, true);
    assert.strictEqual(outPhoto.success, true);
    assert.strictEqual(outPhoto.capability, 'photo');
    assert.strictEqual(outPhoto.capabilityAction, 'list');
    assert.strictEqual(outPhoto.requiresApproval, false);

    const photoQueued = findAddedRowByRequestId(beforePhoto, outPhoto.requestId);
    const photoRow = photoQueued.row;
    assert.strictEqual(photoRow.command_kind, 'capability');
    assert.strictEqual(photoRow.capability, 'photo');
    assert.strictEqual(photoRow.action, 'list');
    assert.strictEqual(photoRow.requires_approval, false);

    const browserWrapped = '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:12 UTC] 운영: 액션: 브라우저; 작업: send; URL: https://example.com; 메서드: POST; 내용: hello [message_id: 23]';
    const beforeBrowser = new Set(listOutbox());
    const outBrowser = runBridge(browserWrapped);

    assert.strictEqual(outBrowser.route, 'ops');
    assert.strictEqual(outBrowser.templateValid, true);
    assert.strictEqual(outBrowser.success, true);
    assert.strictEqual(outBrowser.capability, 'browser');
    assert.strictEqual(outBrowser.capabilityAction, 'send');
    assert.strictEqual(outBrowser.requiresApproval, true);
    assert.strictEqual(outBrowser.riskTier, 'HIGH');

    const browserQueued = findAddedRowByRequestId(beforeBrowser, outBrowser.requestId);
    const browserRow = browserQueued.row;
    assert.strictEqual(browserRow.command_kind, 'capability');
    assert.strictEqual(browserRow.capability, 'browser');
    assert.strictEqual(browserRow.action, 'send');
    assert.strictEqual(browserRow.requires_approval, true);
    assert.strictEqual(browserRow.risk_tier, 'HIGH');

    console.log('test_bridge_ops_capability_routes: ok');
}

main();
