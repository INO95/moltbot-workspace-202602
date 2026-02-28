const assert = require('assert');

const {
    normalizeMonthToken,
    extractMemoStatsPayload,
    inferWordIntentPayload,
    inferMemoIntentPayload,
    inferLinkIntentPayload,
    inferTodoIntentPayload,
    inferWorkIntentPayload,
    inferInspectIntentPayload,
    inferBrowserIntentPayload,
    extractPreferredProjectBasePath,
    inferProjectIntentPayload,
    inferNaturalLanguageRoute,
} = require('./lib/bridge_nl_inference');

function main() {
    assert.strictEqual(normalizeMonthToken('202602'), '2026-02');
    assert.strictEqual(normalizeMonthToken('2026-02'), '2026-02');
    assert.strictEqual(normalizeMonthToken('2026/02'), '');

    assert.strictEqual(inferWordIntentPayload('Refer'), 'Refer');
    assert.strictEqual(inferWordIntentPayload('as soon as'), 'as soon as');
    assert.strictEqual(inferWordIntentPayload('acquire 획득하다'), 'acquire 획득하다');
    assert.strictEqual(
        inferWordIntentPayload('Integration\\nHealth\\nscreening'),
        'Integration\nHealth\nscreening',
    );
    assert.strictEqual(inferWordIntentPayload('Anki 저장하라고'), null);
    assert.strictEqual(inferWordIntentPayload('who are you'), null);

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
    assert.ok(/대상:\s*\/Users\/inho-baek\/Projects\/Moltbot_Workspace/.test(String(workPayload || '')));
    assert.ok(/완료기준:\s*요청사항 반영 \+ 관련 검증 통과 \+ 변경 요약/.test(String(workPayload || '')));

    const todoStatsPayload = inferTodoIntentPayload('아까 보낸 투두리스트 통계 정리해');
    assert.strictEqual(todoStatsPayload, '통계');

    const guardedWork = inferWorkIntentPayload('왜 이렇게 된 건지 원인 파악하고 재귀개선해');
    assert.strictEqual(guardedWork, null);

    const inspectPayload = inferInspectIntentPayload('테스트 실패 원인 점검해줘');
    assert.ok(/대상:\s*\/Users\/inho-baek\/Projects\/Moltbot_Workspace/.test(String(inspectPayload || '')));
    assert.ok(/체크항목:\s*테스트 실패 원인/.test(String(inspectPayload || '')));

    const inspectRootCauseImprove = inferInspectIntentPayload('왜 이렇게 된 건지 원인 파악하고 재귀개선해');
    assert.ok(/체크항목:\s*왜 이렇게 된 건지 원인 파악하고 재귀개선해/.test(String(inspectRootCauseImprove || '')));

    const blockedFm = inferBrowserIntentPayload('브라우저로 fmkorea 베스트 열어줘');
    assert.strictEqual(blockedFm, null);

    const blockedDc = inferBrowserIntentPayload('브라우저로 디시 특이점이 온다 갤러리 보여줘');
    assert.strictEqual(blockedDc, null);

    const blockedUrl = inferBrowserIntentPayload('브라우저 열어 https://www.fmkorea.com/best');
    assert.strictEqual(blockedUrl, null);

    const preferredPath = extractPreferredProjectBasePath(
        '/home/node/.openclaw/workspace/Projects 와 /tmp 중에 첫 번째로',
        { resolveWorkspaceRootHint: () => '/Users/inho-baek/Projects/Moltbot_Workspace' },
    );
    assert.strictEqual(preferredPath, '/Users/inho-baek/Projects/Moltbot_Workspace/Projects');

    const projectPayload = inferProjectIntentPayload('여기에 설치해', {
        extractPreferredProjectBasePath: () => '/Users/inho-baek/Projects',
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
        resolveDefaultProjectBasePath: () => '/Users/inho-baek/Projects',
        toProjectTemplatePayload: (fields) => `경로: ${fields.경로}`,
    });
    assert.strictEqual(projectPayload, '경로: /Users/inho-baek/Projects');

    const inferredStatus = inferNaturalLanguageRoute('상태 알려줘', {}, {
        NATURAL_LANGUAGE_ROUTING: {
            enabled: true,
            hubOnly: false,
            inferWord: false,
            inferMemo: false,
            inferFinance: false,
            inferTodo: false,
            inferRoutine: false,
            inferWorkout: false,
            inferBrowser: false,
            inferSchedule: false,
            inferStatus: true,
            inferLink: false,
            inferWork: false,
            inferInspect: false,
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
            inferWord: false,
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

    const ankiRuntimeWord = inferNaturalLanguageRoute(
        'Refer',
        { env: { MOLTBOT_BOT_ID: 'bot-anki', MOLTBOT_PROFILE: 'anki' } },
        {
            NATURAL_LANGUAGE_ROUTING: {
                enabled: true,
                hubOnly: false,
                inferWord: false,
                inferMemo: false,
                inferFinance: false,
                inferTodo: false,
                inferRoutine: false,
                inferWorkout: false,
                inferBrowser: false,
                inferSchedule: false,
                inferStatus: false,
                inferLink: false,
                inferWork: false,
                inferInspect: false,
                inferProject: false,
                inferReport: false,
            },
            isWordRuntime: () => true,
            normalizeIncomingCommandText: (text) => String(text || '').trim(),
        },
    );
    assert.deepStrictEqual(ankiRuntimeWord, {
        route: 'word',
        payload: 'Refer',
        inferred: true,
        inferredBy: 'natural-language:word',
    });

    const nonWordRuntime = inferNaturalLanguageRoute(
        'Refer',
        { env: { MOLTBOT_BOT_ID: 'bot-daily', MOLTBOT_PROFILE: 'daily' } },
        {
            NATURAL_LANGUAGE_ROUTING: {
                enabled: true,
                hubOnly: false,
                inferWord: false,
                inferMemo: false,
                inferFinance: false,
                inferTodo: false,
                inferRoutine: false,
                inferWorkout: false,
                inferBrowser: false,
                inferSchedule: false,
                inferStatus: false,
                inferLink: false,
                inferWork: false,
                inferInspect: false,
                inferProject: false,
                inferReport: false,
            },
            isWordRuntime: () => false,
            normalizeIncomingCommandText: (text) => String(text || '').trim(),
        },
    );
    assert.strictEqual(nonWordRuntime, null);

    console.log('test_bridge_nl_inference: ok');
}

main();
