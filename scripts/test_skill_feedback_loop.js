const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-feedback-'));
    const conversationPath = path.join(tmp, 'conversation.jsonl');
    const bridgePath = path.join(tmp, 'bridge.jsonl');
    const queuePath = path.join(tmp, 'feedback_queue.jsonl');
    const previewPath = path.join(tmp, 'skill_patch_preview.md');

    fs.writeFileSync(conversationPath, `${JSON.stringify({
        id: 'conv-1',
        timestamp: new Date().toISOString(),
        route: 'work',
        source: 'user',
        message: '스킬 수정해줘. 노션 기록이 빠졌어.',
    })}\n`, 'utf8');
    fs.writeFileSync(bridgePath, `${JSON.stringify({
        taskId: 'bridge-1',
        timestamp: new Date().toISOString(),
        route: 'memo',
        source: 'user',
        command: '기록: 포트폴리오 문구 수정해줘',
    })}\n`, 'utf8');

    const res = spawnSync('node', ['scripts/skill_feedback_loop.js', '--limit', '50'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            CONVERSATION_STAGING_PATH: conversationPath,
            BRIDGE_INBOX_LOG_PATH: bridgePath,
            SKILL_FEEDBACK_QUEUE_PATH: queuePath,
            SKILL_PATCH_PREVIEW_PATH: previewPath,
        },
    });
    assert.strictEqual(res.status, 0, `script failed: ${res.stderr || res.stdout}`);
    const out = JSON.parse(String(res.stdout || '{}').trim());
    assert.strictEqual(out.ok, true);
    assert.ok(out.suggestions >= 1, 'should generate at least one suggestion');
    assert.ok(fs.existsSync(queuePath), 'queue file should be created');
    assert.ok(fs.existsSync(previewPath), 'preview file should be created');
    const preview = fs.readFileSync(previewPath, 'utf8');
    assert.ok(preview.includes('Proposed Changes'));
    console.log('test_skill_feedback_loop: ok');
}

main();
