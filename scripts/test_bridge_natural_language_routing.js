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

    const finance = runRouteWithEnv('점심 1200엔 가계에 기록해줘', inferEnv);
    assert.strictEqual(finance.route, 'finance');

    const todo = runRouteWithEnv('오늘 할 일에 장보기 추가해줘', inferEnv);
    assert.strictEqual(todo.route, 'todo');

    const routine = runRouteWithEnv('루틴 체크 물 2L 완료했어', inferEnv);
    assert.strictEqual(routine.route, 'routine');

    const workout = runRouteWithEnv('러닝 30분 5km 운동 기록해줘', inferEnv);
    assert.strictEqual(workout.route, 'workout');

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

    const disabled = runRouteWithEnv('웹앱 주소 좀 보내줘', {
        BRIDGE_NL_ROUTING_ENABLED: 'false',
        BRIDGE_NL_ROUTING_HUB_ONLY: 'false',
    });
    assert.strictEqual(disabled.route, 'none');

    console.log('test_bridge_natural_language_routing: ok');
}

main();
