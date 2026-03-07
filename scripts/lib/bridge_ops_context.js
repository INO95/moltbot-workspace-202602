const opsFileControlDefault = require('../ops_file_control');

function parseTransportEnvelopeContext(text) {
  const raw = String(text || '').trim();
  const envelope = raw.match(/^\s*\[(Telegram|WhatsApp|Discord|Slack|Signal|Line|Matrix|KakaoTalk|Kakao|iMessage|SMS)\b([^\]]*)\]\s*/i);
  if (!envelope) return null;
  const provider = String(envelope[1] || '').trim().toLowerCase();
  const header = String(envelope[2] || '').trim();
  const userIdMatch = header.match(/\bid\s*[:=]\s*([0-9-]{3,})/i);
  const groupIdMatch = header.match(/\b(?:group|chat|chat_id)\s*[:=]\s*([0-9-]{3,})/i);
  return {
    provider,
    userId: userIdMatch ? String(userIdMatch[1]).trim() : '',
    groupId: groupIdMatch ? String(groupIdMatch[1]).trim() : '',
    header,
  };
}

function resolveOpsFilePolicy(configInput = {}, deps = {}) {
  const loadPolicy = typeof deps.loadPolicy === 'function'
    ? deps.loadPolicy
    : opsFileControlDefault.loadPolicy;
  const baseConfig = (configInput && typeof configInput === 'object') ? configInput : {};
  const policyPatch = {
    ...((baseConfig.opsFileControlPolicy && typeof baseConfig.opsFileControlPolicy === 'object')
      ? baseConfig.opsFileControlPolicy
      : {}),
  };
  if (baseConfig.telegramGuard && typeof baseConfig.telegramGuard === 'object') {
    policyPatch.telegramGuard = {
      ...((policyPatch.telegramGuard && typeof policyPatch.telegramGuard === 'object') ? policyPatch.telegramGuard : {}),
      ...baseConfig.telegramGuard,
    };
  }
  return loadPolicy({
    ...baseConfig,
    opsFileControlPolicy: policyPatch,
  });
}

function isUnifiedApprovalEnabled(configInput = {}, envInput = process.env) {
  const env = envInput && typeof envInput === 'object' ? envInput : {};
  const config = (configInput && typeof configInput === 'object') ? configInput : {};
  const envRaw = String(env.MOLTBOT_DISABLE_APPROVAL_TOKENS || '').trim().toLowerCase();
  if (envRaw === '1' || envRaw === 'true' || envRaw === 'on') return false;
  if (envRaw === '0' || envRaw === 'false' || envRaw === 'off') return true;
  return !(
    config
    && typeof config === 'object'
    && config.opsUnifiedApprovals
    && typeof config.opsUnifiedApprovals === 'object'
    && config.opsUnifiedApprovals.enabled === false
  );
}

function normalizeOpsOptionFlags(value, deps = {}) {
  const normalizeApprovalFlags = typeof deps.normalizeApprovalFlags === 'function'
    ? deps.normalizeApprovalFlags
    : opsFileControlDefault.normalizeApprovalFlags;
  return normalizeApprovalFlags(value);
}

function normalizeOpsFileIntent(value, deps = {}) {
  const normalizeIntentAction = typeof deps.normalizeIntentAction === 'function'
    ? deps.normalizeIntentAction
    : opsFileControlDefault.normalizeIntentAction;
  return normalizeIntentAction(value);
}

function isFileControlAction(action) {
  return action === 'file';
}

function enforceFileControlTelegramGuard(telegramContext, policy) {
  const guard = (policy && policy.telegramGuard) || {};
  if (guard.enabled === false) return { ok: true };
  if (guard.requireContext !== false && (!telegramContext || !telegramContext.provider)) {
    return {
      ok: false,
      code: 'TELEGRAM_CONTEXT_REQUIRED',
      message: '파일 제어 요청은 Telegram 컨텍스트가 필요합니다.',
    };
  }
  if (!telegramContext || String(telegramContext.provider || '').toLowerCase() !== 'telegram') {
    return {
      ok: false,
      code: 'TELEGRAM_PROVIDER_REQUIRED',
      message: '파일 제어 요청은 Telegram 채널에서만 허용됩니다.',
    };
  }

  const userId = String(telegramContext.userId || '').trim();
  const groupId = String(telegramContext.groupId || '').trim();
  const allowedUsers = Array.isArray(guard.allowedUserIds) ? guard.allowedUserIds.map((x) => String(x)) : [];
  const allowedGroups = Array.isArray(guard.allowedGroupIds) ? guard.allowedGroupIds.map((x) => String(x)) : [];

  if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
    if (!userId) {
      return {
        ok: false,
        code: 'TELEGRAM_USER_REQUIRED',
        message: 'Telegram 사용자 ID가 없어 파일 제어 요청을 거부합니다.',
      };
    }
    return {
      ok: false,
      code: 'TELEGRAM_USER_NOT_ALLOWED',
      message: `허용되지 않은 Telegram 사용자입니다: ${userId || 'unknown'}`,
    };
  }

  if (allowedGroups.length > 0 && !groupId) {
    return {
      ok: false,
      code: 'TELEGRAM_GROUP_REQUIRED',
      message: 'Telegram 그룹 ID가 없어 파일 제어 요청을 거부합니다.',
    };
  }

  if (allowedGroups.length > 0 && groupId && !allowedGroups.includes(groupId)) {
    return {
      ok: false,
      code: 'TELEGRAM_GROUP_NOT_ALLOWED',
      message: `허용되지 않은 Telegram 그룹입니다: ${groupId}`,
    };
  }

  return { ok: true };
}

