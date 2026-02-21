function resolveApprovalSelection({
  parsed = {},
  normalized = {},
  requestedBy = '',
  telegramContext = null,
  action = 'approve',
  triggerInlineOpsWorker,
  resolveApprovalTokenFromHint,
  resolveApprovalTokenSelection,
} = {}) {
  const fields = parsed && parsed.fields && typeof parsed.fields === 'object'
    ? parsed.fields
    : {};
  const queryText = String(fields.식별자 || fields.작업 || fields.내용 || '').trim();
  const shorthand = action === 'deny'
    ? (normalized && normalized.denyShorthand)
    : (normalized && normalized.approveShorthand);
  const explicitToken = String(fields.토큰 || (shorthand && shorthand.token) || '').trim();
  const useImplicitSelection = !explicitToken && !queryText;

  if (useImplicitSelection) {
    triggerInlineOpsWorker();
  }

  const hinted = useImplicitSelection
    ? resolveApprovalTokenFromHint(requestedBy, telegramContext)
    : { token: '', row: null, hint: null, found: false };
  const selection = explicitToken
    ? { token: explicitToken, row: null, candidates: [], matchedByRequester: true }
    : (hinted && hinted.found
      ? { token: hinted.token, row: hinted.row, candidates: hinted.row ? [hinted.row] : [], matchedByRequester: true }
      : resolveApprovalTokenSelection({
        query: queryText,
        requestedBy,
        telegramContext,
      }));

  const token = String(selection.token || '').trim();
  const waitingHint = hinted && hinted.hint && !hinted.found
    ? String(hinted.hint.requestId || '').trim()
    : '';
  return { token, waitingHint, selection };
}

function handleOpsApproveAction({
  parsed = {},
  normalized = {},
  requestedBy = '',
  telegramContext = null,
  policy = null,
} = {}, deps = {}) {
  const isUnifiedApprovalEnabled = deps.isUnifiedApprovalEnabled;
  const normalizeOpsOptionFlags = deps.normalizeOpsOptionFlags;
  const triggerInlineOpsWorker = deps.triggerInlineOpsWorker;
  const resolveApprovalTokenFromHint = deps.resolveApprovalTokenFromHint;
  const resolveApprovalTokenSelection = deps.resolveApprovalTokenSelection;
  const resolveApprovalFlagsForToken = deps.resolveApprovalFlagsForToken;
  const enqueueFileControlCommand = deps.enqueueFileControlCommand;
  const normalizeOpsFileIntent = deps.normalizeOpsFileIntent;
  const clearLastApprovalHint = deps.clearLastApprovalHint;
  const isApprovalGrantEnabled = deps.isApprovalGrantEnabled;

  if (typeof isUnifiedApprovalEnabled !== 'function'
      || typeof normalizeOpsOptionFlags !== 'function'
      || typeof triggerInlineOpsWorker !== 'function'
      || typeof resolveApprovalTokenFromHint !== 'function'
      || typeof resolveApprovalTokenSelection !== 'function'
      || typeof resolveApprovalFlagsForToken !== 'function'
      || typeof enqueueFileControlCommand !== 'function'
      || typeof normalizeOpsFileIntent !== 'function'
      || typeof clearLastApprovalHint !== 'function'
      || typeof isApprovalGrantEnabled !== 'function') {
    throw new Error('handleOpsApproveAction dependencies are incomplete');
  }

  if (!isUnifiedApprovalEnabled()) {
    return {
      route: 'ops',
      templateValid: true,
      success: true,
      action: 'approve',
      telegramReply: '승인 토큰 제도는 비활성화되어 있습니다. 실행 요청은 자동 처리됩니다.',
    };
  }

  const fields = parsed && parsed.fields && typeof parsed.fields === 'object'
    ? parsed.fields
    : {};
  const providedApproveFlags = normalizeOpsOptionFlags([
    ...((normalized && normalized.approveShorthand) ? normalized.approveShorthand.flags : []),
    ...normalizeOpsOptionFlags(fields.옵션 || ''),
  ]);
  const { token, waitingHint, selection } = resolveApprovalSelection({
    parsed,
    normalized,
    requestedBy,
    telegramContext,
    action: 'approve',
    triggerInlineOpsWorker,
    resolveApprovalTokenFromHint,
    resolveApprovalTokenSelection,
  });

  if (!token) {
    return {
      route: 'ops',
      templateValid: false,
      success: false,
      action: 'approve',
      errorCode: 'TOKEN_REQUIRED',
      telegramReply: waitingHint
        ? `방금 요청(${waitingHint}) 승인 토큰을 준비 중입니다. 잠시 후 \`승인\`을 다시 보내주세요.`
        : '현재 승인 대기 중인 요청이 없습니다.',
    };
  }

  const approveFlags = resolveApprovalFlagsForToken(token, providedApproveFlags);
  const queued = enqueueFileControlCommand({
    phase: 'execute',
    intent_action: normalizeOpsFileIntent(fields.작업 || '') || 'execute',
    requested_by: requestedBy,
    telegram_context: telegramContext,
    payload: {
      token,
      approval_flags: approveFlags,
      decision: 'approve',
    },
  });
  clearLastApprovalHint(requestedBy, telegramContext);
  triggerInlineOpsWorker();
  return {
    route: 'ops',
    templateValid: true,
    success: true,
    queued: true,
    phase: 'execute',
    action: 'approve',
    requestId: queued.requestId,
    token,
    approvalFlags: approveFlags,
    telegramContext,
    telegramReply: [
      '승인 반영 완료. 실행을 시작했습니다.',
      selection.row && selection.row.request_id
        ? `- request: ${String(selection.row.request_id)}`
        : '',
      `- flags: ${approveFlags.length > 0 ? approveFlags.map((flag) => `--${flag}`).join(' ') : '(none)'}`,
      `- execution: ${queued.requestId}`,
      isApprovalGrantEnabled(policy)
        ? '- 승인 성공 시 일정 시간 전체 권한 세션이 열립니다.'
        : '',
    ].filter(Boolean).join('\n'),
  };
}

