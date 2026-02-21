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
const { buildProjectBootstrapPlan, sanitizeProjectName } = require('./project_bootstrap');
const opsCommandQueue = require('./ops_command_queue');
const opsApprovalStore = require('./ops_approval_store');
const opsFileControl = require('./ops_file_control');
const telegramFinalizer = require('./finalizer');
const personalStorage = require('./personal_storage');
const { handleFinanceCommand } = require('./personal_finance');
const { handleTodoCommand } = require('./personal_todo');
const { handleRoutineCommand } = require('./personal_routine');
const { handleWorkoutCommand } = require('./personal_workout');
const { handleMediaPlaceCommand } = require('./personal_media_place');
const { finalizeTelegramBoundary: finalizeTelegramBoundaryCore } = require('./lib/bridge_output_boundary');
const {
    parseReportModeCommand: parseReportModeCommandCore,
    parsePersonaInfoCommand: parsePersonaInfoCommandCore,
} = require('./lib/bridge_route_parsers');
const {
    parseStructuredCommand: parseStructuredCommandCore,
    handlePromptPayload: handlePromptPayloadCore,
} = require('./lib/bridge_prompt_helpers');
const {
    resolveWorkspaceRootHint: resolveWorkspaceRootHintCore,
    normalizeIncomingCommandText: normalizeIncomingCommandTextCore,
} = require('./lib/bridge_input_normalization');
const {
    isExternalLinkRequest: isExternalLinkRequestCore,
    probeUrlStatus: probeUrlStatusCore,
    buildLinkDiagnosticsText: buildLinkDiagnosticsTextCore,
    buildLinkOnlyReply: buildLinkOnlyReplyCore,
    buildQuickStatusReply: buildQuickStatusReplyCore,
} = require('./lib/bridge_link_diagnostics');
const {
    readLastApprovalHints: readLastApprovalHintsCore,
    writeLastApprovalHints: writeLastApprovalHintsCore,
    buildApprovalOwnerKey: buildApprovalOwnerKeyCore,
    rememberLastApprovalHint: rememberLastApprovalHintCore,
    readLastApprovalHint: readLastApprovalHintCore,
    clearLastApprovalHint: clearLastApprovalHintCore,
    hasAnyApprovalHint: hasAnyApprovalHintCore,
    findPendingApprovalByRequestId: findPendingApprovalByRequestIdCore,
    resolveApprovalTokenFromHint: resolveApprovalTokenFromHintCore,
    findApprovalTokenCandidates: findApprovalTokenCandidatesCore,
    sortPendingApprovalsNewestFirst: sortPendingApprovalsNewestFirstCore,
    resolveApprovalTokenSelection: resolveApprovalTokenSelectionCore,
    mergeUniqueLower: mergeUniqueLowerCore,
    resolveApprovalFlagsForToken: resolveApprovalFlagsForTokenCore,
} = require('./lib/bridge_approval_hints');
const {
    normalizeOpsStateBucket: normalizeOpsStateBucketCore,
    buildOpsStatusRowsFromDocker: buildOpsStatusRowsFromDockerCore,
    buildOpsStatusRowsFromSnapshot: buildOpsStatusRowsFromSnapshotCore,
    buildOpsStatusReply: buildOpsStatusReplyCore,
} = require('./lib/bridge_ops_status');
const {
    splitOpsBatchPayloads: splitOpsBatchPayloadsCore,
    runOpsCommand: runOpsCommandCore,
} = require('./lib/bridge_ops_batch');
const {
    handleOpsTokenAction: handleOpsTokenActionCore,
    handleOpsPersonaAction: handleOpsPersonaActionCore,
} = require('./lib/bridge_ops_persona_token');
const {
    handleOpsApproveAction: handleOpsApproveActionCore,
    handleOpsDenyAction: handleOpsDenyActionCore,
} = require('./lib/bridge_ops_approval_actions');
const {
    handleOpsRestartAction: handleOpsRestartActionCore,
    handleOpsFileAction: handleOpsFileActionCore,
    handleOpsCapabilityAction: handleOpsCapabilityActionCore,
} = require('./lib/bridge_ops_plan_routes');
const {
    clampPreview: clampPreviewCore,
    executeProjectBootstrapScript: executeProjectBootstrapScriptCore,
    readDirectoryListPreview: readDirectoryListPreviewCore,
    buildProjectRoutePayload: buildProjectRoutePayloadCore,
} = require('./lib/bridge_project_route');
const { handleAutoRoutedCommand } = require('./lib/bridge_auto_routes');
const { routeByPrefix: routeByPrefixCore } = require('./lib/bridge_route_dispatch');
const {
    buildNoPrefixGuide: buildNoPrefixGuideCore,
    inferPathListReply: inferPathListReplyCore,
    isLegacyPersonaSwitchAttempt: isLegacyPersonaSwitchAttemptCore,
    buildDailyCasualNoPrefixReply: buildDailyCasualNoPrefixReplyCore,
    buildNoPrefixReply: buildNoPrefixReplyCore,
} = require('./lib/bridge_no_prefix_reply');
const {
    normalizeMonthToken: normalizeMonthTokenCore,
    extractMemoStatsPayload: extractMemoStatsPayloadCore,
    isLikelyMemoJournalBlock: isLikelyMemoJournalBlockCore,
    stripNaturalMemoLead: stripNaturalMemoLeadCore,
    inferMemoIntentPayload: inferMemoIntentPayloadCore,
    inferFinanceIntentPayload: inferFinanceIntentPayloadCore,
    inferTodoIntentPayload: inferTodoIntentPayloadCore,
    inferRoutineIntentPayload: inferRoutineIntentPayloadCore,
    inferWorkoutIntentPayload: inferWorkoutIntentPayloadCore,
    inferWorkIntentPayload: inferWorkIntentPayloadCore,
    inferInspectIntentPayload: inferInspectIntentPayloadCore,
    inferBrowserIntentPayload: inferBrowserIntentPayloadCore,
    inferScheduleIntentPayload: inferScheduleIntentPayloadCore,
    inferGogLookupIntentPayload: inferGogLookupIntentPayloadCore,
    inferPersonaIntentPayload: inferPersonaIntentPayloadCore,
    inferStatusIntentPayload: inferStatusIntentPayloadCore,
    inferLinkIntentPayload: inferLinkIntentPayloadCore,
    inferReportIntentPayload: inferReportIntentPayloadCore,
    extractPreferredProjectBasePath: extractPreferredProjectBasePathCore,
    inferProjectIntentPayload: inferProjectIntentPayloadCore,
    inferNaturalLanguageRoute: inferNaturalLanguageRouteCore,
} = require('./lib/bridge_nl_inference');
const {
    normalizeDailyPersonaConfig,
    applyPersonaToSystemReply,
    enforcePersonaReply,
    buildDailyPersonaStatusReply,
    isDailyPersonaRuntime,
} = require('./daily_persona');
const {
    DAILY_PERSONA_STATE_MODES,
    readDailyPersonaState,
    writeDailyPersonaState,
    resolvePresetProfileId,
    applyDailyPersonaStateToConfig,
} = require('./lib/daily_persona_state');
const {
    DEFAULT_COMMAND_ALLOWLIST,
    DEFAULT_HUB_DELEGATION,
    DEFAULT_NATURAL_LANGUAGE_ROUTING,
} = require('../packages/core-policy/src/bridge_defaults');
const MODEL_DUEL_LOG_PATH = path.join(__dirname, '../data/bridge/model_duel.jsonl');
loadRuntimeEnv({ allowLegacyFallback: true, warnOnLegacyFallback: true });

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
const ANKI_SYNC_WARNING_COOLDOWN_MS = Number(process.env.ANKI_SYNC_WARNING_COOLDOWN_MS || 10 * 60 * 1000);
let ankiSyncWarningMemo = { message: '', at: 0 };

