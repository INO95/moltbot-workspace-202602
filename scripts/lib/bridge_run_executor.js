async function executeBridgeRunLoop(context = {}, deps = {}) {
  let attempt = Number(context.initialAttempt || 1);
  const maxAttempts = Number(context.maxAttempts || 1);
  const retryBackoffMs = Array.isArray(deps.retryBackoffMs) ? deps.retryBackoffMs : [0];
  const emitOutput = typeof deps.emitOutput === 'function'
    ? deps.emitOutput
    : () => {};

  while (attempt <= maxAttempts) {
    try {
      if (attempt > 1) {
        deps.opsLogger.logStep(deps.opsContext, {
          component: 'bridge',
          action: 'retry_dispatch',
          message: `Retry dispatch attempt ${attempt}/${maxAttempts}.`,
          status: 'warn',
          severity: 'P3',
          attempt,
          max_attempts: maxAttempts,
        });
      } else {
        deps.opsLogger.logStep(deps.opsContext, {
          component: 'bridge',
          action: 'dispatch',
          message: `Dispatching command ${context.normalizedCommand || 'none'}.`,
          attempt,
          max_attempts: maxAttempts,
        });
      }

      const dispatchResult = await deps.dispatchBridgeCommandOnce({
        normalizedCommand: context.normalizedCommand,
        command: context.command,
        fullText: context.fullText,
        args: context.args,
        toeicDeck: context.toeicDeck,
        toeicTags: context.toeicTags,
        env: context.env || process.env,
      }, deps.dispatchDeps);
      if (dispatchResult.warnType === 'auto-allowlist') {
        deps.markAutoRouteAllowlistBlocked(deps.runOutcome);
      }
      emitOutput(dispatchResult.output);
      deps.markRunSuccess(deps.runOutcome, attempt);
      return attempt;
    } catch (attemptError) {
      const retriable = deps.isRetriableError(attemptError);
      if (attempt < maxAttempts && retriable) {
        deps.opsLogger.logRetry(deps.opsContext, deps.buildBridgeRetryLogPayload(attemptError, {
          attempt,
          maxAttempts,
          normalizedCommand: context.normalizedCommand,
        }));
        const delay = retryBackoffMs[Math.min(attempt - 1, retryBackoffMs.length - 1)] || 0;
        await deps.sleep(delay);
        attempt += 1;
        continue;
      }
      throw attemptError;
    }
  }

  return attempt;
}

module.exports = {
  executeBridgeRunLoop,
};
