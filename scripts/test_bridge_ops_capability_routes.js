const assert = require('assert');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PERSONA_MAP_PATH = path.join(ROOT, 'data', 'policy', 'bot_persona_map.json');

function runBridge(message, env = {}) {
    const res = spawnSync('node', ['scripts/bridge.js', 'auto', message], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            BRIDGE_ALLOWLIST_ENABLED: 'true',
            BRIDGE_ALLOWLIST_AUTO_ROUTES: 'ops,status,report,link',
            MOLTBOT_DISABLE_APPROVAL_TOKENS: '0',
            ...env,
        },
    });
    assert.strictEqual(res.status, 0, `bridge failed: ${res.stderr || res.stdout}`);
    return JSON.parse(String(res.stdout || '{}').trim());
}

function main() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bridge-ops-capability-'));
    const personaMapBefore = fs.existsSync(PERSONA_MAP_PATH)
        ? fs.readFileSync(PERSONA_MAP_PATH, 'utf8')
        : null;
    try {
    const mailWrapped = '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:10 UTC] 운영: 액션: 메일; 작업: send; 수신자: ops@example.com; 제목: test; 본문: hello [message_id: 21]';
    const outMail = runBridge(mailWrapped, {
        OPS_WORKSPACE_ROOT: tmpRoot,
        OPS_COMMANDS_ROOT: path.join(tmpRoot, 'ops', 'commands'),
        BRIDGE_DIR: path.join(tmpRoot, 'data', 'bridge'),
    });

    assert.strictEqual(outMail.route, 'ops');
    assert.strictEqual(outMail.templateValid, true);
    assert.strictEqual(outMail.success, true);
    assert.strictEqual(outMail.capability, 'mail');
    assert.strictEqual(outMail.capabilityAction, 'send');
    assert.strictEqual(outMail.requiresApproval, true);
    assert.strictEqual(outMail.riskTier, 'HIGH');

    const photoWrapped = '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:11 UTC] 운영: 액션: 사진; 작업: list; 경로: /tmp [message_id: 22]';
    const outPhoto = runBridge(photoWrapped, {
        OPS_WORKSPACE_ROOT: tmpRoot,
        OPS_COMMANDS_ROOT: path.join(tmpRoot, 'ops', 'commands'),
        BRIDGE_DIR: path.join(tmpRoot, 'data', 'bridge'),
    });

    assert.strictEqual(outPhoto.route, 'ops');
    assert.strictEqual(outPhoto.templateValid, true);
    assert.strictEqual(outPhoto.success, true);
    assert.strictEqual(outPhoto.capability, 'photo');
    assert.strictEqual(outPhoto.capabilityAction, 'list');
    assert.strictEqual(outPhoto.requiresApproval, false);

    const browserWrapped = '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:12 UTC] 운영: 액션: 브라우저; 작업: send; URL: https://example.com; 메서드: POST; 내용: hello [message_id: 23]';
    const outBrowser = runBridge(browserWrapped, {
        OPS_WORKSPACE_ROOT: tmpRoot,
        OPS_COMMANDS_ROOT: path.join(tmpRoot, 'ops', 'commands'),
        BRIDGE_DIR: path.join(tmpRoot, 'data', 'bridge'),
    });

    assert.strictEqual(outBrowser.route, 'ops');
    assert.strictEqual(outBrowser.templateValid, true);
    assert.strictEqual(outBrowser.success, true);
    assert.strictEqual(outBrowser.capability, 'browser');
    assert.strictEqual(outBrowser.capabilityAction, 'send');
    assert.strictEqual(outBrowser.requiresApproval, true);
    assert.strictEqual(outBrowser.riskTier, 'HIGH');

    const execWrapped = '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:13 UTC] 운영: 액션: 실행; 작업: pwd [message_id: 24]';
    const outExec = runBridge(execWrapped, {
        OPS_WORKSPACE_ROOT: tmpRoot,
        OPS_COMMANDS_ROOT: path.join(tmpRoot, 'ops', 'commands'),
        BRIDGE_DIR: path.join(tmpRoot, 'data', 'bridge'),
    });
    assert.strictEqual(outExec.route, 'ops');
    assert.strictEqual(outExec.templateValid, true);
    assert.strictEqual(outExec.success, true);
    assert.strictEqual(outExec.capability, 'exec');
    assert.strictEqual(outExec.capabilityAction, 'run');
    assert.strictEqual(outExec.requiresApproval, false);
    assert.strictEqual(outExec.riskTier, 'MEDIUM');

    const googleCalendarLookup = runBridge('구글 캘린더 확인', {
        OPS_WORKSPACE_ROOT: tmpRoot,
        OPS_COMMANDS_ROOT: path.join(tmpRoot, 'ops', 'commands'),
        BRIDGE_DIR: path.join(tmpRoot, 'data', 'bridge'),
    });
    assert.strictEqual(googleCalendarLookup.route, 'ops');
    assert.strictEqual(googleCalendarLookup.templateValid, true);
    assert.strictEqual(googleCalendarLookup.success, true);
    assert.strictEqual(googleCalendarLookup.capability, 'schedule');
    assert.strictEqual(googleCalendarLookup.capabilityAction, 'list');
    assert.strictEqual(googleCalendarLookup.requiresApproval, false);

    const rawGogCommand = runBridge('gog drive ls -a inhoins@gmail.com --no-input', {
        OPS_WORKSPACE_ROOT: tmpRoot,
        OPS_COMMANDS_ROOT: path.join(tmpRoot, 'ops', 'commands'),
        BRIDGE_DIR: path.join(tmpRoot, 'data', 'bridge'),
        BRIDGE_ALLOWLIST_AUTO_ROUTES: 'ops,status,report,link,none',
    });
    assert.strictEqual(rawGogCommand.route, 'none');
    assert.ok(
        String(rawGogCommand.telegramReply || '').includes('실행형은 보안상 자동 실행되지 않습니다'),
        `expected gog safety guide, got: ${rawGogCommand.telegramReply}`,
    );

    const execBatchWrapped = [
        '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:13 UTC] 운영: 액션: 실행; 작업: pwd',
        '운영: 액션: 실행; 작업: gog drive ls -a inhoins@gmail.com --no-input',
        '운영: 액션: 실행; 작업: gog calendar events -a inhoins@gmail.com --no-input [message_id: 241]',
    ].join('\n');
    const outExecBatch = runBridge(execBatchWrapped, {
        OPS_WORKSPACE_ROOT: tmpRoot,
        OPS_COMMANDS_ROOT: path.join(tmpRoot, 'ops', 'commands'),
        BRIDGE_DIR: path.join(tmpRoot, 'data', 'bridge'),
    });
    assert.strictEqual(outExecBatch.route, 'ops');
    assert.strictEqual(outExecBatch.batch, true);
    assert.strictEqual(Array.isArray(outExecBatch.items), true);
    assert.strictEqual(outExecBatch.items.length, 3);
    assert.strictEqual(Array.isArray(outExecBatch.requestIds), true);
    assert.strictEqual(outExecBatch.requestIds.length, 3);
    assert.strictEqual(outExecBatch.items.every((item) => item.requiresApproval === false), true);

    const personaSetWrapped = '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:13 UTC] 운영: 액션: 페르소나; 대상: daily; 이름: analyst; 톤: 간결; 스타일: 실행중심; 금지: 이모지 [message_id: 241]';
    const outPersonaSet = runBridge(personaSetWrapped, {
        OPS_WORKSPACE_ROOT: tmpRoot,
        OPS_COMMANDS_ROOT: path.join(tmpRoot, 'ops', 'commands'),
        BRIDGE_DIR: path.join(tmpRoot, 'data', 'bridge'),
    });
    assert.strictEqual(outPersonaSet.route, 'ops');
    assert.strictEqual(outPersonaSet.templateValid, true);
    assert.strictEqual(outPersonaSet.success, true);
    assert.strictEqual(outPersonaSet.action, 'persona');
    assert.ok(String(outPersonaSet.telegramReply || '').includes('페르소나 적용 완료: bot-daily'));

    const personaShowWrapped = '[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:13 UTC] 운영: 액션: 페르소나; 대상: daily; 작업: 조회 [message_id: 242]';
    const outPersonaShow = runBridge(personaShowWrapped, {
        OPS_WORKSPACE_ROOT: tmpRoot,
        OPS_COMMANDS_ROOT: path.join(tmpRoot, 'ops', 'commands'),
        BRIDGE_DIR: path.join(tmpRoot, 'data', 'bridge'),
    });
    assert.strictEqual(outPersonaShow.route, 'ops');
    assert.strictEqual(outPersonaShow.templateValid, true);
    assert.strictEqual(outPersonaShow.success, true);
    assert.strictEqual(outPersonaShow.action, 'persona');
    assert.ok(String(outPersonaShow.telegramReply || '').includes('이름: analyst'));

    const denyToken = 'apv_deadbeefdeadbeef';
    const denyWrapped = `[Telegram Test User id:7704103236 chat:123456 +0m 2026-02-16 13:14 UTC] /deny ${denyToken} [message_id: 25]`;
    const outDeny = runBridge(denyWrapped, {
        OPS_WORKSPACE_ROOT: tmpRoot,
        OPS_COMMANDS_ROOT: path.join(tmpRoot, 'ops', 'commands'),
        BRIDGE_DIR: path.join(tmpRoot, 'data', 'bridge'),
    });
    assert.strictEqual(outDeny.route, 'ops');
    assert.strictEqual(outDeny.templateValid, true);
    assert.strictEqual(outDeny.success, true);
    assert.strictEqual(outDeny.action, 'deny');
    assert.strictEqual(outDeny.phase, 'execute');
    assert.strictEqual(outDeny.token, denyToken);

    console.log('test_bridge_ops_capability_routes: ok');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        if (personaMapBefore == null) {
            fs.rmSync(PERSONA_MAP_PATH, { force: true });
        } else {
            fs.mkdirSync(path.dirname(PERSONA_MAP_PATH), { recursive: true });
            fs.writeFileSync(PERSONA_MAP_PATH, personaMapBefore, 'utf8');
        }
    }
}

main();
