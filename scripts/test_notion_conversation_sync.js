const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function run(args, env = {}) {
    return spawnSync('node', ['scripts/notion_conversation_sync.js', ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
}

function writeStaging(tmpDir) {
    fs.mkdirSync(tmpDir, { recursive: true });
    const stagingPath = path.join(tmpDir, 'staging.jsonl');
    const row = {
        id: 'conv-test-1',
        timestamp: new Date().toISOString(),
        source: 'user',
        route: 'memo',
        message: '기록: 테스트',
        messageHash: 'hash-test-1',
        sensitiveRedacted: false,
        skillHint: 'memo',
        approvalState: 'staged',
    };
    fs.writeFileSync(stagingPath, `${JSON.stringify(row)}\n`, 'utf8');
}

function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-conv-sync-'));
    writeStaging(tmp);
    const env = { CONVERSATION_DATA_DIR: tmp };

    const prepare = run(['prepare'], env);
    assert.strictEqual(prepare.status, 0, `prepare failed: ${prepare.stderr || prepare.stdout}`);
    const prepareOut = JSON.parse(String(prepare.stdout || '{}').trim());
    assert.strictEqual(prepareOut.ok, true);
    assert.strictEqual(prepareOut.action, 'prepare');
    assert.strictEqual(prepareOut.batchCreated, true);
    assert.strictEqual(prepareOut.requiresApproval, true);
    assert.ok(prepareOut.approvalNonce, 'approval nonce is required');

    const applyWithoutApproval = run(['apply'], env);
    assert.notStrictEqual(applyWithoutApproval.status, 0, 'apply without approval should fail');
    const errText = `${applyWithoutApproval.stderr || ''}${applyWithoutApproval.stdout || ''}`;
    assert.ok(errText.includes('APPROVAL_REQUIRED'), `unexpected error: ${errText}`);

    console.log('test_notion_conversation_sync: ok');
}

main();
