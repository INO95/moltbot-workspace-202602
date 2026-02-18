const engine = require('./molt_engine');
const anki = require('./anki_connect');
const config = require('../data/config.json');
const promptBuilder = require('./prompt_builder');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadRuntimeEnv } = require('./env_runtime');
const { decideApiLane } = require('./oai_api_router');
const { captureConversation } = require('./conversation_capture');
const opsLogger = require('./ops_logger');
const {
    STYLE_VERSION: QUALITY_STYLE_VERSION,
    DEFAULT_POLICY: DEFAULT_QUALITY_POLICY,
    normalizeWordToken,
    fallbackMeaning,
    fallbackExample,
    buildWordCandidates,
    createWordQuality,
    normalizeQualityPolicy,
    suggestToeicTypoCorrection,
} = require('./anki_word_quality');
const { analyzeWordFailures, detectTypoSuspicion } = require('./anki_typo_guard');
const { buildProjectBootstrapPlan } = require('./project_bootstrap');
const opsCommandQueue = require('./ops_command_queue');
const opsFileControl = require('./ops_file_control');
const telegramFinalizer = require('./finalizer');
const personalStorage = require('./personal_storage');
const { handleFinanceCommand } = require('./personal_finance');
const { handleTodoCommand } = require('./personal_todo');
const { handleRoutineCommand } = require('./personal_routine');
const { handleWorkoutCommand } = require('./personal_workout');
const { handleMediaPlaceCommand } = require('./personal_media_place');
const MODEL_DUEL_LOG_PATH = path.join(__dirname, '../data/bridge/model_duel.jsonl');
loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true });

const DEFAULT_COMMAND_ALLOWLIST = Object.freeze({
    enabled: true,
    directCommands: ['auto', 'work', 'inspect', 'deploy', 'project', 'ops', 'word', 'news', 'prompt', 'finance', 'todo', 'routine', 'workout', 'media', 'place'],
    autoRoutes: ['word', 'memo', 'news', 'report', 'work', 'inspect', 'deploy', 'project', 'prompt', 'link', 'status', 'ops', 'finance', 'todo', 'routine', 'workout', 'media', 'place'],
});
const DEFAULT_HUB_DELEGATION = Object.freeze({
    enabled: false,
    fallbackPolicy: 'local',
    routeToProfile: Object.freeze({
        work: 'dev',
        inspect: 'dev',
        deploy: 'dev',
        project: 'dev',
        prompt: 'dev',
        word: 'anki',
        news: 'research',
        report: 'research',
        ops: 'daily',
        status: 'daily',
        link: 'daily',
        memo: 'daily',
        finance: 'daily',
        todo: 'daily',
        routine: 'daily',
        workout: 'daily',
        media: 'daily',
        place: 'daily',
    }),
});
const DEFAULT_NATURAL_LANGUAGE_ROUTING = Object.freeze({
    enabled: true,
    hubOnly: true,
    inferMemo: true,
    inferFinance: true,
    inferTodo: true,
    inferRoutine: true,
    inferWorkout: true,
    inferStatus: true,
    inferLink: true,
    inferReport: true,
});

const KNOWN_DIRECT_COMMANDS = new Set([
    'checklist',
    'summary',
    'work',
    'inspect',
    'deploy',
    'project',
    'ops',
    'word',
    'news',
    'prompt',
    'finance',
    'todo',
    'routine',
    'workout',
    'media',
    'place',
    'anki',
    'auto',
]);

const RETRY_BACKOFF_MS = [5000, 20000, 60000];
const RETRY_SAFE_COMMANDS = new Set([
    'summary',
    'work',
    'inspect',
    'deploy',
    'project',
    'prompt',
]);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableError(error) {
    const text = String(
        (error && (error.code || error.message || error.toString && error.toString())) || '',
    ).toLowerCase();
    return /(timed?out|etimedout|econnreset|eai_again|429|503|rate limit|temporar)/i.test(text);
}

function uniqueNormalizedList(values) {
    const out = [];
    const seen = new Set();
    for (const value of (Array.isArray(values) ? values : [])) {
        const key = String(value || '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

function parseAllowlistEnvList(value) {
    const raw = String(value || '').trim();
    if (!raw) return [];
    return uniqueNormalizedList(raw.split(',').map((v) => v.trim()).filter(Boolean));
}

function parseBooleanEnv(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    return null;
}

function normalizeAllowlistConfig(rawConfig, env = process.env) {
    const warnings = [];
    const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    if (rawConfig == null) {
        warnings.push('config.commandAllowlist missing; fallback defaults applied');
    } else if (typeof rawConfig !== 'object') {
        warnings.push('config.commandAllowlist must be an object; fallback defaults applied');
    }

    let enabled = DEFAULT_COMMAND_ALLOWLIST.enabled;
    if (typeof source.enabled === 'boolean') {
        enabled = source.enabled;
    } else if (Object.prototype.hasOwnProperty.call(source, 'enabled')) {
        warnings.push('commandAllowlist.enabled must be boolean; fallback default applied');
    }

    let directCommands = uniqueNormalizedList(source.directCommands);
    if (!directCommands.length) {
        directCommands = [...DEFAULT_COMMAND_ALLOWLIST.directCommands];
        warnings.push('commandAllowlist.directCommands invalid/missing; fallback defaults applied');
    }

    let autoRoutes = uniqueNormalizedList(source.autoRoutes);
    if (!autoRoutes.length) {
        autoRoutes = [...DEFAULT_COMMAND_ALLOWLIST.autoRoutes];
        warnings.push('commandAllowlist.autoRoutes invalid/missing; fallback defaults applied');
    }

    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_ALLOWLIST_ENABLED')) {
        const parsed = parseBooleanEnv(env.BRIDGE_ALLOWLIST_ENABLED);
        if (parsed == null) {
            warnings.push('BRIDGE_ALLOWLIST_ENABLED invalid; keeping config/default value');
        } else {
            enabled = parsed;
        }
    }

    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_ALLOWLIST_DIRECT_COMMANDS')) {
        const parsed = parseAllowlistEnvList(env.BRIDGE_ALLOWLIST_DIRECT_COMMANDS);
        if (parsed.length > 0) {
            directCommands = parsed;
        } else {
            warnings.push('BRIDGE_ALLOWLIST_DIRECT_COMMANDS empty/invalid; keeping config/default list');
        }
    }

    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_ALLOWLIST_AUTO_ROUTES')) {
        const parsed = parseAllowlistEnvList(env.BRIDGE_ALLOWLIST_AUTO_ROUTES);
        if (parsed.length > 0) {
            autoRoutes = parsed;
        } else {
            warnings.push('BRIDGE_ALLOWLIST_AUTO_ROUTES empty/invalid; keeping config/default list');
        }
    }

    return {
        enabled,
        directCommands,
        autoRoutes,
        warning: warnings.length > 0 ? warnings.join('; ') : '',
    };
}

function normalizeHubDelegationConfig(rawConfig) {
    const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    const rawMap = source.routeToProfile && typeof source.routeToProfile === 'object'
        ? source.routeToProfile
        : {};
    const routeToProfile = {};
    for (const [routeKey, profileValue] of Object.entries(rawMap)) {
        const route = String(routeKey || '').trim().toLowerCase();
        const profile = String(profileValue || '').trim().toLowerCase();
        if (!route || !profile) continue;
        routeToProfile[route] = profile;
    }
    const mergedRouteToProfile = {
        ...DEFAULT_HUB_DELEGATION.routeToProfile,
        ...routeToProfile,
    };
    return {
        enabled: source.enabled == null ? DEFAULT_HUB_DELEGATION.enabled : Boolean(source.enabled),
        fallbackPolicy: String(source.fallbackPolicy || DEFAULT_HUB_DELEGATION.fallbackPolicy).trim().toLowerCase() || 'local',
        routeToProfile: mergedRouteToProfile,
    };
}

function normalizeNaturalLanguageRoutingConfig(rawConfig, env = process.env) {
    const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    const pickBool = (key, fallback) => (
        source[key] == null ? fallback : Boolean(source[key])
    );

    let enabled = pickBool('enabled', DEFAULT_NATURAL_LANGUAGE_ROUTING.enabled);
    let hubOnly = pickBool('hubOnly', DEFAULT_NATURAL_LANGUAGE_ROUTING.hubOnly);
    let inferMemo = pickBool('inferMemo', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferMemo);
    let inferFinance = pickBool('inferFinance', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferFinance);
    let inferTodo = pickBool('inferTodo', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferTodo);
    let inferRoutine = pickBool('inferRoutine', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferRoutine);
    let inferWorkout = pickBool('inferWorkout', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferWorkout);
    let inferStatus = pickBool('inferStatus', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferStatus);
    let inferLink = pickBool('inferLink', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferLink);
    let inferReport = pickBool('inferReport', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferReport);

    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_ROUTING_ENABLED')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_ROUTING_ENABLED);
        if (parsed != null) enabled = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_ROUTING_HUB_ONLY')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_ROUTING_HUB_ONLY);
        if (parsed != null) hubOnly = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_MEMO')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_MEMO);
        if (parsed != null) inferMemo = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_FINANCE')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_FINANCE);
        if (parsed != null) inferFinance = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_TODO')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_TODO);
        if (parsed != null) inferTodo = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_ROUTINE')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_ROUTINE);
        if (parsed != null) inferRoutine = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_WORKOUT')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_WORKOUT);
        if (parsed != null) inferWorkout = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_STATUS')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_STATUS);
        if (parsed != null) inferStatus = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_LINK')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_LINK);
        if (parsed != null) inferLink = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_REPORT')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_REPORT);
        if (parsed != null) inferReport = parsed;
    }

    return {
        enabled,
        hubOnly,
        inferMemo,
        inferFinance,
        inferTodo,
        inferRoutine,
        inferWorkout,
        inferStatus,
        inferLink,
        inferReport,
    };
}

function isHubRuntime(env = process.env) {
    const role = String(env.MOLTBOT_BOT_ROLE || '').trim().toLowerCase();
    const botId = String(env.MOLTBOT_BOT_ID || '').trim().toLowerCase();
    return role === 'supervisor'
        || botId === 'bot-daily'
        || botId === 'daily';
}

function isResearchRuntime(env = process.env) {
    const botId = String(env.MOLTBOT_BOT_ID || '').trim().toLowerCase();
    const profile = String(env.MOLTBOT_PROFILE || env.OPENCLAW_PROFILE || '').trim().toLowerCase();
    return botId === 'bot-research'
        || botId === 'bot-research-bak'
        || profile === 'research'
        || profile === 'research_bak'
        || profile === 'trend'
        || profile === 'trend_bak';
}

const COMMAND_ALLOWLIST = normalizeAllowlistConfig(config.commandAllowlist, process.env);
const HUB_DELEGATION = normalizeHubDelegationConfig(config.hubDelegation);
const HUB_DELEGATION_ACTIVE = HUB_DELEGATION.enabled && isHubRuntime(process.env);
const BRIDGE_BLOCK_HINT = String(process.env.BRIDGE_BLOCK_HINT || '').trim();
const NATURAL_LANGUAGE_ROUTING = normalizeNaturalLanguageRoutingConfig(config.naturalLanguageRouting, process.env);

function applyDailyPersonaToOutput(base, metaInput = {}) {
    if (!base || typeof base !== 'object') return base;
    if (typeof base.telegramReply !== 'string' || !String(base.telegramReply).trim()) return base;
    const telegramReply = rewriteLocalLinks(base.telegramReply, getPublicBases());
    if (telegramReply === base.telegramReply) return base;
    return {
        ...base,
        telegramReply,
    };
}

function allowlistMeta() {
    return {
        allowlistEnabled: COMMAND_ALLOWLIST.enabled,
        ...(COMMAND_ALLOWLIST.warning ? { allowlistWarning: COMMAND_ALLOWLIST.warning } : {}),
    };
}

function isDirectCommandAllowed(command) {
    if (!COMMAND_ALLOWLIST.enabled) return true;
    const key = String(command || '').trim().toLowerCase();
    if (!key) return false;
    return COMMAND_ALLOWLIST.directCommands.includes(key);
}

function isAutoRouteAllowed(route) {
    if (!COMMAND_ALLOWLIST.enabled) return true;
    const key = String(route || '').trim().toLowerCase();
    if (!key || key === 'none') return true;
    return COMMAND_ALLOWLIST.autoRoutes.includes(key);
}

function buildAllowlistBlockedResponse({ requestedCommand = '', requestedRoute = '' } = {}) {
    const lines = [
        '허용되지 않은 명령입니다.',
        requestedCommand ? `요청 command: ${requestedCommand}` : '',
        requestedRoute ? `요청 route: ${requestedRoute}` : '',
        `허용 direct: ${COMMAND_ALLOWLIST.directCommands.join(', ')}`,
        `허용 auto route: ${COMMAND_ALLOWLIST.autoRoutes.join(', ')}`,
        BRIDGE_BLOCK_HINT ? `안내: ${BRIDGE_BLOCK_HINT}` : '',
    ].filter(Boolean);
    const out = {
        route: 'blocked',
        blocked: true,
        errorCode: 'COMMAND_NOT_ALLOWED',
        requestedCommand: requestedCommand || undefined,
        requestedRoute: requestedRoute || undefined,
        telegramReply: lines.join('\n'),
        ...allowlistMeta(),
    };
    return finalizeTelegramBoundary(out, { route: 'blocked' });
}

function captureConversationSafe({ route = 'none', message = '', source = 'user', skillHint = '' } = {}) {
    const text = String(message || '').trim();
    if (!text) return;
    try {
        captureConversation({
            route,
            source,
            message: text,
            skillHint: skillHint || route,
            approvalState: 'staged',
        });
    } catch (_) {
        // Capture failures must not break bridge responses.
    }
}

