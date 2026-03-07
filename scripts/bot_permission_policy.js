const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'data', 'policy', 'bot_permissions.json');

const DEFAULT_POLICY = Object.freeze({
  version: 1,
  default: {
    can_approve: true,
    can_deny: true,
    capabilities: ['*'],
    exec_modes: ['auto', 'approval'],
    notes: 'fallback-open',
  },
  bots: {},
});

function toBotKey(value) {
  return String(value || '').trim().toLowerCase();
}

function uniqLowerList(values) {
  const out = [];
  const seen = new Set();
  for (const item of (Array.isArray(values) ? values : [])) {
    const key = String(item || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function resolvePolicyPath() {
  const raw = String(process.env.BOT_PERMISSION_POLICY_PATH || '').trim();
  if (!raw) return DEFAULT_POLICY_PATH;
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

function normalizePolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const defaultRaw = src.default && typeof src.default === 'object' ? src.default : {};
  const botsRaw = src.bots && typeof src.bots === 'object' ? src.bots : {};

  const normalized = {
    version: Number(src.version || DEFAULT_POLICY.version) || DEFAULT_POLICY.version,
    default: {
      can_approve: defaultRaw.can_approve !== false,
      can_deny: defaultRaw.can_deny !== false,
      capabilities: uniqLowerList(defaultRaw.capabilities || ['*']),
      exec_modes: uniqLowerList(defaultRaw.exec_modes || ['auto', 'approval']),
      notes: String(defaultRaw.notes || '').trim(),
    },
    bots: {},
  };

  if (normalized.default.capabilities.length === 0) {
    normalized.default.capabilities = ['*'];
  }
  if (normalized.default.exec_modes.length === 0) {
    normalized.default.exec_modes = ['auto', 'approval'];
  }

  for (const [rawKey, value] of Object.entries(botsRaw)) {
    const botKey = toBotKey(rawKey);
    if (!botKey || !value || typeof value !== 'object') continue;
    normalized.bots[botKey] = {
      can_approve: value.can_approve == null
        ? normalized.default.can_approve
        : Boolean(value.can_approve),
      can_deny: value.can_deny == null
        ? normalized.default.can_deny
        : Boolean(value.can_deny),
      capabilities: uniqLowerList(value.capabilities != null ? value.capabilities : normalized.default.capabilities),
      exec_modes: uniqLowerList(value.exec_modes != null ? value.exec_modes : normalized.default.exec_modes),
      notes: String(value.notes || '').trim(),
    };

    if (normalized.bots[botKey].capabilities.length === 0) {
      normalized.bots[botKey].capabilities = [...normalized.default.capabilities];
    }
    if (normalized.bots[botKey].exec_modes.length === 0) {
      normalized.bots[botKey].exec_modes = [...normalized.default.exec_modes];
    }
  }

  return normalized;
}

function loadPolicy() {
  const filePath = resolvePolicyPath();
  const parsed = readJson(filePath, DEFAULT_POLICY);
  return normalizePolicy(parsed);
}

function resolveBotPolicy(botId) {
  const policy = loadPolicy();
  const key = toBotKey(botId || process.env.MOLTBOT_BOT_ID || '');
  const merged = {
    ...policy.default,
    ...(key && policy.bots[key] ? policy.bots[key] : {}),
  };
  return {
    bot_id: key || 'unknown',
    can_approve: merged.can_approve !== false,
    can_deny: merged.can_deny !== false,
    capabilities: uniqLowerList(merged.capabilities || policy.default.capabilities || ['*']),
    exec_modes: uniqLowerList(merged.exec_modes || policy.default.exec_modes || ['auto', 'approval']),
    notes: String(merged.notes || '').trim(),
  };
}

function hasCapabilityRule(rules, capability, action) {
  const list = uniqLowerList(rules);
  if (list.includes('*')) return true;
  const cap = String(capability || '').trim().toLowerCase();
  const act = String(action || '').trim().toLowerCase();
  if (!cap) return false;
  const full = `${cap}:${act || '*'}`;
  return list.includes(cap)
    || list.includes(`${cap}:*`)
    || (act ? list.includes(full) || list.includes(`${cap}:${act}`) : false);
}

function canApprove(botId) {
  return resolveBotPolicy(botId).can_approve;
}

function canDeny(botId) {
  return resolveBotPolicy(botId).can_deny;
}

function canUseCapability(botId, capability, action) {
  const policy = resolveBotPolicy(botId);
  return hasCapabilityRule(policy.capabilities, capability, action);
}

function canUseExecMode(botId, mode) {
  const policy = resolveBotPolicy(botId);
  const key = String(mode || '').trim().toLowerCase();
  if (!key) return false;
  return policy.exec_modes.includes('*') || policy.exec_modes.includes(key);
}

module.exports = {
  loadPolicy,
  resolveBotPolicy,
  canApprove,
  canDeny,
  canUseCapability,
  canUseExecMode,
};
