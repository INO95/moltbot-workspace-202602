function prepareOpsCommandContext(payloadText, options = {}, deps = {}) {
  const normalizeOpsPayloadText = deps.normalizeOpsPayloadText;
  const parseStructuredCommand = deps.parseStructuredCommand;
  const normalizeOpsAction = deps.normalizeOpsAction;
  const normalizeOpsTarget = deps.normalizeOpsTarget;
  const parseTransportEnvelopeContext = deps.parseTransportEnvelopeContext;
  const resolveOpsFilePolicy = deps.resolveOpsFilePolicy;
  const normalizeRequester = deps.normalizeRequester;
  const isFileControlAction = deps.isFileControlAction;
  const enforceFileControlTelegramGuard = deps.enforceFileControlTelegramGuard;

  if (typeof normalizeOpsPayloadText !== 'function'
      || typeof parseStructuredCommand !== 'function'
      || typeof normalizeOpsAction !== 'function'
      || typeof normalizeOpsTarget !== 'function'
      || typeof parseTransportEnvelopeContext !== 'function'
      || typeof resolveOpsFilePolicy !== 'function'
      || typeof normalizeRequester !== 'function'
      || typeof isFileControlAction !== 'function'
      || typeof enforceFileControlTelegramGuard !== 'function') {
    throw new Error('prepareOpsCommandContext dependencies are incomplete');
  }

  const normalized = normalizeOpsPayloadText(payloadText);
  const parsed = parseStructuredCommand('ops', normalized.payloadText);
  if (!parsed.ok) {
    return {
      ok: false,
      result: { route: 'ops', templateValid: false, ...parsed },
    };
  }

  const action = normalizeOpsAction(parsed.fields.액션);
  const targetKey = normalizeOpsTarget(parsed.fields.대상);
  const telegramContext = options.telegramContext || parseTransportEnvelopeContext(options.rawText || '');
  const policy = resolveOpsFilePolicy();
  const requestedBy = normalizeRequester(telegramContext, options.requestedBy || '');

  if (!action) {
    return {
      ok: false,
        result: {
          route: 'ops',
          templateValid: false,
          error: '지원하지 않는 액션입니다.',
          telegramReply: '운영 템플릿 액션은 `재시작`, `상태`, `파일`, `실행`, `코덱스`, `메일`, `사진`, `일정`, `브라우저`, `토큰`, `페르소나`, `승인`, `거부`만 지원합니다.',
        },
      };
  }

  if (isFileControlAction(action)) {
    const guard = enforceFileControlTelegramGuard(telegramContext, policy);
    if (!guard.ok) {
      return {
        ok: false,
        result: {
          route: 'ops',
          templateValid: true,
          success: false,
          action,
          errorCode: guard.code,
          telegramReply: `파일 제어 정책 차단: ${guard.message}`,
        },
      };
    }
  }

  return {
    ok: true,
    context: {
      normalized,
      parsed,
      action,
      targetKey,
      telegramContext,
      policy,
      requestedBy,
    },
  };
}

function dispatchOpsAction(context = {}, deps = {}) {
  const handleOpsStatusAction = deps.handleOpsStatusAction;
  const handleOpsTokenAction = deps.handleOpsTokenAction;
  const handleOpsRestartAction = deps.handleOpsRestartAction;
  const handleOpsFileAction = deps.handleOpsFileAction;
  const handleOpsCapabilityAction = deps.handleOpsCapabilityAction;
  const handleOpsPersonaAction = deps.handleOpsPersonaAction;
  const handleOpsApproveAction = deps.handleOpsApproveAction;
  const handleOpsDenyAction = deps.handleOpsDenyAction;

  if (typeof handleOpsStatusAction !== 'function'
      || typeof handleOpsTokenAction !== 'function'
      || typeof handleOpsRestartAction !== 'function'
      || typeof handleOpsFileAction !== 'function'
      || typeof handleOpsCapabilityAction !== 'function'
      || typeof handleOpsPersonaAction !== 'function'
      || typeof handleOpsApproveAction !== 'function'
      || typeof handleOpsDenyAction !== 'function') {
    throw new Error('dispatchOpsAction dependencies are incomplete');
  }

  const action = String(context.action || '').trim().toLowerCase();
  const parsed = context.parsed || {};
  const normalized = context.normalized || {};
  const requestedBy = context.requestedBy || '';
  const telegramContext = context.telegramContext || null;
  const policy = context.policy || null;
  const targetKey = context.targetKey || '';

  if (action === 'status') {
    return handleOpsStatusAction(action, targetKey);
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
  if (action === 'mail' || action === 'photo' || action === 'schedule' || action === 'browser' || action === 'exec' || action === 'codex') {
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

module.exports = {
  prepareOpsCommandContext,
  dispatchOpsAction,
};
