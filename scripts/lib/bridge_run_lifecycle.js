function startBridgeRunLifecycle(context = {}, deps = {}) {
  const normalizedCommand = String(context.normalizedCommand || '').trim().toLowerCase();
  const maxAttempts = Number(context.maxAttempts || 1);
  const argsCount = Number(context.argsCount || 0);

  const opsContext = deps.opsLogger.startRun({
    component: 'bridge',
    action: normalizedCommand || 'unknown',
    max_attempts: maxAttempts,
    message: 'Bridge command run started.',
    metrics: {
      args_count: argsCount,
    },
  });

  const stopHeartbeat = deps.opsLogger.startHeartbeatTicker(opsContext, {
    interval_ms: 5 * 60 * 1000,
    component: 'bridge',
    action: 'bridge_heartbeat',
    message: 'Bridge run heartbeat.',
  });

  return {
    opsContext,
    stopHeartbeat,
  };
}

function finishBridgeRunLifecycle(context = {}, deps = {}) {
  const stopHeartbeat = typeof context.stopHeartbeat === 'function'
    ? context.stopHeartbeat
    : () => {};
  stopHeartbeat();

  const payload = deps.buildBridgeRunEndPayload(context.runOutcome, {
    normalizedCommand: context.normalizedCommand,
    maxAttempts: context.maxAttempts,
    attempt: context.attempt,
    fullText: context.fullText,
  }, {
    isRetriableError: deps.isRetriableError,
  });
  deps.opsLogger.logEnd(context.opsContext, payload);
}

module.exports = {
  startBridgeRunLifecycle,
  finishBridgeRunLifecycle,
};
