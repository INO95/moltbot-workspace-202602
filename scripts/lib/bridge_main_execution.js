async function executeBridgeMainExecution(context = {}, deps = {}) {
    const preflight = deps.runBridgePreflight({
        normalizedCommand: context.normalizedCommand,
        fullText: context.fullText,
        argsCount: context.argsCount,
    }, {
        opsLogger: deps.opsLogger,
        opsContext: context.opsContext,
        captureConversationSafe: deps.captureConversationSafe,
        knownDirectCommands: deps.knownDirectCommands,
        isDirectCommandAllowed: deps.isDirectCommandAllowed,
        buildAllowlistBlockedResponse: deps.buildAllowlistBlockedResponse,
    });

    if (preflight.blocked) {
        deps.emitOutput(preflight.output);
        deps.markCommandAllowlistBlocked(context.runOutcome);
        return {
            blocked: true,
            attempt: Number(context.attempt || 1),
        };
    }

    const dispatchDeps = deps.buildDispatchDeps(context.opsContext);
    const attempt = await deps.executeBridgeRunLoop({
        initialAttempt: context.attempt,
        maxAttempts: context.maxAttempts,
        normalizedCommand: context.normalizedCommand,
        command: context.command,
        fullText: context.fullText,
        args: context.args,
        toeicDeck: context.toeicDeck,
        toeicTags: context.toeicTags,
        env: context.env || process.env,
    }, {
        opsLogger: deps.opsLogger,
        opsContext: context.opsContext,
        dispatchBridgeCommandOnce: deps.dispatchBridgeCommandOnce,
        dispatchDeps,
        markAutoRouteAllowlistBlocked: deps.markAutoRouteAllowlistBlocked,
        markRunSuccess: deps.markRunSuccess,
        runOutcome: context.runOutcome,
        isRetriableError: deps.isRetriableError,
        buildBridgeRetryLogPayload: deps.buildBridgeRetryLogPayload,
        sleep: deps.sleep,
        retryBackoffMs: deps.retryBackoffMs,
        emitOutput: deps.emitOutput,
    });

    return {
        blocked: false,
        attempt,
    };
}

module.exports = {
    executeBridgeMainExecution,
};
