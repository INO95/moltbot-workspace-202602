function handleOpsRestartAction({
  action = 'restart',
  targetKey = '',
  parsed = {},
} = {}, deps = {}) {
  const allowedTargets = deps.allowedTargets;
  const queueOpsRequest = deps.queueOpsRequest;
  if (!allowedTargets || typeof allowedTargets !== 'object') {
    throw new Error('allowedTargets dependency is required');
  }
  if (typeof queueOpsRequest !== 'function') {
    throw new Error('queueOpsRequest dependency is required');
  }

  if (!targetKey || !allowedTargets[targetKey]) {
    return {
      route: 'ops',
      templateValid: false,
      error: '지원하지 않는 대상입니다.',
      telegramReply: '운영 대상은 dev/anki/research/daily/dev_bak/anki_bak/research_bak/daily_bak/proxy/webproxy/tunnel/prompt/web/all 만 지원합니다. (legacy: main/sub1 지원)',
    };
  }
  const targets = Array.isArray(allowedTargets[targetKey])
    ? allowedTargets[targetKey]
    : [allowedTargets[targetKey]];
  const fields = parsed && parsed.fields && typeof parsed.fields === 'object'
    ? parsed.fields
    : {};
  const queued = queueOpsRequest(action, targetKey, targets, fields.사유 || '');
  return {
    route: 'ops',
    templateValid: true,
    success: true,
    queued: true,
    action,
    phase: 'execute',
    target: targetKey,
    requestId: queued.id,
    telegramReply: `운영 재시작 요청 접수: ${queued.id}\n호스트 작업 큐에서 순차 실행됩니다.`,
  };
}

function handleOpsFileAction({
  action = 'file',
  parsed = {},
  requestedBy = '',
  telegramContext = null,
} = {}, deps = {}) {
  const isUnifiedApprovalEnabled = deps.isUnifiedApprovalEnabled;
  const normalizeOpsFileIntent = deps.normalizeOpsFileIntent;
  const normalizeOpsOptionFlags = deps.normalizeOpsOptionFlags;
  const enqueueFileControlCommand = deps.enqueueFileControlCommand;
  if (typeof isUnifiedApprovalEnabled !== 'function'
      || typeof normalizeOpsFileIntent !== 'function'
      || typeof normalizeOpsOptionFlags !== 'function'
      || typeof enqueueFileControlCommand !== 'function') {
    throw new Error('handleOpsFileAction dependencies are incomplete');
  }

  const unifiedApprovalsEnabled = isUnifiedApprovalEnabled();
  const fields = parsed && parsed.fields && typeof parsed.fields === 'object'
    ? parsed.fields
    : {};
  const intentAction = normalizeOpsFileIntent(fields.작업);
  if (!intentAction) {
    return {
      route: 'ops',
      templateValid: false,
      success: false,
      action,
      errorCode: 'FILE_ACTION_REQUIRED',
      telegramReply: [
        '파일 제어 작업이 필요합니다.',
        '지원 작업: list_files, compute_plan, move, rename, archive, trash, restore, drive_preflight_check, git_status, git_diff, git_mv, git_add, git_commit, git_push',
      ].join('\n'),
    };
  }

  const payload = {
    path: String(fields.경로 || '').trim(),
    target_path: String(fields.대상경로 || '').trim(),
    pattern: String(fields.패턴 || '').trim(),
    repository: String(fields.저장소 || '').trim(),
    commit_message: String(fields.커밋메시지 || '').trim(),
    options: normalizeOpsOptionFlags(fields.옵션 || ''),
  };
  const queued = enqueueFileControlCommand({
    phase: 'plan',
    intent_action: intentAction,
    requested_by: requestedBy,
    telegram_context: telegramContext,
    payload,
  });
  return {
    route: 'ops',
    templateValid: true,
    success: true,
    queued: true,
    phase: 'plan',
    action,
    intentAction,
    requestId: queued.requestId,
    telegramContext,
    telegramReply: [
      `파일 제어 PLAN 요청 접수: ${queued.requestId}`,
      unifiedApprovalsEnabled
        ? '- 기본 모드: dry-run (실행 전 승인 필요)'
        : '- 기본 모드: dry-run (승인 토큰 없이 자동 실행)',
      '- 호스트 runner가 위험도/정확 경로를 계산합니다.',
    ].join('\n'),
  };
}

