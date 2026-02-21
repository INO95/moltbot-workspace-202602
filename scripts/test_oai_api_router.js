const assert = require('assert');
const {
    decideApiLane,
    inferRouteFromCommand,
    normalizeApiOverride,
    DEFAULT_POLICY,
} = require('./oai_api_router');

function buildPolicy() {
    return {
        ...DEFAULT_POLICY,
        guards: {
            ...(DEFAULT_POLICY.guards || {}),
            enableApiKeyLane: true,
        },
        featureOverrides: [
            {
                id: 'force-api-key-realtime',
                enabled: true,
                targetLane: 'api-key-openai',
                routes: ['work', 'inspect', 'deploy', 'prompt'],
                keywords: ['realtime', 'webhook', 'batch'],
                match: 'any',
            },
            {
                id: 'report-local-empty',
                targetLane: 'local-only',
                routes: ['report'],
                keywords: ['daily'],
                match: 'any',
                allowEmptyCommand: true,
            },
        ],
    };
}

function testNormalizeOverride() {
    assert.deepStrictEqual(normalizeApiOverride('auto'), { lane: null, valid: true, value: 'auto' });
    assert.deepStrictEqual(normalizeApiOverride('oauth'), { lane: 'oauth-codex', valid: true, value: 'oauth' });
    assert.deepStrictEqual(normalizeApiOverride('key'), { lane: 'api-key-openai', valid: true, value: 'key' });
    assert.strictEqual(normalizeApiOverride('invalid').valid, false);
}

function testRouteDefaults() {
    const policy = buildPolicy();
    const env = {
        OPENAI_API_KEY: 'sk-test',
        MOLTBOT_ALLOW_PAID_API: 'true',
        RATE_LIMIT_SAFE_MODE: 'false',
    };

    const work = decideApiLane({ route: 'work', commandText: '요청: 테스트' }, {
        policy,
        env,
        budgetPolicy: { monthlyApiBudgetYen: 0, paidApiRequiresApproval: true },
    });
    assert.strictEqual(work.apiLane, 'oauth-codex');
    assert.strictEqual(work.blocked, false);

    const local = decideApiLane({ route: 'word', commandText: 'activate 활성화하다' }, {
        policy,
        env,
        budgetPolicy: { monthlyApiBudgetYen: 0, paidApiRequiresApproval: true },
    });
    assert.strictEqual(local.apiLane, 'local-only');
    assert.strictEqual(local.authMode, 'none');
}

function testFeatureOverrideAndManualOverride() {
    const policy = buildPolicy();
    const env = {
        OPENAI_API_KEY: 'sk-test',
        MOLTBOT_ALLOW_PAID_API: 'true',
        RATE_LIMIT_SAFE_MODE: 'false',
    };

    const feature = decideApiLane({
        route: 'work',
        commandText: '요청: realtime 연동 구현',
    }, {
        policy,
        env,
        budgetPolicy: { monthlyApiBudgetYen: 1000, paidApiRequiresApproval: true },
    });
    assert.strictEqual(feature.apiLane, 'api-key-openai');
    assert.strictEqual(feature.blocked, false);

    const manual = decideApiLane({
        route: 'work',
        commandText: '요청: 일반 구현',
        templateFields: { API: 'key' },
    }, {
        policy,
        env,
        budgetPolicy: { monthlyApiBudgetYen: 1000, paidApiRequiresApproval: true },
    });
    assert.strictEqual(manual.apiLane, 'api-key-openai');
    assert.ok(String(manual.reason || '').includes('manual-override:key'));

    const invalid = decideApiLane({
        route: 'work',
        commandText: '요청: 일반 구현',
        templateFields: { API: 'wrong' },
    }, {
        policy,
        env,
        budgetPolicy: { monthlyApiBudgetYen: 1000, paidApiRequiresApproval: true },
    });
    assert.strictEqual(invalid.blocked, true);
    assert.strictEqual(invalid.blockReason, 'invalid_api_override');
}

function testGuards() {
    const policy = buildPolicy();

    const blockedByBudget = decideApiLane({
        route: 'work',
        templateFields: { API: 'key' },
    }, {
        policy,
        env: {
            OPENAI_API_KEY: 'sk-test',
            MOLTBOT_ALLOW_PAID_API: 'false',
            RATE_LIMIT_SAFE_MODE: 'false',
        },
        budgetPolicy: { monthlyApiBudgetYen: 0, paidApiRequiresApproval: true },
    });
    assert.strictEqual(blockedByBudget.blocked, true);
    assert.strictEqual(blockedByBudget.blockReason, 'paid_api_approval_required');

    const blockedBySafeMode = decideApiLane({
        route: 'work',
        templateFields: { API: 'key' },
    }, {
        policy,
        env: {
            OPENAI_API_KEY: 'sk-test',
            MOLTBOT_ALLOW_PAID_API: 'true',
            RATE_LIMIT_SAFE_MODE: 'true',
        },
        budgetPolicy: { monthlyApiBudgetYen: 1000, paidApiRequiresApproval: false },
    });
    assert.strictEqual(blockedBySafeMode.blocked, true);
    assert.strictEqual(blockedBySafeMode.blockReason, 'rate_limit_safe_mode');
}

function testApiKeyLaneDisabledGuard() {
    const policy = {
        ...buildPolicy(),
        guards: {
            ...(buildPolicy().guards || {}),
            enableApiKeyLane: false,
        },
    };

    const blocked = decideApiLane({
        route: 'work',
        templateFields: { API: 'key' },
    }, {
        policy,
        env: {
            OPENAI_API_KEY: 'sk-test',
            MOLTBOT_ALLOW_PAID_API: 'true',
            RATE_LIMIT_SAFE_MODE: 'false',
        },
        budgetPolicy: { monthlyApiBudgetYen: 1000, paidApiRequiresApproval: false },
    });
    assert.strictEqual(blocked.blocked, true);
    assert.strictEqual(blocked.blockReason, 'api_key_lane_disabled');
    assert.strictEqual(blocked.fallbackLane, 'oauth-codex');
}

function testRouteInference() {
    const inferred = inferRouteFromCommand('작업: 요청: a; 대상: b; 완료기준: c');
    assert.strictEqual(inferred.route, 'work');

    const inferredLink = inferRouteFromCommand('링크 : 프롬프트');
    assert.strictEqual(inferredLink.route, 'link');

    const inferredProject = inferRouteFromCommand('프로젝트: 프로젝트명: demo; 목표: 테스트; 스택: next.js; 경로: /tmp; 완료기준: 실행');
    assert.strictEqual(inferredProject.route, 'project');

    const inferredFinance = inferRouteFromCommand('가계: 점심 1200엔');
    assert.strictEqual(inferredFinance.route, 'finance');

    const inferredTodo = inferRouteFromCommand('투두: 추가 장보기');
    assert.strictEqual(inferredTodo.route, 'todo');

    const none = inferRouteFromCommand('그냥 대화');
    assert.strictEqual(none.route, 'none');
}

function run() {
    testNormalizeOverride();
    testRouteDefaults();
    testFeatureOverrideAndManualOverride();
    testGuards();
    testApiKeyLaneDisabledGuard();
    testRouteInference();
    console.log('test_oai_api_router: ok');
}

run();
