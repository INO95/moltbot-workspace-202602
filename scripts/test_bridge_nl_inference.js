const assert = require('assert');

const {
    normalizeMonthToken,
    extractMemoStatsPayload,
    inferMemoIntentPayload,
    inferLinkIntentPayload,
    inferWorkIntentPayload,
    inferInspectIntentPayload,
    inferWorkoutIntentPayload,
    extractPreferredProjectBasePath,
    inferProjectIntentPayload,
    inferNaturalLanguageRoute,
} = require('./lib/bridge_nl_inference');

function main() {
    assert.strictEqual(normalizeMonthToken('202602'), '2026-02');
    assert.strictEqual(normalizeMonthToken('2026-02'), '2026-02');
    assert.strictEqual(normalizeMonthToken('2026/02'), '');

    assert.strictEqual(
        extractMemoStatsPayload('메모 통계 202602'),
        '통계 2026-02',
    );

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
    assert.strictEqual(inferMemoIntentPayload(memoBlock), memoBlock);

    const externalLink = inferLinkIntentPayload('링크: 프롬프트', {
        isExternalLinkRequest: () => true,
    });
    assert.strictEqual(externalLink, '링크: 프롬프트');

    const workPayload = inferWorkIntentPayload('브릿지 라우터 리팩터링해줘');
    assert.ok(/요청:\s*브릿지 라우터 리팩터링해줘/.test(String(workPayload || '')));
    assert.ok(/대상:\s*\/Users\/moltbot\/Projects\/Moltbot_Workspace/.test(String(workPayload || '')));
    assert.ok(/완료기준:\s*요청사항 반영 \+ 관련 검증 통과 \+ 변경 요약/.test(String(workPayload || '')));

    const inspectPayload = inferInspectIntentPayload('테스트 실패 원인 점검해줘');
    assert.ok(/대상:\s*\/Users\/moltbot\/Projects\/Moltbot_Workspace/.test(String(inspectPayload || '')));
    assert.ok(/체크항목:\s*테스트 실패 원인/.test(String(inspectPayload || '')));

    const workoutFalsePositive = inferWorkoutIntentPayload(
        '/Users/moltbot/Projects 여기로 설치해. 없으면 /home/runner/work/moltbot-workspace로 fallback해서 설치해.',
    );
    assert.strictEqual(workoutFalsePositive, null);

    const preferredPath = extractPreferredProjectBasePath(
        '/home/node/.openclaw/workspace/Projects 와 /tmp 중에 첫 번째로',
        { resolveWorkspaceRootHint: () => '/Users/moltbot/Projects/Moltbot_Workspace' },
    );
    assert.strictEqual(preferredPath, '/Users/moltbot/Projects/Moltbot_Workspace/Projects');

    const projectPayload = inferProjectIntentPayload('여기에 설치해', {
        extractPreferredProjectBasePath: () => '/Users/moltbot/Projects',
        loadLastProjectBootstrap: () => ({
            fields: {
                프로젝트명: 'demo',
                목표: 'demo',
                스택: 'web',
                경로: '/tmp',
                완료기준: 'ok',
                초기화: 'execute',
            },
        }),
        resolveDefaultProjectBasePath: () => '/Users/moltbot/Projects',
        toProjectTemplatePayload: (fields) => `경로: ${fields.경로}`,
    });
    assert.strictEqual(projectPayload, '경로: /Users/moltbot/Projects');

    const inferredStatus = inferNaturalLanguageRoute('상태 알려줘', {}, {
        NATURAL_LANGUAGE_ROUTING: {
            enabled: true,
            hubOnly: false,
            inferMemo: false,
            inferFinance: false,
            inferTodo: false,
            inferRoutine: false,
            inferWorkout: false,
            inferBrowser: false,
            inferSchedule: false,
            inferStatus: true,
            inferLink: false,
            inferProject: false,
            inferReport: false,
        },
        normalizeIncomingCommandText: (text) => String(text || '').trim(),
        inferStatusIntentPayload: () => 'daily',
    });
    assert.deepStrictEqual(inferredStatus, {
        route: 'status',
        payload: 'daily',
        inferred: true,
        inferredBy: 'natural-language:status',
    });

    const orderedProject = inferNaturalLanguageRoute('프로젝트 rust wasm 템플릿 만들어줘', {}, {
        NATURAL_LANGUAGE_ROUTING: {
            enabled: true,
            hubOnly: false,
            inferMemo: false,
            inferFinance: false,
            inferTodo: false,
            inferRoutine: false,
            inferWorkout: false,
            inferBrowser: false,
            inferSchedule: false,
            inferStatus: false,
            inferLink: false,
            inferWork: true,
            inferInspect: true,
            inferProject: true,
            inferReport: true,
        },
        normalizeIncomingCommandText: (text) => String(text || '').trim(),
        inferProjectIntentPayload: () => 'PROJECT_PAYLOAD',
        inferWorkIntentPayload: () => 'WORK_PAYLOAD',
        inferInspectIntentPayload: () => 'INSPECT_PAYLOAD',
        inferReportIntentPayload: () => 'REPORT_PAYLOAD',
    });
    assert.deepStrictEqual(orderedProject, {
        route: 'project',
        payload: 'PROJECT_PAYLOAD',
        inferred: true,
        inferredBy: 'natural-language:project',
    });

    console.log('test_bridge_nl_inference: ok');
}

main();
