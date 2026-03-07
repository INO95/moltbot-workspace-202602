function createBridgeRunOutcome() {
  return {
    finalError: null,
    finalStatus: 'ok',
    finalSeverity: 'P3',
    finalMessage: 'Run completed successfully.',
  };
}

function markCommandAllowlistBlocked(outcome) {
  outcome.finalStatus = 'warn';
  outcome.finalSeverity = 'P3';
  outcome.finalMessage = 'Command blocked by allowlist policy.';
  return outcome;
}

function markAutoRouteAllowlistBlocked(outcome) {
  outcome.finalStatus = 'warn';
  outcome.finalSeverity = 'P3';
  outcome.finalMessage = 'Auto route blocked by allowlist policy.';
  return outcome;
}

function markRunSuccess(outcome, attempt) {
  if (outcome.finalStatus === 'warn') return outcome;
  outcome.finalStatus = attempt > 1 ? 'warn' : 'ok';
  outcome.finalSeverity = 'P3';
  outcome.finalMessage = attempt > 1
    ? 'Run completed after retry.'
    : 'Run completed successfully.';
  return outcome;
}

function markRunFailure(outcome, error) {
  outcome.finalError = error;
  outcome.finalStatus = 'error';
  outcome.finalSeverity = /(eacces|permission denied)/i.test(String(error && (error.code || error.message || error)))
    ? 'P1'
    : 'P2';
  outcome.finalMessage = 'Run failed with error.';
  return outcome;
}

function buildBridgeRetryLogPayload(attemptError, context = {}) {
  const attempt = Number(context.attempt || 1);
  const maxAttempts = Number(context.maxAttempts || 1);
  const normalizedCommand = String(context.normalizedCommand || '').trim().toLowerCase();
  return {
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
  };
}

function buildBridgeRunEndPayload(outcome, context = {}, deps = {}) {
  const normalizedCommand = String(context.normalizedCommand || '').trim().toLowerCase();
  const maxAttempts = Number(context.maxAttempts || 1);
  const attempt = Number(context.attempt || 1);
  const fullText = String(context.fullText || '');
  const isRetriableError = typeof deps.isRetriableError === 'function'
    ? deps.isRetriableError
    : () => false;
  return {
    status: outcome.finalStatus,
    severity: outcome.finalSeverity,
    component: 'bridge',
    action: normalizedCommand || 'unknown',
    message: outcome.finalMessage,
    attempt,
    max_attempts: maxAttempts,
    error: outcome.finalError
      ? {
        type: outcome.finalError.name || 'Error',
        code: outcome.finalError.code || '',
        message: outcome.finalError.message || String(outcome.finalError),
        stack: outcome.finalError.stack || '',
        retriable: isRetriableError(outcome.finalError),
      }
      : undefined,
    metrics: {
      command: normalizedCommand || '',
      full_text_chars: fullText.length,
    },
  };
}

module.exports = {
  createBridgeRunOutcome,
  markCommandAllowlistBlocked,
  markAutoRouteAllowlistBlocked,
  markRunSuccess,
  markRunFailure,
  buildBridgeRetryLogPayload,
  buildBridgeRunEndPayload,
};