function isApprovalGrantEnabled(policy) {
  return Boolean(
    policy
    && policy.approvalGrantPolicy
    && typeof policy.approvalGrantPolicy === 'object'
    && policy.approvalGrantPolicy.enabled,
  );
}

function parseApproveShorthand(text, deps = {}) {
  const normalizeFlags = typeof deps.normalizeOpsOptionFlags === 'function'
    ? deps.normalizeOpsOptionFlags
    : (value) => normalizeOpsOptionFlags(value, deps);
  const raw = String(text || '').trim();
  if (!raw) return null;
  const conversationalApprove = /^(?:(?:응|네|예|그래|좋아|오케이|ㅇㅋ|ok|okay)\s*)?(?:승인(?:해|해줘|해주세요|해요|합니다)?|진행(?:해|해줘|해주세요|해요|합니다)?|go\s*ahead)\s*[.!~…]*$/i;
  const explicitApprove = /^\/?approve\b/i.test(raw);
  const conversational = conversationalApprove.test(raw);
  const tokenMatch = raw.match(/\bapv_[a-f0-9]{16}\b/i);
  const token = tokenMatch ? String(tokenMatch[0] || '').trim() : '';
  if (!explicitApprove && !conversational) return null;

  const tail = explicitApprove
    ? raw.replace(/^\/?approve\b/i, '').trim()
    : raw;
  const flagSource = token
    ? String(tail.replace(token, ' ') || '').trim()
    : tail;
  const flags = explicitApprove
    ? normalizeFlags(flagSource)
    : normalizeFlags((String(flagSource || '').match(/--[a-z0-9_-]+/gi) || []).join(' '));
  const flagText = flags.length > 0
    ? `; 옵션: ${flags.map((flag) => `--${flag}`).join(' ')}`
    : '';
  return {
    token,
    flags,
    normalizedPayload: token
      ? `액션: 승인; 토큰: ${token}${flagText}`
      : `액션: 승인${flagText}`,
  };
}

function parseDenyShorthand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const explicitDeny = /^\/?deny\b/i.test(raw);
  const conversationalDeny = /^(?:(?:응|네|예|그래|오케이|ㅇㅋ|ok|okay)\s*)?(?:거부|거절|취소)(?:해|해줘|해주세요|해요|합니다)?\s*[.!~…]*$/i.test(raw);
  const tokenMatch = raw.match(/\bapv_[a-f0-9]{16}\b/i);
  const token = tokenMatch ? String(tokenMatch[0] || '').trim() : '';
  if (!explicitDeny && !conversationalDeny) return null;
  return {
    token,
    normalizedPayload: token ? `액션: 거부; 토큰: ${token}` : '액션: 거부',
  };
}

function parseNaturalApprovalShorthand(text) {
  const raw = String(text || '')
    .trim()
    .replace(/[.!?~]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw.includes(':') || raw.includes('：') || raw.includes('/')) return null;

  if (/^(응\s*)?(승인|승인해|승인할게|진행|진행해|진행할게|오케이|ok|ㅇㅋ|ㅇㅇ)$/.test(raw)) {
    return { decision: 'approve', normalizedPayload: '액션: 승인' };
  }
  if (/^(응\s*)?(거부|거부해|취소|취소해|중지|멈춰|스탑|stop)$/.test(raw)) {
    return { decision: 'deny', normalizedPayload: '액션: 거부' };
  }
  return null;
}

function normalizeOpsPayloadText(text, deps = {}) {
  const parseApprove = typeof deps.parseApproveShorthand === 'function'
    ? deps.parseApproveShorthand
    : (value) => parseApproveShorthand(value, deps);
  const parseDeny = typeof deps.parseDenyShorthand === 'function'
    ? deps.parseDenyShorthand
    : parseDenyShorthand;

  const approve = parseApprove(text);
  if (approve) {
    return {
      payloadText: approve.normalizedPayload,
      approveShorthand: approve,
      denyShorthand: null,
    };
  }
  const deny = parseDeny(text);
  if (deny) {
    return {
      payloadText: deny.normalizedPayload,
      approveShorthand: null,
      denyShorthand: deny,
    };
  }
  return {
    payloadText: String(text || '').trim(),
    approveShorthand: null,
    denyShorthand: null,
  };
}

module.exports = {
  parseTransportEnvelopeContext,
  resolveOpsFilePolicy,
  isUnifiedApprovalEnabled,
  normalizeOpsOptionFlags,
  normalizeOpsFileIntent,
  isFileControlAction,
  enforceFileControlTelegramGuard,
  isApprovalGrantEnabled,
  parseApproveShorthand,
  parseDenyShorthand,
  parseNaturalApprovalShorthand,
  normalizeOpsPayloadText,
};
