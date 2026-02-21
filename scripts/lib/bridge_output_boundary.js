const SAFE_INTERNAL_ERROR_REPLY = '실패\n원인: 내부 실행 오류가 발생했어.\n다음 조치: 잠시 후 다시 시도해줘.';

function defaultSanitizeForUser(text) {
  const raw = String(text || '').trim();
  return raw || SAFE_INTERNAL_ERROR_REPLY;
}

function finalizeTelegramBoundary(base, metaInput = {}, deps = {}) {
  const applyDailyPersonaToOutput = deps.applyDailyPersonaToOutput;
  const appendExternalLinks = deps.appendExternalLinks;
  const parseTransportEnvelopeContext = deps.parseTransportEnvelopeContext;
  const normalizeRequester = deps.normalizeRequester;
  const finalizeTelegramReply = deps.finalizeTelegramReply;
  const sanitizeForUser = deps.sanitizeForUser || defaultSanitizeForUser;
  const enforcePersonaReply = deps.enforcePersonaReply;
  const dailyPersonaConfig = deps.dailyPersonaConfig || {};
  const env = deps.env && typeof deps.env === 'object' ? deps.env : process.env;

  if (typeof applyDailyPersonaToOutput !== 'function') return base;
  if (typeof appendExternalLinks !== 'function') return base;
  if (typeof parseTransportEnvelopeContext !== 'function') return base;
  if (typeof normalizeRequester !== 'function') return base;
  if (typeof finalizeTelegramReply !== 'function') return base;
  if (typeof enforcePersonaReply !== 'function') return base;

  const prepared = applyDailyPersonaToOutput(base, metaInput);
  if (!prepared || typeof prepared !== 'object') return prepared;
  if (prepared.finalizerApplied) return prepared;
  if (typeof prepared.telegramReply !== 'string' || !String(prepared.telegramReply).trim()) return prepared;

  const sanitizedReply = sanitizeForUser(prepared.telegramReply);
  const appended = appendExternalLinks(sanitizedReply);
  const commandText = String(metaInput.commandText || '').trim();
  const telegramContext = metaInput.telegramContext
    || prepared.telegramContext
    || parseTransportEnvelopeContext(commandText);
  const requestedBy = String(
    metaInput.requestedBy
    || prepared.requestedBy
    || normalizeRequester(telegramContext, 'bridge:auto'),
  ).trim();
  const finalized = finalizeTelegramReply(appended, {
    botId: env.MOLTBOT_BOT_ID,
    botRole: env.MOLTBOT_BOT_ROLE,
    profile: env.MOLTBOT_PROFILE || env.OPENCLAW_PROFILE || '',
    telegramContext,
    requestedBy,
    route: String(metaInput.route || prepared.route || '').trim().toLowerCase(),
    finalizerApplied: false,
  });
  const personaSafe = enforcePersonaReply(finalized || appended, {
    route: String(metaInput.route || prepared.route || '').trim().toLowerCase(),
    botId: String(env.MOLTBOT_BOT_ID || '').trim().toLowerCase(),
    profile: String(env.MOLTBOT_PROFILE || env.OPENCLAW_PROFILE || '').trim().toLowerCase(),
    config: dailyPersonaConfig,
  });

  return {
    ...prepared,
    telegramReply: String(personaSafe || appended).trim() || String(appended || '').trim(),
    telegramContext: telegramContext || null,
    requestedBy: requestedBy || undefined,
    finalizerApplied: true,
  };
}

module.exports = {
  finalizeTelegramBoundary,
};