function handleOpsDenyAction({
  parsed = {},
  normalized = {},
  requestedBy = '',
  telegramContext = null,
} = {}, deps = {}) {
  const isUnifiedApprovalEnabled = deps.isUnifiedApprovalEnabled;
  const triggerInlineOpsWorker = deps.triggerInlineOpsWorker;
  const resolveApprovalTokenFromHint = deps.resolveApprovalTokenFromHint;
  const resolveApprovalTokenSelection = deps.resolveApprovalTokenSelection;
  const enqueueFileControlCommand = deps.enqueueFileControlCommand;
  const clearLastApprovalHint = deps.clearLastApprovalHint;

  if (typeof isUnifiedApprovalEnabled !== 'function'
      || typeof triggerInlineOpsWorker !== 'function'
      || typeof resolveApprovalTokenFromHint !== 'function'
      || typeof resolveApprovalTokenSelection !== 'function'
      || typeof enqueueFileControlCommand !== 'function'
      || typeof clearLastApprovalHint !== 'function') {
    throw new Error('handleOpsDenyAction dependencies are incomplete');
  }

  if (!isUnifiedApprovalEnabled()) {
    return {
      route: 'ops',
      templateValid: true,
      success: true,
      action: 'deny',
      telegramReply: '승인 토큰 제도는 비활성화되어 있어 거부할 토큰이 없습니다.',
    };
  }

  const { token, waitingHint, selection } = resolveApprovalSelection({
    parsed,
    normalized,
    requestedBy,
    telegramContext,
    action: 'deny',
    triggerInlineOpsWorker,
    resolveApprovalTokenFromHint,
    resolveApprovalTokenSelection,
  });
  if (!token) {
    return {
      route: 'ops',
      templateValid: false,
      success: false,
      action: 'deny',
      errorCode: 'TOKEN_REQUIRED',
      telegramReply: waitingHint
        ? `방금 요청(${waitingHint}) 승인 토큰을 준비 중입니다. 잠시 후 \`거부\`를 다시 보내주세요.`
        : '현재 거부할 승인 대기 요청이 없습니다.',
    };
  }

  const queued = enqueueFileControlCommand({
    phase: 'execute',
    intent_action: 'execute',
    requested_by: requestedBy,
    telegram_context: telegramContext,
    payload: {
      token,
      decision: 'deny',
    },
  });
  clearLastApprovalHint(requestedBy, telegramContext);
  triggerInlineOpsWorker();
  return {
    route: 'ops',
    templateValid: true,
    success: true,
    queued: true,
    phase: 'execute',
    action: 'deny',
    requestId: queued.requestId,
    token,
    decision: 'deny',
    telegramContext,
    telegramReply: [
      '승인 거부 반영 완료.',
      selection.row && selection.row.request_id
        ? `- request: ${String(selection.row.request_id)}`
        : '',
      `- execution: ${queued.requestId}`,
    ].filter(Boolean).join('\n'),
  };
}

module.exports = {
  handleOpsApproveAction,
  handleOpsDenyAction,
};
