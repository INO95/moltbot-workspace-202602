const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { inferRouteFromCommand, decideApiLane, loadRoutingPolicy } = require('./oai_api_router');
const { routeByPrefix: routeByPrefixCore } = require('./lib/bridge_route_dispatch');
const {
    inferMemoIntentPayload,
    inferFinanceIntentPayload,
    inferTodoIntentPayload,
    inferRoutineIntentPayload,
    inferWorkoutIntentPayload,
    inferBrowserIntentPayload,
    inferScheduleIntentPayload,
    inferGogLookupIntentPayload,
    inferStatusIntentPayload,
    inferLinkIntentPayload: inferLinkIntentPayloadCore,
    inferWorkIntentPayload,
    inferInspectIntentPayload,
    inferReportIntentPayload,
    extractPreferredProjectBasePath,
    inferProjectIntentPayload: inferProjectIntentPayloadCore,
    inferNaturalLanguageRoute: inferNaturalLanguageRouteCore,
} = require('./lib/bridge_nl_inference');
const {
    resolveWorkspaceRootHint: resolveWorkspaceRootHintCore,
    normalizeIncomingCommandText: normalizeIncomingCommandTextCore,
} = require('./lib/bridge_input_normalization');
const { isExternalLinkRequest } = require('./lib/bridge_link_diagnostics');
const {
    loadLastProjectBootstrap,
    resolveDefaultProjectBasePath,
    toProjectTemplatePayload,
} = require('./lib/bridge_project_state');
const { DEFAULT_NATURAL_LANGUAGE_ROUTING } = require('../packages/core-policy/src/bridge_defaults');
const { sanitizeProjectName } = require('./project_bootstrap');
const { resolveDbPath } = require('./personal_schema');
const { runSqlJson } = require('./news_storage');
const {
    getPromptFileSizeMap,
    summarizePromptSnapshot,
    readMainSessionState,
    evaluateMainSessionRotation,
    readLatestSystemPromptReport,
} = require('./lib/main_session_rotation');

const ROOT = path.join(__dirname, '..');
const DASHBOARD_JSON_PATH = path.join(__dirname, '../logs/model_cost_latency_dashboard_latest.json');
const DASHBOARD_MD_PATH = path.join(__dirname, '../logs/model_cost_latency_dashboard_latest.md');
const HISTORY_JSONL_PATH = path.join(__dirname, '../logs/model_cost_latency_history.jsonl');
const BRIDGE_LOG_PATH = path.join(__dirname, '../data/bridge/inbox.jsonl');
const CONFIG_PATH = path.join(__dirname, '../data/config.json');
const PROJECT_BOOTSTRAP_STATE_PATH = path.join(__dirname, '..', 'data', 'runtime', 'project_bootstrap_last.json');

const LOCK_DIR = path.join(__dirname, '../data/locks');
const LOCK_PATH = path.join(LOCK_DIR, 'model_benchmark.lock');
const CODEX_PREFERRED = [
    'openai-codex/gpt-5.3-codex',
    'openai-codex/gpt-5.3-codex-spark',
    'openai-codex/gpt-5.2-codex',
    'openai-codex/gpt-5.2',
    'openai-codex/gpt-5.1-codex-max',
    'openai-codex/gpt-5.1',
];
const ROUTE_COUNT_KEYS = Object.freeze([
    'word',
    'memo',
    'finance',
    'todo',
    'routine',
    'workout',
    'media',
    'place',
    'news',
    'report',
    'work',
    'inspect',
    'deploy',
    'project',
    'prompt',
    'link',
    'status',
    'ops',
    'anki',
    'none',
    'other',
]);
const KNOWN_ROUTE_SET = new Set(ROUTE_COUNT_KEYS.filter((route) => route !== 'other'));