function handleOpsCapabilityAction({
  action = '',
  parsed = {},
  requestedBy = '',
  telegramContext = null,
  policy = null,
} = {}, deps = {}) {
  const isUnifiedApprovalEnabled = deps.isUnifiedApprovalEnabled;
  const normalizeOpsCapabilityAction = deps.normalizeOpsCapabilityAction;
  const capabilityPolicyMap = deps.capabilityPolicyMap || {};
  const buildCapabilityPayload = deps.buildCapabilityPayload;
  const normalizeOpsOptionFlags = deps.normalizeOpsOptionFlags;
  const enqueueCapabilityCommand = deps.enqueueCapabilityCommand;
  const rememberLastApprovalHint = deps.rememberLastApprovalHint;
  const isApprovalGrantEnabled = deps.isApprovalGrantEnabled;
  if (typeof isUnifiedApprovalEnabled !== 'function'
      || typeof normalizeOpsCapabilityAction !== 'function'
      || typeof buildCapabilityPayload !== 'function'
      || typeof normalizeOpsOptionFlags !== 'function'
      || typeof enqueueCapabilityCommand !== 'function'
      || typeof rememberLastApprovalHint !== 'function'
      || typeof isApprovalGrantEnabled !== 'function') {
    throw new Error('handleOpsCapabilityAction dependencies are incomplete');
  }

  const unifiedApprovalsEnabled = isUnifiedApprovalEnabled();
  const fields = parsed && parsed.fields && typeof parsed.fields === 'object'
    ? parsed.fields
    : {};
  const capabilityAction = normalizeOpsCapabilityAction(action, fields.작업);
  const capabilityPolicy = capabilityPolicyMap[action] || {};
  const capabilityRoutePolicy = (capabilityAction && capabilityPolicy[capabilityAction]) || null;
  if (!capabilityAction || !capabilityRoutePolicy) {
    const policyKeys = Object.keys(capabilityPolicy);
    return {
      route: 'ops',
      templateValid: false,
      success: false,
      action,
      errorCode: 'CAPABILITY_ACTION_REQUIRED',
      telegramReply: [
        `${action} 작업이 필요합니다.`,
        `지원 작업: ${policyKeys.length > 0 ? policyKeys.join(', ') : '(none)'}`,
      ].join('\n'),
    };
  }

  const payload = {
    ...buildCapabilityPayload(fields),
    options: normalizeOpsOptionFlags(fields.옵션 || ''),
  };
  if (action === 'exec') {
    const commandText = String(fields.작업 || fields.명령 || fields.내용 || payload.command || '').trim();
    if (!commandText) {
      return {
        route: 'ops',
        templateValid: false,
        success: false,
        action,
        errorCode: 'EXEC_COMMAND_REQUIRED',
        telegramReply: '실행 명령이 필요합니다. 예: 운영: 액션: 실행; 작업: ls -la',
      };
    }
    payload.command = commandText;
  }
  const queued = enqueueCapabilityCommand({
    phase: 'plan',
    capability: action,
    action: capabilityAction,
    requested_by: requestedBy,
    telegram_context: telegramContext,
    reason: String(fields.사유 || '').trim(),
    payload,
    risk_tier: capabilityRoutePolicy.risk_tier,
    requires_approval: capabilityRoutePolicy.requires_approval,
  });
  rememberLastApprovalHint({
    requestedBy,
    telegramContext,
    requestId: queued.requestId,
    capability: action,
    action: capabilityAction,
  });
  const approvalHint = !unifiedApprovalsEnabled
    ? '- 승인 토큰 정책이 비활성화되어 PLAN 검증 후 자동 실행됩니다.'
    : action === 'exec'
      ? (capabilityRoutePolicy.requires_approval
        ? '- 실행 요청은 승인 대기로 접수됩니다. `운영: 액션: 승인`으로 실행, `운영: 액션: 거부`로 취소할 수 있습니다.'
        : '- allowlist 검사 후 안전 명령은 자동 실행, 위험 명령은 승인 대기 후 `운영: 액션: 승인`으로 실행됩니다.')
      : (capabilityRoutePolicy.requires_approval
        ? '- 고위험 작업으로 분류되어 승인 대기됩니다. `운영: 액션: 승인`으로 실행, `운영: 액션: 거부`로 취소할 수 있습니다.'
        : '- 저위험 작업으로 분류되어 PLAN 검증 후 호스트 runner가 즉시 실행합니다.');
  const grantHint = (unifiedApprovalsEnabled && capabilityRoutePolicy.requires_approval && isApprovalGrantEnabled(policy))
    ? '- 승인 성공 시 일정 시간 전체 권한 세션이 열려, 추가 고위험 작업이 토큰 없이 실행될 수 있습니다.'
    : '';
  return {
    route: 'ops',
    templateValid: true,
    success: true,
    queued: true,
    phase: 'plan',
    action,
    capability: action,
    capabilityAction,
    requestId: queued.requestId,
    riskTier: capabilityRoutePolicy.risk_tier,
    requiresApproval: Boolean(capabilityRoutePolicy.requires_approval),
    telegramContext,
    telegramReply: [
      `${action} ${capabilityAction.toUpperCase()} PLAN 요청 접수: ${queued.requestId}`,
      `- risk: ${capabilityRoutePolicy.risk_tier}`,
      approvalHint,
      grantHint,
    ].filter(Boolean).join('\n'),
  };
}

module.exports = {
  handleOpsRestartAction,
  handleOpsFileAction,
  handleOpsCapabilityAction,
};
