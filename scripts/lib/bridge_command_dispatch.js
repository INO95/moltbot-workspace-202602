async function dispatchBridgeCommandOnce(context = {}, deps = {}) {
    const normalizedCommand = String(context.normalizedCommand || '').trim().toLowerCase();

    const directResult = await deps.handleDirectBridgeCommand({
        normalizedCommand,
        fullText: context.fullText,
        args: context.args,
        toeicDeck: context.toeicDeck,
        toeicTags: context.toeicTags,
    }, deps.directCommandDeps || {});
    if (directResult && directResult.handled) {
        return {
            output: directResult.output,
            warnType: '',
        };
    }

    if (normalizedCommand === 'auto') {
        const autoResult = await deps.handleAutoBridgeCommand({
            fullText: context.fullText,
            toeicDeck: context.toeicDeck,
            toeicTags: context.toeicTags,
            env: context.env || process.env,
        }, {
            normalizeIncomingCommandText: deps.normalizeIncomingCommandText,
            parseTransportEnvelopeContext: deps.parseTransportEnvelopeContext,
            normalizeRequester: deps.normalizeRequester,
            handleCodexBotAutoCommand: deps.handleCodexBotAutoCommand,
            withApiMeta: deps.withApiMeta,
            parseReportModeCommand: deps.parseReportModeCommand,
            writeReportMode: deps.writeReportMode,
            routeByPrefix: deps.routeByPrefix,
            logAutoRoute: ({ routed }) => deps.logAutoRoute({ routed }),
            captureConversationSafe: deps.captureConversationSafe,
            isResultFollowupQuery: deps.isResultFollowupQuery,
            resolveRecentResult: deps.resolveRecentResult,
            rememberActionableResult: deps.rememberActionableResult,
            followupStatePath: deps.followupStatePath,
            followupTtlMs: deps.followupTtlMs,
            followupMaxEntriesPerSession: deps.followupMaxEntriesPerSession,
            followupMaxSessions: deps.followupMaxSessions,
            followupResultKeywords: deps.followupResultKeywords,
            isAutoRouteAllowed: deps.isAutoRouteAllowed,
            buildAllowlistBlockedResponse: deps.buildAllowlistBlockedResponse,
            enqueueHubDelegationCommand: deps.enqueueHubDelegationCommand,
            handleAutoRoutedCommand: deps.handleAutoRoutedCommand,
            autoRouteDeps: {
                withApiMeta: deps.withApiMeta,
                appendExternalLinks: deps.appendExternalLinks,
                pickPreferredModelMeta: deps.pickPreferredModelMeta,
                normalizeNewsCommandPayload: deps.normalizeNewsCommandPayload,
                normalizeReportNewsPayload: deps.normalizeReportNewsPayload,
                isResearchRuntime: deps.isResearchRuntime,
                parseStructuredCommand: deps.parseStructuredCommand,
                buildCodexDegradedMeta: deps.buildCodexDegradedMeta,
                buildDuelModeMeta: deps.buildDuelModeMeta,
                buildProjectRoutePayload: deps.buildProjectRoutePayload,
                handlePromptPayload: deps.handlePromptPayload,
                buildLinkOnlyReply: deps.buildLinkOnlyReply,
                buildQuickStatusReply: deps.buildQuickStatusReply,
                parseTransportEnvelopeContext: deps.parseTransportEnvelopeContext,
                runOpsCommand: deps.runOpsCommand,
                inferPathListReply: deps.inferPathListReply,
                buildGogNoPrefixGuide: deps.buildGogNoPrefixGuide,
                buildNoPrefixReply: (text) => deps.buildNoPrefixReply(text, {
                    isHubRuntime: deps.isHubRuntime(context.env || process.env),
                }, {
                    buildDailyCasualNoPrefixReply: deps.buildDailyCasualNoPrefixReply,
                    buildNoPrefixGuide: deps.buildNoPrefixGuide,
                }),
                handlePersonalRoute: deps.handlePersonalRoute,
                processWordTokens: deps.processWordTokens,
                handleMemoCommand: async (text) => deps.loadMemoJournal().handleMemoCommand(text),
                handleNewsCommand: async (text) => deps.loadNewsDigest().handleNewsCommand(text),
                publishFromReports: async () => deps.loadBlogPublisher().publishFromReports(),
                buildWeeklyReport: async () => deps.loadWeeklyReport().buildWeeklyReport(),
                buildDailySummary: async () => deps.loadDailySummary().buildDailySummary(),
            },
        });

        return {
            output: autoResult.output,
            warnType: autoResult && autoResult.blockedByAllowlist ? 'auto-allowlist' : '',
        };
    }

    throw new Error(`Unknown command: ${context.command}`);
}

module.exports = {
    dispatchBridgeCommandOnce,
};
