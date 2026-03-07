function uniqueNormalizedList(values) {
  const out = [];
  const seen = new Set();
  for (const value of (Array.isArray(values) ? values : [])) {
    const key = String(value || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function parseAllowlistEnvList(value, deps = {}) {
  const uniqueList = typeof deps.uniqueNormalizedList === 'function'
    ? deps.uniqueNormalizedList
    : uniqueNormalizedList;
  const raw = String(value || '').trim();
  if (!raw) return [];
  return uniqueList(raw.split(',').map((v) => v.trim()).filter(Boolean));
}

function parseBooleanEnv(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return null;
}

function normalizeAllowlistConfig(rawConfig, env = process.env, deps = {}) {
  const defaultCommandAllowlist = deps.defaultCommandAllowlist || {};
  const uniqueList = typeof deps.uniqueNormalizedList === 'function'
    ? deps.uniqueNormalizedList
    : uniqueNormalizedList;
  const parseEnvList = typeof deps.parseAllowlistEnvList === 'function'
    ? deps.parseAllowlistEnvList
    : (value) => parseAllowlistEnvList(value, { uniqueNormalizedList: uniqueList });
  const parseBool = typeof deps.parseBooleanEnv === 'function'
    ? deps.parseBooleanEnv
    : parseBooleanEnv;

  const warnings = [];
  const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  if (rawConfig == null) {
    warnings.push('config.commandAllowlist missing; fallback defaults applied');
  } else if (typeof rawConfig !== 'object') {
    warnings.push('config.commandAllowlist must be an object; fallback defaults applied');
  }

  let enabled = Boolean(defaultCommandAllowlist.enabled);
  if (typeof source.enabled === 'boolean') {
    enabled = source.enabled;
  } else if (Object.prototype.hasOwnProperty.call(source, 'enabled')) {
    warnings.push('commandAllowlist.enabled must be boolean; fallback default applied');
  }

  let directCommands = uniqueList(source.directCommands);
  if (!directCommands.length) {
    directCommands = Array.isArray(defaultCommandAllowlist.directCommands)
      ? [...defaultCommandAllowlist.directCommands]
      : [];
    warnings.push('commandAllowlist.directCommands invalid/missing; fallback defaults applied');
  }

  let autoRoutes = uniqueList(source.autoRoutes);
  if (!autoRoutes.length) {
    autoRoutes = Array.isArray(defaultCommandAllowlist.autoRoutes)
      ? [...defaultCommandAllowlist.autoRoutes]
      : [];
    warnings.push('commandAllowlist.autoRoutes invalid/missing; fallback defaults applied');
  }

  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_ALLOWLIST_ENABLED')) {
    const parsed = parseBool(env.BRIDGE_ALLOWLIST_ENABLED);
    if (parsed == null) {
      warnings.push('BRIDGE_ALLOWLIST_ENABLED invalid; keeping config/default value');
    } else {
      enabled = parsed;
    }
  }

  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_ALLOWLIST_DIRECT_COMMANDS')) {
    const parsed = parseEnvList(env.BRIDGE_ALLOWLIST_DIRECT_COMMANDS);
    if (parsed.length > 0) {
      directCommands = parsed;
    } else {
      warnings.push('BRIDGE_ALLOWLIST_DIRECT_COMMANDS empty/invalid; keeping config/default list');
    }
  }

  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_ALLOWLIST_AUTO_ROUTES')) {
    const parsed = parseEnvList(env.BRIDGE_ALLOWLIST_AUTO_ROUTES);
    if (parsed.length > 0) {
      autoRoutes = parsed;
    } else {
      warnings.push('BRIDGE_ALLOWLIST_AUTO_ROUTES empty/invalid; keeping config/default list');
    }
  }

  return {
    enabled,
    directCommands,
    autoRoutes,
    warning: warnings.length > 0 ? warnings.join('; ') : '',
  };
}

function normalizeHubDelegationConfig(rawConfig, deps = {}) {
  const defaultHubDelegation = deps.defaultHubDelegation || {};
  const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const rawMap = source.routeToProfile && typeof source.routeToProfile === 'object'
    ? source.routeToProfile
    : {};
  const routeToProfile = {};
  for (const [routeKey, profileValue] of Object.entries(rawMap)) {
    const route = String(routeKey || '').trim().toLowerCase();
    const profile = String(profileValue || '').trim().toLowerCase();
    if (!route || !profile) continue;
    routeToProfile[route] = profile;
  }
  const mergedRouteToProfile = {
    ...((defaultHubDelegation.routeToProfile && typeof defaultHubDelegation.routeToProfile === 'object')
      ? defaultHubDelegation.routeToProfile
      : {}),
    ...routeToProfile,
  };
  return {
    enabled: source.enabled == null ? Boolean(defaultHubDelegation.enabled) : Boolean(source.enabled),
    fallbackPolicy: String(source.fallbackPolicy || defaultHubDelegation.fallbackPolicy || 'local').trim().toLowerCase() || 'local',
    routeToProfile: mergedRouteToProfile,
  };
}