function splitWords(text) {
    const raw = String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // Telegram/bridge에서 literal "\\n"으로 들어온 경우도 실제 개행으로 취급
        .replace(/\\n/g, '\n');

    const byLines = raw
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

    let primaryTokens = byLines.length > 1
        ? byLines
        : raw
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

    // 한 줄에 "Word 뜻 Word 뜻 ..." 형태로 붙여 보낼 때를 대비한 보정.
    if (primaryTokens.length === 1) {
        const compact = String(primaryTokens[0] || '').replace(/\s+/g, ' ').trim();
        const looksPacked = (compact.match(/[A-Za-z][A-Za-z\-']*\s+[가-힣]/g) || []).length >= 2;
        if (looksPacked) {
            const packedSplit = compact
                .split(/\s+(?=[A-Z][A-Za-z\-']*(?:\s+[a-z][A-Za-z\-']*){0,4}\s+[~\(\[]*[가-힣])/)
                .map((v) => v.trim())
                .filter(Boolean);
            if (packedSplit.length > 1) {
                primaryTokens = packedSplit;
            }
        }
    }

    const expanded = [];
    for (const token of primaryTokens) {
        const parts = String(token).split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
        if (parts.length <= 1) {
            expanded.push(token);
            continue;
        }
        expanded.push(...parts);
    }
    return expanded;
}

function stripListPrefix(token) {
    return String(token || '')
        .replace(/^\s*[\-\*\u2022]+\s*/, '')
        .replace(/^\s*\d+\s*[\.\)]\s*/, '')
        .trim();
}

function normalizeWordParseInput(token) {
    return String(token || '')
        .replace(/[’‘`´]/g, "'")
        .replace(/[–—]/g, '-')
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeHintParseInput(hint) {
    return String(hint || '')
        .replace(/^[~\s]+/, '')
        .replace(/[()[\]{}<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseWordToken(token) {
    const clean = normalizeWordParseInput(stripListPrefix(token));
    if (!clean) return null;

    // 명시 구분자 우선 (:, |, " - ")
    const explicit = clean.match(/^([A-Za-z][A-Za-z\-'\s]{0,120}?)\s*(?:[:：|]| - )\s*(.+)$/);
    if (explicit) {
        return {
            word: explicit[1].trim(),
            hint: normalizeHintParseInput(explicit[2]),
        };
    }

    // "activate 활성화하다", "make it to ~에 참석하다", "wave (손,팔을) 흔들다" 형태 처리
    const mixed = clean.match(/^([A-Za-z][A-Za-z\-'\s]{0,120}?)\s+[\(\[\{<~\s]*([가-힣].+)$/);
    if (mixed) {
        return {
            word: mixed[1].trim(),
            hint: normalizeHintParseInput(mixed[2]),
        };
    }

    // 영어만 있으면 전체를 단어/구로 간주
    if (/^[A-Za-z][A-Za-z\-'\s]{0,120}$/.test(clean)) {
        return { word: clean.trim(), hint: '' };
    }

    return null;
}

function isKoreanHintFragment(token) {
    const text = String(token || '').trim();
    if (!text) return false;
    if (/[A-Za-z]/.test(text)) return false;
    if (!/[가-힣]/.test(text)) return false;
    return /^[가-힣0-9\s,./()\-~·'"“”‘’]+$/.test(text);
}

function mergeDetachedHintTokens(tokens = []) {
    const merged = [];
    for (const raw of (Array.isArray(tokens) ? tokens : [])) {
        const token = String(raw || '').trim();
        if (!token) continue;

        if (merged.length > 0 && isKoreanHintFragment(token)) {
            const prev = String(merged[merged.length - 1] || '').trim();
            const prevParsed = parseWordToken(prev);
            if (prevParsed && String(prevParsed.hint || '').trim()) {
                const joiner = /[,;]\s*$/.test(prevParsed.hint) ? ' ' : ', ';
                const combinedHint = `${prevParsed.hint}${joiner}${token}`.trim();
                merged[merged.length - 1] = `${prevParsed.word} ${combinedHint}`.trim();
                continue;
            }
        }

        merged.push(token);
    }
    return merged;
}

function buildToeicAnswer(word, hint) {
    const meaning = hint || fallbackMeaning(word) || '(의미 보강 필요)';
    return buildToeicAnswerRich(
        word,
        meaning,
        fallbackExample(word),
        '',
        `${word} 관련 예문입니다.`,
        'Part 5/6에서 자주 등장하는 문맥과 함께 암기하세요.',
    );
}

async function enrichToeicWord(word, hint, options = {}) {
    const quality = await createWordQuality(word, hint, options);
    return {
        meaning: quality.meaningKo,
        example: quality.exampleEn,
        exampleKo: quality.exampleKo,
        toeicTip: quality.toeicTip,
        partOfSpeech: quality.partOfSpeech || '',
        lemma: quality.lemma || normalizeWordToken(word),
        quality,
    };
}

function buildToeicAnswerRich(word, meaningText, exampleText, partOfSpeech = '', exampleKo = '', toeicTip = '') {
    const meaning = String(meaningText || '(의미 보강 필요)').trim();
    const ex = String(exampleText || fallbackExample(word)).trim();
    const pos = partOfSpeech ? `품사: ${partOfSpeech}<br>` : '';
    const ko = String(exampleKo || `${word} 관련 예문입니다.`).trim();
    const tip = String(toeicTip || 'Part 5/6 문맥에서 함께 출제되는 표현까지 암기하세요.').trim();
    return [
        `뜻: <b>${meaning}</b>`,
        '<hr>',
        `${pos}예문: <i>${ex}</i>`,
        `예문 해석: ${ko}`,
        '<hr>',
        `💡 <b>TOEIC TIP:</b> ${tip}`,
    ].join('<br>');
}

const COMMAND_TEMPLATE_SCHEMA = {
    work: {
        displayName: '작업',
        required: ['요청', '대상', '완료기준'],
        optional: ['제약', '우선순위', '기한', 'API'],
        aliases: {
            요청: ['요청', '목표', '작업', 'task', 'goal'],
            대상: ['대상', '범위', 'target', 'scope', 'repo', '파일'],
            완료기준: ['완료기준', '성공기준', 'done', 'acceptance'],
            제약: ['제약', '조건', 'constraint'],
            우선순위: ['우선순위', 'priority'],
            기한: ['기한', 'due', 'deadline'],
            API: ['api', 'API', '모델경로', 'api경로', 'lane'],
        },
    },
    inspect: {
        displayName: '점검',
        required: ['대상', '체크항목'],
        optional: ['출력형식', '심각도기준', 'API'],
        aliases: {
            대상: ['대상', '범위', 'target', 'scope'],
            체크항목: ['체크항목', '점검항목', 'check', 'checklist'],
            출력형식: ['출력형식', '형식', 'format'],
            심각도기준: ['심각도기준', 'severity'],
            API: ['api', 'API', '모델경로', 'api경로', 'lane'],
        },
    },
    deploy: {
        displayName: '배포',
        required: ['대상', '환경', '검증'],
        optional: ['롤백', '승인자', 'API'],
        aliases: {
            대상: ['대상', '서비스', 'target', 'service'],
            환경: ['환경', 'env', 'environment'],
            검증: ['검증', '검증방법', 'verify'],
            롤백: ['롤백', 'rollback'],
            승인자: ['승인자', 'approver'],
            API: ['api', 'API', '모델경로', 'api경로', 'lane'],
        },
    },
    project: {
        displayName: '프로젝트',
        required: ['프로젝트명', '목표', '스택', '경로', '완료기준'],
        optional: ['초기화', '제약', 'API'],
        aliases: {
            프로젝트명: ['프로젝트명', '이름', 'project', 'projectname', 'name'],
            목표: ['목표', '요청', 'objective', 'goal'],
            스택: ['스택', '기술스택', 'stack', 'tech'],
            경로: ['경로', 'path', 'directory', 'dir'],
            완료기준: ['완료기준', 'done', 'acceptance', 'success'],
            초기화: ['초기화', 'init', 'bootstrap'],
            제약: ['제약', 'constraint'],
            API: ['api', 'API', '모델경로', 'api경로', 'lane'],
        },
    },
    ops: {
        displayName: '운영',
        required: ['액션'],
        optional: [
            '대상',
            '사유',
            '작업',
            '경로',
            '대상경로',
            '패턴',
            '저장소',
            '커밋메시지',
            '토큰',
            '옵션',
            '계정',
            '수신자',
            '제목',
            '본문',
            '시간',
            '첨부',
            '장치',
            '식별자',
            '내용',
            'URL',
            '셀렉터',
            '키',
            '값',
            '메서드',
        ],
        aliases: {
            액션: ['액션', 'action', '명령'],
            대상: ['대상', 'target', '서비스'],
            사유: ['사유', 'reason', '메모'],
            작업: ['작업', 'task', 'operation', 'intent'],
            경로: ['경로', 'path', 'source', 'src'],
            대상경로: ['대상경로', 'targetpath', 'destination', 'dst'],
            패턴: ['패턴', 'pattern', 'glob'],
            저장소: ['저장소', 'repository', 'repo'],
            커밋메시지: ['커밋메시지', 'commitmessage', 'message'],
            토큰: ['토큰', 'token', 'approval'],
            옵션: ['옵션', 'option', 'flags'],
            계정: ['계정', 'account', 'mailbox', 'profile'],
            수신자: ['수신자', 'recipient', 'to', 'email'],
            제목: ['제목', 'subject'],
            본문: ['본문', 'body'],
            시간: ['시간', 'time', 'schedule_at', 'when'],
            첨부: ['첨부', 'attachment', 'file'],
            장치: ['장치', 'device', 'camera'],
            식별자: ['식별자', 'id', 'event_id', 'schedule_id'],
            내용: ['내용', 'content', 'note'],
            URL: ['url', 'URL', '링크', '주소'],
            셀렉터: ['셀렉터', 'selector', 'ref'],
            키: ['키', 'key'],
            값: ['값', 'value', 'text'],
            메서드: ['메서드', 'method'],
        },
    },
};

const OPS_ALLOWED_TARGETS = {
    dev: 'moltbot-dev',
    anki: 'moltbot-anki',
    research: 'moltbot-research',
    daily: 'moltbot-daily',
    dev_bak: 'moltbot-dev-bak',
    anki_bak: 'moltbot-anki-bak',
    research_bak: 'moltbot-research-bak',
    daily_bak: 'moltbot-daily-bak',
    // Legacy aliases
    main: 'moltbot-dev',
    sub1: 'moltbot-anki',
    main_bak: 'moltbot-dev-bak',
    sub1_bak: 'moltbot-anki-bak',
    proxy: 'moltbot-proxy',
    webproxy: 'moltbot-web-proxy',
    tunnel: 'moltbot-dev-tunnel',
    prompt: 'moltbot-prompt-web',
    web: ['moltbot-prompt-web', 'moltbot-web-proxy'],
    all: [
        'moltbot-dev',
        'moltbot-anki',
        'moltbot-research',
        'moltbot-daily',
        'moltbot-dev-bak',
        'moltbot-anki-bak',
        'moltbot-research-bak',
        'moltbot-daily-bak',
        'moltbot-prompt-web',
        'moltbot-proxy',
        'moltbot-web-proxy',
        'moltbot-dev-tunnel',
    ],
};

function normalizeOpsAction(value) {
    const v = String(value || '').trim().toLowerCase();
    if (/(재시작|restart|reboot)/.test(v)) return 'restart';
    if (/(상태|status|health|check)/.test(v)) return 'status';
    if (/(파일|file|fs|git)/.test(v)) return 'file';
    if (/(메일|mail|email)/.test(v)) return 'mail';
    if (/(사진|photo|image|camera|cam)/.test(v)) return 'photo';
    if (/(일정|스케줄|schedule|calendar)/.test(v)) return 'schedule';
    if (/(브라우저|browser|웹자동화)/.test(v)) return 'browser';
    if (/(승인|approve)/.test(v)) return 'approve';
    return null;
}

const OPS_CAPABILITY_POLICY = Object.freeze({
    mail: Object.freeze({
        list: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
        summary: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
        send: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
    }),
    photo: Object.freeze({
        capture: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
        list: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
        cleanup: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
    }),
    schedule: Object.freeze({
        list: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
        create: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
        update: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
        delete: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
    }),
    browser: Object.freeze({
        open: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
        list: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
        click: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
        type: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
        wait: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
        screenshot: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
        checkout: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
        post: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
        send: { risk_tier: 'HIGH', requires_approval: true, mutating: true },
    }),
});

function normalizeOpsCapabilityAction(capability, value) {
    const raw = String(value || '').trim().toLowerCase();
    if (capability === 'mail') {
        if (/(list|목록|조회|inbox|메일함)/.test(raw)) return 'list';
        if (/(summary|요약|digest)/.test(raw)) return 'summary';
        if (/(send|전송|발송|보내기)/.test(raw)) return 'send';
        return 'list';
    }
    if (capability === 'photo') {
        if (/(capture|snap|shoot|촬영|캡처)/.test(raw)) return 'capture';
        if (/(list|목록|조회)/.test(raw)) return 'list';
        if (/(cleanup|정리|clean|삭제)/.test(raw)) return 'cleanup';
        return 'list';
    }
    if (capability === 'schedule') {
        if (/(list|목록|조회)/.test(raw)) return 'list';
        if (/(create|add|등록|추가)/.test(raw)) return 'create';
        if (/(update|edit|수정|변경)/.test(raw)) return 'update';
        if (/(delete|remove|삭제)/.test(raw)) return 'delete';
        return 'list';
    }
    if (capability === 'browser') {
        if (/(open|열기|navigate|접속|이동)/.test(raw)) return 'open';
        if (/(list|목록|조회)/.test(raw)) return 'list';
        if (/(click|클릭)/.test(raw)) return 'click';
        if (/(type|입력)/.test(raw)) return 'type';
        if (/(wait|대기)/.test(raw)) return 'wait';
        if (/(screenshot|캡처|스크린샷)/.test(raw)) return 'screenshot';
        if (/(checkout|결제)/.test(raw)) return 'checkout';
        if (/(post|요청|전송요청)/.test(raw)) return 'post';
        if (/(send|보내기|발송)/.test(raw)) return 'send';
        return 'list';
    }
    return null;
}

function buildCapabilityPayload(fields = {}) {
    return {
        target: String(fields.대상 || '').trim(),
        reason: String(fields.사유 || '').trim(),
        path: String(fields.경로 || '').trim(),
        target_path: String(fields.대상경로 || '').trim(),
        pattern: String(fields.패턴 || '').trim(),
        account: String(fields.계정 || '').trim(),
        recipient: String(fields.수신자 || '').trim(),
        subject: String(fields.제목 || '').trim(),
        body: String(fields.본문 || '').trim(),
        content: String(fields.내용 || '').trim(),
        when: String(fields.시간 || '').trim(),
        attachment: String(fields.첨부 || '').trim(),
        device: String(fields.장치 || '').trim(),
        identifier: String(fields.식별자 || '').trim(),
        url: String(fields.URL || '').trim(),
        selector: String(fields.셀렉터 || '').trim(),
        key: String(fields.키 || '').trim(),
        value: String(fields.값 || '').trim(),
        method: String(fields.메서드 || '').trim(),
    };
}

function normalizeOpsTarget(value) {
    const raw = String(value || '').trim().toLowerCase();
    const map = {
        'dev': 'dev',
        '개발': 'dev',
        'main': 'dev',
        '메인': 'dev',
        'anki': 'anki',
        '안키': 'anki',
        'sub': 'anki',
        'sub1': 'anki',
        '서브': 'anki',
        'research': 'research',
        '리서치': 'research',
        '리서쳐': 'research',
        'daily': 'daily',
        '일상': 'daily',
        'dev_bak': 'dev_bak',
        'dev-bak': 'dev_bak',
        'main_bak': 'dev_bak',
        'main-bak': 'dev_bak',
        '개발백업': 'dev_bak',
        'anki_bak': 'anki_bak',
        'anki-bak': 'anki_bak',
        'sub1_bak': 'anki_bak',
        'sub1-bak': 'anki_bak',
        '안키백업': 'anki_bak',
        'research_bak': 'research_bak',
        'research-bak': 'research_bak',
        '리서쳐백업': 'research_bak',
        'daily_bak': 'daily_bak',
        'daily-bak': 'daily_bak',
        '일상백업': 'daily_bak',
        'proxy': 'proxy',
        '프록시': 'proxy',
        'webproxy': 'webproxy',
        '웹프록시': 'webproxy',
        'tunnel': 'tunnel',
        '터널': 'tunnel',
        'prompt': 'prompt',
        '프롬프트': 'prompt',
        'web': 'web',
        '웹': 'web',
        'all': 'all',
        '전체': 'all',
    };
    return map[raw] || null;
}

function execDocker(args) {
    const res = spawnSync('docker', args, { encoding: 'utf8' });
    return {
        ok: !res.error && res.status === 0,
        code: res.status == null ? 1 : res.status,
        stdout: String(res.stdout || '').trim(),
        stderr: String(res.stderr || '').trim(),
        error: res.error ? String(res.error.message || res.error) : '',
    };
}

const OPS_QUEUE_PATH = path.join(__dirname, '..', 'data', 'runtime', 'ops_requests.jsonl');
const OPS_SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'runtime', 'ops_snapshot.json');

function parseTransportEnvelopeContext(text) {
    const raw = String(text || '').trim();
    const envelope = raw.match(/^\s*\[(Telegram|WhatsApp|Discord|Slack|Signal|Line|Matrix|KakaoTalk|Kakao|iMessage|SMS)\b([^\]]*)\]\s*/i);
    if (!envelope) return null;
    const provider = String(envelope[1] || '').trim().toLowerCase();
    const header = String(envelope[2] || '').trim();
    const userIdMatch = header.match(/\bid\s*[:=]\s*([0-9-]{3,})/i);
    const groupIdMatch = header.match(/\b(?:group|chat|chat_id)\s*[:=]\s*([0-9-]{3,})/i);
    return {
        provider,
        userId: userIdMatch ? String(userIdMatch[1]).trim() : '',
        groupId: groupIdMatch ? String(groupIdMatch[1]).trim() : '',
        header,
    };
}

function resolveHubDelegationTarget(route) {
    if (!HUB_DELEGATION_ACTIVE) return null;
    const key = String(route || '').trim().toLowerCase();
    if (!key || key === 'none') return null;
    const target = String(HUB_DELEGATION.routeToProfile[key] || '').trim().toLowerCase();
    if (!target) return null;
    if (target === 'daily' || target === 'local' || target === 'self') return null;
    return target;
}

function enqueueHubDelegationCommand({ route, payload, originalMessage, rawText, telegramContext }) {
    const targetProfile = resolveHubDelegationTarget(route);
    if (!targetProfile) return null;
    const normalizedOriginal = String(originalMessage || '').trim();
    if (!normalizedOriginal) return null;
    const requestedBy = opsFileControl.normalizeRequester(telegramContext, 'hub:auto');
    const queued = enqueueCapabilityCommand({
        phase: 'plan',
        capability: 'bot',
        action: 'dispatch',
        requested_by: requestedBy,
        telegram_context: telegramContext || parseTransportEnvelopeContext(rawText || ''),
        reason: `hub_delegation:${route}`,
        risk_tier: 'MEDIUM',
        requires_approval: false,
        payload: {
            route: String(route || '').trim().toLowerCase(),
            route_payload: String(payload || '').trim(),
            original_message: normalizedOriginal,
            target_profile: targetProfile,
            target: targetProfile,
        },
    });
    return {
        route: String(route || '').trim().toLowerCase() || 'none',
        delegated: true,
        targetProfile,
        queued: true,
        phase: 'plan',
        capability: 'bot',
        capabilityAction: 'dispatch',
        requestId: queued.requestId,
        telegramContext: telegramContext || null,
        telegramReply: [
            `허브 위임 접수: ${route} -> ${targetProfile}`,
            `- request: ${queued.requestId}`,
            '- 결과는 역할 봇 처리 후 자동 회신됩니다.',
        ].join('\n'),
    };
}

function resolveOpsFilePolicy() {
    const baseConfig = (config && typeof config === 'object') ? config : {};
    const policyPatch = {
        ...((baseConfig.opsFileControlPolicy && typeof baseConfig.opsFileControlPolicy === 'object')
            ? baseConfig.opsFileControlPolicy
            : {}),
    };
    if (baseConfig.telegramGuard && typeof baseConfig.telegramGuard === 'object') {
        policyPatch.telegramGuard = {
            ...((policyPatch.telegramGuard && typeof policyPatch.telegramGuard === 'object') ? policyPatch.telegramGuard : {}),
            ...baseConfig.telegramGuard,
        };
    }
    return opsFileControl.loadPolicy({
        ...baseConfig,
        opsFileControlPolicy: policyPatch,
    });
}

function normalizeOpsOptionFlags(value) {
    return opsFileControl.normalizeApprovalFlags(value);
}

function normalizeOpsFileIntent(value) {
    return opsFileControl.normalizeIntentAction(value);
}

function isFileControlAction(action) {
    return action === 'file' || action === 'approve';
}

function enforceFileControlTelegramGuard(telegramContext, policy) {
    const guard = (policy && policy.telegramGuard) || {};
    if (guard.enabled === false) return { ok: true };
    if (guard.requireContext !== false && (!telegramContext || !telegramContext.provider)) {
        return {
            ok: false,
            code: 'TELEGRAM_CONTEXT_REQUIRED',
            message: '파일 제어 요청은 Telegram 컨텍스트가 필요합니다.',
        };
    }
    if (!telegramContext || String(telegramContext.provider || '').toLowerCase() !== 'telegram') {
        return {
            ok: false,
            code: 'TELEGRAM_PROVIDER_REQUIRED',
            message: '파일 제어 요청은 Telegram 채널에서만 허용됩니다.',
        };
    }

    const userId = String(telegramContext.userId || '').trim();
    const groupId = String(telegramContext.groupId || '').trim();
    const allowedUsers = Array.isArray(guard.allowedUserIds) ? guard.allowedUserIds.map((x) => String(x)) : [];
    const allowedGroups = Array.isArray(guard.allowedGroupIds) ? guard.allowedGroupIds.map((x) => String(x)) : [];

    if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
        if (!userId) {
            return {
                ok: false,
                code: 'TELEGRAM_USER_REQUIRED',
                message: 'Telegram 사용자 ID가 없어 파일 제어 요청을 거부합니다.',
            };
        }
        return {
            ok: false,
            code: 'TELEGRAM_USER_NOT_ALLOWED',
            message: `허용되지 않은 Telegram 사용자입니다: ${userId || 'unknown'}`,
        };
    }

    if (allowedGroups.length > 0 && !groupId) {
        return {
            ok: false,
            code: 'TELEGRAM_GROUP_REQUIRED',
            message: 'Telegram 그룹 ID가 없어 파일 제어 요청을 거부합니다.',
        };
    }

    if (allowedGroups.length > 0 && groupId && !allowedGroups.includes(groupId)) {
        return {
            ok: false,
            code: 'TELEGRAM_GROUP_NOT_ALLOWED',
            message: `허용되지 않은 Telegram 그룹입니다: ${groupId}`,
        };
    }

    return { ok: true };
}

function isApprovalGrantEnabled(policy) {
    return Boolean(
        policy
        && policy.approvalGrantPolicy
        && typeof policy.approvalGrantPolicy === 'object'
        && policy.approvalGrantPolicy.enabled,
    );
}

function parseApproveShorthand(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const match = raw.match(/^approve\s+([A-Za-z0-9._:-]+)\s*(.*)$/i);
    if (!match) return null;
    const token = String(match[1] || '').trim();
    const flags = normalizeOpsOptionFlags(match[2] || '');
    const flagText = flags.length > 0
        ? `; 옵션: ${flags.map((flag) => `--${flag}`).join(' ')}`
        : '';
    return {
        token,
        flags,
        normalizedPayload: `액션: 승인; 토큰: ${token}${flagText}`,
    };
}

function normalizeOpsPayloadText(text) {
    const approve = parseApproveShorthand(text);
    if (approve) {
        return {
            payloadText: approve.normalizedPayload,
            approveShorthand: approve,
        };
    }
    return {
        payloadText: String(text || '').trim(),
        approveShorthand: null,
    };
}

function enqueueFileControlCommand(command = {}) {
    const normalized = {
        schema_version: '1.0',
        request_id: opsCommandQueue.makeRequestId('opsfc'),
        phase: String(command.phase || 'plan'),
        intent_action: String(command.intent_action || '').trim(),
        requested_by: String(command.requested_by || '').trim() || 'unknown',
        telegram_context: (command.telegram_context && typeof command.telegram_context === 'object')
            ? command.telegram_context
            : null,
        payload: (command.payload && typeof command.payload === 'object') ? command.payload : {},
        created_at: new Date().toISOString(),
    };
    return opsCommandQueue.enqueueCommand(normalized);
}

function enqueueCapabilityCommand(command = {}) {
    const capability = String(command.capability || '').trim().toLowerCase();
    const action = String(command.action || '').trim().toLowerCase();
    const normalized = {
        schema_version: '1.0',
        request_id: opsCommandQueue.makeRequestId('opsc'),
        command_kind: 'capability',
        phase: String(command.phase || 'plan').trim().toLowerCase(),
        capability,
        action,
        intent_action: `capability:${capability}:${action}`,
        risk_tier: String(command.risk_tier || 'MEDIUM').trim().toUpperCase(),
        requires_approval: Boolean(command.requires_approval),
        requested_by: String(command.requested_by || '').trim() || 'unknown',
        telegram_context: (command.telegram_context && typeof command.telegram_context === 'object')
            ? command.telegram_context
            : null,
        reason: String(command.reason || '').trim(),
        payload: (command.payload && typeof command.payload === 'object') ? command.payload : {},
        created_at: new Date().toISOString(),
    };
    return opsCommandQueue.enqueueCommand(normalized);
}

function isDockerPermissionError(errText) {
    return /(EACCES|permission denied|Cannot connect to the Docker daemon|is the docker daemon running)/i.test(String(errText || ''));
}

function queueOpsRequest(action, targetKey, targets, reason = '') {
    const id = `ops-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const row = {
        id,
        createdAt: new Date().toISOString(),
        action,
        target: targetKey,
        targets,
        reason: String(reason || '').trim(),
        status: 'pending',
    };
    const dir = path.dirname(OPS_QUEUE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(OPS_QUEUE_PATH, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
}

function readOpsSnapshot() {
    try {
        const raw = fs.readFileSync(OPS_SNAPSHOT_PATH, 'utf8');
        const json = JSON.parse(raw);
        if (!json || !Array.isArray(json.containers)) return null;
        return json;
    } catch (_) {
        return null;
    }
}

function normalizeOpsStateBucket(state, statusText) {
    const stateRaw = String(state || '').trim().toLowerCase();
    const statusRaw = String(statusText || '').trim().toLowerCase();
    if (stateRaw === 'running' || /^up\b/.test(statusRaw)) return 'running';
    if (stateRaw === 'restarting' || /^restarting\b/.test(statusRaw)) return 'restarting';
    if (stateRaw === 'paused') return 'paused';
    if (stateRaw === 'created') return 'created';
    if (stateRaw === 'exited' || stateRaw === 'dead' || statusRaw === 'not-running' || /\bexited\b/.test(statusRaw)) return 'stopped';
    if (statusRaw === 'not-found') return 'missing';
    return 'unknown';
}

function buildOpsStatusRowsFromDocker(rawLines, targets) {
    const map = new Map();
    for (const line of String(rawLines || '').split('\n').filter(Boolean)) {
        const parts = line.split('\t');
        if (parts.length < 2) continue;
        const name = String(parts[0] || '').trim();
        const state = String(parts[1] || '').trim();
        const statusText = String(parts.slice(2).join('\t') || '').trim() || state || 'unknown';
        if (!name) continue;
        map.set(name, { name, state, statusText });
    }
    return targets.map((name) => {
        const row = map.get(name);
        if (!row) {
            return {
                name,
                state: 'missing',
                statusText: 'not-found',
            };
        }
        return {
            name: row.name,
            state: normalizeOpsStateBucket(row.state, row.statusText),
            statusText: row.statusText,
        };
    });
}

function buildOpsStatusRowsFromSnapshot(snapshot, targets) {
    const map = new Map();
    for (const row of (Array.isArray(snapshot && snapshot.containers) ? snapshot.containers : [])) {
        const name = String((row && row.name) || '').trim();
        if (!name) continue;
        const statusText = String((row && row.status) || '').trim() || 'unknown';
        map.set(name, { name, statusText });
    }
    return targets.map((name) => {
        const row = map.get(name);
        if (!row) {
            return {
                name,
                state: 'missing',
                statusText: 'not-found',
            };
        }
        return {
            name: row.name,
            state: normalizeOpsStateBucket('', row.statusText),
            statusText: row.statusText,
        };
    });
}

function buildOpsStatusReply(rows, options = {}) {
    const safeRows = Array.isArray(rows) ? rows : [];
    if (safeRows.length === 0) return '운영 상태: 대상 정보가 없습니다.';

    const counts = {
        running: 0,
        restarting: 0,
        paused: 0,
        created: 0,
        stopped: 0,
        missing: 0,
        unknown: 0,
    };
    for (const row of safeRows) {
        const bucket = String((row && row.state) || 'unknown');
        counts[bucket] = (counts[bucket] || 0) + 1;
    }

    const summary = [
        `running ${counts.running}`,
        `stopped ${counts.stopped}`,
        `missing ${counts.missing}`,
        counts.restarting > 0 ? `restarting ${counts.restarting}` : '',
        counts.paused > 0 ? `paused ${counts.paused}` : '',
        counts.created > 0 ? `created ${counts.created}` : '',
        counts.unknown > 0 ? `unknown ${counts.unknown}` : '',
    ].filter(Boolean).join(', ');
    const title = options.snapshotUpdatedAt
        ? `운영 상태(스냅샷 ${options.snapshotUpdatedAt}):`
        : '운영 상태:';
    const lines = [
        title,
        `- 요약: ${summary}`,
        ...safeRows.map((row) => `- ${row.name}: ${row.statusText}`),
    ];
    if (options.tunnelUrl) {
        lines.push(`- tunnel-url: ${options.tunnelUrl}`);
    }
    return lines.join('\n');
}

function runOpsCommand(payloadText, options = {}) {
    const normalized = normalizeOpsPayloadText(payloadText);
    const parsed = parseStructuredCommand('ops', normalized.payloadText);
    if (!parsed.ok) {
        return { route: 'ops', templateValid: false, ...parsed };
    }

    const action = normalizeOpsAction(parsed.fields.액션);
    const targetKey = normalizeOpsTarget(parsed.fields.대상);
    const telegramContext = options.telegramContext || parseTransportEnvelopeContext(options.rawText || '');
    const policy = resolveOpsFilePolicy();
    const requestedBy = opsFileControl.normalizeRequester(telegramContext, options.requestedBy || '');

    if (!action) {
        return {
            route: 'ops',
            templateValid: false,
            error: '지원하지 않는 액션입니다.',
            telegramReply: '운영 템플릿 액션은 `재시작`, `상태`, `파일`, `메일`, `사진`, `일정`, `브라우저`, `승인`만 지원합니다.',
        };
    }

    if (isFileControlAction(action)) {
        const guard = enforceFileControlTelegramGuard(telegramContext, policy);
        if (!guard.ok) {
            return {
                route: 'ops',
                templateValid: true,
                success: false,
                action,
                errorCode: guard.code,
                telegramReply: `파일 제어 정책 차단: ${guard.message}`,
            };
        }
    }

    if (action === 'status') {
        if (!targetKey || !OPS_ALLOWED_TARGETS[targetKey]) {
            return {
                route: 'ops',
                templateValid: false,
                error: '지원하지 않는 대상입니다.',
                telegramReply: '운영 대상은 dev/anki/research/daily/dev_bak/anki_bak/research_bak/daily_bak/proxy/webproxy/tunnel/prompt/web/all 만 지원합니다. (legacy: main/sub1 지원)',
            };
        }
        const targets = Array.isArray(OPS_ALLOWED_TARGETS[targetKey])
            ? OPS_ALLOWED_TARGETS[targetKey]
            : [OPS_ALLOWED_TARGETS[targetKey]];
        const ps = execDocker(['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}']);
        if (!ps.ok) {
            if (isDockerPermissionError(ps.stderr || ps.error)) {
                const snap = readOpsSnapshot();
                const tunnelUrl = targetKey === 'tunnel' || targetKey === 'all' ? getTunnelPublicBaseUrl() : null;
                if (snap && Array.isArray(snap.containers)) {
                    const rows = buildOpsStatusRowsFromSnapshot(snap, targets);
                    return {
                        route: 'ops',
                        templateValid: true,
                        success: true,
                        action,
                        target: targetKey,
                        source: 'snapshot',
                        snapshotUpdatedAt: snap.updatedAt || null,
                        results: rows.map((row) => `${row.name}\t${row.statusText}`),
                        rows,
                        telegramReply: buildOpsStatusReply(rows, {
                            snapshotUpdatedAt: snap.updatedAt || '',
                            tunnelUrl,
                        }),
                    };
                }
            }
            return {
                route: 'ops',
                templateValid: true,
                success: false,
                action,
                target: targetKey,
                telegramReply: `운영 상태 조회 실패: ${ps.stderr || ps.error || 'unknown error'}`,
            };
        }
        const rows = buildOpsStatusRowsFromDocker(ps.stdout, targets);
        const tunnelUrl = targetKey === 'tunnel' || targetKey === 'all' ? getTunnelPublicBaseUrl() : null;
        return {
            route: 'ops',
            templateValid: true,
            success: true,
            action,
            target: targetKey,
            results: rows.map((row) => `${row.name}\t${row.statusText}`),
            rows,
            telegramReply: buildOpsStatusReply(rows, { tunnelUrl }),
        };
    }

    if (action === 'restart') {
        if (!targetKey || !OPS_ALLOWED_TARGETS[targetKey]) {
            return {
                route: 'ops',
                templateValid: false,
                error: '지원하지 않는 대상입니다.',
                telegramReply: '운영 대상은 dev/anki/research/daily/dev_bak/anki_bak/research_bak/daily_bak/proxy/webproxy/tunnel/prompt/web/all 만 지원합니다. (legacy: main/sub1 지원)',
            };
        }
        const targets = Array.isArray(OPS_ALLOWED_TARGETS[targetKey])
            ? OPS_ALLOWED_TARGETS[targetKey]
            : [OPS_ALLOWED_TARGETS[targetKey]];
        const queued = queueOpsRequest(action, targetKey, targets, parsed.fields.사유 || '');
        return {
            route: 'ops',
            templateValid: true,
            success: true,
            queued: true,
            action,
            phase: 'execute',
            target: targetKey,
            requestId: queued.id,
            telegramReply: `운영 재시작 요청 접수: ${queued.id}\n호스트 작업 큐에서 순차 실행됩니다.`,
        };
    }

    if (action === 'file') {
        const intentAction = normalizeOpsFileIntent(parsed.fields.작업);
        if (!intentAction) {
            return {
                route: 'ops',
                templateValid: false,
                success: false,
                action,
                errorCode: 'FILE_ACTION_REQUIRED',
                telegramReply: [
                    '파일 제어 작업이 필요합니다.',
                    '지원 작업: list_files, compute_plan, move, rename, archive, trash, restore, drive_preflight_check, git_status, git_diff, git_mv, git_add, git_commit, git_push',
                ].join('\n'),
            };
        }

        const payload = {
            path: String(parsed.fields.경로 || '').trim(),
            target_path: String(parsed.fields.대상경로 || '').trim(),
            pattern: String(parsed.fields.패턴 || '').trim(),
            repository: String(parsed.fields.저장소 || '').trim(),
            commit_message: String(parsed.fields.커밋메시지 || '').trim(),
            options: normalizeOpsOptionFlags(parsed.fields.옵션 || ''),
        };
        const queued = enqueueFileControlCommand({
            phase: 'plan',
            intent_action: intentAction,
            requested_by: requestedBy,
            telegram_context: telegramContext,
            payload,
        });
        return {
            route: 'ops',
            templateValid: true,
            success: true,
            queued: true,
            phase: 'plan',
            action,
            intentAction,
            requestId: queued.requestId,
            telegramContext,
            telegramReply: [
                `파일 제어 PLAN 요청 접수: ${queued.requestId}`,
                '- 기본 모드: dry-run (실행 전 승인 필요)',
                '- 호스트 runner가 위험도/정확 경로/토큰을 계산합니다.',
            ].join('\n'),
        };
    }

    if (action === 'mail' || action === 'photo' || action === 'schedule' || action === 'browser') {
        const capabilityAction = normalizeOpsCapabilityAction(action, parsed.fields.작업);
        const capabilityPolicy = OPS_CAPABILITY_POLICY[action] || {};
        const capabilityRoutePolicy = (capabilityAction && capabilityPolicy[capabilityAction]) || null;
        if (!capabilityAction || !capabilityRoutePolicy) {
            const policyKeys = Object.keys(capabilityPolicy);
            return {
                route: 'ops',
                templateValid: false,
                success: false,
                action,
                errorCode: 'CAPABILITY_ACTION_REQUIRED',
                telegramReply: [
                    `${action} 작업이 필요합니다.`,
                    `지원 작업: ${policyKeys.length > 0 ? policyKeys.join(', ') : '(none)'}`,
                ].join('\n'),
            };
        }

        const payload = {
            ...buildCapabilityPayload(parsed.fields),
            options: normalizeOpsOptionFlags(parsed.fields.옵션 || ''),
        };
        const queued = enqueueCapabilityCommand({
            phase: 'plan',
            capability: action,
            action: capabilityAction,
            requested_by: requestedBy,
            telegram_context: telegramContext,
            reason: String(parsed.fields.사유 || '').trim(),
            payload,
            risk_tier: capabilityRoutePolicy.risk_tier,
            requires_approval: capabilityRoutePolicy.requires_approval,
        });
        const approvalHint = capabilityRoutePolicy.requires_approval
            ? '- 고위험 작업으로 분류되어 승인 토큰이 발급됩니다. 승인 후 `APPROVE <token>`로 실행됩니다.'
            : '- 저위험 작업으로 분류되어 PLAN 검증 후 호스트 runner가 즉시 실행합니다.';
        const grantHint = (capabilityRoutePolicy.requires_approval && isApprovalGrantEnabled(policy))
            ? '- 승인 성공 시 일정 시간 전체 권한 세션이 열려, 추가 고위험 작업이 토큰 없이 실행될 수 있습니다.'
            : '';
        return {
            route: 'ops',
            templateValid: true,
            success: true,
            queued: true,
            phase: 'plan',
            action,
            capability: action,
            capabilityAction,
            requestId: queued.requestId,
            riskTier: capabilityRoutePolicy.risk_tier,
            requiresApproval: Boolean(capabilityRoutePolicy.requires_approval),
            telegramContext,
            telegramReply: [
                `${action} ${capabilityAction.toUpperCase()} PLAN 요청 접수: ${queued.requestId}`,
                `- risk: ${capabilityRoutePolicy.risk_tier}`,
                approvalHint,
                grantHint,
            ].filter(Boolean).join('\n'),
        };
    }

    if (action === 'approve') {
        const approveFlags = normalizeOpsOptionFlags([
            ...(normalized.approveShorthand ? normalized.approveShorthand.flags : []),
            ...normalizeOpsOptionFlags(parsed.fields.옵션 || ''),
        ]);
        const token = String(parsed.fields.토큰 || (normalized.approveShorthand && normalized.approveShorthand.token) || '').trim();
        if (!token) {
            return {
                route: 'ops',
                templateValid: false,
                success: false,
                action,
                errorCode: 'TOKEN_REQUIRED',
                telegramReply: '승인 토큰이 필요합니다. 예: APPROVE <token> --force',
            };
        }

        const queued = enqueueFileControlCommand({
            phase: 'execute',
            intent_action: normalizeOpsFileIntent(parsed.fields.작업 || '') || 'execute',
            requested_by: requestedBy,
            telegram_context: telegramContext,
            payload: {
                token,
                approval_flags: approveFlags,
            },
        });
        return {
            route: 'ops',
            templateValid: true,
            success: true,
            queued: true,
            phase: 'execute',
            action,
            requestId: queued.requestId,
            token,
            approvalFlags: approveFlags,
            telegramContext,
            telegramReply: [
                `파일 제어 EXECUTE 요청 접수: ${queued.requestId}`,
                `- token: ${token}`,
                `- flags: ${approveFlags.length > 0 ? approveFlags.map((flag) => `--${flag}`).join(' ') : '(none)'}`,
                '- 호스트 runner가 토큰/요청자/플래그를 검증 후 실행합니다.',
                isApprovalGrantEnabled(policy)
                    ? '- 승인 성공 시 일정 시간 전체 권한 세션이 열립니다.'
                    : '',
            ].filter(Boolean).join('\n'),
        };
    }

    return {
        route: 'ops',
        templateValid: false,
        success: false,
        action,
        errorCode: 'UNSUPPORTED_OPS_ACTION',
        telegramReply: '지원하지 않는 운영 액션입니다.',
    };
}

function normalizeHttpsBase(v) {
    const out = String(v || '').trim().replace(/\/+$/, '');
    return /^https:\/\/[a-z0-9.-]+$/i.test(out) ? out : null;
}

function getTunnelPublicBaseUrl() {
    // Backward-compat helper for legacy callers.
    const bases = getPublicBases();
    return bases.promptBase || bases.genericBase || null;
}

function getPublicBases() {
    const promptEnv = normalizeHttpsBase(process.env.PROMPT_PUBLIC_BASE_URL || '');
    const genericEnv = normalizeHttpsBase(process.env.DEV_TUNNEL_PUBLIC_BASE_URL || '');

    if (promptEnv || genericEnv) {
        return {
            promptBase: promptEnv || genericEnv || null,
            genericBase: genericEnv || null,
        };
    }

    // Host-side tunnel manager writes latest URL to a shared state file.
    try {
        const statePath = path.join(__dirname, '..', 'data', 'runtime', 'tunnel_state.json');
        const raw = fs.readFileSync(statePath, 'utf8');
        const json = JSON.parse(raw);
        const candidate = normalizeHttpsBase(json && json.publicUrl ? json.publicUrl : '');
        if (candidate) {
            return {
                promptBase: candidate,
                genericBase: candidate,
            };
        }
    } catch (_) {
        // no-op: fall through to docker logs probing
    }

    // Fallback: probe tunnel container logs (works on host bridge execution path).
    const logs = execDocker(['logs', '--tail', '200', 'moltbot-dev-tunnel']);
    if (!logs.ok) return { promptBase: null, genericBase: null };
    const m = String(`${logs.stdout}\n${logs.stderr}`).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
    if (!m || !m.length) return { promptBase: null, genericBase: null };
    const base = m[m.length - 1];
    return {
        promptBase: base,
        genericBase: base,
    };
}

function buildExternalLinksText() {
    const { promptBase } = getPublicBases();
    if (!promptBase) return null;
    const lines = ['외부 확인 링크'];
    if (promptBase) lines.push(`- 프롬프트: ${promptBase}/prompt/`);
    return lines.join('\n');
}

function rewriteLocalLinks(text, bases) {
    const raw = String(text || '');
    const promptBase = String((bases && bases.promptBase) || '').trim().replace(/\/+$/, '');
    if (!promptBase) return raw;

    let out = raw;
    if (promptBase) {
        out = out
            .replace(/https?:\/\/127\.0\.0\.1:18788\/prompt\/?/gi, `${promptBase}/prompt/`)
            .replace(/https?:\/\/localhost:18788\/prompt\/?/gi, `${promptBase}/prompt/`)
            .replace(/https?:\/\/127\.0\.0\.1:18787\/prompt\/?/gi, `${promptBase}/prompt/`)
            .replace(/https?:\/\/localhost:18787\/prompt\/?/gi, `${promptBase}/prompt/`);
    }
    return out;
}

function appendExternalLinks(reply) {
    const bases = getPublicBases();
    const rewritten = rewriteLocalLinks(reply, bases);
    const links = buildExternalLinksText();
    if (!links) return rewritten;
    if (/(^|\n)외부 확인 링크(\n|$)/.test(String(rewritten || ''))) {
        return String(rewritten || '').trim();
    }
    return `${String(rewritten || '').trim()}\n\n${links}`.trim();
}

function parseReportModeCommand(text) {
    const raw = String(text || '').trim();
    if (!raw) return { matched: false, valid: false, mode: '' };
    const matched = raw.match(/^\/report\s+(.+)$/i);
    if (!matched) return { matched: false, valid: false, mode: '' };
    const modeRaw = String(matched[1] || '').trim().toLowerCase();
    if (modeRaw === 'ko' || modeRaw === 'ko+en') {
        return { matched: true, valid: true, mode: modeRaw };
    }
    return { matched: true, valid: false, mode: modeRaw };
}

function finalizeTelegramBoundary(base, metaInput = {}) {
    const prepared = applyDailyPersonaToOutput(base, metaInput);
    if (!prepared || typeof prepared !== 'object') return prepared;
    if (prepared.finalizerApplied) return prepared;
    if (typeof prepared.telegramReply !== 'string' || !String(prepared.telegramReply).trim()) return prepared;

    const appended = appendExternalLinks(prepared.telegramReply);
    const commandText = String(metaInput.commandText || '').trim();
    const telegramContext = metaInput.telegramContext
        || prepared.telegramContext
        || parseTransportEnvelopeContext(commandText);
    const requestedBy = String(
        metaInput.requestedBy
        || prepared.requestedBy
        || opsFileControl.normalizeRequester(telegramContext, 'bridge:auto'),
    ).trim();
    const finalized = telegramFinalizer.finalizeTelegramReply(appended, {
        botId: process.env.MOLTBOT_BOT_ID,
        botRole: process.env.MOLTBOT_BOT_ROLE,
        telegramContext,
        requestedBy,
        route: String(metaInput.route || prepared.route || '').trim().toLowerCase(),
        finalizerApplied: false,
    });

    return {
        ...prepared,
        telegramReply: String(finalized || appended).trim() || String(appended || '').trim(),
        telegramContext: telegramContext || null,
        requestedBy: requestedBy || undefined,
        finalizerApplied: true,
    };
}

function isExternalLinkRequest(text) {
    const t = String(text || '').toLowerCase();
    const hasLink = /(링크|url|주소|접속)/i.test(t);
    const hasTarget = /(프롬프트|prompt|웹앱|webapp|web)/i.test(t);
    return hasLink && hasTarget;
}

function buildLinkOnlyReply(text) {
    const t = String(text || '').toLowerCase();
    const { promptBase } = getPublicBases();
    if (!promptBase) {
        return '외부 링크를 찾을 수 없습니다. 터널 상태를 먼저 점검해주세요.';
    }
    if (/(프롬프트|prompt)/i.test(t)) {
        const baseReply = promptBase
            ? `외부 확인 링크\n- 프롬프트: ${promptBase}/prompt/`
            : '프롬프트 외부 링크를 찾을 수 없습니다.';
        const diag = /(점검|체크|status|확인)/i.test(t) ? buildLinkDiagnosticsText() : '';
        return diag ? `${baseReply}\n\n${diag}` : baseReply;
    }
    const lines = ['외부 확인 링크'];
    if (promptBase) lines.push(`- 프롬프트: ${promptBase}/prompt/`);
    const out = lines.join('\n');
    const diag = /(점검|체크|status|확인)/i.test(t) ? buildLinkDiagnosticsText() : '';
    return diag ? `${out}\n\n${diag}` : out;
}

function probeUrlStatus(url) {
    const target = String(url || '').trim();
    if (!target) return { ok: false, code: 'N/A', reason: 'empty' };
    const r = spawnSync('curl', ['-sS', '-L', '--max-time', '6', '-o', '/dev/null', '-w', '%{http_code}', target], { encoding: 'utf8' });
    if (r.error) return { ok: false, code: 'N/A', reason: 'curl-missing' };
    const code = String(r.stdout || '').trim() || '000';
    if (r.status !== 0 || code === '000') {
        return { ok: false, code, reason: (r.stderr || '').trim() || `exit:${r.status}` };
    }
    return { ok: true, code, reason: '' };
}

function buildLinkDiagnosticsText() {
    const scriptPath = path.join(__dirname, 'tunnel_dns_check.js');
    const scriptRun = spawnSync('node', [scriptPath, '--json'], { encoding: 'utf8' });
    if (!scriptRun.error && scriptRun.status === 0) {
        try {
            const parsed = JSON.parse(String(scriptRun.stdout || '{}'));
            if (parsed && Array.isArray(parsed.targets) && parsed.targets.length > 0) {
                const lines = ['외부 링크 점검'];
                for (const row of parsed.targets) {
                    const dnsPart = row?.dns?.ok
                        ? `DNS OK(${row.dns.address || '-'})`
                        : `DNS FAIL(${row?.dns?.error || 'unknown'})`;
                    const httpsPart = row?.https?.ok
                        ? `HTTPS ${row.https.statusCode || 0}`
                        : `HTTPS FAIL(${row?.https?.error || 'unknown'})`;
                    lines.push(`- ${row.label || row.key || 'link'}: ${dnsPart}, ${httpsPart}`);
                }
                return lines.join('\n');
            }
        } catch (_) {
            // fall through to curl-based fallback.
        }
    }

    const { promptBase } = getPublicBases();
    const checks = [];
    if (promptBase) checks.push({ label: '프롬프트', url: `${promptBase}/prompt/` });
    if (!checks.length) return '';
    const lines = ['외부 링크 점검'];
    for (const c of checks) {
        const p = probeUrlStatus(c.url);
        const msg = p.ok ? `${p.code} OK` : `${p.code} FAIL${p.reason ? ` (${p.reason})` : ''}`;
        lines.push(`- ${c.label}: ${msg}`);
    }
    return lines.join('\n');
}

function buildQuickStatusReply(payload) {
    const raw = String(payload || '').trim();
    const target = raw ? raw : 'all';
    const out = runOpsCommand(`액션: 상태; 대상: ${target}`);
    const base = out && out.telegramReply ? out.telegramReply : '상태 조회 실패';
    const diag = buildLinkDiagnosticsText();
    const merged = diag ? `${base}\n\n${diag}` : base;
    return appendExternalLinks(merged);
}

function normalizeTemplateKey(route, rawKey) {
    const schema = COMMAND_TEMPLATE_SCHEMA[route];
    if (!schema) return null;
    const key = String(rawKey || '').replace(/\s+/g, '').toLowerCase();
    for (const [canonical, aliases] of Object.entries(schema.aliases || {})) {
        if (aliases.some(alias => key === String(alias).replace(/\s+/g, '').toLowerCase())) {
            return canonical;
        }
    }
    return null;
}

function parseTemplateFields(route, payloadText) {
    const fields = {};
    const tokens = String(payloadText || '')
        .split(/\n|;/)
        .map(s => s.trim())
        .filter(Boolean);
    for (const token of tokens) {
        const m = token.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
        if (!m) continue;
        const canonical = normalizeTemplateKey(route, m[1]);
        if (!canonical) continue;
        const value = String(m[2] || '').trim();
        if (!value) continue;
        fields[canonical] = value;
    }
    return fields;
}

function buildTemplateGuide(route) {
    const schema = COMMAND_TEMPLATE_SCHEMA[route];
    if (!schema) return '지원하지 않는 템플릿입니다.';
    const prefix = route === 'work'
        ? '작업'
        : route === 'inspect'
            ? '점검'
            : route === 'deploy'
                ? '배포'
                : route === 'ops'
                    ? '운영'
                    : route === 'project'
                        ? '프로젝트'
                    : route;
    const required = schema.required.map(k => `${k}: ...`).join('\n');
    const optional = schema.optional.map(k => `${k}: ...`).join('\n');
    return [
        `[${schema.displayName} 템플릿]`,
        required,
        optional ? '\n(선택)\n' + optional : '',
        '\n예시:',
        `${prefix}: ${schema.required.map((k) => `${k}: ...`).join('; ')}`,
    ].join('\n');
}

function buildNoPrefixGuide() {
    return [
        '명령 프리픽스를 붙여주세요.',
        '',
        '자주 쓰는 형식:',
        '- 메모: 오늘 회고',
        '- 가계: 점심 1200엔',
        '- 투두: 추가 장보기',
        '- 루틴: 체크 물 2L',
        '- 운동: 러닝 30분 5km',
        '- 콘텐츠: 듄2 봤음 4.5점 #SF',
        '- 식당: 라멘집 가고싶음 #도쿄',
        '- 링크: 프롬프트',
        '- 상태: [옵션]',
        '- APPROVE <token> [--force] [--push]',
        '- 단어: 단어1',
        '- 작업: 요청: ...; 대상: ...; 완료기준: ...',
        '- 점검: 대상: ...; 체크항목: ...',
        '- 배포: 대상: ...; 환경: ...; 검증: ...',
        '- 프로젝트: 프로젝트명: ...; 목표: ...; 스택: ...; 경로: ...; 완료기준: ...',
    ].join('\n');
}

function isLegacyPersonaSwitchAttempt(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    const hasKeyword = /(페르소나|캐릭터|인격|persona|character|모드)/i.test(raw);
    const hasSwitch = /(바꿔|바꾸|변경|전환|스위치|switch|목록|리스트|종류|라인업|현재|원본|이름|누구|뭐\s*있|뭐있|어떤)/i.test(raw);
    const hasLegacyName = /(에일리|ailey|베일리|bailey|문학소녀|문소녀|미유|literary|t[_-]?ray|tray|레이)/i.test(raw);
    return (hasKeyword && hasSwitch) || hasLegacyName;
}

function buildDailyCasualNoPrefixReply(inputText) {
    const normalized = normalizeIncomingCommandText(inputText) || String(inputText || '').trim();
    if (isLegacyPersonaSwitchAttempt(normalized)) {
        return [
            '페르소나는 봇별로 고정되어 있습니다. 전환할 수 없습니다.',
            '- bot-dev / bot-dev-bak: 지크 예거',
            '- bot-anki / bot-anki-bak: 한지 단장',
            '- bot-research / bot-research-bak: 아르민',
            '- bot-daily / bot-daily-bak / main DM: 엘빈 단장',
        ].join('\n');
    }
    return buildNoPrefixGuide();
}

function buildDuelModeMeta() {
    return {
        enabled: true,
        mode: 'two-pass',
        maxRounds: 1,
        timeoutMs: 120000,
        logPath: MODEL_DUEL_LOG_PATH,
    };
}

function buildCodexDegradedMeta() {
    const safeMode = String(process.env.RATE_LIMIT_SAFE_MODE || '').trim().toLowerCase() === 'true';
    if (!safeMode) return { enabled: false };
    return {
        enabled: true,
        reason: 'rate_limit_safe_mode',
        notice: 'Codex unavailable or intentionally throttled. Falling back to non-codex route.',
    };
}

function buildApiRoutingMeta({ route, routeHint = '', commandText = '', templateFields = {} }) {
    const decision = decideApiLane({
        route,
        routeHint,
        commandText,
        templateFields,
    });
    return {
        apiLane: decision.apiLane,
        apiAuthMode: decision.authMode,
        apiReason: decision.reason,
        apiBlocked: Boolean(decision.blocked),
        apiBlockReason: decision.blockReason || '',
        apiFallbackLane: decision.fallbackLane || null,
        apiCapabilities: Array.isArray(decision.capabilities) ? decision.capabilities : [],
    };
}

function withApiMeta(base, metaInput) {
    const prepared = finalizeTelegramBoundary(base, metaInput);
    return {
        ...prepared,
        ...buildApiRoutingMeta(metaInput),
        ...allowlistMeta(),
    };
}

function pickPreferredModelMeta(result, fallbackAlias = 'fast', fallbackReasoning = 'low') {
    const source = (result && typeof result === 'object') ? result : {};
    const alias = String(source.preferredModelAlias || '').trim() || String(fallbackAlias || 'fast').trim() || 'fast';
    const reasoningRaw = String(source.preferredReasoning || '').trim().toLowerCase();
    const fallbackRaw = String(fallbackReasoning || 'low').trim().toLowerCase();
    const allowed = new Set(['low', 'medium', 'high']);
    const reasoning = allowed.has(reasoningRaw)
        ? reasoningRaw
        : (allowed.has(fallbackRaw) ? fallbackRaw : 'low');
    return {
        preferredModelAlias: alias,
        preferredReasoning: reasoning,
    };
}

function buildProjectRoutePayload(parsed) {
    const bootstrap = parsed.ok ? buildProjectBootstrapPlan(parsed.fields || {}) : null;
    const summaryLines = [];
    if (bootstrap) {
        summaryLines.push(`프로젝트 템플릿 확인 완료 (${bootstrap.templateLabel})`);
        summaryLines.push(`- 이름: ${bootstrap.projectName}`);
        summaryLines.push(`- 경로: ${bootstrap.targetPath}`);
        summaryLines.push(`- 패키지매니저: ${bootstrap.packageManager}`);
        summaryLines.push(`- 초기화 모드: ${bootstrap.initMode}`);
        summaryLines.push(`- 경로 정책: ${bootstrap.pathPolicy?.allowed ? `OK (${bootstrap.pathPolicy.matchedRoot})` : '승인 필요'}`);
        summaryLines.push(`- 품질 게이트: ${Array.isArray(bootstrap.qualityGates) ? bootstrap.qualityGates.join(' | ') : '-'}`);
        if (Array.isArray(bootstrap.warnings) && bootstrap.warnings.length > 0) {
            summaryLines.push(`- 주의: ${bootstrap.warnings.join(' / ')}`);
        }
        if (bootstrap.requiresApproval) {
            const reasons = Array.isArray(bootstrap.approvalReasons) && bootstrap.approvalReasons.length > 0
                ? bootstrap.approvalReasons.join(',')
                : 'policy';
            summaryLines.push(`- 실행 요청 감지: 승인 후 초기화 실행 (${reasons})`);
        }
    }
    const telegramReply = appendExternalLinks(parsed.ok
        ? summaryLines.join('\n')
        : (parsed.telegramReply || '프로젝트 템플릿 오류'));
    const normalizedInstruction = parsed.ok && bootstrap
        ? `${parsed.normalizedInstruction}\n초기화 명령:\n${bootstrap.commands.map((line) => `- ${line}`).join('\n')}`
        : parsed.normalizedInstruction;
    return {
        route: 'project',
        templateValid: parsed.ok,
        ...parsed,
        ...(bootstrap ? { bootstrap } : {}),
        normalizedInstruction,
        telegramReply,
        ...(bootstrap && bootstrap.requiresApproval ? { needsApproval: true } : {}),
    };
}

function parseStructuredCommand(route, payloadText) {
    const schema = COMMAND_TEMPLATE_SCHEMA[route];
    if (!schema) return { ok: false, error: 'unknown template route' };

    const payload = String(payloadText || '').trim();
    if (!payload || /^(도움말|help|템플릿)$/i.test(payload)) {
        return {
            ok: false,
            missing: schema.required,
            telegramReply: buildTemplateGuide(route),
        };
    }

    const fields = parseTemplateFields(route, payload);
    if (fields.API) {
        const apiValue = String(fields.API || '').trim().toLowerCase();
        if (!['auto', 'oauth', 'key'].includes(apiValue)) {
            return {
                ok: false,
                missing: [],
                telegramReply: `${schema.displayName} 템플릿 오류: API 값은 auto|oauth|key 만 허용됩니다.`,
            };
        }
        fields.API = apiValue;
    }
    const missing = schema.required.filter(key => !fields[key]);
    if (missing.length > 0) {
        return {
            ok: false,
            missing,
            telegramReply: [
                `${schema.displayName} 템플릿 누락: ${missing.join(', ')}`,
                buildTemplateGuide(route),
            ].join('\n\n'),
        };
    }

    const ordered = [...schema.required, ...schema.optional]
        .filter(key => fields[key])
        .map(key => `${key}: ${fields[key]}`)
        .join('\n');
    const needsApproval = route === 'deploy';
    return {
        ok: true,
        fields,
        normalizedInstruction: ordered,
        telegramReply: `${schema.displayName} 템플릿 확인 완료`,
        needsApproval,
    };
}

function normalizeIncomingCommandText(text) {
    let out = String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
    if (!out) return '';

    // OpenClaw telegram wrapper metadata: "... [message_id: 123]".
    out = out.replace(/\s*\[message_id:\s*\d+\]\s*$/i, '').trim();

    // Preserve the user's message and drop quoted reply block.
    out = out.replace(/\s*\[Replying to [^\]]+\][\s\S]*$/i, '').trim();

    // Remove leading transport envelope, e.g. "[Telegram ...] 작업: ...".
    const envelope = out.match(/^\s*\[(Telegram|WhatsApp|Discord|Slack|Signal|Line|Matrix|KakaoTalk|Kakao|iMessage|SMS)\b[^\]]*\]\s*(.*)$/i);
    if (envelope) {
        out = String(envelope[2] || '').trim();
    }

    return out;
}

function normalizeNewsCommandPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();

    if (lower === '상태' || lower === 'status') return '상태';
    if (lower === '지금요약' || lower === '요약' || lower === 'summary') return '지금요약';
    if (lower === '트렌드' || lower === 'trend') return '지금요약';
    if (lower === '이벤트' || lower === 'event') return '이벤트';
    if (lower === '도움말' || lower === 'help') return '도움말';

    // Natural phrases like "테크 트렌드 요약" should map to digest.
    if (lower.includes('요약') && (lower.includes('트렌드') || lower.includes('테크'))) {
        return '지금요약';
    }
    if (lower.includes('트렌드') || lower.includes('trend')) {
        return '지금요약';
    }

    return raw;
}

function normalizeReportNewsPayload(text) {
    const normalized = String(normalizeNewsCommandPayload(text) || '').trim();
    if (!normalized) return '지금요약';
    if (/^(상태|지금요약|이벤트|도움말)$/i.test(normalized)) return normalized;
    if (/^(키워드|소스)\b/i.test(normalized)) return normalized;
    return '지금요약';
}

function normalizeMonthToken(rawValue) {
    const token = String(rawValue || '').trim();
    if (!token) return '';
    if (/^\d{4}-\d{2}$/.test(token)) return token;
    if (/^\d{6}$/.test(token)) return `${token.slice(0, 4)}-${token.slice(4, 6)}`;
    return '';
}

function extractMemoStatsPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const memoKeyword = /(메모장|메모|기록|일지|회고|저널|다이어리)/i.test(raw);
    const statsKeyword = /(통계|요약|summary|status)/i.test(raw);
    if (!memoKeyword || !statsKeyword) return null;

    const monthMatch = raw.match(/(20\d{2}-\d{2}|\d{6})/);
    const month = normalizeMonthToken(monthMatch ? monthMatch[1] : '');
    return month ? `통계 ${month}` : '통계';
}

function isLikelyMemoJournalBlock(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!raw) return false;
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length < 4) return false;
    const hasRangeHint = /(?:^|\n)\s*\d{2}\d{2}\d{1,2}\s*[~\-]\s*\d{1,2}\s*(?:\n|$)/.test(raw);
    const dayHeaderCount = (raw.match(/(?:^|\n)\s*\d{1,2}\s*(월|화|수|목|금|토|일)(?:요일)?\s*(?:\n|$)/g) || []).length;
    if (hasRangeHint && dayHeaderCount >= 1) return true;
    if (dayHeaderCount >= 2) return true;
    return false;
}

function stripNaturalMemoLead(text) {
    const raw = String(text || '').trim();
    if (!raw) return raw;
    const stripped = raw
        .replace(/^(메모장|메모|기록|일지|회고|저널|다이어리)\s*(?:[:：]|으로|로|를|은|는)?\s*/i, '')
        .trim();
    return stripped || raw;
}

function inferMemoIntentPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const statsPayload = extractMemoStatsPayload(raw);
    if (statsPayload) return statsPayload;
    if (isLikelyMemoJournalBlock(raw)) return raw;

    const memoKeyword = /(메모장|메모|기록|일지|회고|저널|다이어리)/i.test(raw);
    const memoAction = /(저장|정리|집계|통계|분석|추가|남겨|반영|업데이트|던져|올려)/i.test(raw);
    if (memoKeyword && memoAction) {
        return stripNaturalMemoLead(raw);
    }
    return null;
}

function inferFinanceIntentPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const hasFinanceKeyword = /(가계|가계부|지출|수입|환급|정산|이체|소비|입금|출금|결제|용돈|식비|교통비|월세|생활비|finance|expense|income|refund|budget)/i.test(raw);
    const hasMoneyToken = /(¥|￥|\$)\s*\d+|(?:\d[\d,]*(?:\.\d+)?)\s*(?:만엔|엔|円|jpy|원|krw|달러|usd|eur|유로)(?:\s|$)/i.test(raw);
    const hasFinanceVerb = /(기록|저장|추가|정리|요약|통계|내역|조회|보여|알려)/i.test(raw);
    const hasWorkoutSignal = /(운동|러닝|달리기|헬스|요가|수영|사이클|걷기)/i.test(raw);

    if (hasWorkoutSignal && !hasFinanceKeyword) return null;
    if (!hasFinanceKeyword && !hasMoneyToken) return null;
    if (!hasMoneyToken && !/(통계|요약|내역|목록|summary|list|status)/i.test(raw)) return null;
    if (!hasFinanceKeyword && !hasFinanceVerb && !hasMoneyToken) return null;

    return raw
        .replace(/^(가계부?|finance)\s*(?:로|에|를|는|은)?\s*/i, '')
        .trim() || raw;
}

function inferTodoIntentPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const hasTodoKeyword = /(투두|todo|to-do|할일|할 일|task|체크리스트)/i.test(raw);
    const hasTodoAction = /(추가|등록|완료|끝|체크|재개|다시|삭제|지움|목록|리스트|요약|통계|status|list|done|remove|open|add)/i.test(raw);

    if (hasTodoKeyword && hasTodoAction) {
        return raw
            .replace(/^(투두|todo|to-do|할일|할 일)\s*(?:로|에|를|는|은)?\s*/i, '')
            .trim() || raw;
    }

    if (/^(오늘\s*)?(할\s*일|해야\s*할\s*일)/i.test(raw)) {
        return raw;
    }

    return null;
}

function inferRoutineIntentPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const hasRoutineKeyword = /(루틴|습관|habit|routine|체크인)/i.test(raw);
    const hasRoutineAction = /(등록|추가|활성|비활성|켜|끄|체크|완료|오늘|목록|리스트|요약|통계|summary|status|check)/i.test(raw);

    if (!hasRoutineKeyword) return null;
    if (!hasRoutineAction && raw.length > 40) return null;

    return raw
        .replace(/^(루틴|습관)\s*(?:으로|로|에|를|는|은)?\s*/i, '')
        .trim() || raw;
}

function inferWorkoutIntentPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const hasWorkoutKeyword = /(운동|헬스|러닝|달리기|런닝|조깅|걷기|산책|웨이트|스쿼트|벤치|푸쉬업|요가|필라테스|수영|사이클|자전거|workout|run|running|gym|walk|swim|cycle)/i.test(raw);
    const hasWorkoutMetric = /(\d{1,4}\s*(분|min)|\d+(?:\.\d+)?\s*(km|킬로)|\d{2,5}\s*(kcal|칼로리))/i.test(raw);
    const hasFinanceOnlyToken = /(¥|￥|\$)\s*\d+|(?:\d[\d,]*(?:\.\d+)?)\s*(?:만엔|엔|円|jpy|원|krw|달러|usd|eur|유로)(?:\s|$)/i.test(raw);

    if (!hasWorkoutKeyword && !hasWorkoutMetric) return null;
    if (!hasWorkoutKeyword && !/(기록|완료|했다|했어|함|로그)/i.test(raw)) return null;
    if (hasFinanceOnlyToken && !hasWorkoutKeyword) return null;

    return raw
        .replace(/^(운동|workout)\s*(?:으로|로|을|를|은|는)?\s*/i, '')
        .trim() || raw;
}

function inferStatusIntentPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const hasStatusKeyword = /(상태|현황|헬스|health|status|업타임|다운|장애|에러|오류|살아있|죽었|정상)/i.test(raw);
    if (!hasStatusKeyword) return null;

    const isDirectStatusQuery = /^(상태|현황|헬스|health|status)\b/i.test(raw);
    const hasOpsScope = /(봇|bot|서버|컨테이너|daily|데일리|dev|개발봇|anki|리서치|research|트렌드봇|오픈클로|openclaw|시스템|운영|서비스|프롬프트|prompt)/i.test(raw);
    if (!isDirectStatusQuery && !hasOpsScope) return null;

    if (/(전체|all|모든|봇들|bot들)/i.test(raw)) return 'all';
    if (/(데일리|daily)/i.test(raw)) return 'daily';
    if (/(리서치|research|트렌드봇)/i.test(raw)) return 'research';
    if (/(안키|anki)/i.test(raw)) return 'anki';
    if (/(개발봇|개발|dev)/i.test(raw)) return 'dev';
    if (/(프롬프트|prompt|웹앱|webapp|웹)/i.test(raw)) return 'prompt';
    if (/(터널|tunnel)/i.test(raw)) return 'tunnel';
    return '';
}

function inferLinkIntentPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (/링크드인|linkedin/i.test(raw)) return null;
    if (isExternalLinkRequest(raw)) return raw;

    const hasLinkKeyword = /(링크|url|주소|접속|도메인)/i.test(raw);
    if (!hasLinkKeyword) return null;
    const hasDeliveryVerb = /(줘|보내|알려|열어|확인|어디|뭐야|찾아)/i.test(raw);
    const hasOpsTarget = /(프롬프트|prompt|오픈클로|openclaw|웹앱|webapp|웹|web|대시보드|터널|tunnel|상태페이지|페이지)/i.test(raw);
    if (!(hasDeliveryVerb || hasOpsTarget)) return null;
    return raw;
}

function inferReportIntentPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const hasReportKeyword = /(리포트|report|보고서|브리핑|트렌드|동향|뉴스|소식|digest)/i.test(raw);
    if (!hasReportKeyword) return null;
    if (/(메모|기록|일지|회고|저널|다이어리)/i.test(raw) && /(통계|요약|summary|status)/i.test(raw)) {
        return null;
    }

    const hasActionVerb = /(줘|보내|작성|정리|만들|업데이트|발행|올려|요약)/i.test(raw);
    if (!hasActionVerb && raw.length > 40) return null;
    return raw;
}

function inferNaturalLanguageRoute(text, options = {}) {
    const env = options.env && typeof options.env === 'object' ? options.env : process.env;
    if (!NATURAL_LANGUAGE_ROUTING.enabled) return null;
    if (NATURAL_LANGUAGE_ROUTING.hubOnly && !isHubRuntime(env)) return null;

    const normalized = normalizeIncomingCommandText(text) || String(text || '').trim();
    if (!normalized) return null;

    if (NATURAL_LANGUAGE_ROUTING.inferMemo) {
        const payload = inferMemoIntentPayload(normalized);
        if (payload != null) {
            return { route: 'memo', payload, inferred: true, inferredBy: 'natural-language:memo' };
        }
    }
    if (NATURAL_LANGUAGE_ROUTING.inferFinance) {
        const payload = inferFinanceIntentPayload(normalized);
        if (payload != null) {
            return { route: 'finance', payload, inferred: true, inferredBy: 'natural-language:finance' };
        }
    }
    if (NATURAL_LANGUAGE_ROUTING.inferTodo) {
        const payload = inferTodoIntentPayload(normalized);
        if (payload != null) {
            return { route: 'todo', payload, inferred: true, inferredBy: 'natural-language:todo' };
        }
    }
    if (NATURAL_LANGUAGE_ROUTING.inferRoutine) {
        const payload = inferRoutineIntentPayload(normalized);
        if (payload != null) {
            return { route: 'routine', payload, inferred: true, inferredBy: 'natural-language:routine' };
        }
    }
    if (NATURAL_LANGUAGE_ROUTING.inferWorkout) {
        const payload = inferWorkoutIntentPayload(normalized);
        if (payload != null) {
            return { route: 'workout', payload, inferred: true, inferredBy: 'natural-language:workout' };
        }
    }
    if (NATURAL_LANGUAGE_ROUTING.inferStatus) {
        const payload = inferStatusIntentPayload(normalized);
        if (payload != null) {
            return { route: 'status', payload, inferred: true, inferredBy: 'natural-language:status' };
        }
    }
    if (NATURAL_LANGUAGE_ROUTING.inferLink) {
        const payload = inferLinkIntentPayload(normalized);
        if (payload != null) {
            return { route: 'link', payload, inferred: true, inferredBy: 'natural-language:link' };
        }
    }
    if (NATURAL_LANGUAGE_ROUTING.inferReport) {
        const payload = inferReportIntentPayload(normalized);
        if (payload != null) {
            return { route: 'report', payload, inferred: true, inferredBy: 'natural-language:report' };
        }
    }
    return null;
}

