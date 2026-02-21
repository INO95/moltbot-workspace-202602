const assert = require('assert');

const { routeByPrefix, matchPrefix } = require('./lib/bridge_route_dispatch');

function main() {
    assert.strictEqual(matchPrefix('링크: 프롬프트', '링크:'), 4);
    assert.strictEqual(matchPrefix('링크 : 프롬프트', '링크:'), 5);
    assert.strictEqual(matchPrefix('링크 프롬프트', '링크:'), 3);
    assert.strictEqual(matchPrefix('메모장에 오늘 회고 저장', '메모:'), null);
    assert.strictEqual(matchPrefix('작업으로 bridge 라우터 정리', '작업:'), null);
    assert.strictEqual(matchPrefix('단어: apple', '메모:'), null);

    const prefixed = routeByPrefix('메모: 오늘 회고', {
        commandPrefixes: {},
        normalizeIncomingCommandText: (text) => String(text || '').trim(),
    });
    assert.deepStrictEqual(prefixed, { route: 'memo', payload: '오늘 회고' });

    const approve = routeByPrefix('승인 abc123', {
        normalizeIncomingCommandText: (text) => String(text || '').trim(),
        parseApproveShorthand: () => ({ normalizedPayload: '액션: 승인; 토큰: abc123' }),
    });
    assert.deepStrictEqual(approve, { route: 'ops', payload: '액션: 승인; 토큰: abc123' });

    const naturalApprovalNoPending = routeByPrefix('승인해', {
        normalizeIncomingCommandText: (text) => String(text || '').trim(),
        parseNaturalApprovalShorthand: () => ({ normalizedPayload: '액션: 승인' }),
        readPendingApprovalsState: () => [],
        hasAnyApprovalHint: () => false,
    });
    assert.deepStrictEqual(naturalApprovalNoPending, { route: 'none', payload: '승인해' });

    const naturalApprovalWithPending = routeByPrefix('승인해', {
        normalizeIncomingCommandText: (text) => String(text || '').trim(),
        parseNaturalApprovalShorthand: () => ({ normalizedPayload: '액션: 승인' }),
        readPendingApprovalsState: () => [{ token: 't1' }],
        hasAnyApprovalHint: () => false,
    });
    assert.deepStrictEqual(naturalApprovalWithPending, { route: 'ops', payload: '액션: 승인' });

    const inferred = routeByPrefix('데일리 봇 살아있나 확인해줘', {
        normalizeIncomingCommandText: (text) => String(text || '').trim(),
        inferNaturalLanguageRoute: () => ({ route: 'status', payload: 'daily', inferred: true }),
    });
    assert.deepStrictEqual(inferred, { route: 'status', payload: 'daily', inferred: true });

    const memoPad = routeByPrefix('메모장에 오늘 회고 저장해줘', {
        normalizeIncomingCommandText: (text) => String(text || '').trim(),
        inferNaturalLanguageRoute: () => ({
            route: 'memo',
            payload: '오늘 회고 저장해줘',
            inferred: true,
            inferredBy: 'natural-language:memo',
        }),
    });
    assert.deepStrictEqual(memoPad, {
        route: 'memo',
        payload: '오늘 회고 저장해줘',
        inferred: true,
        inferredBy: 'natural-language:memo',
    });

    const retryProjectInference = routeByPrefix('프로젝트 rust wasm 게임 템플릿 만들어줘', {
        normalizeIncomingCommandText: (text) => String(text || '').trim(),
        inferNaturalLanguageRoute: () => ({
            route: 'project',
            payload: '프로젝트명: demo; 목표: rust wasm 게임 템플릿 만들어줘; 스택: rust wasm web game; 경로: /Users/moltbot/Projects; 완료기준: 프로젝트 폴더와 기본 실행 파일 생성; 초기화: execute',
            inferred: true,
            inferredBy: 'natural-language:project',
        }),
    });
    assert.deepStrictEqual(retryProjectInference, {
        route: 'project',
        payload: '프로젝트명: demo; 목표: rust wasm 게임 템플릿 만들어줘; 스택: rust wasm web game; 경로: /Users/moltbot/Projects; 완료기준: 프로젝트 폴더와 기본 실행 파일 생성; 초기화: execute',
        inferred: true,
        inferredBy: 'natural-language:project',
    });

    console.log('test_bridge_route_dispatch: ok');
}

main();
