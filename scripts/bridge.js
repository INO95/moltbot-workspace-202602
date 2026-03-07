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
const { createApprovalHintBindings } = require('./lib/bridge_approval_hint_bindings');
const {
    OPS_ALLOWED_TARGETS: OPS_ALLOWED_TARGETS_CORE,
    OPS_CAPABILITY_POLICY: OPS_CAPABILITY_POLICY_CORE,
    normalizeOpsAction: normalizeOpsActionCore,
    normalizeOpsCapabilityAction: normalizeOpsCapabilityActionCore,
    buildCapabilityPayload: buildCapabilityPayloadCore,
    normalizeOpsTarget: normalizeOpsTargetCore,
} = require('./lib/bridge_ops_primitives');
const {
    parseTransportEnvelopeContext: parseTransportEnvelopeContextCore,
    resolveOpsFilePolicy: resolveOpsFilePolicyCore,
    isUnifiedApprovalEnabled: isUnifiedApprovalEnabledCore,
    normalizeOpsOptionFlags: normalizeOpsOptionFlagsCore,
    normalizeOpsFileIntent: normalizeOpsFileIntentCore,
    isFileControlAction: isFileControlActionCore,
    enforceFileControlTelegramGuard: enforceFileControlTelegramGuardCore,
    isApprovalGrantEnabled: isApprovalGrantEnabledCore,
    parseApproveShorthand: parseApproveShorthandCore,
    parseDenyShorthand: parseDenyShorthandCore,
    parseNaturalApprovalShorthand: parseNaturalApprovalShorthandCore,
    normalizeOpsPayloadText: normalizeOpsPayloadTextCore,
} = require('./lib/bridge_ops_context');
const {
    enqueueFileControlCommand: enqueueFileControlCommandCore,
    enqueueCapabilityCommand: enqueueCapabilityCommandCore,
    queueOpsRequest: queueOpsRequestCore,
} = require('./lib/bridge_ops_queue');
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
} = require('./lib/bridge_ops_token');
const {
    handleOpsApproveAction: handleOpsApproveActionCore,
    handleOpsDenyAction: handleOpsDenyActionCore,
} = require('./lib/bridge_ops_approval_actions');
const {
    handleOpsRestartAction: handleOpsRestartActionCore,
    handleOpsFileAction: handleOpsFileActionCore,
    handleOpsCapabilityAction: handleOpsCapabilityActionCore,
} = require('./lib/bridge_ops_plan_routes');
const { handleOpsStatusAction: handleOpsStatusActionCore } = require('./lib/bridge_ops_status_action');
const {
    prepareOpsCommandContext: prepareOpsCommandContextCore,
    dispatchOpsAction: dispatchOpsActionCore,
} = require('./lib/bridge_ops_dispatch');
const {
    normalizeHttpsBase: normalizeHttpsBaseCore,
    getTunnelPublicBaseUrl: getTunnelPublicBaseUrlCore,
    getPublicBases: getPublicBasesCore,
    buildExternalLinksText: buildExternalLinksTextCore,
    rewriteLocalLinks: rewriteLocalLinksCore,
    appendExternalLinks: appendExternalLinksCore,
} = require('./lib/bridge_external_links');
const {
    clampPreview: clampPreviewCore,
    executeProjectBootstrapScript: executeProjectBootstrapScriptCore,
    readDirectoryListPreview: readDirectoryListPreviewCore,
    buildProjectRoutePayload: buildProjectRoutePayloadCore,
} = require('./lib/bridge_project_route');
const {
    writeJsonFileSafe: writeJsonFileSafeCore,
    readJsonFileSafe: readJsonFileSafeCore,
    saveLastProjectBootstrap: saveLastProjectBootstrapCore,
    loadLastProjectBootstrap: loadLastProjectBootstrapCore,
    resolveDefaultProjectBasePath: resolveDefaultProjectBasePathCore,
    toProjectTemplatePayload: toProjectTemplatePayloadCore,
} = require('./lib/bridge_project_state');
const {
    resolveHubDelegationTarget: resolveHubDelegationTargetCore,
    enqueueHubDelegationCommand: enqueueHubDelegationCommandCore,
} = require('./lib/bridge_hub_delegation');
const {
    readOpsSnapshot: readOpsSnapshotCore,
    readPendingApprovalsState: readPendingApprovalsStateCore,
} = require('./lib/bridge_ops_state_store');
const {
    isInlineApprovalExecutionEnabled: isInlineApprovalExecutionEnabledCore,
    triggerInlineOpsWorker: triggerInlineOpsWorkerCore,
} = require('./lib/bridge_ops_worker_trigger');
const { handleAutoRoutedCommand } = require('./lib/bridge_auto_routes');
const { handleDirectBridgeCommand } = require('./lib/bridge_direct_commands');
const { routeByPrefix: routeByPrefixCore } = require('./lib/bridge_route_dispatch');
const {
    buildNoPrefixGuide: buildNoPrefixGuideCore,
    inferPathListReply: inferPathListReplyCore,
    buildDailyCasualNoPrefixReply: buildDailyCasualNoPrefixReplyCore,
    buildNoPrefixReply: buildNoPrefixReplyCore,
} = require('./lib/bridge_no_prefix_reply');
const {
    handleCodexBotAutoCommand,
} = require('./lib/bridge_codex_auto');
const { handleAutoBridgeCommand } = require('./lib/bridge_auto_command');
const { dispatchBridgeCommandOnce } = require('./lib/bridge_command_dispatch');
const {
    normalizeMonthToken: normalizeMonthTokenCore,
    extractMemoStatsPayload: extractMemoStatsPayloadCore,
    isLikelyMemoJournalBlock: isLikelyMemoJournalBlockCore,
    stripNaturalMemoLead: stripNaturalMemoLeadCore,
    inferWordIntentPayload: inferWordIntentPayloadCore,
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
    inferStatusIntentPayload: inferStatusIntentPayloadCore,
    inferLinkIntentPayload: inferLinkIntentPayloadCore,
    inferReportIntentPayload: inferReportIntentPayloadCore,
    extractPreferredProjectBasePath: extractPreferredProjectBasePathCore,
    inferProjectIntentPayload: inferProjectIntentPayloadCore,
    inferNaturalLanguageRoute: inferNaturalLanguageRouteCore,
} = require('./lib/bridge_nl_inference');
const {
    DEFAULT_TTL_MS: DEFAULT_FOLLOWUP_TTL_MS,
    DEFAULT_MAX_ENTRIES_PER_SESSION: DEFAULT_FOLLOWUP_MAX_ENTRIES_PER_SESSION,
    DEFAULT_MAX_SESSIONS: DEFAULT_FOLLOWUP_MAX_SESSIONS,
    isResultFollowupQuery: isResultFollowupQueryCore,
    rememberActionableResult: rememberActionableResultCore,
    resolveRecentResult: resolveRecentResultCore,
} = require('./lib/bridge_followup_context');
const {
    DEFAULT_COMMAND_ALLOWLIST,
    DEFAULT_HUB_DELEGATION,
    DEFAULT_NATURAL_LANGUAGE_ROUTING,
} = require('../packages/core-policy/src/bridge_defaults');
const {
    uniqueNormalizedList: uniqueNormalizedListCore,
    parseAllowlistEnvList: parseAllowlistEnvListCore,
    parseBooleanEnv: parseBooleanEnvCore,
    normalizeAllowlistConfig: normalizeAllowlistConfigCore,
    normalizeHubDelegationConfig: normalizeHubDelegationConfigCore,
    normalizeNaturalLanguageRoutingConfig: normalizeNaturalLanguageRoutingConfigCore,
    isHubRuntime: isHubRuntimeCore,
    isResearchRuntime: isResearchRuntimeCore,
    isWordRuntime: isWordRuntimeCore,
} = require('./lib/bridge_runtime_policy');
const {
    createBridgeRunOutcome,
    markCommandAllowlistBlocked,
    markAutoRouteAllowlistBlocked,
    markRunSuccess,
    markRunFailure,
    buildBridgeRetryLogPayload,
    buildBridgeRunEndPayload,
} = require('./lib/bridge_run_state');
const { buildBridgeDispatchDeps } = require('./lib/bridge_dispatch_deps');
const { executeBridgeRunLoop } = require('./lib/bridge_run_executor');
const { runBridgePreflight } = require('./lib/bridge_preflight');
const {
    startBridgeRunLifecycle,
    finishBridgeRunLifecycle,
} = require('./lib/bridge_run_lifecycle');
const { executeBridgeMainExecution } = require('./lib/bridge_main_execution');
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
const TOKYO_TIMEZONE = 'Asia/Tokyo';
const TOKYO_DAY_FORMAT = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TOKYO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});
const TOKYO_DATETIME_FORMAT = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TOKYO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});
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