function routeByPrefix(text) {
    const rawInput = String(text || '').trim();
    const input = normalizeIncomingCommandText(rawInput) || rawInput;
    const prefixes = config.commandPrefixes || {};
    const list = (v) => Array.isArray(v) ? v.filter(Boolean) : [v].filter(Boolean);
    const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matchPrefix = (rawInput, rawPrefix) => {
        const p = String(rawPrefix || '').trim();
        if (!p) return null;
        // Support variants like "링크: ...", "링크 : ...", "링크：...", and optionally no-colon form.
        const colonMatch = p.match(/^(.*?)[：:]$/);
        if (colonMatch) {
            const stem = colonMatch[1].trim();
            if (!stem) return null;
            const re = new RegExp(`^\\s*${escapeRegExp(stem)}\\s*(?:[:：])?\\s*`, 'i');
            const m = rawInput.match(re);
            return m ? m[0].length : null;
        }
        const re = new RegExp(`^\\s*${escapeRegExp(p)}\\s+`, 'i');
        const m = rawInput.match(re);
        return m ? m[0].length : null;
    };

    const routingRules = [
        { route: 'word', prefixes: list(prefixes.word || '단어:').concat(list(prefixes.learn || '학습:')) },
        { route: 'memo', prefixes: list(prefixes.memo || '메모:').concat(list(prefixes.record || '기록:')) },
        { route: 'finance', prefixes: list(prefixes.finance || '가계:').concat(list(prefixes.ledger || '가계부:')) },
        { route: 'todo', prefixes: list(prefixes.todo || '투두:').concat(list(prefixes.task || '할일:')) },
        { route: 'routine', prefixes: list(prefixes.routine || '루틴:') },
        { route: 'workout', prefixes: list(prefixes.workout || '운동:') },
        { route: 'media', prefixes: list(prefixes.media || '콘텐츠:') },
        { route: 'place', prefixes: list(prefixes.place || '식당:').concat(list(prefixes.restaurant || '맛집:')) },
        { route: 'news', prefixes: list(prefixes.news || '소식:') },
        { route: 'report', prefixes: list(prefixes.report || '리포트:').concat(list(prefixes.summary || '요약:')) },
        { route: 'work', prefixes: list(prefixes.work || '작업:').concat(list(prefixes.do || '실행:')) },
        { route: 'inspect', prefixes: list(prefixes.inspect || '점검:').concat(list(prefixes.check || '검토:')) },
        { route: 'deploy', prefixes: list(prefixes.deploy || '배포:').concat(list(prefixes.ship || '출시:')) },
        { route: 'project', prefixes: list(prefixes.project || '프로젝트:') },
        { route: 'prompt', prefixes: list(prefixes.prompt || '프롬프트:').concat(list(prefixes.ask || '질문:')) },
        { route: 'link', prefixes: list(prefixes.link || '링크:') },
        { route: 'status', prefixes: list(prefixes.status || '상태:') },
        { route: 'ops', prefixes: list(prefixes.ops || '운영:') },
    ];

    for (const rule of routingRules) {
        for (const prefix of rule.prefixes) {
            const offset = matchPrefix(input, prefix);
            if (offset != null) {
                return { route: rule.route, payload: input.slice(offset).trim() };
            }
        }
    }
    const approve = parseApproveShorthand(input);
    if (approve) {
        return {
            route: 'ops',
            payload: approve.normalizedPayload,
        };
    }
    const inferred = inferNaturalLanguageRoute(input, { env: process.env });
    if (inferred) return inferred;
    return { route: 'none', payload: input }; // no prefix fallback
}

function handlePromptPayload(payloadText) {
    const payload = String(payloadText || '').trim();
    // mode 1) "답변 sessionId | field:value ..."
    if (payload.startsWith('답변')) {
        const body = payload.replace(/^답변\s*/, '');
        const [sessionIdRaw, patchRaw = ''] = body.split('|');
        const sessionId = String(sessionIdRaw || '').trim();
        if (!sessionId) {
            return { error: 'sessionId가 필요합니다. 예: 프롬프트: 답변 pf_xxx | 출력형식: 표' };
        }
        const patch = {};
        for (const token of patchRaw.split(/[;\n]/).map(x => x.trim()).filter(Boolean)) {
            const parts = token.split(/[:：]/);
            if (parts.length < 2) continue;
            const keyRaw = parts[0].toLowerCase();
            const value = parts.slice(1).join(':').trim();
            if (!value) continue;
            if (/(목적|goal|요청)/.test(keyRaw)) patch.goal = value;
            else if (/(제약|constraint|조건)/.test(keyRaw)) patch.constraints = value;
            else if (/(출력|format|형식)/.test(keyRaw)) patch.outputFormat = value;
            else if (/(금지|forbidden)/.test(keyRaw)) patch.forbidden = value;
            else if (/(성공|criteria|완료)/.test(keyRaw)) patch.successCriteria = value;
        }
        const updated = promptBuilder.updateSession(sessionId, patch);
        return {
            mode: 'update',
            sessionId,
            domain: updated.domain || 'general',
            completeness: updated.completeness,
            missingQuestions: updated.missingQuestions,
        };
    }

    // mode 2) "완성 sessionId"
    if (payload.startsWith('완성') || payload.startsWith('최종')) {
        const sessionId = payload.replace(/^(완성|최종)\s*/, '').trim();
        if (!sessionId) {
            return { error: 'sessionId가 필요합니다. 예: 프롬프트: 완성 pf_xxx' };
        }
        const result = promptBuilder.finalizeSession(sessionId);
        return { mode: 'finalize', ...result };
    }

    // mode 3) start with free text
    const fields = promptBuilder.parseFreeTextToFields(payload);
    const session = promptBuilder.createSession(fields);
    return {
        mode: 'start',
        sessionId: session.id,
        domain: session.domain || 'general',
        completeness: session.completeness,
        missingQuestions: session.missingQuestions,
        usage: [
            `프롬프트: 답변 ${session.id} | 제약: ...; 출력형식: ...`,
            `프롬프트: 완성 ${session.id}`,
        ],
    };
}

function isWeakEnrichment(word, hint, enriched, threshold = DEFAULT_QUALITY_POLICY.qualityThreshold) {
    const quality = enriched && enriched.quality ? enriched.quality : null;
    const hasHint = Boolean(String(hint || '').trim());
    if (quality) {
        const warnings = new Set(
            (Array.isArray(quality.warnings) ? quality.warnings : [])
                .map((v) => String(v || '').trim())
                .filter(Boolean),
        );
        const hasWarningPrefix = (prefix) => {
            const p = String(prefix || '').trim();
            if (!p) return false;
            for (const w of warnings) {
                if (w === p || w.startsWith(p + ':')) return true;
            }
            return false;
        };
        const confidence = Number(quality.confidence || 0);
        const criticalWarningPrefixes = [
            'missing_meaning_ko',
            'missing_example_en',
            'missing_example_ko',
            'missing_toeic_tip',
            'placeholder_meaning',
            'meaning_translation_failed',
            'word_translation_failed',
            'example_translation_failed',
            'example_ko_placeholder',
            'example_generic_template',
            'tip_not_specific',
            'tip_lacks_detail',
        ];
        if (!hasHint) {
            criticalWarningPrefixes.push('example_not_toeic_context', 'example_missing_target');
        }
        const effectiveThreshold = hasHint
            ? Math.min(Number(threshold || DEFAULT_QUALITY_POLICY.qualityThreshold || 0.82), 0.45)
            : Number(threshold || DEFAULT_QUALITY_POLICY.qualityThreshold || 0.82);
        return Boolean(quality.hardFail)
            || Boolean(quality.degraded)
            || (Number.isFinite(confidence) && confidence < effectiveThreshold)
            || criticalWarningPrefixes.some((prefix) => hasWarningPrefix(prefix));
    }
    if (hasHint) return false;
    const meaning = String((enriched && enriched.meaning) || '').trim();
    const example = String((enriched && enriched.example) || '').trim();
    return meaning === '(의미 보강 필요)' && example === fallbackExample(word);
}
function safeRecordVocabLog(row, options = {}) {
    try {
        personalStorage.recordVocabLog(row, options);
    } catch (_) {
        // Vocab logging failure must not break primary Anki flow.
    }
}

async function processWordTokens(text, toeicDeck, toeicTags, options = {}) {
    const configuredPolicy = normalizeQualityPolicy(config.ankiQualityPolicy || {});
    const runtimePolicy = normalizeQualityPolicy(options.qualityPolicy || configuredPolicy);
    const dedupeMode = String(options.dedupeMode || config.ankiQualityPolicy?.dedupeMode || 'allow').toLowerCase();
    const qualityFn = options.qualityFn || (async (word, hint) => createWordQuality(word, hint, {
        policy: runtimePolicy,
        llmFallbackFn: options.llmFallbackFn,
    }));
    const enrichFn = options.enrichFn || (async (word, hint) => {
        const quality = await qualityFn(word, hint);
        return {
            meaning: quality.meaningKo,
            example: quality.exampleEn,
            exampleKo: quality.exampleKo,
            toeicTip: quality.toeicTip,
            partOfSpeech: quality.partOfSpeech || '',
            lemma: quality.lemma || normalizeWordToken(word),
            quality,
        };
    });
    const addCardFn = options.addCardFn || ((deck, front, back, tags, addOpts) => anki.addCard(deck, front, back, tags, addOpts));
    const syncFn = options.syncFn || (() => anki.syncWithDelay());
    const rawTokens = splitWords(text);
    const tokens = mergeDetachedHintTokens(rawTokens);
    const results = [];
    const failures = [];
    const autoCorrections = [];
    const warningSet = new Set();
    let syncWarning = null;
    let failedParseCount = 0;
    let failedQualityCount = 0;
    let failedAddCount = 0;
    let vocabEventId = '';

    try {
        const event = personalStorage.createEvent({
            route: 'word',
            source: options.source || 'telegram',
            rawText: options.rawText || text,
            normalizedText: personalStorage.normalizeSpace(text),
            payload: {
                deck: toeicDeck,
                tokens: tokens.slice(0, 200),
                rawTokens: rawTokens.slice(0, 200),
            },
            dedupeMaterial: `word:${personalStorage.normalizeSpace(text).toLowerCase()}`,
        }, options);
        vocabEventId = String(event && event.eventId ? event.eventId : '');
    } catch (_) {
        vocabEventId = `word_${Date.now()}`;
    }

    for (const token of tokens) {
        try {
            const parsed = parseWordToken(token);
            if (!parsed) {
                failures.push({ token, reason: 'parse_failed' });
                failedParseCount += 1;
                safeRecordVocabLog({
                    eventId: vocabEventId,
                    word: token,
                    deck: toeicDeck,
                    saveStatus: 'failed',
                    errorText: 'parse_failed',
                    meta: { token, reason: 'parse_failed' },
                }, options);
                continue;
            }
            const originalWord = parsed.word;
            let word = originalWord;
            const hint = parsed.hint;
            if (!String(hint || '').trim()) {
                const typoSignal = detectTypoSuspicion(word);
                if (typoSignal.suspicious && typoSignal.primary) {
                    const shouldUseLlmCorrection = options.enableLlmTypoCorrection !== undefined
                        ? Boolean(options.enableLlmTypoCorrection)
                        : !(options.qualityFn || options.enrichFn);
                    const correctionFn = options.typoCorrectionFn || suggestToeicTypoCorrection;
                    const corrected = await correctionFn({
                        token,
                        word,
                        primary: typoSignal.primary,
                        suggestions: typoSignal.suggestions,
                    }, {
                        llmThinking: options.llmThinking || 'high',
                        mode: shouldUseLlmCorrection ? 'llm' : 'rule',
                    });
                    const correctedWord = normalizeWordToken(
                        corrected && corrected.word ? corrected.word : typoSignal.primary,
                    );
                    if (correctedWord) {
                        word = correctedWord;
                        autoCorrections.push({
                            token,
                            from: typoSignal.target || normalizeWordToken(originalWord),
                            to: correctedWord,
                            source: String((corrected && corrected.source) || 'rule_fallback'),
                        });
                    } else {
                        failures.push({
                            token,
                            reason: `typo_suspected:${typoSignal.suggestions.join('|')}`,
                        });
                        failedQualityCount += 1;
                        safeRecordVocabLog({
                            eventId: vocabEventId,
                            word,
                            deck: toeicDeck,
                            saveStatus: 'failed',
                            errorText: `typo_suspected:${typoSignal.suggestions.join('|')}`,
                            meta: {
                                token,
                                typo: true,
                                suggestions: typoSignal.suggestions,
                            },
                        }, options);
                        continue;
                    }
                }
            }
            const enriched = await enrichFn(word, hint);
            const quality = enriched && enriched.quality ? enriched.quality : {
                lemma: normalizeWordToken(word),
                partOfSpeech: String((enriched && enriched.partOfSpeech) || '').trim().toLowerCase(),
                meaningKo: String((enriched && enriched.meaning) || '').trim(),
                exampleEn: String((enriched && enriched.example) || '').trim(),
                exampleKo: String((enriched && enriched.exampleKo) || '').trim(),
                toeicTip: String((enriched && enriched.toeicTip) || '').trim(),
                sourceMode: 'local',
                confidence: 0.6,
                degraded: false,
                warnings: [],
                hardFail: false,
                styleVersion: QUALITY_STYLE_VERSION,
            };
            if (!(enriched && enriched.quality)) {
                const placeholderMeaning = quality.meaningKo === '(의미 보강 필요)';
                quality.hardFail = !quality.meaningKo
                    || !quality.exampleEn
                    || !quality.exampleKo
                    || !quality.toeicTip
                    || placeholderMeaning;
                if (placeholderMeaning) quality.warnings.push('placeholder_meaning');
                if (!quality.exampleKo) quality.warnings.push('missing_example_ko');
                if (!quality.toeicTip) quality.warnings.push('missing_toeic_tip');
            }
            if (isWeakEnrichment(word, hint, { ...enriched, quality }, runtimePolicy.qualityThreshold)) {
                const reason = Array.isArray(quality.warnings) && quality.warnings.length > 0
                    ? `low_quality:${quality.warnings.slice(0, 3).join(',')}`
                    : 'no_definition_found';
                failures.push({ token, reason });
                failedQualityCount += 1;
                safeRecordVocabLog({
                    eventId: vocabEventId,
                    word,
                    deck: toeicDeck,
                    saveStatus: 'failed',
                    errorText: reason,
                    meta: {
                        token,
                        warnings: Array.isArray(quality.warnings) ? quality.warnings : [],
                        confidence: Number(quality.confidence || 0),
                    },
                }, options);
                continue;
            }
            const answer = buildToeicAnswerRich(
                word,
                enriched.meaning || quality.meaningKo,
                enriched.example || quality.exampleEn,
                enriched.partOfSpeech || quality.partOfSpeech || '',
                enriched.exampleKo || quality.exampleKo || '',
                enriched.toeicTip || quality.toeicTip || '',
            );
            const tags = [...new Set([
                ...toeicTags,
                `style:${quality.styleVersion || QUALITY_STYLE_VERSION}`,
                `source:${quality.sourceMode || 'local'}`,
                ...(quality.degraded ? ['degraded'] : []),
            ])];
            const noteResult = await addCardFn(toeicDeck, word, answer, tags, {
                sync: false,
                dedupeMode,
            });
            const noteMeta = typeof noteResult === 'object'
                ? noteResult
                : { noteId: noteResult };
            results.push({
                word,
                deck: toeicDeck,
                ...noteMeta,
                quality: {
                    styleVersion: quality.styleVersion || QUALITY_STYLE_VERSION,
                    sourceMode: quality.sourceMode || 'local',
                    confidence: Number(quality.confidence || 0),
                    degraded: Boolean(quality.degraded),
                },
                warnings: Array.isArray(quality.warnings) ? quality.warnings : [],
            });
            for (const warning of (Array.isArray(quality.warnings) ? quality.warnings : [])) {
                warningSet.add(String(warning));
            }
            safeRecordVocabLog({
                eventId: vocabEventId,
                word,
                deck: toeicDeck,
                noteId: noteMeta.noteId,
                saveStatus: 'saved',
                meta: {
                    token,
                    originalWord,
                    correctedWord: word !== originalWord ? word : '',
                    duplicate: Boolean(noteMeta.duplicate),
                    action: noteMeta.action || '',
                    quality: {
                        sourceMode: quality.sourceMode || 'local',
                        confidence: Number(quality.confidence || 0),
                        degraded: Boolean(quality.degraded),
                    },
                },
            }, options);
        } catch (e) {
            failures.push({ token, reason: e.message });
            failedAddCount += 1;
            const parsed = parseWordToken(token);
            safeRecordVocabLog({
                eventId: vocabEventId,
                word: parsed && parsed.word ? parsed.word : token,
                deck: toeicDeck,
                saveStatus: 'failed',
                errorText: String(e && e.message ? e.message : e),
                meta: { token, stage: 'anki_add' },
            }, options);
        }
    }
    if (results.length > 0) {
        try {
            await syncFn();
        } catch (e) {
            console.log('Anki batch sync failed (non-critical):', e.message);
            syncWarning = `sync_failed: ${e.message}`;
            warningSet.add(syncWarning);
        }
    }
    const failedTotal = failedParseCount + failedQualityCount + failedAddCount;
    const correctionMap = new Map();
    for (const row of autoCorrections) {
        const from = String(row && row.from ? row.from : '').trim();
        const to = String(row && row.to ? row.to : '').trim();
        if (!from || !to || from === to) continue;
        const key = `${from}->${to}`;
        if (!correctionMap.has(key)) {
            correctionMap.set(key, {
                from,
                to,
                source: String(row && row.source ? row.source : 'rule_fallback').trim() || 'rule_fallback',
            });
        }
    }
    const correctionRows = [...correctionMap.values()];
    const sourceModeCounts = {};
    let degradedCount = 0;
    for (const row of results) {
        const mode = String(row.quality?.sourceMode || 'local');
        sourceModeCounts[mode] = (sourceModeCounts[mode] || 0) + 1;
        if (row.quality?.degraded) degradedCount += 1;
    }
    const summary = `Anki 저장 결과: 성공 ${results.length}건 / 실패 ${failedTotal}건`;
    const failedRows = failures.filter((f) => !String(f.token || '').startsWith('__sync__'));
    const typoReview = analyzeWordFailures(failedRows);
    const telegramReplyCore = failedRows.length > 0
        ? `${summary}\n실패 목록:\n- ${failedRows.map(f => `${f.token}: ${f.reason}`).join('\n- ')}`
        : `${summary}\n실패 목록: 없음`;
    const correctionBlock = correctionRows.length > 0
        ? `\n자동 보정:\n- ${correctionRows.map((row) => `${row.from} -> ${row.to} (${row.source})`).join('\n- ')}`
        : '';
    const clarificationBlock = typoReview.needsClarification
        ? `\n\n입력 확인 필요:\n${typoReview.clarificationLines.join('\n')}\n수정 후 다시 "단어: ..." 로 보내주세요.`
        : '';
    const telegramReply = syncWarning
        ? `${telegramReplyCore}${correctionBlock}\n동기화 경고: ${syncWarning}${clarificationBlock}`
        : `${telegramReplyCore}${correctionBlock}${clarificationBlock}`;
    return {
        success: failedTotal === 0,
        saved: results.length,
        failed: failedTotal,
        failedParseCount,
        failedQualityCount,
        failedAddCount,
        syncWarning,
        summary,
        telegramReply,
        failedTokens: failedRows.map(f => `${f.token}: ${f.reason}`),
        results,
        failures: failedRows,
        autoCorrections: correctionRows,
        needsClarification: typoReview.needsClarification,
        clarificationLines: typoReview.clarificationLines,
        warnings: [...warningSet],
        quality: {
            styleVersion: QUALITY_STYLE_VERSION,
            sourceMode: Object.keys(sourceModeCounts).length === 1
                ? Object.keys(sourceModeCounts)[0]
                : Object.keys(sourceModeCounts).length > 1
                    ? 'hybrid'
                    : 'local',
            confidence: results.length > 0
                ? Number((results.reduce((acc, cur) => acc + Number(cur.quality?.confidence || 0), 0) / results.length).toFixed(2))
                : 0,
            degraded: degradedCount > 0,
            degradedCount,
            sourceModeCounts,
        },
    };
}