function shouldAnnounceAnkiSyncWarning(message) {
    const text = String(message || '').trim();
    if (!text) return false;
    const now = Date.now();
    const sameMessage = ankiSyncWarningMemo.message === text;
    if (sameMessage && (now - ankiSyncWarningMemo.at) < ANKI_SYNC_WARNING_COOLDOWN_MS) {
        return false;
    }
    ankiSyncWarningMemo = { message: text, at: now };
    return true;
}

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
    let inferPersona = pickBool('inferPersona', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferPersona);
    let inferBrowser = pickBool('inferBrowser', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferBrowser);
    let inferSchedule = pickBool('inferSchedule', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferSchedule);
    let inferStatus = pickBool('inferStatus', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferStatus);
    let inferLink = pickBool('inferLink', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferLink);
    let inferWork = pickBool('inferWork', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferWork);
    let inferInspect = pickBool('inferInspect', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferInspect);
    let inferReport = pickBool('inferReport', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferReport);
    let inferProject = pickBool('inferProject', DEFAULT_NATURAL_LANGUAGE_ROUTING.inferProject);

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
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_PERSONA')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_PERSONA);
        if (parsed != null) inferPersona = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_BROWSER')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_BROWSER);
        if (parsed != null) inferBrowser = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_SCHEDULE')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_SCHEDULE);
        if (parsed != null) inferSchedule = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_STATUS')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_STATUS);
        if (parsed != null) inferStatus = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_LINK')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_LINK);
        if (parsed != null) inferLink = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_WORK')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_WORK);
        if (parsed != null) inferWork = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_INSPECT')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_INSPECT);
        if (parsed != null) inferInspect = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_REPORT')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_REPORT);
        if (parsed != null) inferReport = parsed;
    }
    if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_PROJECT')) {
        const parsed = parseBooleanEnv(env.BRIDGE_NL_INFER_PROJECT);
        if (parsed != null) inferProject = parsed;
    }

    return {
        enabled,
        hubOnly,
        inferMemo,
        inferFinance,
        inferTodo,
        inferRoutine,
        inferWorkout,
        inferPersona,
        inferBrowser,
        inferSchedule,
        inferStatus,
        inferLink,
        inferWork,
        inferInspect,
        inferReport,
        inferProject,
    };
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

const COMMAND_ALLOWLIST = normalizeAllowlistConfig(config.commandAllowlist, process.env);
const HUB_DELEGATION = normalizeHubDelegationConfig(config.hubDelegation);
const HUB_DELEGATION_ACTIVE = HUB_DELEGATION.enabled && isHubRuntime(process.env);
const BRIDGE_BLOCK_HINT = String(process.env.BRIDGE_BLOCK_HINT || '').trim();
const NATURAL_LANGUAGE_ROUTING = normalizeNaturalLanguageRoutingConfig(config.naturalLanguageRouting, process.env);
const DAILY_PERSONA_BASE_CONFIG = config.dailyPersona && typeof config.dailyPersona === 'object'
    ? config.dailyPersona
    : {};

function resolveDailyPersonaRuntimeContext() {
    const stateRead = readDailyPersonaState(DAILY_PERSONA_BASE_CONFIG, {
        env: process.env,
    });
    const applied = applyDailyPersonaStateToConfig(DAILY_PERSONA_BASE_CONFIG, stateRead.state || {});
    return {
        config: normalizeDailyPersonaConfig(applied.config || DAILY_PERSONA_BASE_CONFIG),
        state: applied.state || stateRead.state || null,
        meta: applied.meta || {},
        statePath: stateRead.path || '',
        stateRecovered: Boolean(stateRead.recovered),
    };
}

