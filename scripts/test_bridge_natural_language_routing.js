const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const HARNESS = `
const { routeByPrefix } = require('./scripts/bridge.js');
const input = process.argv[1] || '';
const out = routeByPrefix(input);
process.stdout.write(JSON.stringify(out));
`;

function runRouteWithEnv(message, env = {}) {
    const res = spawnSync('node', ['-e', HARNESS, message], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            ...env,
        },
    });
    assert.strictEqual(res.status, 0, `bridge route harness failed: ${res.stderr || res.stdout}`);
    const raw = String(res.stdout || '').trim();
    assert.ok(raw, 'empty route output');
    return JSON.parse(raw);
}

function runAutoWithEnv(message, env = {}) {
    const res = spawnSync('node', ['scripts/bridge.js', 'auto', message], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            ...env,
        },
    });
    assert.strictEqual(res.status, 0, `bridge auto failed: ${res.stderr || res.stdout}`);
    const raw = String(res.stdout || '').trim();
    assert.ok(raw, 'empty auto output');
    return JSON.parse(raw);
}

function main() {
    const inferEnv = {
        BRIDGE_NL_ROUTING_ENABLED: 'true',
        BRIDGE_NL_ROUTING_HUB_ONLY: 'false',
    };

    const status = runRouteWithEnv('데일리랑 dev 봇 상태 좀 확인해줘', inferEnv);
    assert.strictEqual(status.route, 'status');

    const link = runRouteWithEnv('웹앱 주소 좀 보내줘', inferEnv);
    assert.strictEqual(link.route, 'link');

    const report = runRouteWithEnv('요즘 테크 트렌드 리포트 한번 줘', inferEnv);
    assert.strictEqual(report.route, 'report');

    const googleCalendarLookup = runRouteWithEnv('구글 캘린더 확인', inferEnv);
    assert.strictEqual(googleCalendarLookup.route, 'ops');
    assert.ok(
        /액션:\s*일정/.test(String(googleCalendarLookup.payload || '')),
        `expected schedule lookup payload, got: ${googleCalendarLookup.payload}`,
    );

    const googleMailLookup = runRouteWithEnv('구글 메일 최근 내역 보여줘', inferEnv);
    assert.strictEqual(googleMailLookup.route, 'ops');
    assert.ok(
        /액션:\s*메일/.test(String(googleMailLookup.payload || '')),
        `expected mail lookup payload, got: ${googleMailLookup.payload}`,
    );

    const googleDriveLookup = runRouteWithEnv('구글 드라이브 목록 확인', inferEnv);
    assert.strictEqual(googleDriveLookup.route, 'ops');
    assert.ok(
        /액션:\s*브라우저/.test(String(googleDriveLookup.payload || '')),
        `expected drive lookup payload, got: ${googleDriveLookup.payload}`,
    );

    const rawGogCommand = runRouteWithEnv('gog drive ls -a inhoins@gmail.com --no-input', inferEnv);
    assert.strictEqual(rawGogCommand.route, 'none');

    const finance = runRouteWithEnv('점심 1200엔 가계에 기록해줘', inferEnv);
    assert.strictEqual(finance.route, 'finance');

    const todo = runRouteWithEnv('오늘 할 일에 장보기 추가해줘', inferEnv);
    assert.strictEqual(todo.route, 'todo');

    const routine = runRouteWithEnv('루틴 체크 물 2L 완료했어', inferEnv);
    assert.strictEqual(routine.route, 'routine');

    const workout = runRouteWithEnv('러닝 30분 5km 운동 기록해줘', inferEnv);
    assert.strictEqual(workout.route, 'workout');

    const work = runRouteWithEnv('브릿지 라우터 리팩터링해줘', inferEnv);
    assert.strictEqual(work.route, 'work');
    assert.strictEqual(work.inferredBy, 'natural-language:work');
    assert.ok(/요청:\s*브릿지 라우터 리팩터링해줘/.test(String(work.payload || '')));

    const inspect = runRouteWithEnv('테스트 실패 원인 점검해줘', inferEnv);
    assert.strictEqual(inspect.route, 'inspect');
    assert.strictEqual(inspect.inferredBy, 'natural-language:inspect');
    assert.ok(/체크항목:\s*테스트 실패 원인/.test(String(inspect.payload || '')));

    const memoBlock = [
        '260210~15',
        '',
        '10 화',
        '독서',
        '운동',
        '',
        '11 수',
        '안키',
    ].join('\n');
    const memo = runRouteWithEnv(memoBlock, inferEnv);
    assert.strictEqual(memo.route, 'memo');

    const casual = runRouteWithEnv('오늘 저녁 뭐 먹지?', inferEnv);
    assert.strictEqual(casual.route, 'none');

    const gated = runRouteWithEnv('데일리 봇 상태 알려줘', {
        BRIDGE_NL_ROUTING_ENABLED: 'true',
        BRIDGE_NL_ROUTING_HUB_ONLY: 'true',
    });
    assert.strictEqual(gated.route, 'none');

    const gatedHub = runRouteWithEnv('데일리 봇 상태 알려줘', {
        BRIDGE_NL_ROUTING_ENABLED: 'true',
        BRIDGE_NL_ROUTING_HUB_ONLY: 'true',
        MOLTBOT_BOT_ROLE: 'supervisor',
        MOLTBOT_BOT_ID: 'bot-daily',
    });
    assert.strictEqual(gatedHub.route, 'status');

    const gatedMainAlias = runRouteWithEnv('데일리 봇 상태 알려줘', {
        BRIDGE_NL_ROUTING_ENABLED: 'true',
        BRIDGE_NL_ROUTING_HUB_ONLY: 'true',
        MOLTBOT_BOT_ROLE: 'worker',
        MOLTBOT_BOT_ID: 'bot-main',
    });
    assert.strictEqual(gatedMainAlias.route, 'status');

    const disabled = runRouteWithEnv('웹앱 주소 좀 보내줘', {
        BRIDGE_NL_ROUTING_ENABLED: 'false',
        BRIDGE_NL_ROUTING_HUB_ONLY: 'false',
    });
    assert.strictEqual(disabled.route, 'none');

    const projectExplicitPath = runRouteWithEnv(
        '/Users/moltbot/Projects 여기로 설치해. 없으면 /home/node/.openclaw/workspace/Projects로 fallback해서 설치해.',
        inferEnv,
    );
    assert.strictEqual(projectExplicitPath.route, 'project');
    assert.ok(
        /경로:\s*\/Users\/moltbot\/Projects\b/.test(String(projectExplicitPath.payload || '')),
        `expected explicit /Users path in payload, got: ${projectExplicitPath.payload}`,
    );

    const projectPrefixedLike = runAutoWithEnv('프로젝트 rust wasm 게임 템플릿 만들어줘', inferEnv);
    assert.strictEqual(projectPrefixedLike.route, 'project');
    assert.strictEqual(projectPrefixedLike.templateValid, true);

    console.log('test_bridge_natural_language_routing: ok');
}

main();
