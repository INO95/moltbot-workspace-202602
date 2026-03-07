function runBridgePreflight(context = {}, deps = {}) {
    const normalizedCommand = String(context.normalizedCommand || '').trim().toLowerCase();
    const fullText = String(context.fullText || '');
    const argsCount = Number(context.argsCount || 0);

    deps.opsLogger.logStep(deps.opsContext, {
        component: 'bridge',
        action: 'command_received',
        message: `Command received: ${normalizedCommand || 'none'}.`,
        metrics: { args_count: argsCount },
    });

    if (normalizedCommand && normalizedCommand !== 'auto') {
        const rawCommandText = fullText
            ? `${normalizedCommand}: ${fullText}`
            : normalizedCommand;
        deps.captureConversationSafe({
            route: normalizedCommand,
            message: rawCommandText,
            source: 'user',
            skillHint: normalizedCommand,
        });
    }

    if (deps.knownDirectCommands.has(normalizedCommand) && !deps.isDirectCommandAllowed(normalizedCommand)) {
        return {
            blocked: true,
            output: deps.buildAllowlistBlockedResponse({
                requestedCommand: normalizedCommand,
            }),
        };
    }

    return {
        blocked: false,
        output: null,
    };
}

module.exports = {
    runBridgePreflight,
};
