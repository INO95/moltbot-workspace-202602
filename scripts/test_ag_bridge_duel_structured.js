const assert = require('assert');
const {
    buildStructuredCritiqueRequest,
    parseCritiqueFromOutboxResponse,
    normalizeStructuredCritique,
    extractJsonObject,
} = require('./ag_bridge_client');

function sampleStructuredPayload() {
    return {
        content: 'Draft has missing rollback criteria and weak edge-case coverage.',
        rubric: {
            correctness: 4,
            feasibility: 4,
            risk: 3,
            clarity: 4,
            testability: 5,
        },
        issues: [
            {
                claim: 'Rollback trigger is unclear.',
                evidence: 'No explicit rollback condition in draft.',
                suggestedFix: 'Define rollback trigger, owner, and execution window.',
            },
            {
                claim: 'Negative path tests are missing.',
                evidence: 'Validation plan lists only happy-path checks.',
                suggestedFix: 'Add malformed input and timeout test scenarios.',
            },
        ],
    };
}

function testBuildStructuredCritiqueRequest() {
    const text = buildStructuredCritiqueRequest({
        debateId: 'debate-123',
        taskId: 'task-123',
        ackId: 'ack-123',
        command: '요청: 구현; 대상: 브리지; 완료기준: 테스트 통과',
        draftContent: 'codex draft body',
    });

    assert.ok(text.includes('[DUEL_CRITIQUE_REQUEST:v1]'), 'protocol marker missing');
    assert.ok(text.includes('debate-123'), 'debateId missing in request');
    assert.ok(text.includes('codex draft body'), 'draft content missing in request');
}

function testExtractJsonObject() {
    const payload = sampleStructuredPayload();

    const direct = extractJsonObject(JSON.stringify(payload));
    assert.strictEqual(direct.content, payload.content);

    const fenced = extractJsonObject(`\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`);
    assert.strictEqual(fenced.rubric.correctness, 4);
}

function testNormalizeStructuredCritique() {
    const payload = sampleStructuredPayload();
    const out = normalizeStructuredCritique(payload);
    assert.strictEqual(out.issues.length, 2);
    assert.strictEqual(out.rubric.testability, 5);
}

function testParseCritiqueFromOutboxResponseStructured() {
    const payload = sampleStructuredPayload();

    const parsedDirect = parseCritiqueFromOutboxResponse(
        { taskId: 't1', result: JSON.stringify(payload) },
        'draft text',
    );
    assert.strictEqual(parsedDirect.structured, true);
    assert.strictEqual(parsedDirect.critique.issues.length, 2);

    const parsedFenced = parseCritiqueFromOutboxResponse(
        { taskId: 't2', result: `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`` },
        'draft text',
    );
    assert.strictEqual(parsedFenced.structured, true);
    assert.strictEqual(parsedFenced.critique.rubric.correctness, 4);
}

function testParseCritiqueFromOutboxResponseFallback() {
    const parsed = parseCritiqueFromOutboxResponse(
        { taskId: 't3', result: '이건 JSON이 아닌 자유 텍스트 응답입니다.' },
        'draft content here',
    );

    assert.strictEqual(parsed.structured, false);
    assert.ok(parsed.parseError && typeof parsed.parseError === 'string', 'parseError should exist');
    assert.ok(Array.isArray(parsed.critique.issues) && parsed.critique.issues.length === 1);
}

function run() {
    testBuildStructuredCritiqueRequest();
    testExtractJsonObject();
    testNormalizeStructuredCritique();
    testParseCritiqueFromOutboxResponseStructured();
    testParseCritiqueFromOutboxResponseFallback();
    console.log('test_ag_bridge_duel_structured: ok');
}

run();