function applyDailyPersonaToOutput(base, metaInput = {}) {
    if (!base || typeof base !== 'object') return base;
    if (typeof base.telegramReply !== 'string' || !String(base.telegramReply).trim()) return base;

    const route = String(metaInput.route || base.route || '').trim().toLowerCase();
    const runtimeBotId = String(metaInput.botId || process.env.MOLTBOT_BOT_ID || '').trim().toLowerCase();
    const runtimeProfile = String(metaInput.profile || process.env.MOLTBOT_PROFILE || process.env.OPENCLAW_PROFILE || '').trim().toLowerCase();
    const personaRuntime = resolveDailyPersonaRuntimeContext();
    const personaConfig = personaRuntime.config;
    const rewritten = rewriteLocalLinks(base.telegramReply, getPublicBases());
    const personaApplied = isDailyPersonaRuntime(personaConfig, runtimeBotId, { profile: runtimeProfile })
        ? applyPersonaToSystemReply(rewritten, {
            route,
            botId: runtimeBotId,
            profile: runtimeProfile,
            config: personaConfig,
        })
        : rewritten;

    if (personaApplied === base.telegramReply) return base;
    return {
        ...base,
        telegramReply: personaApplied,
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
    if (/(실행|exec|shell|terminal|command)/.test(v)) return 'exec';
    if (/(메일|mail|email)/.test(v)) return 'mail';
    if (/(사진|photo|image|camera|cam)/.test(v)) return 'photo';
    if (/(일정|스케줄|schedule|calendar)/.test(v)) return 'schedule';
    if (/(브라우저|browser|웹자동화)/.test(v)) return 'browser';
    if (/(페르소나|persona|캐릭터|tone|스타일)/.test(v)) return 'persona';
    if (/(토큰조회|승인조회|토큰|token)/.test(v)) return 'token';
    if (/(승인|approve)/.test(v)) return 'approve';
    if (/(거부|deny)/.test(v)) return 'deny';
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
    exec: Object.freeze({
        run: { risk_tier: 'MEDIUM', requires_approval: false, mutating: false },
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
    if (capability === 'exec') {
        return 'run';
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
        command: String(fields.명령 || '').trim(),
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

function resolvePathFromEnv(envName, fallback) {
    const raw = String(process.env[envName] || '').trim();
    if (!raw) return fallback;
    return path.isAbsolute(raw) ? raw : path.resolve(raw);
}

const OPS_QUEUE_PATH = resolvePathFromEnv(
    'OPS_QUEUE_PATH',
    path.join(__dirname, '..', 'data', 'runtime', 'ops_requests.jsonl'),
);
const OPS_SNAPSHOT_PATH = resolvePathFromEnv(
    'OPS_SNAPSHOT_PATH',
    path.join(__dirname, '..', 'data', 'runtime', 'ops_snapshot.json'),
);
const PROJECT_BOOTSTRAP_STATE_PATH = resolvePathFromEnv(
    'OPS_PROJECT_BOOTSTRAP_STATE_PATH',
    path.join(__dirname, '..', 'data', 'runtime', 'project_bootstrap_last.json'),
);
const PENDING_APPROVALS_STATE_PATH = resolvePathFromEnv(
    'OPS_PENDING_APPROVALS_STATE_PATH',
    path.join(__dirname, '..', 'data', 'state', 'pending_approvals.json'),
);
const LAST_APPROVAL_HINTS_PATH = resolvePathFromEnv(
    'OPS_LAST_APPROVAL_HINTS_PATH',
    path.join(__dirname, '..', 'data', 'runtime', 'ops_last_approval_hints.json'),
);
const BOT_PERSONA_MAP_PATH = resolvePathFromEnv(
    'OPS_BOT_PERSONA_MAP_PATH',
    path.join(__dirname, '..', 'data', 'policy', 'bot_persona_map.json'),
);

const OPS_PERSONA_TARGET_TO_BOT = Object.freeze({
    dev: 'bot-dev',
    anki: 'bot-anki',
    research: 'bot-research',
    daily: 'bot-daily',
    main: 'bot-daily',
    dev_bak: 'bot-dev-bak',
    anki_bak: 'bot-anki-bak',
    research_bak: 'bot-research-bak',
    daily_bak: 'bot-daily-bak',
    'bot-main': 'bot-daily',
    'moltbot-main': 'bot-daily',
    'moltbot-dev': 'bot-dev',
    'moltbot-anki': 'bot-anki',
    'moltbot-research': 'bot-research',
    'moltbot-daily': 'bot-daily',
    'moltbot-dev-bak': 'bot-dev-bak',
    'moltbot-anki-bak': 'bot-anki-bak',
    'moltbot-research-bak': 'bot-research-bak',
    'moltbot-daily-bak': 'bot-daily-bak',
    'bot-dev': 'bot-dev',
    'bot-anki': 'bot-anki',
    'bot-research': 'bot-research',
    'bot-daily': 'bot-daily',
    'bot-dev-bak': 'bot-dev-bak',
    'bot-anki-bak': 'bot-anki-bak',
    'bot-research-bak': 'bot-research-bak',
    'bot-daily-bak': 'bot-daily-bak',
});

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

function writeJsonFileSafe(filePath, payload) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        return true;
    } catch (_) {
        return false;
    }
}

function readJsonFileSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function saveLastProjectBootstrap(fields = {}, bootstrap = null) {
    if (!fields || typeof fields !== 'object') return false;
    if (!bootstrap || typeof bootstrap !== 'object') return false;
    const snapshot = {
        savedAt: new Date().toISOString(),
        fields: {
            프로젝트명: String(fields.프로젝트명 || '').trim(),
            목표: String(fields.목표 || '').trim(),
            스택: String(fields.스택 || '').trim(),
            경로: String(fields.경로 || '').trim(),
            완료기준: String(fields.완료기준 || '').trim(),
            초기화: String(fields.초기화 || bootstrap.initMode || 'plan').trim(),
        },
        bootstrap: {
            projectName: String(bootstrap.projectName || '').trim(),
            targetPath: String(bootstrap.targetPath || '').trim(),
            template: String(bootstrap.template || '').trim(),
            templateLabel: String(bootstrap.templateLabel || '').trim(),
            initMode: String(bootstrap.initMode || '').trim(),
            pathAllowed: Boolean(bootstrap.pathPolicy && bootstrap.pathPolicy.allowed),
        },
    };
    return writeJsonFileSafe(PROJECT_BOOTSTRAP_STATE_PATH, snapshot);
}

function loadLastProjectBootstrap(maxAgeHours = 48) {
    const parsed = readJsonFileSafe(PROJECT_BOOTSTRAP_STATE_PATH);
    if (!parsed || typeof parsed !== 'object') return null;
    const savedAt = Date.parse(String(parsed.savedAt || ''));
    if (!Number.isFinite(savedAt)) return null;
    const ageMs = Date.now() - savedAt;
    if (ageMs < 0 || ageMs > maxAgeHours * 60 * 60 * 1000) return null;
    const fields = parsed.fields && typeof parsed.fields === 'object' ? parsed.fields : {};
    if (!String(fields.프로젝트명 || '').trim()) return null;
    return parsed;
}

function resolveDefaultProjectBasePath() {
    return path.resolve('/Users/moltbot/Projects');
}

function toProjectTemplatePayload(fields = {}, { forceExecute = false } = {}) {
    const projectName = sanitizeProjectName(fields.프로젝트명 || fields.projectName || 'rust-tap-game');
    const goal = String(fields.목표 || fields.goal || '모바일에서 실행 가능한 Rust 웹게임 템플릿 생성').trim();
    const stack = String(fields.스택 || fields.stack || 'rust wasm web').trim();
    const basePathRaw = String(fields.경로 || fields.path || resolveDefaultProjectBasePath()).trim();
    const done = String(fields.완료기준 || fields.done || '프로젝트 폴더와 기본 Rust/WASM 파일 생성').trim();
    const initRaw = String(fields.초기화 || fields.initMode || 'execute').trim();
    const initMode = forceExecute ? 'execute' : (initRaw || 'execute');
    return [
        `프로젝트명: ${projectName}`,
        `목표: ${goal}`,
        `스택: ${stack}`,
        `경로: ${basePathRaw}`,
        `완료기준: ${done}`,
        `초기화: ${initMode}`,
    ].join('; ');
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

function isUnifiedApprovalEnabled() {
    const envRaw = String(process.env.MOLTBOT_DISABLE_APPROVAL_TOKENS || '').trim().toLowerCase();
    if (envRaw === '1' || envRaw === 'true' || envRaw === 'on') return false;
    if (envRaw === '0' || envRaw === 'false' || envRaw === 'off') return true;
    return !(
        config
        && typeof config === 'object'
        && config.opsUnifiedApprovals
        && typeof config.opsUnifiedApprovals === 'object'
        && config.opsUnifiedApprovals.enabled === false
    );
}

function normalizeOpsOptionFlags(value) {
    return opsFileControl.normalizeApprovalFlags(value);
}

function normalizeOpsFileIntent(value) {
    return opsFileControl.normalizeIntentAction(value);
}

function isFileControlAction(action) {
    return action === 'file';
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
    const conversationalApprove = /^(?:(?:응|네|예|그래|좋아|오케이|ㅇㅋ|ok|okay)\s*)?(?:승인(?:해|해줘|해주세요|해요|합니다)?|진행(?:해|해줘|해주세요|해요|합니다)?|go\s*ahead)\s*[.!~…]*$/i;
    const explicitApprove = /^\/?approve\b/i.test(raw);
    const conversational = conversationalApprove.test(raw);
    const tokenMatch = raw.match(/\bapv_[a-f0-9]{16}\b/i);
    const token = tokenMatch ? String(tokenMatch[0] || '').trim() : '';
    if (!explicitApprove && !conversational) return null;

    const tail = explicitApprove
        ? raw.replace(/^\/?approve\b/i, '').trim()
        : raw;
    const flagSource = token
        ? String(tail.replace(token, ' ') || '').trim()
        : tail;
    const flags = explicitApprove
        ? normalizeOpsOptionFlags(flagSource)
        : normalizeOpsOptionFlags((String(flagSource || '').match(/--[a-z0-9_-]+/gi) || []).join(' '));
    const flagText = flags.length > 0
        ? `; 옵션: ${flags.map((flag) => `--${flag}`).join(' ')}`
        : '';
    return {
        token,
        flags,
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

function normalizeOpsPayloadText(text) {
    const approve = parseApproveShorthand(text);
    if (approve) {
        return {
            payloadText: approve.normalizedPayload,
            approveShorthand: approve,
            denyShorthand: null,
        };
    }
    const deny = parseDenyShorthand(text);
    if (deny) {
        return {
            payloadText: deny.normalizedPayload,
            approveShorthand: null,
            denyShorthand: deny,
        };
    }
    return {
        payloadText: String(text || '').trim(),
        approveShorthand: null,
        denyShorthand: null,
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
    const payload = (command.payload && typeof command.payload === 'object')
        ? { ...command.payload }
        : {};
    const originBotId = String(command.origin_bot_id || process.env.MOLTBOT_BOT_ID || '').trim();
    if (originBotId && !String(payload.origin_bot_id || '').trim()) {
        payload.origin_bot_id = originBotId;
    }
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
        payload,
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

function isInlineApprovalExecutionEnabled() {
    const raw = String(process.env.BRIDGE_INLINE_APPROVAL_EXECUTE || 'true').trim().toLowerCase();
    return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

function triggerInlineOpsWorker() {
    if (!isInlineApprovalExecutionEnabled()) {
        return { enabled: false, triggered: false, ok: false, error: '' };
    }
    const run = spawnSync('node', ['scripts/ops_host_worker.js'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 1024 * 1024,
    });
    const ok = !run.error && run.status === 0;
    return {
        enabled: true,
        triggered: true,
        ok,
        error: ok ? '' : String(run.error ? run.error.message || run.error : (run.stderr || run.stdout || 'ops_host_worker failed')).trim(),
    };
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

function readPendingApprovalsState() {
    try {
        if (!fs.existsSync(PENDING_APPROVALS_STATE_PATH)) return [];
        const raw = fs.readFileSync(PENDING_APPROVALS_STATE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed && parsed.pending) ? parsed.pending : [];
    } catch (_) {
        return [];
    }
}

function readBotPersonaMap() {
    try {
        if (!fs.existsSync(BOT_PERSONA_MAP_PATH)) return {};
        const raw = fs.readFileSync(BOT_PERSONA_MAP_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) {
        return {};
    }
}

function writeBotPersonaMap(map = {}) {
    try {
        fs.mkdirSync(path.dirname(BOT_PERSONA_MAP_PATH), { recursive: true });
        fs.writeFileSync(BOT_PERSONA_MAP_PATH, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
        return true;
    } catch (_) {
        return false;
    }
}

function normalizePersonaTarget(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (OPS_PERSONA_TARGET_TO_BOT[raw]) return OPS_PERSONA_TARGET_TO_BOT[raw];
    return '';
}

function readLastApprovalHints() {
    return readLastApprovalHintsCore({
        fsModule: fs,
        hintsPath: LAST_APPROVAL_HINTS_PATH,
    });
}

function writeLastApprovalHints(hints = {}) {
    return writeLastApprovalHintsCore(hints, {
        fsModule: fs,
        pathModule: path,
        hintsPath: LAST_APPROVAL_HINTS_PATH,
    });
}

function buildApprovalOwnerKey(requestedBy = '', telegramContext = null) {
    return buildApprovalOwnerKeyCore(requestedBy, telegramContext);
}

function rememberLastApprovalHint({
    requestedBy = '',
    telegramContext = null,
    requestId = '',
    capability = '',
    action = '',
} = {}) {
    return rememberLastApprovalHintCore({
        requestedBy,
        telegramContext,
        requestId,
        capability,
        action,
    }, {
        readLastApprovalHints,
        writeLastApprovalHints,
    });
}

function readLastApprovalHint(requestedBy = '', telegramContext = null) {
    return readLastApprovalHintCore(requestedBy, telegramContext, {
        readLastApprovalHints,
    });
}

function clearLastApprovalHint(requestedBy = '', telegramContext = null) {
    return clearLastApprovalHintCore(requestedBy, telegramContext, {
        readLastApprovalHints,
        writeLastApprovalHints,
    });
}

function hasAnyApprovalHint() {
    return hasAnyApprovalHintCore({
        readLastApprovalHints,
    });
}

function findPendingApprovalByRequestId(requestId = '', rows = []) {
    return findPendingApprovalByRequestIdCore(requestId, rows);
}

function resolveApprovalTokenFromHint(requestedBy = '', telegramContext = null) {
    return resolveApprovalTokenFromHintCore(requestedBy, telegramContext, {
        readLastApprovalHint,
        readPendingApprovalsState,
    });
}

function findApprovalTokenCandidates(query = '') {
    return findApprovalTokenCandidatesCore(query, {
        readPendingApprovalsState,
    });
}

function sortPendingApprovalsNewestFirst(rows = []) {
    return sortPendingApprovalsNewestFirstCore(rows);
}

function resolveApprovalTokenSelection({
    query = '',
    requestedBy = '',
    telegramContext = null,
} = {}) {
    return resolveApprovalTokenSelectionCore({
        query,
        requestedBy,
        telegramContext,
    }, {
        readPendingApprovalsState,
        findApprovalTokenCandidates,
        sortPendingApprovalsNewestFirst,
    });
}

function mergeUniqueLower(items = []) {
    return mergeUniqueLowerCore(items);
}

function resolveApprovalFlagsForToken(token = '', providedFlags = []) {
    return resolveApprovalFlagsForTokenCore(token, providedFlags, {
        readPendingToken: (key) => opsApprovalStore.readPendingToken(key),
    });
}

function normalizeOpsStateBucket(state, statusText) {
    return normalizeOpsStateBucketCore(state, statusText);
}

function buildOpsStatusRowsFromDocker(rawLines, targets) {
    return buildOpsStatusRowsFromDockerCore(rawLines, targets);
}

function buildOpsStatusRowsFromSnapshot(snapshot, targets) {
    return buildOpsStatusRowsFromSnapshotCore(snapshot, targets);
}

function buildOpsStatusReply(rows, options = {}) {
    return buildOpsStatusReplyCore(rows, options);
}

function splitOpsBatchPayloads(payloadText) {
    return splitOpsBatchPayloadsCore(payloadText);
}

function runOpsCommand(payloadText, options = {}) {
    return runOpsCommandCore(payloadText, options, {
        runOpsCommandSingle,
    });
}

function handleOpsTokenAction(parsed) {
    return handleOpsTokenActionCore(parsed, {
        isUnifiedApprovalEnabled,
        findApprovalTokenCandidates,
    });
}

function handleOpsPersonaAction(parsed, requestedBy) {
    return handleOpsPersonaActionCore(parsed, requestedBy, {
        normalizePersonaTarget,
        readBotPersonaMap,
        writeBotPersonaMap,
        readDailyPersonaState: () => readDailyPersonaState(DAILY_PERSONA_BASE_CONFIG, {
            env: process.env,
        }),
        writeDailyPersonaState: (stateInput) => writeDailyPersonaState(DAILY_PERSONA_BASE_CONFIG, stateInput, {
            env: process.env,
        }),
        applyDailyPersonaStateToConfig: (stateInput) => applyDailyPersonaStateToConfig(DAILY_PERSONA_BASE_CONFIG, stateInput),
        resolvePresetProfileId: (value) => resolvePresetProfileId(DAILY_PERSONA_BASE_CONFIG, value),
        dailyPersonaTargetBotIds: ['bot-daily'],
        dailyPersonaStateModes: DAILY_PERSONA_STATE_MODES,
        dailyPersonaDefaultTitle: String((DAILY_PERSONA_BASE_CONFIG && DAILY_PERSONA_BASE_CONFIG.defaultTitle) || '인호님').trim() || '인호님',
    });
}

function handleOpsApproveAction(parsed, normalized, requestedBy, telegramContext, policy) {
    return handleOpsApproveActionCore({
        parsed,
        normalized,
        requestedBy,
        telegramContext,
        policy,
    }, {
        isUnifiedApprovalEnabled,
        normalizeOpsOptionFlags,
        triggerInlineOpsWorker,
        resolveApprovalTokenFromHint,
        resolveApprovalTokenSelection,
        resolveApprovalFlagsForToken,
        enqueueFileControlCommand,
        normalizeOpsFileIntent,
        clearLastApprovalHint,
        isApprovalGrantEnabled,
    });
}

function handleOpsDenyAction(parsed, normalized, requestedBy, telegramContext) {
    return handleOpsDenyActionCore({
        parsed,
        normalized,
        requestedBy,
        telegramContext,
    }, {
        isUnifiedApprovalEnabled,
        triggerInlineOpsWorker,
        resolveApprovalTokenFromHint,
        resolveApprovalTokenSelection,
        enqueueFileControlCommand,
        clearLastApprovalHint,
    });
}

function handleOpsRestartAction(action, targetKey, parsed) {
    return handleOpsRestartActionCore({
        action,
        targetKey,
        parsed,
    }, {
        allowedTargets: OPS_ALLOWED_TARGETS,
        queueOpsRequest,
    });
}

function handleOpsFileAction(action, parsed, requestedBy, telegramContext) {
    return handleOpsFileActionCore({
        action,
        parsed,
        requestedBy,
        telegramContext,
    }, {
        isUnifiedApprovalEnabled,
        normalizeOpsFileIntent,
        normalizeOpsOptionFlags,
        enqueueFileControlCommand,
    });
}

function handleOpsCapabilityAction(action, parsed, requestedBy, telegramContext, policy) {
    return handleOpsCapabilityActionCore({
        action,
        parsed,
        requestedBy,
        telegramContext,
        policy,
    }, {
        isUnifiedApprovalEnabled,
        normalizeOpsCapabilityAction,
        capabilityPolicyMap: OPS_CAPABILITY_POLICY,
        buildCapabilityPayload,
        normalizeOpsOptionFlags,
        enqueueCapabilityCommand,
        rememberLastApprovalHint,
        isApprovalGrantEnabled,
    });
}

function runOpsCommandSingle(payloadText, options = {}) {
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
            telegramReply: '운영 템플릿 액션은 `재시작`, `상태`, `파일`, `실행`, `메일`, `사진`, `일정`, `브라우저`, `페르소나`, `토큰`, `승인`, `거부`만 지원합니다.',
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

    if (action === 'token') {
        return handleOpsTokenAction(parsed);
    }

    if (action === 'persona') {
        return handleOpsPersonaAction(parsed, requestedBy);
    }

    if (action === 'restart') {
        return handleOpsRestartAction(action, targetKey, parsed);
    }

    if (action === 'file') {
        return handleOpsFileAction(action, parsed, requestedBy, telegramContext);
    }

    if (action === 'mail' || action === 'photo' || action === 'schedule' || action === 'browser' || action === 'exec') {
        return handleOpsCapabilityAction(action, parsed, requestedBy, telegramContext, policy);
    }

    if (action === 'approve') {
        return handleOpsApproveAction(parsed, normalized, requestedBy, telegramContext, policy);
    }

    if (action === 'deny') {
        return handleOpsDenyAction(parsed, normalized, requestedBy, telegramContext);
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
    return parseReportModeCommandCore(text);
}

function parsePersonaInfoCommand(text) {
    const normalized = normalizeIncomingCommandText(text);
    if (/^\s*(?:운영|ops)\s*[:：]/i.test(normalized)) {
        return { matched: false };
    }
    return parsePersonaInfoCommandCore(text, { normalizeIncomingCommandText });
}

function buildPersonaStatusReply(context = {}) {
    const runtimeBotId = String(context.botId || process.env.MOLTBOT_BOT_ID || '').trim().toLowerCase();
    const runtimeProfile = String(context.profile || process.env.MOLTBOT_PROFILE || process.env.OPENCLAW_PROFILE || '').trim().toLowerCase();
    const botPersonaMap = readBotPersonaMap();
    const personaRuntime = resolveDailyPersonaRuntimeContext();
    return buildDailyPersonaStatusReply({
        config: personaRuntime.config,
        botId: runtimeBotId,
        profile: runtimeProfile,
        route: String(context.route || '').trim().toLowerCase(),
        botPersonaMap,
        personaState: personaRuntime.state,
        personaStateMeta: personaRuntime.meta,
        personaStatePath: personaRuntime.statePath,
        personaStateRecovered: personaRuntime.stateRecovered,
    });
}

function finalizeTelegramBoundary(base, metaInput = {}) {
    const personaRuntime = resolveDailyPersonaRuntimeContext();
    return finalizeTelegramBoundaryCore(base, metaInput, {
        applyDailyPersonaToOutput,
        appendExternalLinks,
        parseTransportEnvelopeContext,
        normalizeRequester: opsFileControl.normalizeRequester,
        finalizeTelegramReply: (text, context) => telegramFinalizer.finalizeTelegramReply(text, context),
        sanitizeForUser: (text) => {
            if (telegramFinalizer && typeof telegramFinalizer.sanitizeForUser === 'function') {
                return telegramFinalizer.sanitizeForUser(text);
            }
            const raw = String(text || '').trim();
            return raw || '실패\n원인: 내부 실행 오류가 발생했어.\n다음 조치: 잠시 후 다시 시도해줘.';
        },
        enforcePersonaReply,
        dailyPersonaConfig: personaRuntime.config,
        env: process.env,
    });
}

function isExternalLinkRequest(text) {
    return isExternalLinkRequestCore(text);
}

function buildLinkOnlyReply(text) {
    return buildLinkOnlyReplyCore(text, {
        getPublicBases,
        buildLinkDiagnosticsText,
    });
}

function probeUrlStatus(url) {
    return probeUrlStatusCore(url, { spawnSync });
}

function buildLinkDiagnosticsText() {
    return buildLinkDiagnosticsTextCore({
        bridgeDir: __dirname,
        pathModule: path,
        spawnSync,
        getPublicBases,
        probeUrlStatus,
    });
}

function buildQuickStatusReply(payload) {
    return buildQuickStatusReplyCore(payload, {
        runOpsCommand,
        buildLinkDiagnosticsText,
        appendExternalLinks,
    });
}

function buildNoPrefixGuide() {
    return buildNoPrefixGuideCore();
}

function inferPathListReply(inputText) {
    return inferPathListReplyCore(inputText, {
        normalizeIncomingCommandText,
        extractPreferredProjectBasePath,
        readDirectoryListPreview,
    });
}

function isLegacyPersonaSwitchAttempt(text) {
    return isLegacyPersonaSwitchAttemptCore(text);
}

function buildDailyCasualNoPrefixReply(inputText) {
    return buildDailyCasualNoPrefixReplyCore(inputText, {
        normalizeIncomingCommandText,
        buildPersonaStatusReply,
        inferPathListReply,
    });
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

function clampPreview(value, maxLen = 600) {
    return clampPreviewCore(value, maxLen);
}

function executeProjectBootstrapScript(bootstrap) {
    return executeProjectBootstrapScriptCore(bootstrap, {
        redact: (text) => opsLogger.redact(String(text || '')),
        spawnSync,
        timeoutMs: Number(process.env.PROJECT_BOOTSTRAP_TIMEOUT_MS || 180000),
    });
}

function readDirectoryListPreview(targetPath, maxLen = 1600) {
    return readDirectoryListPreviewCore(targetPath, maxLen, {
        redact: (text) => opsLogger.redact(String(text || '')),
        spawnSync,
    });
}

function buildProjectRoutePayload(parsed) {
    return buildProjectRoutePayloadCore(parsed, {
        buildProjectBootstrapPlan,
        saveLastProjectBootstrap,
        appendExternalLinks,
        executeProjectBootstrapScript,
        readDirectoryListPreview,
    });
}

function parseStructuredCommand(route, payloadText) {
    return parseStructuredCommandCore(route, payloadText);
}

function resolveWorkspaceRootHint() {
    return resolveWorkspaceRootHintCore({
        env: process.env,
        fsModule: fs,
        pathModule: path,
        fallbackWorkspaceRoot: path.resolve(__dirname, '..'),
    });
}

function normalizeIncomingCommandText(text) {
    return normalizeIncomingCommandTextCore(text, { resolveWorkspaceRootHint });
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
    return normalizeMonthTokenCore(rawValue);
}

function extractMemoStatsPayload(text) {
    return extractMemoStatsPayloadCore(text, { normalizeMonthToken });
}

function isLikelyMemoJournalBlock(text) {
    return isLikelyMemoJournalBlockCore(text);
}

function stripNaturalMemoLead(text) {
    return stripNaturalMemoLeadCore(text);
}

function inferMemoIntentPayload(text) {
    return inferMemoIntentPayloadCore(text, {
        extractMemoStatsPayload,
        isLikelyMemoJournalBlock,
        stripNaturalMemoLead,
    });
}

function inferFinanceIntentPayload(text) {
    return inferFinanceIntentPayloadCore(text);
}

function inferTodoIntentPayload(text) {
    return inferTodoIntentPayloadCore(text);
}

function inferRoutineIntentPayload(text) {
    return inferRoutineIntentPayloadCore(text);
}

function inferWorkoutIntentPayload(text) {
    return inferWorkoutIntentPayloadCore(text);
}

function inferPersonaIntentPayload(text) {
    return inferPersonaIntentPayloadCore(text, {
        defaultTarget: 'daily',
    });
}

function inferWorkIntentPayload(text) {
    return inferWorkIntentPayloadCore(text);
}

function inferInspectIntentPayload(text) {
    return inferInspectIntentPayloadCore(text);
}

function inferBrowserIntentPayload(text) {
    return inferBrowserIntentPayloadCore(text);
}

function inferScheduleIntentPayload(text) {
    return inferScheduleIntentPayloadCore(text);
}

function inferGogLookupIntentPayload(text) {
    return inferGogLookupIntentPayloadCore(text);
}

function inferStatusIntentPayload(text) {
    return inferStatusIntentPayloadCore(text);
}

function inferLinkIntentPayload(text) {
    return inferLinkIntentPayloadCore(text, { isExternalLinkRequest });
}

function inferReportIntentPayload(text) {
    return inferReportIntentPayloadCore(text);
}

function extractPreferredProjectBasePath(text) {
    return extractPreferredProjectBasePathCore(text, { resolveWorkspaceRootHint, pathModule: path });
}

function inferProjectIntentPayload(text) {
    return inferProjectIntentPayloadCore(text, {
        extractPreferredProjectBasePath,
        loadLastProjectBootstrap,
        resolveDefaultProjectBasePath,
        toProjectTemplatePayload,
    });
}

function inferNaturalLanguageRoute(text, options = {}) {
    return inferNaturalLanguageRouteCore(text, options, {
        NATURAL_LANGUAGE_ROUTING,
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
        inferPersonaIntentPayload,
        inferStatusIntentPayload,
        inferLinkIntentPayload,
        inferProjectIntentPayload,
        inferReportIntentPayload,
    });
}

function routeByPrefix(text) {
    return routeByPrefixCore(text, {
        commandPrefixes: config.commandPrefixes || {},
        normalizeIncomingCommandText,
        parseApproveShorthand,
        parseDenyShorthand,
        parseNaturalApprovalShorthand,
        readPendingApprovalsState,
        hasAnyApprovalHint,
        inferNaturalLanguageRoute,
        env: process.env,
    });
}

function buildGogNoPrefixGuide(inputText) {
    const raw = normalizeIncomingCommandText(inputText) || String(inputText || '').trim();
    if (!raw) return '';

    const hasGoogleSignal = /(구글|google|\bgog\b)/i.test(raw);
    if (!hasGoogleSignal) return '';

    const looksRawGogCommand = /^\s*gog\b/i.test(raw);
    const hasSkillKeyword = /(스킬|skill)/i.test(raw);
    const hasGoogleDomain = /(캘린더|calendar|메일|gmail|email|지메일|드라이브|drive)/i.test(raw);
    if (!looksRawGogCommand && !hasSkillKeyword && !hasGoogleDomain) return '';

    return [
        'GOG/구글 요청은 유형에 따라 처리됩니다.',
        '- 조회형은 자동 라우팅됩니다: `구글 캘린더 확인`, `구글 메일 최근 내역 보여줘`, `구글 드라이브 목록 확인`',
        '- 실행형은 보안상 자동 실행되지 않습니다: `운영: 액션: 실행; 작업: gog ...` 형식을 사용해 주세요.',
    ].join('\n');
}

function handlePromptPayload(payloadText) {
    return handlePromptPayloadCore(payloadText, { promptBuilder });
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
    };
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
            const nextSyncWarning = `sync_failed: ${e.message}`;
            if (shouldAnnounceAnkiSyncWarning(nextSyncWarning)) {
                syncWarning = nextSyncWarning;
                warningSet.add(syncWarning);
            } else {
                warningSet.add('sync_warning_suppressed_in_cooldown');
            }
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
                const personaInfoCommand = parsePersonaInfoCommand(normalizedAutoMessage);
                if (personaInfoCommand.matched) {
                    console.log(JSON.stringify(withApiMeta({
                        route: 'none',
                        success: true,
                        telegramContext: autoTelegramContext,
                        requestedBy: autoRequestedBy,
                        telegramReply: buildPersonaStatusReply({
                            telegramContext: autoTelegramContext,
                            requestedBy: autoRequestedBy,
                        }),
                    }, {
                        route: 'none',
                        routeHint: 'persona-status',
                        commandText: fullText,
                        telegramContext: autoTelegramContext,
                        requestedBy: autoRequestedBy,
                    })));
                    break;
                }
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
                const autoRouteResult = await handleAutoRoutedCommand({
                    routed,
                    fullText,
                    toeicDeck,
                    toeicTags,
                    env: process.env,
                }, {
                    withApiMeta,
                    appendExternalLinks,
                    pickPreferredModelMeta,
                    normalizeNewsCommandPayload,
                    normalizeReportNewsPayload,
                    isResearchRuntime,
                    parseStructuredCommand,
                    buildCodexDegradedMeta,
                    buildDuelModeMeta,
                    buildProjectRoutePayload,
                    handlePromptPayload,
                    buildLinkOnlyReply,
                    buildQuickStatusReply,
                    parseTransportEnvelopeContext,
                    runOpsCommand,
                    inferPathListReply,
                    buildGogNoPrefixGuide,
                    buildNoPrefixReply: (text) => buildNoPrefixReplyCore(text, {
                        isHubRuntime: isHubRuntime(process.env),
                    }, {
                        buildDailyCasualNoPrefixReply,
                        buildNoPrefixGuide,
                    }),
                    handlePersonalRoute,
                    processWordTokens,
                    handleMemoCommand: async (text) => {
                        const memoJournal = require('./memo_journal');
                        return memoJournal.handleMemoCommand(text);
                    },
                    handleNewsCommand: async (text) => {
                        const newsDigest = require('./news_digest');
                        return newsDigest.handleNewsCommand(text);
                    },
                    publishFromReports: async () => {
                        const blog = require('./blog_publish_from_reports');
                        return blog.publishFromReports();
                    },
                    buildWeeklyReport: async () => {
                        const weekly = require('./weekly_report');
                        return weekly.buildWeeklyReport();
                    },
                    buildDailySummary: async () => {
                        const daily = require('./daily_summary');
                        return daily.buildDailySummary();
                    },
                });
                console.log(JSON.stringify(autoRouteResult));
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
    inferWorkIntentPayload,
    inferInspectIntentPayload,
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
