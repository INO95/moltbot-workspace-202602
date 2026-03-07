function resolveHubDelegationTarget(route, deps = {}) {
  const active = Boolean(deps.active);
  const routeToProfile = deps.routeToProfile && typeof deps.routeToProfile === 'object'
    ? deps.routeToProfile
    : {};
  if (!active) return null;
  const key = String(route || '').trim().toLowerCase();
  if (!key || key === 'none') return null;
  const target = String(routeToProfile[key] || '').trim().toLowerCase();
  if (!target) return null;
  if (target === 'daily' || target === 'local' || target === 'self') return null;
  return target;
}

function enqueueHubDelegationCommand(input = {}, deps = {}) {
  const resolveTarget = typeof deps.resolveHubDelegationTarget === 'function'
    ? deps.resolveHubDelegationTarget
    : (route) => resolveHubDelegationTarget(route, deps);
  const normalizeRequester = deps.normalizeRequester;
  const enqueueCapabilityCommand = deps.enqueueCapabilityCommand;
  const parseTransportEnvelopeContext = deps.parseTransportEnvelopeContext;

  if (typeof normalizeRequester !== 'function'
      || typeof enqueueCapabilityCommand !== 'function'
      || typeof parseTransportEnvelopeContext !== 'function') {
    throw new Error('enqueueHubDelegationCommand requires normalizeRequester/enqueueCapabilityCommand/parseTransportEnvelopeContext deps');
  }

  const route = String(input.route || '').trim();
  const targetProfile = resolveTarget(route);
  if (!targetProfile) return null;

  const normalizedOriginal = String(input.originalMessage || '').trim();
  if (!normalizedOriginal) return null;

  const telegramContext = input.telegramContext || parseTransportEnvelopeContext(input.rawText || '');
  const requestedBy = normalizeRequester(telegramContext, 'hub:auto');
  const queued = enqueueCapabilityCommand({
    phase: 'plan',
    capability: 'bot',
    action: 'dispatch',
    requested_by: requestedBy,
    telegram_context: telegramContext,
    reason: `hub_delegation:${route}`,
    risk_tier: 'MEDIUM',
    requires_approval: false,
    payload: {
      route: route.toLowerCase(),
      route_payload: String(input.payload || '').trim(),
      original_message: normalizedOriginal,
      target_profile: targetProfile,
      target: targetProfile,
    },
  });

  return {
    route: route.toLowerCase() || 'none',
    delegated: true,
    targetProfile,
    queued: true,
    phase: 'plan',
    capability: 'bot',
    capabilityAction: 'dispatch',
    requestId: queued.requestId,
    telegramContext: telegramContext || null,
    telegramReply: [
      `허브 위임 접수: ${route} -> ${targetProfile}`,
      `- request: ${queued.requestId}`,
      '- 결과는 역할 봇 처리 후 자동 회신됩니다.',
    ].join('\n'),
  };
}

module.exports = {
  resolveHubDelegationTarget,
  enqueueHubDelegationCommand,
};