async function handlePersonalRoute(route, payload, options = {}) {
    const normalizedRoute = String(route || '').trim().toLowerCase();
    const commandText = String(payload || '').trim();
    const baseOptions = {
        source: options.source || 'telegram',
    };
    let out = null;

    if (normalizedRoute === 'finance') {
        out = await handleFinanceCommand(commandText, baseOptions);
    } else if (normalizedRoute === 'todo') {
        out = await handleTodoCommand(commandText, baseOptions);
    } else if (normalizedRoute === 'routine') {
        out = await handleRoutineCommand(commandText, baseOptions);
    } else if (normalizedRoute === 'workout') {
        out = await handleWorkoutCommand(commandText, baseOptions);
    } else if (normalizedRoute === 'media') {
        out = await handleMediaPlaceCommand(commandText, {
            ...baseOptions,
            kind: 'media',
        });
    } else if (normalizedRoute === 'place') {
        out = await handleMediaPlaceCommand(commandText, {
            ...baseOptions,
            kind: 'place',
        });
    } else {
        return {
            route: normalizedRoute || 'none',
            success: false,
            action: 'unsupported',
            telegramReply: `지원하지 않는 개인 도메인 route: ${normalizedRoute}`,
            preferredModelAlias: 'fast',
            preferredReasoning: 'low',
        };
    }

    if (out && out.telegramReply) {
        out.telegramReply = appendExternalLinks(out.telegramReply);
    }
    return {
        ...(out || {}),
        route: normalizedRoute,
        preferredModelAlias: 'fast',
        preferredReasoning: 'low',
    };
}