function normalizeNaturalLanguageRoutingConfig(rawConfig, env = process.env, deps = {}) {
  const defaults = deps.defaultNaturalLanguageRouting || {};
  const parseBool = typeof deps.parseBooleanEnv === 'function'
    ? deps.parseBooleanEnv
    : parseBooleanEnv;
  const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const pickBool = (key, fallback) => (
    source[key] == null ? fallback : Boolean(source[key])
  );

  let enabled = pickBool('enabled', Boolean(defaults.enabled));
  let hubOnly = pickBool('hubOnly', Boolean(defaults.hubOnly));
  let inferWord = pickBool('inferWord', Boolean(defaults.inferWord));
  let inferMemo = pickBool('inferMemo', Boolean(defaults.inferMemo));
  let inferFinance = pickBool('inferFinance', Boolean(defaults.inferFinance));
  let inferTodo = pickBool('inferTodo', Boolean(defaults.inferTodo));
  let inferRoutine = pickBool('inferRoutine', Boolean(defaults.inferRoutine));
  let inferWorkout = pickBool('inferWorkout', Boolean(defaults.inferWorkout));
  let inferBrowser = pickBool('inferBrowser', Boolean(defaults.inferBrowser));
  let inferSchedule = pickBool('inferSchedule', Boolean(defaults.inferSchedule));
  let inferStatus = pickBool('inferStatus', Boolean(defaults.inferStatus));
  let inferLink = pickBool('inferLink', Boolean(defaults.inferLink));
  let inferWork = pickBool('inferWork', Boolean(defaults.inferWork));
  let inferInspect = pickBool('inferInspect', Boolean(defaults.inferInspect));
  let inferReport = pickBool('inferReport', Boolean(defaults.inferReport));
  let inferProject = pickBool('inferProject', Boolean(defaults.inferProject));

  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_ROUTING_ENABLED')) {
    const parsed = parseBool(env.BRIDGE_NL_ROUTING_ENABLED);
    if (parsed != null) enabled = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_ROUTING_HUB_ONLY')) {
    const parsed = parseBool(env.BRIDGE_NL_ROUTING_HUB_ONLY);
    if (parsed != null) hubOnly = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_WORD')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_WORD);
    if (parsed != null) inferWord = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_MEMO')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_MEMO);
    if (parsed != null) inferMemo = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_FINANCE')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_FINANCE);
    if (parsed != null) inferFinance = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_TODO')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_TODO);
    if (parsed != null) inferTodo = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_ROUTINE')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_ROUTINE);
    if (parsed != null) inferRoutine = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_WORKOUT')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_WORKOUT);
    if (parsed != null) inferWorkout = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_BROWSER')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_BROWSER);
    if (parsed != null) inferBrowser = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_SCHEDULE')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_SCHEDULE);
    if (parsed != null) inferSchedule = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_STATUS')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_STATUS);
    if (parsed != null) inferStatus = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_LINK')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_LINK);
    if (parsed != null) inferLink = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_WORK')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_WORK);
    if (parsed != null) inferWork = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_INSPECT')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_INSPECT);
    if (parsed != null) inferInspect = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_REPORT')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_REPORT);
    if (parsed != null) inferReport = parsed;
  }
  if (Object.prototype.hasOwnProperty.call(env, 'BRIDGE_NL_INFER_PROJECT')) {
    const parsed = parseBool(env.BRIDGE_NL_INFER_PROJECT);
    if (parsed != null) inferProject = parsed;
  }

  return {
    enabled,
    hubOnly,
    inferWord,
    inferMemo,
    inferFinance,
    inferTodo,
    inferRoutine,
    inferWorkout,
    inferBrowser,
    inferSchedule,
    inferStatus,
    inferLink,
    inferWork,
    inferInspect,
    inferReport,
    inferProject,
  };
}

function isWordRuntime(env = process.env) {
  const botId = String(env.MOLTBOT_BOT_ID || '').trim().toLowerCase();
  const profile = String(env.MOLTBOT_PROFILE || env.OPENCLAW_PROFILE || '').trim().toLowerCase();
  return botId === 'bot-anki'
    || botId === 'bot-anki-bak'
    || profile === 'anki'
    || profile === 'anki_bak';
}

function isHubRuntime(env = process.env) {
  const role = String(env.MOLTBOT_BOT_ROLE || '').trim().toLowerCase();
  const botId = String(env.MOLTBOT_BOT_ID || '').trim().toLowerCase();
  const profile = String(env.MOLTBOT_PROFILE || env.OPENCLAW_PROFILE || '').trim().toLowerCase();
  return role === 'supervisor'
    || botId === 'bot-daily'
    || botId === 'daily'
    || botId === 'bot-main'
    || botId === 'main'
    || profile === 'daily'
    || profile === 'main';
}

function isResearchRuntime(env = process.env) {
  const botId = String(env.MOLTBOT_BOT_ID || '').trim().toLowerCase();
  const profile = String(env.MOLTBOT_PROFILE || env.OPENCLAW_PROFILE || '').trim().toLowerCase();
  return botId === 'bot-research'
    || botId === 'bot-research-bak'
    || profile === 'research'
    || profile === 'research_bak'
    || profile === 'trend'
    || profile === 'trend_bak';
}

module.exports = {
  uniqueNormalizedList,
  parseAllowlistEnvList,
  parseBooleanEnv,
  normalizeAllowlistConfig,
  normalizeHubDelegationConfig,
  normalizeNaturalLanguageRoutingConfig,
  isHubRuntime,
  isResearchRuntime,
  isWordRuntime,
};
