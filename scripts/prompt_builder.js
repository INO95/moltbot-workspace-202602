const fs = require('fs');
const path = require('path');

const sessionsPath = path.join(__dirname, '../data/prompt_sessions.json');

const fieldLabels = {
    goal: '요청 목적',
    constraints: '제약',
    outputFormat: '출력형식',
    forbidden: '금지사항',
    successCriteria: '성공기준',
};

const questionBank = {
    goal: '이번 요청의 최종 목적은 무엇인가요? (한 줄)',
    constraints: '시간/비용/도구/환경 제약이 있나요?',
    outputFormat: '결과물을 어떤 형태로 받길 원하나요? (예: 표, 체크리스트, 코드)',
    forbidden: '절대 포함되면 안 되는 요소가 있나요?',
    successCriteria: '완료됐다고 판단할 기준은 무엇인가요?',
};

const domainQuestionBank = {
    coding: [
        { label: '실행환경', question: '실행 환경은 무엇인가요? (예: Mac/Docker/Node 버전)' },
        { label: '수정범위', question: '수정 대상 파일/모듈 범위를 지정할 수 있나요?' },
        { label: '검증방법', question: '완료 후 어떤 테스트/검증으로 성공을 판정하나요?' },
    ],
    deployment: [
        { label: '배포환경', question: '배포 대상 환경은 어디인가요? (dev/stage/prod)' },
        { label: '롤백기준', question: '배포 실패 시 롤백 기준/방법은 무엇인가요?' },
        { label: '헬스체크', question: '배포 후 확인할 헬스체크 항목은 무엇인가요?' },
    ],
    analysis: [
        { label: '판단기준', question: '무엇을 기준으로 좋고/나쁨을 판정할까요?' },
        { label: '근거수준', question: '근거는 요약만 필요한가요, 데이터/수치까지 필요한가요?' },
        { label: '결과활용', question: '결과를 어떤 의사결정에 쓸 예정인가요?' },
    ],
    study: [
        { label: '난이도', question: '학습 난이도/수준은 어느 정도로 맞출까요?' },
        { label: '학습형식', question: '암기형/이해형/실전형 중 어떤 비중이 큰가요?' },
        { label: '복습주기', question: '복습 주기 또는 체크 방식이 있나요?' },
    ],
    general: [
        { label: '대상독자', question: '결과물을 누가 읽거나 사용할 예정인가요?' },
        { label: '시간제한', question: '언제까지 필요한 결과인가요?' },
        { label: '형식수준', question: '간단 요약/실행안/상세 문서 중 원하는 수준은 무엇인가요?' },
    ],
};

function detectDomain(fields) {
    const source = [
        fields.goal,
        fields.constraints,
        fields.outputFormat,
        fields.successCriteria,
    ].join(' ').toLowerCase();

    if (/(배포|release|deploy|운영|nginx|k8s|쿠버|docker compose|ci\/cd)/i.test(source)) return 'deployment';
    if (/(코드|개발|버그|디버그|api|db|repo|리포|테스트|리팩터)/i.test(source)) return 'coding';
    if (/(분석|리뷰|요약|리포트|대시보드|지표|원인)/i.test(source)) return 'analysis';
    if (/(toeic|토익|학습|암기|anki|공부|문제풀이)/i.test(source)) return 'study';
    return 'general';
}

function ensureSessions() {
    if (fs.existsSync(sessionsPath)) return;
    fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
    fs.writeFileSync(sessionsPath, JSON.stringify({ sessions: {} }, null, 2), 'utf8');
}

function readSessions() {
    ensureSessions();
    try {
        return JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    } catch {
        return { sessions: {} };
    }
}