async function main() {
    const [, , command, ...args] = process.argv;
    const fullText = args.join(' ');
    const normalizedCommand = String(command || '').trim().toLowerCase();
    const toeicDeck = config.ankiPolicy?.toeicDeck || 'TOEIC_AI';
    const toeicTags = Array.isArray(config.ankiPolicy?.autoTags) ? config.ankiPolicy.autoTags : ['moltbot', 'toeic_ai'];
    const maxAttempts = RETRY_SAFE_COMMANDS.has(normalizedCommand) ? 3 : 1;
    let attempt = 1;
    let finalError = null;
    let finalStatus = 'ok';
    let finalSeverity = 'P3';
    let finalMessage = 'Run completed successfully.';
    const opsContext = opsLogger.startRun({
        component: 'bridge',
        action: normalizedCommand || 'unknown',
        max_attempts: maxAttempts,
        message: 'Bridge command run started.',
        metrics: {
            args_count: args.length,
        },
    });
    const stopHeartbeat = opsLogger.startHeartbeatTicker(opsContext, {
        interval_ms: 5 * 60 * 1000,
        component: 'bridge',
        action: 'bridge_heartbeat',
        message: 'Bridge run heartbeat.',
    });

    try {
        opsLogger.logStep(opsContext, {
            component: 'bridge',
            action: 'command_received',
            message: `Command received: ${normalizedCommand || 'none'}.`,
            metrics: { args_count: args.length },
        });

        if (normalizedCommand && normalizedCommand !== 'auto') {
            const rawCommandText = fullText
                ? `${normalizedCommand}: ${fullText}`
                : normalizedCommand;
            captureConversationSafe({
                route: normalizedCommand,
                message: rawCommandText,
                source: 'user',
                skillHint: normalizedCommand,
            });
        }

        if (KNOWN_DIRECT_COMMANDS.has(normalizedCommand) && !isDirectCommandAllowed(normalizedCommand)) {
            console.log(JSON.stringify(buildAllowlistBlockedResponse({
                requestedCommand: normalizedCommand,
            })));
            finalStatus = 'warn';
            finalSeverity = 'P3';
            finalMessage = 'Command blocked by allowlist policy.';
            return;
        }

        while (attempt <= maxAttempts) {
            try {
                if (attempt > 1) {
                    opsLogger.logStep(opsContext, {
                        component: 'bridge',
                        action: 'retry_dispatch',
                        message: `Retry dispatch attempt ${attempt}/${maxAttempts}.`,
                        status: 'warn',
                        severity: 'P3',
                        attempt,
                        max_attempts: maxAttempts,
                    });
                } else {
                    opsLogger.logStep(opsContext, {
                        component: 'bridge',
                        action: 'dispatch',
                        message: `Dispatching command ${normalizedCommand || 'none'}.`,
                        attempt,
                        max_attempts: maxAttempts,
                    });
                }

                switch (normalizedCommand) {
            case 'checklist': {
                const checkResult = await engine.recordActivity(fullText);
                console.log(JSON.stringify(checkResult));
                break;
            }

            case 'summary': {
                const summary = await engine.getTodaySummary();
                console.log(JSON.stringify(summary));
                break;
            }

            case 'work': {
                // usage: node bridge.js work "요청: ...; 대상: ...; 완료기준: ..."
                const parsed = parseStructuredCommand('work', fullText);
                const telegramReply = appendExternalLinks(parsed.telegramReply || '');
                const degradedMode = buildCodexDegradedMeta();
                const routeHint = 'complex-workload';
                console.log(JSON.stringify(withApiMeta({
                    route: 'work',
                    templateValid: parsed.ok,
                    ...parsed,
                    telegramReply,
                    duelMode: buildDuelModeMeta(),
                    degradedMode,
                    preferredModelAlias: degradedMode.enabled ? 'deep' : 'codex',
                    preferredReasoning: 'high',
                    routeHint,
                }, {
                    route: 'work',
                    routeHint,
                    commandText: fullText,
                    templateFields: parsed.fields || {},
                })));
                break;
            }

            case 'inspect': {
                // usage: node bridge.js inspect "대상: ...; 체크항목: ..."
                const parsed = parseStructuredCommand('inspect', fullText);
                const telegramReply = appendExternalLinks(parsed.telegramReply || '');
                const degradedMode = buildCodexDegradedMeta();
                const routeHint = 'inspection';
                console.log(JSON.stringify(withApiMeta({
                    route: 'inspect',
                    templateValid: parsed.ok,
                    ...parsed,
                    telegramReply,
                    degradedMode,
                    preferredModelAlias: degradedMode.enabled ? 'deep' : 'codex',
                    preferredReasoning: 'medium',
                    routeHint,
                }, {
                    route: 'inspect',
                    routeHint,
                    commandText: fullText,
                    templateFields: parsed.fields || {},
                })));
                break;
            }

            case 'deploy': {
                // usage: node bridge.js deploy "대상: ...; 환경: ...; 검증: ..."
                const parsed = parseStructuredCommand('deploy', fullText);
                const telegramReply = appendExternalLinks(parsed.telegramReply || '');
                const degradedMode = buildCodexDegradedMeta();
                const routeHint = 'deployment';
                console.log(JSON.stringify(withApiMeta({
                    route: 'deploy',
                    templateValid: parsed.ok,
                    ...parsed,
                    telegramReply,
                    degradedMode,
                    preferredModelAlias: degradedMode.enabled ? 'deep' : 'codex',
                    preferredReasoning: 'high',
                    routeHint,
                }, {
                    route: 'deploy',
                    routeHint,
                    commandText: fullText,
                    templateFields: parsed.fields || {},
                })));
                break;
            }

            case 'project': {
                // usage: node bridge.js project "프로젝트명: ...; 목표: ...; 스택: ...; 경로: ...; 완료기준: ..."
                const parsed = parseStructuredCommand('project', fullText);
                const payload = buildProjectRoutePayload(parsed);
                const degradedMode = buildCodexDegradedMeta();
                const routeHint = 'project-bootstrap';
                console.log(JSON.stringify(withApiMeta({
                    ...payload,
                    degradedMode,
                    preferredModelAlias: degradedMode.enabled ? 'deep' : 'codex',
                    preferredReasoning: 'high',
                    routeHint,
                }, {
                    route: 'project',
                    routeHint,
                    commandText: fullText,
                    templateFields: parsed.fields || {},
                })));
                break;
            }

            case 'ops': {
                const telegramContext = parseTransportEnvelopeContext(fullText);
                const out = runOpsCommand(fullText, {
                    rawText: fullText,
                    telegramContext,
                });
                if (out && out.telegramReply) {
                    out.telegramReply = appendExternalLinks(out.telegramReply);
                }
                console.log(JSON.stringify(withApiMeta(out, {
                    route: 'ops',
                    commandText: fullText,
                })));
                break;
            }

            case 'word': {
                // usage: node bridge.js word "Activated 활성화된, Formulate"
                const wordResult = await processWordTokens(fullText, toeicDeck, toeicTags, {
                    source: 'telegram',
                    rawText: `단어: ${fullText}`,
                });
                console.log(JSON.stringify(withApiMeta({
                    route: 'word',
                    ...wordResult,
                    preferredModelAlias: 'gpt',
                    preferredReasoning: 'high',
                }, {
                    route: 'word',
                    commandText: fullText,
                })));
                break;
            }

            case 'finance':
            case 'todo':
            case 'routine':
            case 'workout':
            case 'media':
            case 'place': {
                const out = await handlePersonalRoute(normalizedCommand, fullText, {
                    source: 'telegram',
                });
                console.log(JSON.stringify(withApiMeta(out, {
                    route: normalizedCommand,
                    commandText: fullText,
                })));
                break;
            }

            case 'news': {
                // usage: node bridge.js news "상태|지금요약|키워드 추가 ..."
                try {
                    const newsDigest = require('./news_digest');
                    const payload = [args[0], ...args.slice(1)].join(' ').trim() || fullText;
                    const normalizedPayload = normalizeNewsCommandPayload(payload);
                    const result = await newsDigest.handleNewsCommand(normalizedPayload);
                    const modelMeta = pickPreferredModelMeta(result, 'fast', 'low');
                    console.log(JSON.stringify(withApiMeta({
                        route: 'news',
                        ...result,
                        ...modelMeta,
                    }, {
                        route: 'news',
                        commandText: normalizedPayload,
                    })));
                } catch (error) {
                    console.log(JSON.stringify(withApiMeta({
                        route: 'news',
                        success: false,
                        errorCode: error && error.code ? error.code : 'NEWS_ROUTE_LOAD_FAILED',
                        error: String(error && error.message ? error.message : error),
                        telegramReply: `소식 모듈 로드 실패: ${error && error.message ? error.message : error}`,
                        preferredModelAlias: 'fast',
                        preferredReasoning: 'low',
                    }, {
                        route: 'news',
                        commandText: fullText,
                    })));
                }
                break;
            }

            case 'prompt': {
                // usage:
                // node bridge.js prompt "목적: ..."
                // node bridge.js prompt "답변 pf_xxx | 출력형식: 표"
                // node bridge.js prompt "완성 pf_xxx"
                const out = handlePromptPayload(fullText);
                if (out && out.telegramReply) {
                    out.telegramReply = appendExternalLinks(out.telegramReply);
                }
                console.log(JSON.stringify(withApiMeta({
                    route: 'prompt',
                    ...out,
                }, {
                    route: 'prompt',
                    commandText: fullText,
                })));
                break;
            }

            case 'anki': {
                // usage: node bridge.js anki add "deckName" "Front" "Back" "tag1,tag2"
                // usage: node bridge.js anki decks
                const subCmd = args[0];
                if (subCmd === 'add') {
                    const deck = args[1];
                    const front = args[2];
                    let back = args[3];
                    const tags = args[4]
                        ? args[4].split(',').map((v) => v.trim()).filter(Boolean)
                        : toeicTags;

                    if (!front || !back) {
                        throw new Error('Usage: anki add <deck> <front> <back> [tags]');
                    }

                    const finalDeck = deck || toeicDeck;
                    back = back.replace(/\\n/g, '<br>').replace(/\n/g, '<br>');

                    const dedupeMode = String(config.ankiQualityPolicy?.dedupeMode || 'allow').toLowerCase();
                    const result = await anki.addCard(finalDeck, front, back, tags, { dedupeMode });
                    const noteMeta = typeof result === 'object' ? result : { noteId: result };
                    console.log(JSON.stringify(withApiMeta({
                        route: 'anki',
                        success: true,
                        deck: finalDeck,
                        ...noteMeta,
                    }, {
                        route: 'anki',
                        commandText: fullText,
                    })));
                } else if (subCmd === 'decks') {
                    const decks = await anki.getDeckNames();
                    console.log(JSON.stringify(withApiMeta({
                        route: 'anki',
                        decks,
                    }, {
                        route: 'anki',
                        commandText: fullText,
                    })));
                } else {
                    throw new Error(`Unknown anki command: ${subCmd}`);
                }
                break;
            }

            case 'auto': {
                // usage: node bridge.js auto "단어: activate 활성화하다"
                const normalizedAutoMessage = normalizeIncomingCommandText(fullText) || String(fullText || '').trim();
                const autoTelegramContext = parseTransportEnvelopeContext(fullText);
                const autoRequestedBy = opsFileControl.normalizeRequester(autoTelegramContext, 'bridge:auto');
                const reportModeCommand = parseReportModeCommand(normalizedAutoMessage);
                if (reportModeCommand.matched) {
                    if (!reportModeCommand.valid) {
                        console.log(JSON.stringify(withApiMeta({
                            route: 'report',
                            success: false,
                            telegramContext: autoTelegramContext,
                            requestedBy: autoRequestedBy,
                            telegramReply: '지원하지 않는 REPORT_MODE 입니다. 사용 가능: /report ko 또는 /report ko+en',
                        }, {
                            route: 'report',
                            routeHint: 'report-mode',
                            commandText: fullText,
                            telegramContext: autoTelegramContext,
                            requestedBy: autoRequestedBy,
                        })));
                        break;
                    }
                    telegramFinalizer.writeReportMode({
                        telegramContext: autoTelegramContext,
                        requestedBy: autoRequestedBy,
                        mode: reportModeCommand.mode,
                    });
                    console.log(JSON.stringify(withApiMeta({
                        route: 'report',
                        success: true,
                        telegramContext: autoTelegramContext,
                        requestedBy: autoRequestedBy,
                        telegramReply: `REPORT_MODE=${reportModeCommand.mode} 로 설정됨`,
                    }, {
                        route: 'report',
                        routeHint: 'report-mode',
                        commandText: fullText,
                        telegramContext: autoTelegramContext,
                        requestedBy: autoRequestedBy,
                    })));
                    break;
                }
                const routed = routeByPrefix(normalizedAutoMessage);
                opsLogger.logStep(opsContext, {
                    component: 'router',
                    action: 'auto_route',
                    message: `Auto route resolved to ${routed.route || 'none'}.`,
                });
                captureConversationSafe({
                    route: routed.route || 'none',
                    message: fullText,
                    source: 'user',
                    skillHint: routed.route || 'none',
                });
                if (!isAutoRouteAllowed(routed.route)) {
                    console.log(JSON.stringify(buildAllowlistBlockedResponse({
                        requestedCommand: 'auto',
                        requestedRoute: routed.route,
                    })));
                    finalStatus = 'warn';
                    finalSeverity = 'P3';
                    finalMessage = 'Auto route blocked by allowlist policy.';
                    break;
                }
                const delegated = enqueueHubDelegationCommand({
                    route: routed.route,
                    payload: routed.payload,
                    originalMessage: normalizedAutoMessage,
                    rawText: fullText,
                    telegramContext: autoTelegramContext,
                });
                if (delegated) {
                    console.log(JSON.stringify(withApiMeta(delegated, {
                        route: routed.route,
                        routeHint: `hub-delegation:${delegated.targetProfile}`,
                        commandText: normalizedAutoMessage,
                    })));
                    break;
                }
                if (routed.route === 'memo') {
                    try {
                        const memoJournal = require('./memo_journal');
                        const memoResult = await memoJournal.handleMemoCommand(routed.payload || fullText);
                        const legacyLogged = typeof memoResult.logged === 'boolean'
                            ? memoResult.logged
                            : Boolean(memoResult && memoResult.success);
                        console.log(JSON.stringify(withApiMeta({
                            route: 'memo',
                            preferredModelAlias: 'fast',
                            preferredReasoning: 'low',
                            logged: legacyLogged,
                            ...memoResult,
                        }, {
                            route: 'memo',
                            routeHint: 'memo-journal',
                            commandText: routed.payload || fullText,
                        })));
                    } catch (error) {
                        console.log(JSON.stringify(withApiMeta({
                            route: 'memo',
                            success: false,
                            errorCode: error && error.code ? error.code : 'MEMO_ROUTE_LOAD_FAILED',
                            error: String(error && error.message ? error.message : error),
                            telegramReply: `메모 처리 실패: ${error && error.message ? error.message : error}`,
                            preferredModelAlias: 'fast',
                            preferredReasoning: 'low',
                            logged: false,
                        }, {
                            route: 'memo',
                            routeHint: 'memo-journal',
                            commandText: routed.payload || fullText,
                        })));
                    }
                    break;
                }
                if (['finance', 'todo', 'routine', 'workout', 'media', 'place'].includes(routed.route)) {
                    const out = await handlePersonalRoute(routed.route, routed.payload || fullText, {
                        source: 'telegram',
                    });
                    console.log(JSON.stringify(withApiMeta(out, {
                        route: routed.route,
                        commandText: routed.payload || fullText,
                    })));
                    break;
                }
                if (routed.route === 'word') {
                    const wordResult = await processWordTokens(routed.payload, toeicDeck, toeicTags, {
                        source: 'telegram',
                        rawText: fullText,
                    });
                    console.log(JSON.stringify(withApiMeta({
                        route: routed.route,
                        preferredModelAlias: 'gpt',
                        preferredReasoning: 'high',
                        ...wordResult,
                    }, {
                        route: routed.route,
                        commandText: routed.payload,
                    })));
                    break;
                }
                if (routed.route === 'news') {
                    try {
                        const newsDigest = require('./news_digest');
                        const normalizedPayload = normalizeNewsCommandPayload(routed.payload);
                        const result = await newsDigest.handleNewsCommand(normalizedPayload);
                        const modelMeta = pickPreferredModelMeta(result, 'fast', 'low');
                        console.log(JSON.stringify(withApiMeta({
                            route: routed.route,
                            ...result,
                            ...modelMeta,
                        }, {
                            route: routed.route,
                            commandText: normalizedPayload,
                        })));
                    } catch (error) {
                        console.log(JSON.stringify(withApiMeta({
                            route: routed.route,
                            success: false,
                            errorCode: error && error.code ? error.code : 'NEWS_ROUTE_LOAD_FAILED',
                            error: String(error && error.message ? error.message : error),
                            telegramReply: `소식 모듈 로드 실패: ${error && error.message ? error.message : error}`,
                            preferredModelAlias: 'fast',
                            preferredReasoning: 'low',
                        }, {
                            route: routed.route,
                            commandText: routed.payload,
                        })));
                    }
                    break;
                }
                if (routed.route === 'report') {
                    const payloadRaw = String(routed.payload || '').trim();
                    const payload = payloadRaw.toLowerCase();
                    const forceTrendOnResearch = isResearchRuntime(process.env);
                    if (payload.includes('블로그')) {
                        const blog = require('./blog_publish_from_reports');
                        const res = await blog.publishFromReports();
                        console.log(JSON.stringify(withApiMeta({
                            route: 'report',
                            action: 'blog-publish',
                            ...res,
                            telegramReply: appendExternalLinks('리포트 완료'),
                            preferredModelAlias: 'fast',
                            preferredReasoning: 'low',
                            routeHint: 'report-blog-publish',
                        }, {
                            route: 'report',
                            routeHint: 'report-blog-publish',
                            commandText: routed.payload,
                        })));
                        break;
                    }
                    if (payload.includes('주간')) {
                        const weekly = require('./weekly_report');
                        const res = await weekly.buildWeeklyReport();
                        console.log(JSON.stringify(withApiMeta({
                            route: 'report',
                            action: 'weekly',
                            ...res,
                            telegramReply: appendExternalLinks('리포트 완료'),
                            preferredModelAlias: 'fast',
                            preferredReasoning: 'low',
                            routeHint: 'report-weekly',
                        }, {
                            route: 'report',
                            routeHint: 'report-weekly',
                            commandText: routed.payload,
                        })));
                        break;
                    }
                    if (
                        forceTrendOnResearch ||
                        !payload ||
                        payload.includes('지금요약') ||
                        payload.includes('요약') ||
                        payload.includes('상태') ||
                        payload.includes('이벤트') ||
                        payload.includes('키워드') ||
                        payload.includes('소스') ||
                        payload.includes('트렌드') ||
                        payload.includes('테크')
                    ) {
                        try {
                            const newsDigest = require('./news_digest');
                            const normalizedPayload = normalizeReportNewsPayload(payloadRaw || '지금요약');
                            const result = await newsDigest.handleNewsCommand(normalizedPayload);
                            const modelMeta = pickPreferredModelMeta(result, 'fast', 'low');
                            console.log(JSON.stringify(withApiMeta({
                                route: 'report',
                                action: 'tech-trend',
                                ...result,
                                ...modelMeta,
                                routeHint: 'report-tech-trend',
                            }, {
                                route: 'report',
                                routeHint: 'report-tech-trend',
                                commandText: normalizedPayload,
                            })));
                        } catch (error) {
                            console.log(JSON.stringify(withApiMeta({
                                route: 'report',
                                success: false,
                                errorCode: error && error.code ? error.code : 'REPORT_TREND_ROUTE_LOAD_FAILED',
                                error: String(error && error.message ? error.message : error),
                                telegramReply: `리포트(테크 트렌드) 처리 실패: ${error && error.message ? error.message : error}`,
                                preferredModelAlias: 'fast',
                                preferredReasoning: 'low',
                                routeHint: 'report-tech-trend',
                            }, {
                                route: 'report',
                                routeHint: 'report-tech-trend',
                                commandText: routed.payload,
                            })));
                        }
                        break;
                    }
                    const daily = require('./daily_summary');
                    const res = await daily.buildDailySummary();
                    console.log(JSON.stringify(withApiMeta({
                        route: 'report',
                        action: 'daily',
                        ...res,
                        telegramReply: appendExternalLinks('리포트 완료'),
                        preferredModelAlias: 'fast',
                        preferredReasoning: 'low',
                        routeHint: 'report-daily',
                    }, {
                        route: 'report',
                        routeHint: 'report-daily',
                        commandText: routed.payload,
                    })));
                    break;
                }
                if (routed.route === 'work') {
                    const parsed = parseStructuredCommand('work', routed.payload);
                    const telegramReply = appendExternalLinks(parsed.telegramReply || '');
                    const degradedMode = buildCodexDegradedMeta();
                    const routeHint = 'complex-workload';
                    console.log(JSON.stringify(withApiMeta({
                        route: routed.route,
                        templateValid: parsed.ok,
                        ...parsed,
                        telegramReply,
                        duelMode: buildDuelModeMeta(),
                        degradedMode,
                        preferredModelAlias: degradedMode.enabled ? 'deep' : 'codex',
                        preferredReasoning: 'high',
                        routeHint,
                    }, {
                        route: routed.route,
                        routeHint,
                        commandText: routed.payload,
                        templateFields: parsed.fields || {},
                    })));
                    break;
                }
                if (routed.route === 'inspect') {
                    const parsed = parseStructuredCommand('inspect', routed.payload);
                    const telegramReply = appendExternalLinks(parsed.telegramReply || '');
                    const degradedMode = buildCodexDegradedMeta();
                    const routeHint = 'inspection';
                    console.log(JSON.stringify(withApiMeta({
                        route: routed.route,
                        templateValid: parsed.ok,
                        ...parsed,
                        telegramReply,
                        degradedMode,
                        preferredModelAlias: degradedMode.enabled ? 'deep' : 'codex',
                        preferredReasoning: 'medium',
                        routeHint,
                    }, {
                        route: routed.route,
                        routeHint,
                        commandText: routed.payload,
                        templateFields: parsed.fields || {},
                    })));
                    break;
                }
                if (routed.route === 'deploy') {
                    const parsed = parseStructuredCommand('deploy', routed.payload);
                    const telegramReply = appendExternalLinks(parsed.telegramReply || '');
                    const degradedMode = buildCodexDegradedMeta();
                    const routeHint = 'deployment';
                    console.log(JSON.stringify(withApiMeta({
                        route: routed.route,
                        templateValid: parsed.ok,
                        ...parsed,
                        telegramReply,
                        degradedMode,
                        preferredModelAlias: degradedMode.enabled ? 'deep' : 'codex',
                        preferredReasoning: 'high',
                        routeHint,
                    }, {
                        route: routed.route,
                        routeHint,
                        commandText: routed.payload,
                        templateFields: parsed.fields || {},
                    })));
                    break;
                }
                if (routed.route === 'project') {
                    const parsed = parseStructuredCommand('project', routed.payload);
                    const payload = buildProjectRoutePayload(parsed);
                    const degradedMode = buildCodexDegradedMeta();
                    const routeHint = 'project-bootstrap';
                    console.log(JSON.stringify(withApiMeta({
                        ...payload,
                        route: routed.route,
                        degradedMode,
                        preferredModelAlias: degradedMode.enabled ? 'deep' : 'codex',
                        preferredReasoning: 'high',
                        routeHint,
                    }, {
                        route: routed.route,
                        routeHint,
                        commandText: routed.payload,
                        templateFields: parsed.fields || {},
                    })));
                    break;
                }
                if (routed.route === 'prompt') {
                    const out = handlePromptPayload(routed.payload);
                    if (out && out.telegramReply) {
                        out.telegramReply = appendExternalLinks(out.telegramReply);
                    }
                    console.log(JSON.stringify(withApiMeta({
                        route: 'prompt',
                        ...out,
                    }, {
                        route: 'prompt',
                        commandText: routed.payload,
                    })));
                    break;
                }
                if (routed.route === 'link') {
                    const reply = buildLinkOnlyReply(routed.payload || '링크');
                    console.log(JSON.stringify(withApiMeta({
                        route: 'link',
                        success: true,
                        telegramReply: reply,
                        preferredModelAlias: 'fast',
                        preferredReasoning: 'low',
                    }, {
                        route: 'link',
                        commandText: routed.payload,
                    })));
                    break;
                }
                if (routed.route === 'status') {
                    console.log(JSON.stringify(withApiMeta({
                        route: 'status',
                        success: true,
                        telegramReply: buildQuickStatusReply(routed.payload),
                        preferredModelAlias: 'fast',
                        preferredReasoning: 'low',
                    }, {
                        route: 'status',
                        commandText: routed.payload,
                    })));
                    break;
                }
                if (routed.route === 'ops') {
                    const telegramContext = parseTransportEnvelopeContext(fullText);
                    const out = runOpsCommand(routed.payload, {
                        rawText: fullText,
                        telegramContext,
                    });
                    if (out && out.telegramReply) {
                        out.telegramReply = appendExternalLinks(out.telegramReply);
                    }
                    console.log(JSON.stringify(withApiMeta(out, {
                        route: 'ops',
                        commandText: routed.payload,
                    })));
                    break;
                }
                if (routed.route === 'none') {
                    const noPrefixReply = isHubRuntime(process.env)
                        ? buildDailyCasualNoPrefixReply(routed.payload || fullText)
                        : buildNoPrefixGuide();
                    console.log(JSON.stringify(withApiMeta({
                        route: 'none',
                        skipped: fullText,
                        preferredModelAlias: 'fast',
                        preferredReasoning: 'low',
                        telegramReply: appendExternalLinks(noPrefixReply),
                    }, {
                        route: 'none',
                        commandText: fullText,
                    })));
                    break;
                }
                console.log(JSON.stringify(withApiMeta({
                    route: 'none',
                    skipped: fullText,
                }, {
                    route: 'none',
                    commandText: fullText,
                })));
                break;
            }

            default:
                throw new Error(`Unknown command: ${command}`);
                }

                if (finalStatus !== 'warn') {
                    finalStatus = attempt > 1 ? 'warn' : 'ok';
                    finalSeverity = 'P3';
                    finalMessage = attempt > 1
                        ? 'Run completed after retry.'
                        : 'Run completed successfully.';
                }
                break;
            } catch (attemptError) {
                const retriable = isRetriableError(attemptError);
                if (attempt < maxAttempts && retriable) {
                    opsLogger.logRetry(opsContext, {
                        component: 'bridge',
                        action: normalizedCommand || 'unknown',
                        message: `Retrying after transient error on attempt ${attempt}.`,
                        attempt: attempt + 1,
                        max_attempts: maxAttempts,
                        error: {
                            type: attemptError && (attemptError.name || attemptError.type) ? String(attemptError.name || attemptError.type) : 'Error',
                            code: attemptError && attemptError.code ? String(attemptError.code) : '',
                            message: attemptError && attemptError.message ? String(attemptError.message) : String(attemptError),
                            stack: attemptError && attemptError.stack ? String(attemptError.stack) : '',
                        },
                    });
                    await sleep(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]);
                    attempt += 1;
                    continue;
                }
                throw attemptError;
            }
        }
    } catch (error) {
        finalError = error;
        finalStatus = 'error';
        finalSeverity = /(eacces|permission denied)/i.test(String(error && (error.code || error.message || error)))
            ? 'P1'
            : 'P2';
        finalMessage = 'Run failed with error.';
        console.error('Error:', error);
    } finally {
        stopHeartbeat();
        opsLogger.logEnd(opsContext, {
            status: finalStatus,
            severity: finalSeverity,
            component: 'bridge',
            action: normalizedCommand || 'unknown',
            message: finalMessage,
            attempt,
            max_attempts: maxAttempts,
            error: finalError
                ? {
                    type: finalError.name || 'Error',
                    code: finalError.code || '',
                    message: finalError.message || String(finalError),
                    stack: finalError.stack || '',
                    retriable: isRetriableError(finalError),
                }
                : undefined,
            metrics: {
                command: normalizedCommand || '',
                full_text_chars: fullText.length,
            },
        });
    }

    if (finalError) {
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    parseWordToken,
    enrichToeicWord,
    processWordTokens,
    routeByPrefix,
    inferNaturalLanguageRoute,
    inferFinanceIntentPayload,
    inferTodoIntentPayload,
    inferRoutineIntentPayload,
    inferWorkoutIntentPayload,
    runOpsCommand,
    parseApproveShorthand,
    parseTransportEnvelopeContext,
    normalizeIncomingCommandText,
    normalizeNewsCommandPayload,
    resolveHubDelegationTarget,
    enqueueHubDelegationCommand,
    buildToeicAnswerRich,
    buildToeicAnswer,
    fallbackExample,
    buildWordCandidates,
    isWeakEnrichment,
    normalizeQualityPolicy,
    QUALITY_STYLE_VERSION,
};
