const DEFAULT_FOLLOWUP_EMPTY_REPLY = '재표시할 최근 실행 결과가 없어요. 어떤 작업 결과를 보여드릴지 한 줄로 알려주세요.';

function normalizeKeyPart(value, fallback = '') {
    const raw = String(value || '').trim();
    return raw || String(fallback || '').trim();
}

function buildFollowupSessionKey(telegramContext, requestedBy) {
    const context = telegramContext && typeof telegramContext === 'object' ? telegramContext : {};
    const provider = normalizeKeyPart(context.provider, 'direct').toLowerCase();
    const userId = normalizeKeyPart(context.userId, requestedBy || 'unknown');
    const groupId = normalizeKeyPart(context.groupId, 'direct');
    return `${provider}:${userId}:${groupId}`;
}

function shouldRememberAutoResult(output) {
    const row = output && typeof output === 'object' ? output : null;
    if (!row || row.success !== true) return false;
    const route = String(row.route || '').trim().toLowerCase();
    if (!route || route === 'none' || route === 'blocked') return false;
    const reply = String(row.telegramReply || '').trim();
    return Boolean(reply);
}

function rememberAutoResult(sessionKey, output, deps = {}) {
    if (!shouldRememberAutoResult(output)) return;
    if (typeof deps.rememberActionableResult !== 'function') return;

    const opts = {
        statePath: deps.followupStatePath,
        ttlMs: deps.followupTtlMs,
        maxEntriesPerSession: deps.followupMaxEntriesPerSession,
        maxSessions: deps.followupMaxSessions,
    };
    try {
        deps.rememberActionableResult(sessionKey, {
            route: output.route,
            success: output.success,
            telegramReply: output.telegramReply,
            timestamp: output.timestamp || undefined,
        }, opts);
    } catch (_) {
        // Follow-up cache failures must not break command handling.
    }
}

async function handleAutoBridgeCommand(context = {}, deps = {}) {
    const fullText = String(context.fullText || '');
    const toeicDeck = String(context.toeicDeck || '');
    const toeicTags = Array.isArray(context.toeicTags) ? context.toeicTags : [];
    const env = context.env || process.env;

    const normalizedAutoMessage = deps.normalizeIncomingCommandText(fullText) || String(fullText || '').trim();
    const autoTelegramContext = deps.parseTransportEnvelopeContext(fullText);
    const autoRequestedBy = deps.normalizeRequester(autoTelegramContext, 'bridge:auto');
    const followupSessionKey = buildFollowupSessionKey(autoTelegramContext, autoRequestedBy);

    const followupKeywords = Array.isArray(deps.followupResultKeywords)
        ? deps.followupResultKeywords
        : [];
    const isFollowupQuery = typeof deps.isResultFollowupQuery === 'function'
        ? deps.isResultFollowupQuery(normalizedAutoMessage, followupKeywords)
        : false;
    if (isFollowupQuery) {
        const recent = typeof deps.resolveRecentResult === 'function'
            ? deps.resolveRecentResult(followupSessionKey, {
                statePath: deps.followupStatePath,
                ttlMs: deps.followupTtlMs,
                maxEntriesPerSession: deps.followupMaxEntriesPerSession,
                maxSessions: deps.followupMaxSessions,
            })
            : null;
        if (recent && String(recent.telegramReply || '').trim()) {
            return {
                handled: true,
                output: deps.withApiMeta({
                    route: String(recent.route || 'none').trim() || 'none',
                    success: true,
                    telegramContext: autoTelegramContext,
                    requestedBy: autoRequestedBy,
                    telegramReply: String(recent.telegramReply || '').trim(),
                }, {
                    route: String(recent.route || 'none').trim() || 'none',
                    routeHint: 'followup-last-result',
                    commandText: normalizedAutoMessage,
                    telegramContext: autoTelegramContext,
                    requestedBy: autoRequestedBy,
                }),
            };
        }
        return {
            handled: true,
            output: deps.withApiMeta({
                route: 'none',
                success: true,
                telegramContext: autoTelegramContext,
                requestedBy: autoRequestedBy,
                telegramReply: DEFAULT_FOLLOWUP_EMPTY_REPLY,
            }, {
                route: 'none',
                routeHint: 'followup-empty',
                commandText: normalizedAutoMessage,
                telegramContext: autoTelegramContext,
                requestedBy: autoRequestedBy,
            }),
        };
    }

    const codexBotAutoResult = deps.handleCodexBotAutoCommand({
        rawText: fullText,
        normalizedText: normalizedAutoMessage,
        telegramContext: autoTelegramContext,
        requestedBy: autoRequestedBy,
        env,
    });
    if (codexBotAutoResult) {
        const output = deps.withApiMeta(codexBotAutoResult, {
            route: 'codex',
            routeHint: 'codex-auto',
            commandText: normalizedAutoMessage,
            telegramContext: autoTelegramContext,
            requestedBy: autoRequestedBy,
        });
        rememberAutoResult(followupSessionKey, output, deps);
        return {
            handled: true,
            output,
        };
    }

    const reportModeCommand = deps.parseReportModeCommand(normalizedAutoMessage);
    if (reportModeCommand.matched) {
        if (!reportModeCommand.valid) {
            const output = deps.withApiMeta({
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
            });
            rememberAutoResult(followupSessionKey, output, deps);
            return {
                handled: true,
                output,
            };
        }

        deps.writeReportMode({
            telegramContext: autoTelegramContext,
            requestedBy: autoRequestedBy,
            mode: reportModeCommand.mode,
        });
        const output = deps.withApiMeta({
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
        });
        rememberAutoResult(followupSessionKey, output, deps);
        return {
            handled: true,
            output,
        };
    }

    const routed = deps.routeByPrefix(normalizedAutoMessage);
    deps.logAutoRoute({
        routed,
        fullText,
    });
    deps.captureConversationSafe({
        route: routed.route || 'none',
        message: fullText,
        source: 'user',
        skillHint: routed.route || 'none',
    });

    if (!deps.isAutoRouteAllowed(routed.route)) {
        return {
            handled: true,
            blockedByAllowlist: true,
            output: deps.buildAllowlistBlockedResponse({
                requestedCommand: 'auto',
                requestedRoute: routed.route,
            }),
        };
    }

    const delegated = deps.enqueueHubDelegationCommand({
        route: routed.route,
        payload: routed.payload,
        originalMessage: normalizedAutoMessage,
        rawText: fullText,
        telegramContext: autoTelegramContext,
    });
    if (delegated) {
        const output = deps.withApiMeta(delegated, {
            route: routed.route,
            routeHint: `hub-delegation:${delegated.targetProfile}`,
            commandText: normalizedAutoMessage,
        });
        rememberAutoResult(followupSessionKey, output, deps);
        return {
            handled: true,
            output,
        };
    }

    const autoRouteResult = await deps.handleAutoRoutedCommand({
        routed,
        fullText,
        toeicDeck,
        toeicTags,
        env,
    }, deps.autoRouteDeps || {});
    rememberAutoResult(followupSessionKey, autoRouteResult, deps);
    return {
        handled: true,
        output: autoRouteResult,
    };
}

module.exports = {
    handleAutoBridgeCommand,
};