function writeSessions(data) {
    fs.writeFileSync(sessionsPath, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeInput(input) {
    const base = {
        goal: '',
        constraints: '',
        outputFormat: '',
        forbidden: '',
        successCriteria: '',
    };
    return { ...base, ...(input || {}) };
}

function scoreCompleteness(fields) {
    const values = Object.values(fields).map(v => String(v || '').trim());
    const filled = values.filter(Boolean).length;
    return Math.round((filled / values.length) * 100);
}

function buildMissingQuestions(fields, max = 5) {
    const questions = [];
    for (const key of Object.keys(fieldLabels)) {
        if (!String(fields[key] || '').trim()) {
            questions.push({
                field: key,
                label: fieldLabels[key],
                question: questionBank[key],
            });
        }
    }
    const domain = detectDomain(fields);
    const domainQuestions = domainQuestionBank[domain] || domainQuestionBank.general;
    for (const q of domainQuestions) {
        if (questions.length >= Math.max(1, max)) break;
        questions.push({
            field: `domain:${domain}`,
            label: q.label,
            question: q.question,
        });
    }
    return questions.slice(0, Math.max(1, max));
}

function buildPromptText(fields) {
    const domain = detectDomain(fields);
    return [
        '너는 실무 중심의 실행형 AI 어시스턴트다.',
        '아이디어를 즉시 실행 가능한 작업 지시로 변환하라.',
        `도메인: ${domain}`,
        '',
        `[요청 목적]`,
        fields.goal || '(미입력)',
        '',
        `[제약]`,
        fields.constraints || '(없음)',
        '',
        `[출력형식]`,
        fields.outputFormat || '(자유형식)',
        '',
        `[금지사항]`,
        fields.forbidden || '(없음)',
        '',
        `[성공기준]`,
        fields.successCriteria || '(명시 없음)',
        '',
        '[실행 규칙]',
        '1) 작업 시작 전 누락 정보가 있으면 최대 3개만 질문',
        '2) 가능한 경우 바로 실행하고, 결과/근거/다음 액션 순으로 보고',
        '3) 금지사항과 제약을 위반하지 않는다',
        '4) 도메인별 필수 확인항목을 먼저 점검한다',
        '',
        '답변 시 위 조건을 반드시 만족하고, 부족한 정보가 있으면 먼저 짧게 질문 후 진행하라.',
    ].join('\n');
}

function buildChecklist(fields) {
    return [
        `요청 목적 명확성: ${fields.goal ? 'OK' : '확인 필요'}`,
        `제약 반영: ${fields.constraints ? 'OK' : '확인 필요'}`,
        `출력형식 지정: ${fields.outputFormat ? 'OK' : '확인 필요'}`,
        `금지사항 지정: ${fields.forbidden ? 'OK' : '확인 필요'}`,
        `성공기준 지정: ${fields.successCriteria ? 'OK' : '확인 필요'}`,
    ];
}

function buildSelfReview(fields) {
    const q = [];
    if (!fields.goal) q.push('이 요청의 최종 목적이 한 문장으로 명확한가?');
    if (!fields.constraints) q.push('시간/비용/도구 제약이 빠지지 않았는가?');
    if (!fields.outputFormat) q.push('원하는 결과 형식이 구체적으로 지정되었는가?');
    if (!fields.forbidden) q.push('절대 하면 안 되는 조건이 명시되었는가?');
    if (!fields.successCriteria) q.push('완료 판정 기준이 숫자/상태로 정의되었는가?');
    if (q.length < 3) {
        q.push('지금 프롬프트만으로 즉시 실행 가능한가?');
        q.push('결과 검증에 필요한 로그/증거를 요구했는가?');
        q.push('실패 시 대안 경로를 한 줄로 지정했는가?');
    }
    return q.slice(0, 5);
}

function createSession(initialInput = {}) {
    const db = readSessions();
    const id = `pf_${Date.now().toString(36)}`;
    const fields = normalizeInput(initialInput);
    const session = {
        id,
        fields,
        domain: detectDomain(fields),
        completeness: scoreCompleteness(fields),
        missingQuestions: buildMissingQuestions(fields, 5),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    db.sessions[id] = session;
    writeSessions(db);
    return session;
}

function updateSession(id, patchInput = {}) {
    const db = readSessions();
    const session = db.sessions[id];
    if (!session) {
        throw new Error(`session_not_found:${id}`);
    }
    const fields = { ...normalizeInput(session.fields), ...normalizeInput(patchInput) };
    session.fields = fields;
    session.domain = detectDomain(fields);
    session.completeness = scoreCompleteness(fields);
    session.missingQuestions = buildMissingQuestions(fields, 5);
    session.updatedAt = new Date().toISOString();
    db.sessions[id] = session;
    writeSessions(db);
    return session;
}

function finalizeSession(id) {
    const db = readSessions();
    const session = db.sessions[id];
    if (!session) throw new Error(`session_not_found:${id}`);
    const fields = normalizeInput(session.fields);
    const result = {
        sessionId: id,
        domain: detectDomain(fields),
        completeness: scoreCompleteness(fields),
        prompt: buildPromptText(fields),
        checklist: buildChecklist(fields),
        selfReview: buildSelfReview(fields),
        missingQuestions: buildMissingQuestions(fields, 5),
    };
    session.finalizedAt = new Date().toISOString();
    session.lastResult = result;
    db.sessions[id] = session;
    writeSessions(db);
    return result;
}

function parseFreeTextToFields(text) {
    const raw = String(text || '');
    const lines = raw.split('\n').map(x => x.trim()).filter(Boolean);
    const fields = normalizeInput({});
    const mapRules = [
        { keys: ['목적', 'goal', '요청'], field: 'goal' },
        { keys: ['제약', 'constraint', '조건'], field: 'constraints' },
        { keys: ['출력', 'format', '형식'], field: 'outputFormat' },
        { keys: ['금지', 'forbidden', '하지마'], field: 'forbidden' },
        { keys: ['성공', 'criteria', '완료'], field: 'successCriteria' },
    ];
    for (const line of lines) {
        let matched = false;
        for (const rule of mapRules) {
            if (rule.keys.some(k => line.toLowerCase().includes(k.toLowerCase()))) {
                const value = line.replace(/^[^:：]+[:：]/, '').trim();
                if (value) fields[rule.field] = fields[rule.field] ? `${fields[rule.field]} ${value}` : value;
                matched = true;
                break;
            }
        }
        if (!matched && !fields.goal) fields.goal = line;
    }
    return fields;
}

module.exports = {
    createSession,
    updateSession,
    finalizeSession,
    parseFreeTextToFields,
    buildMissingQuestions,
    scoreCompleteness,
};