function ensureDirFor(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseJson(text, fallback = null) {
    try {
        return JSON.parse(String(text || ''));
    } catch {
        return fallback;
    }
}

function readConfig(configPath = CONFIG_PATH) {
    if (!fs.existsSync(configPath)) return {};
    return parseJson(fs.readFileSync(configPath, 'utf8'), {}) || {};
}

function parseBooleanEnv(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    return null;
}

function emptyRouteCounts() {
    return ROUTE_COUNT_KEYS.reduce((acc, route) => {
        acc[route] = 0;
        return acc;
    }, {});
}

function normalizeKnownRoute(value) {
    const route = String(value || '').trim().toLowerCase();
    return KNOWN_ROUTE_SET.has(route) ? route : '';
}

function normalizeApprovalFlags(value) {
    const raw = String(value || '');
    const matches = raw.match(/--[a-z0-9_-]+/gi) || [];
    const seen = new Set();
    const flags = [];
    for (const match of matches) {
        const normalized = String(match).replace(/^--/, '').trim().toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        flags.push(normalized);
    }
    return flags;
}

function parseApproveShorthand(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const conversationalApprove = /^(?:(?:응|네|예|그래|좋아|오케이|ㅇㅋ|ok|okay)\s*)?(?:승인(?:해|해줘|해주세요|해요|합니다)?|진행(?:해|해줘|해주세요|해요|합니다)?|go\s*ahead)\s*[.!~…]*$/i;
    const explicitApprove = /^\/?approve\b/i.test(raw);
    const conversational = conversationalApprove.test(raw);
    const tokenMatch = raw.match(/\bapv_[a-f0-9]{16}\b/i);
    const token = tokenMatch ? String(tokenMatch[0] || '').trim() : '';
    if (!explicitApprove && !conversational) return null;

    const tail = explicitApprove ? raw.replace(/^\/?approve\b/i, '').trim() : raw;
    const flagSource = token ? String(tail.replace(token, ' ') || '').trim() : tail;
    const flags = explicitApprove
        ? normalizeApprovalFlags(flagSource)
        : normalizeApprovalFlags((String(flagSource || '').match(/--[a-z0-9_-]+/gi) || []).join(' '));
    const flagText = flags.length > 0
        ? `; 옵션: ${flags.map((flag) => `--${flag}`).join(' ')}`
        : '';

    return {
        token,
        normalizedPayload: token
            ? `액션: 승인; 토큰: ${token}${flagText}`
            : `액션: 승인${flagText}`,
    };
}

function parseDenyShorthand(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const explicitDeny = /^\/?deny\b/i.test(raw);
    const conversationalDeny = /^(?:(?:응|네|예|그래|오케이|ㅇㅋ|ok|okay)\s*)?(?:거부|거절|취소)(?:해|해줘|해주세요|해요|합니다)?\s*[.!~…]*$/i.test(raw);
    const tokenMatch = raw.match(/\bapv_[a-f0-9]{16}\b/i);
    const token = tokenMatch ? String(tokenMatch[0] || '').trim() : '';
    if (!explicitDeny && !conversationalDeny) return null;
    return {
        token,
        normalizedPayload: token ? `액션: 거부; 토큰: ${token}` : '액션: 거부',
    };
}

function parseNaturalApprovalShorthand(text) {
    const raw = String(text || '')
        .trim()
        .replace(/[.!?~]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    if (!raw) return null;
    if (raw.includes(':') || raw.includes('：') || raw.includes('/')) return null;

    if (/^(응\s*)?(승인|승인해|승인할게|진행|진행해|진행할게|오케이|ok|ㅇㅋ|ㅇㅇ)$/.test(raw)) {
        return { decision: 'approve', normalizedPayload: '액션: 승인' };
    }
    if (/^(응\s*)?(거부|거부해|취소|취소해|중지|멈춰|스탑|stop)$/.test(raw)) {
        return { decision: 'deny', normalizedPayload: '액션: 거부' };
    }
    return null;
}

function normalizeNaturalLanguageRoutingConfig(rawConfig, env = process.env) {
    const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    const pickBool = (key, fallback) => (
        source[key] == null ? fallback : Boolean(source[key])
    );

    const config = {
        enabled: pickBool('enabled', DEFAULT_NATURAL_LANGUAGE_ROUTING.enabled),
        hubOnly: pickBool('hubOnly', DEFAULT_NATURAL_LANGUAGE_ROUTING.hubOnly),
        inferMemo: pickBool('inferMemo', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferMemo),
        inferFinance: pickBool('inferFinance', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferFinance),
        inferTodo: pickBool('inferTodo', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferTodo),
        inferRoutine: pickBool('inferRoutine', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferRoutine),
        inferWorkout: pickBool('inferWorkout', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferWorkout),
        inferPersona: pickBool('inferPersona', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferPersona),
        inferBrowser: pickBool('inferBrowser', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferBrowser),
        inferSchedule: pickBool('inferSchedule', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferSchedule),
        inferStatus: pickBool('inferStatus', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferStatus),
        inferLink: pickBool('inferLink', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferLink),
        inferWork: pickBool('inferWork', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferWork),
        inferInspect: pickBool('inferInspect', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferInspect),
        inferReport: pickBool('inferReport', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferReport),
        inferProject: pickBool('inferProject', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferProject),
    };

    const envKeys = {
        enabled: 'BRIDGE_NL_ROUTING_ENABLED',
        hubOnly: 'BRIDGE_NL_ROUTING_HUB_ONLY',
        inferMemo: 'BRIDGE_NL_INFER_MEMO',
        inferFinance: 'BRIDGE_NL_INFER_FINANCE',
        inferTodo: 'BRIDGE_NL_INFER_TODO',
        inferRoutine: 'BRIDGE_NL_INFER_ROUTINE',
        inferWorkout: 'BRIDGE_NL_INFER_WORKOUT',
        inferPersona: 'BRIDGE_NL_INFER_PERSONA',
        inferBrowser: 'BRIDGE_NL_INFER_BROWSER',
        inferSchedule: 'BRIDGE_NL_INFER_SCHEDULE',
        inferStatus: 'BRIDGE_NL_INFER_STATUS',
        inferLink: 'BRIDGE_NL_INFER_LINK',
        inferWork: 'BRIDGE_NL_INFER_WORK',
        inferInspect: 'BRIDGE_NL_INFER_INSPECT',
        inferReport: 'BRIDGE_NL_INFER_REPORT',
        inferProject: 'BRIDGE_NL_INFER_PROJECT',
    };

    for (const [key, envKey] of Object.entries(envKeys)) {
        if (!Object.prototype.hasOwnProperty.call(env, envKey)) continue;
        const parsed = parseBooleanEnv(env[envKey]);
        if (parsed != null) config[key] = parsed;
    }

    return config;
}

function isHubRuntime(env = process.env) {
    const role = String(env.MOLTBOT_BOT_ROLE || '').trim().toLowerCase();
    const botId = String(env.MOLTBOT_BOT_ID || '').trim().toLowerCase();
    const profile = String(env.MOLTBOT_PROFILE || env.OPENCLAW_PROFILE || '').trim().toLowerCase();
    return role === 'supervisor'
        || botId === 'bot-daily'
        || botId === 'daily'
        || botId === 'bot-main'
        || botId === 'main'
        || profile === 'daily'
        || profile === 'main';
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

function buildRouteResolver({ commandPrefixes = {}, naturalLanguageRouting = {}, env = process.env } = {}) {
    const workspaceRootResolver = () => resolveWorkspaceRootHintCore({
        env,
        fsModule: fs,
        pathModule: path,
        fallbackWorkspaceRoot: path.resolve(__dirname, '..'),
    });
    const normalizeIncomingCommandText = (text) => normalizeIncomingCommandTextCore(text, {
        resolveWorkspaceRootHint: workspaceRootResolver,
    });
    const normalizedRouting = normalizeNaturalLanguageRoutingConfig(naturalLanguageRouting, env);
    const defaultProjectBasePath = () => resolveDefaultProjectBasePath({ pathModule: path });
    const projectStatePath = path.resolve(
        String(env.OPS_PROJECT_BOOTSTRAP_STATE_PATH || PROJECT_BOOTSTRAP_STATE_PATH),
    );
    const inferLinkIntentPayload = (text) => inferLinkIntentPayloadCore(text, { isExternalLinkRequest });
    const inferProjectIntentPayload = (text) => inferProjectIntentPayloadCore(text, {
        extractPreferredProjectBasePath: (value) => extractPreferredProjectBasePath(value, {
            resolveWorkspaceRootHint: workspaceRootResolver,
            pathModule: path,
        }),
        loadLastProjectBootstrap: () => loadLastProjectBootstrap(48, { statePath: projectStatePath }),
        resolveDefaultProjectBasePath: defaultProjectBasePath,
        toProjectTemplatePayload: (fields, options = {}) => toProjectTemplatePayload(fields, options, {
            sanitizeProjectName,
            resolveDefaultProjectBasePath: defaultProjectBasePath,
        }),
    });
    const inferNaturalLanguageRoute = (text, options = {}) => inferNaturalLanguageRouteCore(text, {
        ...options,
        env,
    }, {
        NATURAL_LANGUAGE_ROUTING: normalizedRouting,
        isHubRuntime,
        isResearchRuntime,
        normalizeIncomingCommandText,
        inferMemoIntentPayload,
        inferFinanceIntentPayload,
        inferTodoIntentPayload,
        inferRoutineIntentPayload,
        inferWorkoutIntentPayload,
        inferWorkIntentPayload,
        inferInspectIntentPayload,
        inferBrowserIntentPayload,
        inferScheduleIntentPayload,
        inferGogLookupIntentPayload,
        inferStatusIntentPayload,
        inferLinkIntentPayload,
        inferProjectIntentPayload,
        inferReportIntentPayload,
    });

    return (commandText) => routeByPrefixCore(commandText, {
        commandPrefixes,
        normalizeIncomingCommandText,
        parseApproveShorthand,
        parseDenyShorthand,
        parseNaturalApprovalShorthand,
        readPendingApprovalsState: () => [],
        hasAnyApprovalHint: () => false,
        inferNaturalLanguageRoute,
        env,
    });
}

function classifyBridgeRoute(row, options = {}) {
    const commandText = String((row && row.command) || '').trim();
    if (!commandText) {
        return {
            route: 'other',
            commandText: '',
            classification: 'empty-command',
        };
    }

    const routeResolver = typeof options.routeResolver === 'function'
        ? options.routeResolver
        : buildRouteResolver(options);
    const routed = routeResolver(commandText) || {};
    const routedRoute = normalizeKnownRoute(routed.route);
    if (routedRoute && routedRoute !== 'none') {
        return {
            route: routedRoute,
            commandText: String(routed.payload || commandText).trim() || commandText,
            classification: String(routed.inferredBy || 'route-dispatch'),
        };
    }

    const rowRoute = normalizeKnownRoute(row && row.route);
    if (routedRoute === 'none' && rowRoute && rowRoute !== 'none') {
        return {
            route: rowRoute,
            commandText: String(routed.payload || commandText).trim() || commandText,
            classification: 'row-route-fallback',
        };
    }

    const prefixFallback = inferRouteFromCommand(commandText, {
        commandPrefixes: options.commandPrefixes || {},
    });
    const prefixRoute = normalizeKnownRoute(prefixFallback.route);
    if (prefixRoute && prefixRoute !== 'none') {
        return {
            route: prefixRoute,
            commandText: String(prefixFallback.payload || commandText).trim() || commandText,
            classification: 'prefix-fallback',
        };
    }

    if (String((row && row.route) || '').trim()) {
        return {
            route: rowRoute || 'other',
            commandText: String(prefixFallback.payload || routed.payload || commandText).trim() || commandText,
            classification: rowRoute ? 'row-route-none' : 'unknown-row-route',
        };
    }

    return {
        route: 'none',
        commandText: String(prefixFallback.payload || routed.payload || commandText).trim() || commandText,
        classification: 'unclassified-none',
    };
}

function runDocker(args, options = {}) {
    const result = spawnSync('docker', ['exec', 'moltbot-dev', ...args], {
        encoding: 'utf8',
        maxBuffer: 30 * 1024 * 1024,
        ...options,
    });
    if (result.status !== 0) {
        const stderr = String(result.stderr || '').trim();
        const stdout = String(result.stdout || '').trim();
        throw new Error(`docker exec failed: ${stderr || stdout || 'unknown error'}`);
    }
    return String(result.stdout || '');
}

function sleep(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        // short busy wait for lock retry loop.
    }
}

function acquireLock(timeoutMs = 90000) {
    ensureDirFor(LOCK_PATH);
    const start = Date.now();
    while (true) {
        try {
            const fd = fs.openSync(LOCK_PATH, 'wx');
            fs.writeFileSync(fd, String(process.pid), 'utf8');
            return fd;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Failed to acquire lock: ${LOCK_PATH}`);
            }
            sleep(200);
        }
    }
}

function releaseLock(fd) {
    try {
        if (typeof fd === 'number') fs.closeSync(fd);
    } catch {}
    try {
        if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
    } catch {}
}

function getModelStatusPlain() {
    return runDocker(['node', 'dist/index.js', 'models', 'status', '--plain']).trim();
}

function setModel(model) {
    runDocker(['node', 'dist/index.js', 'models', 'set', model]);
}

function getCodexCatalog() {
    const out = runDocker([
        'node',
        'dist/index.js',
        'models',
        'list',
        '--all',
        '--provider',
        'openai-codex',
        '--plain',
    ]);
    return out
        .split('\n')
        .map(v => v.trim())
        .filter(Boolean);
}

function getSessions() {
    const out = runDocker(['node', 'dist/index.js', 'sessions', '--json']);
    return JSON.parse(out);
}

function chooseCodexModel(catalog) {
    for (const c of CODEX_PREFERRED) {
        if (catalog.includes(c)) return c;
    }
    return null;
}

function summarizeSessions(sessions) {
    const byModel = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalTokens = 0;
    for (const s of sessions) {
        const m = s.model || 'unknown';
        byModel[m] = byModel[m] || {
            sessions: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
        };
        byModel[m].sessions += 1;
        byModel[m].inputTokens += Number(s.inputTokens || 0);
        byModel[m].outputTokens += Number(s.outputTokens || 0);
        byModel[m].totalTokens += Number(s.totalTokens || 0);
        totalInput += Number(s.inputTokens || 0);
        totalOutput += Number(s.outputTokens || 0);
        totalTokens += Number(s.totalTokens || 0);
    }
    return { byModel, totalInput, totalOutput, totalTokens, sessionCount: sessions.length };
}

function buildNormalizedBridgeLogCommand(commandText, options = {}) {
    const text = String(commandText || '').trim();
    if (!text) return '';
    const routeResolver = typeof options.workspaceRootResolver === 'function'
        ? options.workspaceRootResolver
        : (() => resolveWorkspaceRootHintCore({
            env: options.env || process.env,
            fsModule: fs,
            pathModule: path,
            fallbackWorkspaceRoot: ROOT,
        }));
    const normalized = normalizeIncomingCommandTextCore(text, {
        resolveWorkspaceRootHint: routeResolver,
    });
    return String(normalized || text)
        .replace(/^\s*\[Telegram[^\]]*\]\s*/i, '')
        .replace(/\s*\[message_id:\s*[^\]]+\]\s*$/i, '')
        .trim();
}

function parseBridgeRouteCounts(options = {}) {
    const counts = emptyRouteCounts();
    const system = { cronFail: 0, otherSystem: 0, total: 0 };
    const apiLanes = {
        total: 0,
        byLane: {
            'oauth-codex': 0,
            'api-key-openai': 0,
            'local-only': 0,
        },
        blocked: 0,
        blockedByReason: {},
    };
    const bridgeLogPath = path.resolve(String(
        options.bridgeLogPath
        || process.env.BRIDGE_INBOX_LOG_PATH
        || BRIDGE_LOG_PATH,
    ));
    const configPath = path.resolve(String(options.configPath || CONFIG_PATH));
    if (!fs.existsSync(bridgeLogPath)) return { counts, total: 0, system, apiLanes };

    const cfg = options.config && typeof options.config === 'object'
        ? options.config
        : readConfig(configPath);
    const commandPrefixes = cfg.commandPrefixes || {};
    const naturalLanguageRouting = cfg.naturalLanguageRouting || {};
    const budgetPolicy = loadBudgetPolicy({ config: cfg, configPath });
    const routingPolicy = loadRoutingPolicy();
    const env = options.env && typeof options.env === 'object' ? options.env : process.env;
    const routeResolver = buildRouteResolver({ commandPrefixes, naturalLanguageRouting, env });
    const workspaceRootResolver = () => resolveWorkspaceRootHintCore({
        env,
        fsModule: fs,
        pathModule: path,
        fallbackWorkspaceRoot: ROOT,
    });

    const lines = fs
        .readFileSync(bridgeLogPath, 'utf8')
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean);
    for (const line of lines) {
        let obj = null;
        try {
            obj = JSON.parse(line);
        } catch {
            continue;
        }
        const cmd = String(obj.command || '').trim();
        const source = String(obj.source || '').trim().toLowerCase();
        const isCronFail = source === 'cron-guard' || cmd.startsWith('[CRON FAIL]');
        const looksSystemEvent = /^\[(ALERT|NOTIFY|CRON FAIL)\]/i.test(cmd);
        if (isCronFail) {
            system.cronFail += 1;
            system.total += 1;
            continue;
        }
        if (source && source !== 'user' && looksSystemEvent) {
            system.otherSystem += 1;
            system.total += 1;
            continue;
        }
        obj.command = buildNormalizedBridgeLogCommand(obj.command, {
            env,
            workspaceRootResolver,
        });
        const classified = classifyBridgeRoute(obj, {
            commandPrefixes,
            naturalLanguageRouting,
            env,
            routeResolver,
        });
        counts[classified.route] = (counts[classified.route] || 0) + 1;
        if (!cmd) continue;
        const decision = decideApiLane(
            {
                route: classified.route,
                commandText: classified.commandText || cmd,
            },
            {
                policy: routingPolicy,
                budgetPolicy,
                env,
            },
        );
        apiLanes.total += 1;
        if (!Object.prototype.hasOwnProperty.call(apiLanes.byLane, decision.apiLane)) {
            apiLanes.byLane[decision.apiLane] = 0;
        }
        apiLanes.byLane[decision.apiLane] += 1;
        if (decision.blocked) {
            apiLanes.blocked += 1;
            const reason = decision.blockReason || 'unknown';
            apiLanes.blockedByReason[reason] = (apiLanes.blockedByReason[reason] || 0) + 1;
        }
    }
    const userTotal = Object.values(counts).reduce((acc, value) => acc + Number(value || 0), 0);
    return {
        counts,
        byRoute: { ...counts },
        total: userTotal,
        system,
        apiLanes,
    };
}

function loadBudgetPolicy(options = {}) {
    const cfg = options.config && typeof options.config === 'object'
        ? options.config
        : readConfig(options.configPath || CONFIG_PATH);
    const policy = cfg.budgetPolicy || {};
    return {
        monthlyApiBudgetYen: Number(policy.monthlyApiBudgetYen || 0),
        paidApiRequiresApproval: Boolean(policy.paidApiRequiresApproval),
    };
}

function summarizeWordMetrics(options = {}) {
    const dbPath = resolveDbPath({
        dbPath: options.dbPath || process.env.PERSONAL_DB_PATH || undefined,
    });
    const summary = {
        total: 0,
        saved: 0,
        failed: 0,
        duplicate: 0,
        autoCorrected: 0,
    };
    if (!dbPath || !fs.existsSync(dbPath)) return summary;

    let rows = [];
    try {
        rows = runSqlJson(
            dbPath,
            `
SELECT save_status, meta_json
FROM vocab_logs
ORDER BY id ASC;
`,
        );
    } catch (_) {
        return summary;
    }

    for (const row of rows) {
        summary.total += 1;
        const saveStatus = String((row && row.save_status) || '').trim().toLowerCase();
        if (saveStatus === 'saved') summary.saved += 1;
        else if (saveStatus === 'failed') summary.failed += 1;

        const meta = parseJson(row && row.meta_json, {}) || {};
        if (meta && meta.duplicate === true) summary.duplicate += 1;
        if (String(meta && meta.correctedWord ? meta.correctedWord : '').trim()) {
            summary.autoCorrected += 1;
        }
    }
    return summary;
}

function runLatencyProbe({ label, thinking = 'minimal' }) {
    const sid = `latency-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const t0 = Date.now();
    const out = runDocker([
        'node',
        'dist/index.js',
        'agent',
        '--session-id',
        sid,
        '--message',
        'Reply with exactly: OK',
        '--thinking',
        thinking,
        '--json',
    ]);
    const elapsedMs = Date.now() - t0;
    const parsed = JSON.parse(out);
    const meta = (((parsed || {}).result || {}).meta || {});
    const agentMeta = meta.agentMeta || {};
    return {
        label,
        provider: agentMeta.provider || 'unknown',
        model: agentMeta.model || 'unknown',
        elapsedMs,
        durationMs: Number(meta.durationMs || 0),
    };
}

function benchmarkLatencies(codexModel) {
    const lockFd = acquireLock();
    let original = '';
    try {
        original = getModelStatusPlain();
        const probes = [];

        probes.push(runLatencyProbe({ label: 'default', thinking: 'minimal' }));
        if (codexModel) {
            setModel(codexModel);
            probes.push(runLatencyProbe({ label: 'codex', thinking: 'low' }));
        }
        return probes;
    } finally {
        try {
            if (original) setModel(original);
        } finally {
            releaseLock(lockFd);
        }
    }
}

function estimateCostYen() {
    // Current policy is OpenAI Codex OAuth only; direct API-key spend remains 0 unless explicitly enabled.
    return 0;
}

function appendHistory(snapshot) {
    ensureDirFor(HISTORY_JSONL_PATH);
    fs.appendFileSync(HISTORY_JSONL_PATH, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

function buildPromptBudgetSummary(options = {}) {
    const root = options.root || ROOT;
    const report = readLatestSystemPromptReport({ root, env: options.env || process.env });
    const currentPromptSizes = getPromptFileSizeMap({ root });
    const snapshot = summarizePromptSnapshot(report);
    return {
        injectedWorkspaceChars: Object.values(currentPromptSizes).reduce((acc, value) => (
            Number.isFinite(Number(value)) ? acc + Number(value) : acc
        ), 0),
        toolSchemaChars: snapshot.toolSchemaChars,
        skillsPromptChars: snapshot.skillsPromptChars,
        injectedWorkspaceSnapshotChars: snapshot.injectedWorkspaceChars,
        injectedWorkspaceByFile: currentPromptSizes,
    };
}

function buildSessionRotationSummary(options = {}) {
    const root = options.root || ROOT;
    const state = readMainSessionState({ root, env: options.env || process.env });
    if (!state.ok) {
        return {
            recommended: false,
            reason: state.reason,
        };
    }
    const decision = evaluateMainSessionRotation(state.current, {
        root,
        fsModule: fs,
        pathModule: path,
    });
    return {
        recommended: decision.recommended,
        reason: decision.reason,
        totalTokens: decision.totalTokens,
        tokenSource: decision.tokenSource,
        isStale: decision.isStale,
    };
}

function markdownReport(report) {
    const lines = [];
    lines.push(`# Model Cost/Latency Dashboard`);
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push('');
    lines.push(`- Default model: ${report.runtime.defaultModel}`);
    lines.push(`- Codex best available: ${report.runtime.bestCodexModel || 'N/A'}`);
    lines.push(`- Estimated API cost (JPY): ${report.cost.estimatedMonthlyYen}`);
    lines.push(`- Budget limit (JPY): ${report.cost.budgetPolicy.monthlyApiBudgetYen}`);
    lines.push('');

    lines.push(`## Prompt Budget`);
    lines.push(`- injectedWorkspaceChars: ${report.promptBudget.injectedWorkspaceChars}`);
    lines.push(`- toolSchemaChars: ${report.promptBudget.toolSchemaChars}`);
    lines.push(`- skillsPromptChars: ${report.promptBudget.skillsPromptChars}`);
    lines.push('');

    lines.push(`## Latency Probes`);
    for (const p of report.latency.probes) {
        lines.push(
            `- ${p.label}: ${p.provider}/${p.model} (elapsed ${p.elapsedMs}ms, agent ${p.durationMs}ms)`,
        );
    }
    lines.push('');

    lines.push(`## Route Volume`);
    lines.push(`- Total user command events: ${report.routes.total}`);
    for (const [k, v] of Object.entries(report.routes.byRoute || report.routes.counts || {})) {
        lines.push(`- ${k}: ${v}`);
    }
    if (report.routes.system) {
        lines.push(`- system.total: ${report.routes.system.total}`);
        lines.push(`- system.cronFail: ${report.routes.system.cronFail}`);
        lines.push(`- system.otherSystem: ${report.routes.system.otherSystem}`);
    }
    lines.push('');

    lines.push(`## Word ROI`);
    lines.push(`- total: ${report.wordMetrics.total}`);
    lines.push(`- saved: ${report.wordMetrics.saved}`);
    lines.push(`- failed: ${report.wordMetrics.failed}`);
    lines.push(`- duplicate: ${report.wordMetrics.duplicate}`);
    lines.push(`- autoCorrected: ${report.wordMetrics.autoCorrected}`);
    lines.push('');

    lines.push(`## API Lane Volume`);
    lines.push(`- total: ${report.routes.apiLanes.total}`);
    for (const [k, v] of Object.entries(report.routes.apiLanes.byLane || {})) {
        lines.push(`- ${k}: ${v}`);
    }
    lines.push(`- blocked: ${report.routes.apiLanes.blocked}`);
    for (const [k, v] of Object.entries(report.routes.apiLanes.blockedByReason || {})) {
        lines.push(`- blocked.${k}: ${v}`);
    }
    lines.push('');

    lines.push(`## Sessions by model`);
    for (const [model, info] of Object.entries(report.sessions.byModel)) {
        lines.push(`- ${model}: sessions=${info.sessions}, totalTokens=${info.totalTokens}`);
    }
    lines.push('');

    lines.push(`## Session Rotation`);
    lines.push(`- recommended: ${report.sessionRotation.recommended}`);
    lines.push(`- reason: ${report.sessionRotation.reason}`);
    lines.push('');
    return lines.join('\n');
}

function main() {
    const sessionsDoc = getSessions();
    const sessions = Array.isArray(sessionsDoc.sessions) ? sessionsDoc.sessions : [];
    const sessionSummary = summarizeSessions(sessions);
    const routes = parseBridgeRouteCounts();
    const budgetPolicy = loadBudgetPolicy();
    const wordMetrics = summarizeWordMetrics();
    const codexCatalog = getCodexCatalog();
    const bestCodexModel = chooseCodexModel(codexCatalog);
    const defaultModel = getModelStatusPlain();
    const probes = benchmarkLatencies(bestCodexModel);
    const promptBudget = buildPromptBudgetSummary();
    const sessionRotation = buildSessionRotationSummary();

    const report = {
        generatedAt: new Date().toISOString(),
        runtime: {
            defaultModel,
            bestCodexModel,
            codexCatalog,
        },
        sessions: sessionSummary,
        routes,
        promptBudget,
        sessionRotation,
        wordMetrics,
        latency: {
            probes,
        },
        cost: {
            estimatedMonthlyYen: estimateCostYen(),
            budgetPolicy,
            note: 'Dual-lane routing active; direct API key spend is blocked by default until explicit approval.',
        },
    };

    ensureDirFor(DASHBOARD_JSON_PATH);
    fs.writeFileSync(DASHBOARD_JSON_PATH, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(DASHBOARD_MD_PATH, markdownReport(report), 'utf8');
    appendHistory({
        t: report.generatedAt,
        defaultModel,
        bestCodexModel,
        routes: report.routes.byRoute || report.routes.counts,
        routeSystem: report.routes.system,
        routeApiLanes: report.routes.apiLanes,
        promptBudget: report.promptBudget,
        sessionRotation: report.sessionRotation,
        wordMetrics: report.wordMetrics,
        latency: report.latency.probes,
        sessions: {
            total: sessionSummary.sessionCount,
            totalTokens: sessionSummary.totalTokens,
        },
        costYen: report.cost.estimatedMonthlyYen,
    });

    console.log(
        JSON.stringify(
            {
                ok: true,
                json: DASHBOARD_JSON_PATH,
                markdown: DASHBOARD_MD_PATH,
                history: HISTORY_JSONL_PATH,
                report,
            },
            null,
            2,
        ),
    );
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

module.exports = {
    buildNormalizedBridgeLogCommand,
    buildPromptBudgetSummary,
    buildRouteResolver,
    buildSessionRotationSummary,
    classifyBridgeRoute,
    parseBridgeRouteCounts,
};

module.exports = {
    parseBridgeRouteCounts,
    summarizeWordMetrics,
    markdownReport,
};