function toValidDate(input = null) {
    const date = input instanceof Date ? new Date(input.getTime()) : new Date(input || Date.now());
    if (Number.isFinite(date.getTime())) return date;
    return new Date();
}

function nowTokyoDate(now = null) {
    return TOKYO_DAY_FORMAT.format(toValidDate(now));
}

function formatTokyoDateTime(input = null) {
    return TOKYO_DATETIME_FORMAT.format(toValidDate(input));
}

function parseWordLogMeta(metaJson) {
    try {
        const parsed = JSON.parse(String(metaJson || '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

function isDuplicateWordLog(row) {
    const meta = parseWordLogMeta(row && row.meta_json);
    return Boolean(meta.duplicate);
}

function getCorrectedWordFromLog(row) {
    const meta = parseWordLogMeta(row && row.meta_json);
    return String(meta.correctedWord || '').trim();
}

function normalizeWordReadQuery(text = '') {
    return String(text || '').replace(/\s+/g, '').trim().toLowerCase();
}

function detectWordReadMode(text = '') {
    const compact = normalizeWordReadQuery(text);
    if (!compact) return null;
    if (compact.includes('오늘추가')) return 'today_added';
    if (compact.includes('실패목록')) return 'failure_list';
    if (compact.includes('복습추천')) return 'review_recommendation';
    return null;
}

function getWordTodayActivity(options = {}) {
    const dbPath = personalStorage.ensureStorage(options);
    const date = nowTokyoDate(options.now);
    const rows = personalStorage.runSqlJson(
        dbPath,
        `
SELECT word, save_status, error_text, meta_json, created_at
FROM vocab_logs
WHERE date(datetime(created_at), '+9 hours') = ${personalStorage.sqlQuote(date)}
ORDER BY datetime(created_at) DESC, id DESC
LIMIT 500;
`,
    );
    const totals = {
        total: rows.length,
        saved: 0,
        failed: 0,
        duplicate: 0,
        autoCorrected: 0,
    };
    const recentAdded = [];
    const seenRecentWords = new Set();

    for (const row of rows) {
        const duplicate = isDuplicateWordLog(row);
        const correctedWord = getCorrectedWordFromLog(row);
        if (row.save_status === 'saved') {
            totals.saved += 1;
            if (duplicate) totals.duplicate += 1;
            if (correctedWord) totals.autoCorrected += 1;
            const word = String(row.word || '').trim();
            if (word && !duplicate && !seenRecentWords.has(word.toLowerCase()) && recentAdded.length < 5) {
                seenRecentWords.add(word.toLowerCase());
                recentAdded.push(word);
            }
        } else if (row.save_status === 'failed') {
            totals.failed += 1;
        }
    }

    return {
        date,
        totals,
        recentAdded,
    };
}

function getRecentWordFailures(options = {}) {
    const dbPath = personalStorage.ensureStorage(options);
    const limit = Math.max(1, Number(options.limit || 8));
    const rows = personalStorage.runSqlJson(
        dbPath,
        `
SELECT word, error_text, created_at
FROM vocab_logs
WHERE save_status = 'failed'
ORDER BY datetime(created_at) DESC, id DESC
LIMIT ${limit};
`,
    );
    return rows.map((row) => ({
        word: String(row.word || '').trim() || '(unknown)',
        reason: String(row.error_text || '').trim() || 'unknown_error',
        createdAt: String(row.created_at || '').trim(),
        createdAtTokyo: formatTokyoDateTime(row.created_at),
    }));
}

function getWordReviewRecommendations(options = {}) {
    const dbPath = personalStorage.ensureStorage(options);
    const limit = Math.max(1, Number(options.limit || 5));
    const days = Math.max(1, Number(options.days || 60));
    const now = toValidDate(options.now);
    const cutoffMs = now.getTime() - (days * 24 * 60 * 60 * 1000);
    const rows = personalStorage.runSqlJson(
        dbPath,
        `
SELECT word, save_status, meta_json, created_at
FROM vocab_logs
ORDER BY datetime(created_at) DESC, id DESC
LIMIT 1000;
`,
    );
    const bucket = new Map();

    for (const row of rows) {
        const createdAt = String(row.created_at || '').trim();
        const createdMs = Date.parse(createdAt);
        if (Number.isFinite(createdMs) && createdMs < cutoffMs) continue;

        const word = String(row.word || '').trim();
        if (!word) continue;
        const key = word.toLowerCase();
        if (!bucket.has(key)) {
            bucket.set(key, {
                word,
                savedCount: 0,
                failedCount: 0,
                duplicateCount: 0,
                autoCorrectedCount: 0,
                lastSeenAt: createdAt,
            });
        }
        const item = bucket.get(key);
        const duplicate = isDuplicateWordLog(row);
        const correctedWord = getCorrectedWordFromLog(row);
        if (row.save_status === 'saved') {
            item.savedCount += 1;
            if (duplicate) item.duplicateCount += 1;
            if (correctedWord) item.autoCorrectedCount += 1;
        } else if (row.save_status === 'failed') {
            item.failedCount += 1;
        }
        if (!item.lastSeenAt || Date.parse(createdAt) > Date.parse(item.lastSeenAt)) {
            item.lastSeenAt = createdAt;
            item.word = word;
        }
    }

    return [...bucket.values()]
        .filter((row) => row.savedCount > 0)
        .map((row) => {
            const lastSeenMs = Date.parse(row.lastSeenAt);
            const staleDays = Number.isFinite(lastSeenMs)
                ? Math.max(0, Math.floor((now.getTime() - lastSeenMs) / (24 * 60 * 60 * 1000)))
                : 0;
            const score = (row.failedCount * 4)
                + (row.duplicateCount * 3)
                + (row.autoCorrectedCount * 2)
                + Math.min(staleDays, 5)
                + Math.min(row.savedCount, 2);
            const reasons = [];
            if (row.failedCount > 0) reasons.push(`실패 ${row.failedCount}`);
            if (row.duplicateCount > 0) reasons.push(`중복 ${row.duplicateCount}`);
            if (row.autoCorrectedCount > 0) reasons.push(`자동 보정 ${row.autoCorrectedCount}`);
            if (staleDays > 0) reasons.push(`${staleDays}일 경과`);
            if (reasons.length === 0) reasons.push(`저장 ${row.savedCount}`);
            return {
                ...row,
                staleDays,
                score,
                reasonText: reasons.join(', '),
                lastSeenTokyo: formatTokyoDateTime(row.lastSeenAt),
            };
        })
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (b.staleDays !== a.staleDays) return b.staleDays - a.staleDays;
            return Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt);
        })
        .slice(0, limit);
}

function handleWordReadCommand(text, options = {}) {
    const queryMode = detectWordReadMode(text);
    if (!queryMode) return null;

    if (queryMode === 'today_added') {
        const activity = getWordTodayActivity(options);
        return {
            route: 'word',
            success: true,
            queryMode,
            date: activity.date,
            savedCount: activity.totals.saved,
            failedCount: activity.totals.failed,
            duplicateCount: activity.totals.duplicate,
            autoCorrectedCount: activity.totals.autoCorrected,
            recentWords: activity.recentAdded,
            telegramReply: [
                `오늘 단어 활동 (${activity.date})`,
                `- 저장: ${activity.totals.saved}건`,
                `- 실패: ${activity.totals.failed}건`,
                `- 중복: ${activity.totals.duplicate}건`,
                `- 자동 보정: ${activity.totals.autoCorrected}건`,
                `- 최근 추가: ${activity.recentAdded.length ? activity.recentAdded.join(', ') : '없음'}`,
            ].join('\n'),
        };
    }

    if (queryMode === 'failure_list') {
        const failures = getRecentWordFailures(options);
        return {
            route: 'word',
            success: true,
            queryMode,
            failures,
            telegramReply: [
                '최근 단어 실패 목록',
                ...(failures.length > 0
                    ? failures.map((row) => `- ${row.word}: ${row.reason} (${row.createdAtTokyo})`)
                    : ['- 없음']),
            ].join('\n'),
        };
    }

    if (queryMode === 'review_recommendation') {
        const recommendations = getWordReviewRecommendations(options);
        return {
            route: 'word',
            success: true,
            queryMode,
            recommendations,
            telegramReply: [
                '단어 복습 추천',
                ...(recommendations.length > 0
                    ? recommendations.map((row) => `- ${row.word}: ${row.reasonText} (점수 ${row.score})`)
                    : ['- 추천할 단어가 아직 없습니다.']),
            ].join('\n'),
        };
    }

    return null;
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
    return uniqueNormalizedListCore(values);
}

function parseAllowlistEnvList(value) {
    return parseAllowlistEnvListCore(value, {
        uniqueNormalizedList,
    });
}

function parseBooleanEnv(value) {
    return parseBooleanEnvCore(value);
}

function normalizeAllowlistConfig(rawConfig, env = process.env) {
    return normalizeAllowlistConfigCore(rawConfig, env, {
        defaultCommandAllowlist: DEFAULT_COMMAND_ALLOWLIST,
        uniqueNormalizedList,
        parseAllowlistEnvList,
        parseBooleanEnv,
    });
}

function normalizeHubDelegationConfig(rawConfig) {
    return normalizeHubDelegationConfigCore(rawConfig, {
        defaultHubDelegation: DEFAULT_HUB_DELEGATION,
    });
}

function normalizeNaturalLanguageRoutingConfig(rawConfig, env = process.env) {
    return normalizeNaturalLanguageRoutingConfigCore(rawConfig, env, {
        defaultNaturalLanguageRouting: DEFAULT_NATURAL_LANGUAGE_ROUTING,
        parseBooleanEnv,
    });
}

function isHubRuntime(env = process.env) {
    return isHubRuntimeCore(env);
}

function isResearchRuntime(env = process.env) {
    return isResearchRuntimeCore(env);
}

function isWordRuntime(env = process.env) {
    return isWordRuntimeCore(env);
}

const COMMAND_ALLOWLIST = normalizeAllowlistConfig(config.commandAllowlist, process.env);
const HUB_DELEGATION = normalizeHubDelegationConfig(config.hubDelegation);
const HUB_DELEGATION_ACTIVE = HUB_DELEGATION.enabled && isHubRuntime(process.env);
const BRIDGE_BLOCK_HINT = String(process.env.BRIDGE_BLOCK_HINT || '').trim();
const NATURAL_LANGUAGE_ROUTING = normalizeNaturalLanguageRoutingConfig(config.naturalLanguageRouting, process.env);

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
            bot_id: process.env.MOLTBOT_BOT_ID,
            profile: process.env.MOLTBOT_PROFILE || process.env.OPENCLAW_PROFILE,
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

    if (primaryTokens.length === 1) {
        const bySemicolon = String(primaryTokens[0] || '')
            .split(/\s*[;；]\s*/)
            .map((s) => s.trim())
            .filter(Boolean);
        if (bySemicolon.length > 1) {
            primaryTokens = bySemicolon;
        }
    }

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
    const normalized = String(hint || '')
        .replace(/^[~\s]+/, '')
        .replace(/[()[\]{}<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) return '';
    if (/^[-–—~_./\\?]+$/.test(normalized)) return '';
    const compact = normalized.replace(/\s+/g, '').toLowerCase();
    if (new Set(['없음', '뜻없음', '모름', '몰라', 'unknown', 'none', 'null', 'na', 'n/a', 'x']).has(compact)) {
        return '';
    }
    return normalized;
}

function parseWordToken(token) {
    const clean = normalizeWordParseInput(stripListPrefix(token));
    if (!clean) return null;

    // 명시 구분자 우선 (:, |, " - ")
    const explicit = clean.match(/^([A-Za-z][A-Za-z\-'\s]{0,120}?)\s*(?:[:：|=]|\s+-\s+)\s*(.+)$/);
    if (explicit) {
        return {
            word: explicit[1].trim(),
            hint: normalizeHintParseInput(explicit[2]),
        };
    }

    // "word -", "word:", "word |" 같이 뜻이 비어있는 경우도 단어로 인식
    const trailingEmptyHint = clean.match(/^([A-Za-z][A-Za-z\-'\s]{0,120}?)\s*(?:[:：|=]|-)\s*$/);
    if (trailingEmptyHint) {
        return {
            word: trailingEmptyHint[1].trim(),
            hint: '',
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

const OPS_ALLOWED_TARGETS = OPS_ALLOWED_TARGETS_CORE;
const OPS_CAPABILITY_POLICY = OPS_CAPABILITY_POLICY_CORE;

function normalizeOpsAction(value) {
    return normalizeOpsActionCore(value);
}

function normalizeOpsCapabilityAction(capability, value) {
    return normalizeOpsCapabilityActionCore(capability, value);
}

function buildCapabilityPayload(fields = {}) {
    return buildCapabilityPayloadCore(fields);
}

function normalizeOpsTarget(value) {
    return normalizeOpsTargetCore(value);
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
const FOLLOWUP_STATE_PATH = resolvePathFromEnv(
    'BRIDGE_FOLLOWUP_STATE_PATH',
    path.join(__dirname, '..', 'data', 'runtime', 'bridge_followup_state.json'),
);
const ROUTING_ADAPTIVE_KEYWORDS_PATH = resolvePathFromEnv(
    'ROUTING_ADAPTIVE_KEYWORDS_PATH',
    path.join(__dirname, '..', 'data', 'policy', 'routing_adaptive_keywords.json'),
);

function parsePositiveIntEnv(envName, fallback, minimum = 1) {
    const parsed = Number(process.env[envName]);
    if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
    return Math.floor(parsed);
}

const FOLLOWUP_TTL_MS = parsePositiveIntEnv('BRIDGE_FOLLOWUP_TTL_MS', DEFAULT_FOLLOWUP_TTL_MS, 1000);
const FOLLOWUP_MAX_ENTRIES_PER_SESSION = parsePositiveIntEnv(
    'BRIDGE_FOLLOWUP_MAX_ENTRIES_PER_SESSION',
    DEFAULT_FOLLOWUP_MAX_ENTRIES_PER_SESSION,
    1,
);
const FOLLOWUP_MAX_SESSIONS = parsePositiveIntEnv(
    'BRIDGE_FOLLOWUP_MAX_SESSIONS',
    DEFAULT_FOLLOWUP_MAX_SESSIONS,
    1,
);

function parseTransportEnvelopeContext(text) {
    return parseTransportEnvelopeContextCore(text);
}

function writeJsonFileSafe(filePath, payload) {
    return writeJsonFileSafeCore(filePath, payload, {
        fsModule: fs,
        pathModule: path,
    });
}

function readJsonFileSafe(filePath) {
    return readJsonFileSafeCore(filePath, {
        fsModule: fs,
    });
}

function normalizeAdaptiveKeywordList(values) {
    const source = Array.isArray(values) ? values : [];
    const out = [];
    const seen = new Set();
    for (const raw of source) {
        const token = String(raw || '').trim();
        if (!token) continue;
        const key = token.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(token);
    }
    return out;
}

function loadRoutingAdaptiveKeywords() {
    const raw = readJsonFileSafe(ROUTING_ADAPTIVE_KEYWORDS_PATH);
    const data = raw && typeof raw === 'object' ? raw : {};
    return {
        todoStatsKeywords: normalizeAdaptiveKeywordList(data.todoStatsKeywords),
        followupResultKeywords: normalizeAdaptiveKeywordList(data.followupResultKeywords),
        inspectRootCauseKeywords: normalizeAdaptiveKeywordList(data.inspectRootCauseKeywords),
        inspectImproveKeywords: normalizeAdaptiveKeywordList(data.inspectImproveKeywords),
    };
}

function saveLastProjectBootstrap(fields = {}, bootstrap = null) {
    return saveLastProjectBootstrapCore(fields, bootstrap, {
        statePath: PROJECT_BOOTSTRAP_STATE_PATH,
        writeJsonFileSafe,
    });
}

function loadLastProjectBootstrap(maxAgeHours = 48) {
    return loadLastProjectBootstrapCore(maxAgeHours, {
        statePath: PROJECT_BOOTSTRAP_STATE_PATH,
        readJsonFileSafe,
    });
}

function resolveDefaultProjectBasePath() {
    return resolveDefaultProjectBasePathCore({ pathModule: path });
}

function toProjectTemplatePayload(fields = {}, { forceExecute = false } = {}) {
    return toProjectTemplatePayloadCore(fields, { forceExecute }, {
        sanitizeProjectName,
        resolveDefaultProjectBasePath,
    });
}

function resolveHubDelegationTarget(route) {
    return resolveHubDelegationTargetCore(route, {
        active: HUB_DELEGATION_ACTIVE,
        routeToProfile: HUB_DELEGATION.routeToProfile,
    });
}

function enqueueHubDelegationCommand({ route, payload, originalMessage, rawText, telegramContext }) {
    return enqueueHubDelegationCommandCore({
        route,
        payload,
        originalMessage,
        rawText,
        telegramContext,
    }, {
        resolveHubDelegationTarget,
        normalizeRequester: (context, fallback) => opsFileControl.normalizeRequester(context, fallback),
        enqueueCapabilityCommand,
        parseTransportEnvelopeContext,
    });
}

function resolveOpsFilePolicy() {
    return resolveOpsFilePolicyCore(config, {
        loadPolicy: (inputConfig) => opsFileControl.loadPolicy(inputConfig),
    });
}

function isUnifiedApprovalEnabled() {
    return isUnifiedApprovalEnabledCore(config, process.env);
}

function normalizeOpsOptionFlags(value) {
    return normalizeOpsOptionFlagsCore(value, {
        normalizeApprovalFlags: (input) => opsFileControl.normalizeApprovalFlags(input),
    });
}

function normalizeOpsFileIntent(value) {
    return normalizeOpsFileIntentCore(value, {
        normalizeIntentAction: (input) => opsFileControl.normalizeIntentAction(input),
    });
}

function isFileControlAction(action) {
    return isFileControlActionCore(action);
}

function enforceFileControlTelegramGuard(telegramContext, policy) {
    return enforceFileControlTelegramGuardCore(telegramContext, policy);
}

function isApprovalGrantEnabled(policy) {
    return isApprovalGrantEnabledCore(policy);
}

function parseApproveShorthand(text) {
    return parseApproveShorthandCore(text, { normalizeOpsOptionFlags });
}

function parseDenyShorthand(text) {
    return parseDenyShorthandCore(text);
}

function parseNaturalApprovalShorthand(text) {
    return parseNaturalApprovalShorthandCore(text);
}

function normalizeOpsPayloadText(text) {
    return normalizeOpsPayloadTextCore(text, {
        parseApproveShorthand,
        parseDenyShorthand,
    });
}

function enqueueFileControlCommand(command = {}) {
    return enqueueFileControlCommandCore(command, {
        makeRequestId: (prefix) => opsCommandQueue.makeRequestId(prefix),
        enqueueCommand: (payload) => opsCommandQueue.enqueueCommand(payload),
    });
}

function enqueueCapabilityCommand(command = {}) {
    return enqueueCapabilityCommandCore(command, {
        makeRequestId: (prefix) => opsCommandQueue.makeRequestId(prefix),
        enqueueCommand: (payload) => opsCommandQueue.enqueueCommand(payload),
        env: process.env,
    });
}

function isDockerPermissionError(errText) {
    return /(EACCES|permission denied|Cannot connect to the Docker daemon|is the docker daemon running)/i.test(String(errText || ''));
}

function queueOpsRequest(action, targetKey, targets, reason = '') {
    return queueOpsRequestCore(action, targetKey, targets, reason, {
        fsModule: fs,
        pathModule: path,
        queuePath: OPS_QUEUE_PATH,
    });
}

function isInlineApprovalExecutionEnabled() {
    return isInlineApprovalExecutionEnabledCore(process.env);
}

function triggerInlineOpsWorker() {
    return triggerInlineOpsWorkerCore({
        env: process.env,
        isInlineApprovalExecutionEnabled,
        spawnSync,
        pathModule: path,
        bridgeDir: __dirname,
    });
}

function readOpsSnapshot() {
    return readOpsSnapshotCore(OPS_SNAPSHOT_PATH, {
        fsModule: fs,
    });
}

function readPendingApprovalsState() {
    return readPendingApprovalsStateCore(PENDING_APPROVALS_STATE_PATH, {
        fsModule: fs,
    });
}

const {
    readLastApprovalHints,
    writeLastApprovalHints,
    buildApprovalOwnerKey,
    rememberLastApprovalHint,
    readLastApprovalHint,
    clearLastApprovalHint,
    hasAnyApprovalHint,
    findPendingApprovalByRequestId,
    resolveApprovalTokenFromHint,
    findApprovalTokenCandidates,
    sortPendingApprovalsNewestFirst,
    resolveApprovalTokenSelection,
    mergeUniqueLower,
    resolveApprovalFlagsForToken,
} = createApprovalHintBindings({
    readLastApprovalHintsCore,
    writeLastApprovalHintsCore,
    buildApprovalOwnerKeyCore,
    rememberLastApprovalHintCore,
    readLastApprovalHintCore,
    clearLastApprovalHintCore,
    hasAnyApprovalHintCore,
    findPendingApprovalByRequestIdCore,
    resolveApprovalTokenFromHintCore,
    findApprovalTokenCandidatesCore,
    sortPendingApprovalsNewestFirstCore,
    resolveApprovalTokenSelectionCore,
    mergeUniqueLowerCore,
    resolveApprovalFlagsForTokenCore,
}, {
    fsModule: fs,
    pathModule: path,
    hintsPath: LAST_APPROVAL_HINTS_PATH,
    readPendingApprovalsState: () => readPendingApprovalsState(),
    readPendingToken: (key) => opsApprovalStore.readPendingToken(key),
});

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

function handleOpsStatusAction(action, targetKey) {
    return handleOpsStatusActionCore({
        action,
        targetKey,
    }, {
        allowedTargets: OPS_ALLOWED_TARGETS,
        execDocker,
        isDockerPermissionError,
        readOpsSnapshot,
        getTunnelPublicBaseUrl,
        buildOpsStatusRowsFromSnapshot,
        buildOpsStatusRowsFromDocker,
        buildOpsStatusReply,
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

function prepareOpsCommandContext(payloadText, options = {}) {
    return prepareOpsCommandContextCore(payloadText, options, {
        normalizeOpsPayloadText,
        parseStructuredCommand,
        normalizeOpsAction,
        normalizeOpsTarget,
        parseTransportEnvelopeContext,
        resolveOpsFilePolicy,
        normalizeRequester: (telegramContext, requestedBy) => opsFileControl.normalizeRequester(telegramContext, requestedBy),
        isFileControlAction,
        enforceFileControlTelegramGuard,
    });
}

function dispatchOpsAction(context) {
    return dispatchOpsActionCore(context, {
        handleOpsStatusAction,
        handleOpsTokenAction,
        handleOpsRestartAction,
        handleOpsFileAction,
        handleOpsCapabilityAction,
        handleOpsApproveAction,
        handleOpsDenyAction,
    });
}

function runOpsCommandSingle(payloadText, options = {}) {
    const prepared = prepareOpsCommandContext(payloadText, options);
    if (!prepared.ok) {
        return prepared.result;
    }
    return dispatchOpsAction(prepared.context);
}

function normalizeHttpsBase(v) {
    return normalizeHttpsBaseCore(v);
}

function getTunnelPublicBaseUrl() {
    return getTunnelPublicBaseUrlCore({ getPublicBases });
}

function getPublicBases() {
    return getPublicBasesCore({
        env: process.env,
        pathModule: path,
        fsModule: fs,
        bridgeDir: __dirname,
        execDocker,
    });
}

function buildExternalLinksText() {
    return buildExternalLinksTextCore({ getPublicBases });
}

function rewriteLocalLinks(text, bases) {
    return rewriteLocalLinksCore(text, bases);
}

function appendExternalLinks(reply) {
    return appendExternalLinksCore(reply, {
        getPublicBases,
        rewriteLocalLinks,
        buildExternalLinksText,
    });
}

function parseReportModeCommand(text) {
    return parseReportModeCommandCore(text);
}

function finalizeTelegramBoundary(base, metaInput = {}) {
    return finalizeTelegramBoundaryCore(base, metaInput, {
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

function buildDailyCasualNoPrefixReply(inputText) {
    return buildDailyCasualNoPrefixReplyCore(inputText, {
        normalizeIncomingCommandText,
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

function inferWordIntentPayload(text) {
    return inferWordIntentPayloadCore(text);
}

function inferFinanceIntentPayload(text) {
    return inferFinanceIntentPayloadCore(text);
}

function inferTodoIntentPayload(text) {
    const adaptive = loadRoutingAdaptiveKeywords();
    return inferTodoIntentPayloadCore(text, {
        adaptiveKeywords: adaptive.todoStatsKeywords,
    });
}

function inferRoutineIntentPayload(text) {
    return inferRoutineIntentPayloadCore(text);
}

function inferWorkoutIntentPayload(text) {
    return inferWorkoutIntentPayloadCore(text);
}

function inferWorkIntentPayload(text) {
    const adaptive = loadRoutingAdaptiveKeywords();
    return inferWorkIntentPayloadCore(text, {
        inspectRootCauseKeywords: adaptive.inspectRootCauseKeywords,
        inspectImproveKeywords: adaptive.inspectImproveKeywords,
    });
}

function inferInspectIntentPayload(text) {
    const adaptive = loadRoutingAdaptiveKeywords();
    return inferInspectIntentPayloadCore(text, {
        inspectRootCauseKeywords: adaptive.inspectRootCauseKeywords,
        inspectImproveKeywords: adaptive.inspectImproveKeywords,
    });
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
        isWordRuntime,
        normalizeIncomingCommandText,
        inferWordIntentPayload,
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
    const wordReadResult = handleWordReadCommand(text, {
        ...options,
        dbPath: options.dbPath || process.env.PERSONAL_DB_PATH,
    });
    if (wordReadResult) return wordReadResult;

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
    const duplicateCount = results.filter((row) => Boolean(row && row.duplicate)).length;
    const autoCorrectedCount = correctionRows.length;
    const summary = `Anki 저장 결과: 성공 ${results.length}건 / 실패 ${failedTotal}건 / 중복 ${duplicateCount}건 / 자동 보정 ${autoCorrectedCount}건`;
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
        duplicateCount,
        autoCorrectedCount,
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

function buildDispatchDepsForMain(opsContext) {
    const adaptiveKeywords = loadRoutingAdaptiveKeywords();
    return buildBridgeDispatchDeps({
        opsContext,
    }, {
        opsLogger,
        handleDirectBridgeCommand,
        engine,
        anki,
        config,
        parseStructuredCommand,
        appendExternalLinks,
        withApiMeta,
        buildCodexDegradedMeta,
        buildDuelModeMeta,
        buildProjectRoutePayload,
        parseTransportEnvelopeContext,
        runOpsCommand,
        handlePersonalRoute,
        processWordTokens,
        normalizeNewsCommandPayload,
        pickPreferredModelMeta,
        handlePromptPayload,
        loadNewsDigest: () => require('./news_digest'),
        handleAutoBridgeCommand,
        normalizeIncomingCommandText,
        normalizeRequester: opsFileControl.normalizeRequester,
        handleCodexBotAutoCommand,
        parseReportModeCommand,
        writeReportMode: telegramFinalizer.writeReportMode,
        routeByPrefix,
        captureConversationSafe,
        isResultFollowupQuery: isResultFollowupQueryCore,
        resolveRecentResult: resolveRecentResultCore,
        rememberActionableResult: rememberActionableResultCore,
        followupStatePath: FOLLOWUP_STATE_PATH,
        followupTtlMs: FOLLOWUP_TTL_MS,
        followupMaxEntriesPerSession: FOLLOWUP_MAX_ENTRIES_PER_SESSION,
        followupMaxSessions: FOLLOWUP_MAX_SESSIONS,
        followupResultKeywords: adaptiveKeywords.followupResultKeywords,
        isAutoRouteAllowed,
        buildAllowlistBlockedResponse,
        enqueueHubDelegationCommand,
        handleAutoRoutedCommand,
        normalizeReportNewsPayload,
        isResearchRuntime,
        buildLinkOnlyReply,
        buildQuickStatusReply,
        inferPathListReply,
        buildGogNoPrefixGuide,
        buildNoPrefixReply: buildNoPrefixReplyCore,
        isHubRuntime,
        buildDailyCasualNoPrefixReply,
        buildNoPrefixGuide,
        loadMemoJournal: () => require('./memo_journal'),
        loadBlogPublisher: () => require('./blog_publish_from_reports'),
        loadWeeklyReport: () => require('./weekly_report'),
        loadDailySummary: () => require('./daily_summary'),
    });
}

async function main() {
    const [, , command, ...args] = process.argv;
    const fullText = args.join(' ');
    const normalizedCommand = String(command || '').trim().toLowerCase();
    const toeicDeck = config.ankiPolicy?.toeicDeck || 'TOEIC_AI';
    const toeicTags = Array.isArray(config.ankiPolicy?.autoTags) ? config.ankiPolicy.autoTags : ['moltbot', 'toeic_ai'];
    const maxAttempts = RETRY_SAFE_COMMANDS.has(normalizedCommand) ? 3 : 1;
    let attempt = 1;
    const runOutcome = createBridgeRunOutcome();
    const lifecycle = startBridgeRunLifecycle({
        normalizedCommand,
        maxAttempts,
        argsCount: args.length,
    }, {
        opsLogger,
    });
    const { opsContext, stopHeartbeat } = lifecycle;

    try {
        const execution = await executeBridgeMainExecution({
            normalizedCommand,
            fullText,
            argsCount: args.length,
            maxAttempts,
            attempt,
            command,
            args,
            toeicDeck,
            toeicTags,
            env: process.env,
            opsContext,
            runOutcome,
        }, {
            opsLogger,
            runBridgePreflight,
            captureConversationSafe,
            knownDirectCommands: KNOWN_DIRECT_COMMANDS,
            isDirectCommandAllowed,
            buildAllowlistBlockedResponse,
            markCommandAllowlistBlocked,
            emitOutput: (output) => console.log(JSON.stringify(output)),
            buildDispatchDeps: (contextOps) => buildDispatchDepsForMain(contextOps),
            executeBridgeRunLoop,
            dispatchBridgeCommandOnce,
            markAutoRouteAllowlistBlocked,
            markRunSuccess,
            isRetriableError,
            buildBridgeRetryLogPayload,
            sleep,
            retryBackoffMs: RETRY_BACKOFF_MS,
        });
        attempt = execution.attempt;
        if (execution.blocked) {
            return;
        }
    } catch (error) {
        markRunFailure(runOutcome, error);
        console.error('Error:', error);
    } finally {
        finishBridgeRunLifecycle({
            opsContext,
            stopHeartbeat,
            runOutcome,
            normalizedCommand,
            maxAttempts,
            attempt,
            fullText,
        }, {
            opsLogger,
            buildBridgeRunEndPayload,
            isRetriableError,
        });
    }

    if (runOutcome.finalError) {
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
