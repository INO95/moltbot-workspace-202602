const fs = require('fs');
const path = require('path');

const DAILY_PERSONA_STATE_MODES = Object.freeze({
  AUTO: 'auto',
  FORCE_PRESET: 'force_preset',
  FORCE_CUSTOM: 'force_custom',
});

const RUNTIME_CUSTOM_PROFILE_ID = 'runtime_custom';
const FORCE_ROUTE_KEYS = Object.freeze(['word', 'anki', 'news', 'report']);

const DEFAULT_DAILY_PERSONA_STATE = Object.freeze({
  version: 1,
  mode: DAILY_PERSONA_STATE_MODES.AUTO,
  profileId: '',
  custom: Object.freeze({
    name: '',
    tone: '',
    style: '',
    forbidden: '',
    description: '',
    introTemplate: '',
  }),
  forceAllRoutes: true,
  updatedAt: '',
  updatedBy: '',
});

const PROFILE_ALIAS_HINTS = Object.freeze({
  adelia: ['아델리아', '아델'],
  sylvia: ['실비아', '실비'],
  neris: ['네리스', '네리'],
});

function safeObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function toLower(value) {
  return String(value || '').trim().toLowerCase();
}

function toText(value) {
  return String(value || '').trim();
}

function toBool(value, fallback = true) {
  if (value === true || value === false) return value;
  return fallback;
}

function cloneJson(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function normalizeCustomState(rawCustom = {}) {
  const source = safeObject(rawCustom);
  return {
    name: toText(source.name),
    tone: toText(source.tone),
    style: toText(source.style),
    forbidden: toText(source.forbidden),
    description: toText(source.description),
    introTemplate: toText(source.introTemplate),
  };
}

function collectPresetProfiles(rawConfig = {}) {
  const source = safeObject(rawConfig);
  const rows = Array.isArray(source.profiles) ? source.profiles : [];
  return rows
    .map((row) => {
      const r = safeObject(row);
      const id = toLower(r.id);
      if (!id) return null;
      return {
        id,
        name: toText(r.name) || id,
      };
    })
    .filter(Boolean);
}

function resolveProfileMaps(rawConfig = {}) {
  const presets = collectPresetProfiles(rawConfig);
  const byId = {};
  const byAlias = {};
  for (const row of presets) {
    byId[row.id] = row;
    byAlias[row.id] = row.id;
    byAlias[toLower(row.name)] = row.id;
  }
  for (const [id, aliases] of Object.entries(PROFILE_ALIAS_HINTS)) {
    if (!byId[id]) continue;
    for (const alias of aliases) {
      const key = toLower(alias);
      if (!key) continue;
      byAlias[key] = id;
    }
  }
  return { presets, byId, byAlias };
}

function normalizeDailyPersonaState(rawState = {}, options = {}) {
  const source = safeObject(rawState);
  const allowedProfileIds = new Set(
    Array.isArray(options.allowedProfileIds)
      ? options.allowedProfileIds.map((value) => toLower(value)).filter(Boolean)
      : [],
  );

  const rawMode = toLower(source.mode);
  const mode = (
    rawMode === DAILY_PERSONA_STATE_MODES.FORCE_PRESET
    || rawMode === DAILY_PERSONA_STATE_MODES.FORCE_CUSTOM
  )
    ? rawMode
    : DAILY_PERSONA_STATE_MODES.AUTO;

  let profileId = toLower(source.profileId);
  if (mode === DAILY_PERSONA_STATE_MODES.FORCE_PRESET && allowedProfileIds.size > 0 && !allowedProfileIds.has(profileId)) {
    profileId = '';
  }

  const custom = normalizeCustomState(source.custom);
  const next = {
    version: 1,
    mode,
    profileId,
    custom,
    forceAllRoutes: toBool(source.forceAllRoutes, true),
    updatedAt: toText(source.updatedAt),
    updatedBy: toText(source.updatedBy),
  };

  if (next.mode === DAILY_PERSONA_STATE_MODES.FORCE_PRESET && !next.profileId) {
    next.mode = DAILY_PERSONA_STATE_MODES.AUTO;
  }
  if (next.mode === DAILY_PERSONA_STATE_MODES.FORCE_CUSTOM && !next.custom.name) {
    next.mode = DAILY_PERSONA_STATE_MODES.AUTO;
  }

  return next;
}

function resolveDailyPersonaStatePath(rawConfig = {}, options = {}) {
  const source = safeObject(rawConfig);
  const env = safeObject(options.env || process.env);
  const rootDir = toText(options.rootDir) || path.resolve(__dirname, '..', '..');
  const envOverride = toText(env.MOLTBOT_DAILY_PERSONA_STATE_PATH || env.DAILY_PERSONA_STATE_PATH);
  const configured = toText(source.statePath) || 'data/runtime/daily_persona_state.json';
  const rawPath = envOverride || configured;
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(rootDir, rawPath);
}

function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readDailyPersonaState(rawConfig = {}, options = {}) {
  const pathValue = resolveDailyPersonaStatePath(rawConfig, options);
  const maps = resolveProfileMaps(rawConfig);
  const fallback = normalizeDailyPersonaState(DEFAULT_DAILY_PERSONA_STATE, {
    allowedProfileIds: maps.presets.map((row) => row.id),
  });
  const repairOnCorruption = options.repairOnCorruption !== false;

  try {
    if (!fs.existsSync(pathValue)) {
      return {
        ok: true,
        exists: false,
        recovered: false,
        repaired: false,
        path: pathValue,
        state: fallback,
      };
    }
    const parsed = JSON.parse(fs.readFileSync(pathValue, 'utf8'));
    const state = normalizeDailyPersonaState(parsed, {
      allowedProfileIds: maps.presets.map((row) => row.id),
    });
    return {
      ok: true,
      exists: true,
      recovered: false,
      repaired: false,
      path: pathValue,
      state,
    };
  } catch (error) {
    let repaired = false;
    if (repairOnCorruption) {
      try {
        writeJsonAtomic(pathValue, fallback);
        repaired = true;
      } catch (_) {
        repaired = false;
      }
    }
    return {
      ok: false,
      exists: true,
      recovered: true,
      repaired,
      path: pathValue,
      error: error && error.message ? String(error.message) : String(error),
      state: fallback,
    };
  }
}

function writeDailyPersonaState(rawConfig = {}, stateInput = {}, options = {}) {
  const pathValue = resolveDailyPersonaStatePath(rawConfig, options);
  const maps = resolveProfileMaps(rawConfig);
  const state = normalizeDailyPersonaState(stateInput, {
    allowedProfileIds: maps.presets.map((row) => row.id),
  });
  try {
    writeJsonAtomic(pathValue, state);
    return { ok: true, path: pathValue, state };
  } catch (error) {
    return {
      ok: false,
      path: pathValue,
      state,
      error: error && error.message ? String(error.message) : String(error),
    };
  }
}

function resolvePresetProfileId(rawConfig = {}, value = '') {
  const input = toLower(value);
  if (!input) return '';
  const maps = resolveProfileMaps(rawConfig);
  return maps.byAlias[input] || '';
}

function buildForcedRouteMap(rawRouteMap = {}, profileId = '') {
  const source = safeObject(rawRouteMap);
  const routeKeys = new Set([...FORCE_ROUTE_KEYS, ...Object.keys(source)]);
  const forced = {};
  const pid = toLower(profileId);
  for (const key of routeKeys) {
    const route = toLower(key);
    if (!route || !pid) continue;
    forced[route] = pid;
  }
  return forced;
}

function applyDailyPersonaStateToConfig(rawConfig = {}, stateInput = {}, options = {}) {
  const source = cloneJson(safeObject(rawConfig), {});
  const maps = resolveProfileMaps(source);
  const state = normalizeDailyPersonaState(stateInput, {
    allowedProfileIds: maps.presets.map((row) => row.id),
  });

  const autoMeta = {
    mode: DAILY_PERSONA_STATE_MODES.AUTO,
    forced: false,
    profileId: toLower(source.defaultProfileId),
    profileName: '',
    forceAllRoutes: false,
  };

  if (state.mode === DAILY_PERSONA_STATE_MODES.AUTO) {
    const baseProfile = maps.byId[toLower(source.defaultProfileId)] || null;
    return {
      config: source,
      state,
      meta: {
        ...autoMeta,
        profileName: baseProfile ? baseProfile.name : '',
      },
    };
  }

  if (state.mode === DAILY_PERSONA_STATE_MODES.FORCE_PRESET) {
    const preset = maps.byId[state.profileId];
    if (!preset) {
      return {
        config: source,
        state: {
          ...state,
          mode: DAILY_PERSONA_STATE_MODES.AUTO,
        },
        meta: autoMeta,
      };
    }
    source.defaultProfileId = preset.id;
    source.routeToProfile = buildForcedRouteMap(source.routeToProfile, preset.id);
    return {
      config: source,
      state,
      meta: {
        mode: DAILY_PERSONA_STATE_MODES.FORCE_PRESET,
        forced: true,
        profileId: preset.id,
        profileName: preset.name,
        forceAllRoutes: true,
      },
    };
  }

  if (state.mode === DAILY_PERSONA_STATE_MODES.FORCE_CUSTOM) {
    const custom = normalizeCustomState(state.custom);
    if (!custom.name) {
      return {
        config: source,
        state: {
          ...state,
          mode: DAILY_PERSONA_STATE_MODES.AUTO,
        },
        meta: autoMeta,
      };
    }

    const customId = toLower(options.customProfileId) || RUNTIME_CUSTOM_PROFILE_ID;
    const rows = Array.isArray(source.profiles) ? source.profiles : [];
    const preserved = rows.filter((row) => toLower(safeObject(row).id) !== customId);
    preserved.push({
      id: customId,
      name: custom.name,
      role: 'custom',
      tone: custom.tone,
      style: custom.style,
      forbidden: custom.forbidden,
      description: custom.description,
      emojis: ['☕'],
      introTemplate: custom.introTemplate || `☕ ${custom.name}입니다, {{title}}.`,
    });
    source.profiles = preserved;
    source.defaultProfileId = customId;
    source.routeToProfile = buildForcedRouteMap(source.routeToProfile, customId);

    return {
      config: source,
      state,
      meta: {
        mode: DAILY_PERSONA_STATE_MODES.FORCE_CUSTOM,
        forced: true,
        profileId: customId,
        profileName: custom.name,
        forceAllRoutes: true,
      },
    };
  }

  return {
    config: source,
    state: {
      ...state,
      mode: DAILY_PERSONA_STATE_MODES.AUTO,
    },
    meta: autoMeta,
  };
}

module.exports = {
  DAILY_PERSONA_STATE_MODES,
  DEFAULT_DAILY_PERSONA_STATE,
  RUNTIME_CUSTOM_PROFILE_ID,
  normalizeDailyPersonaState,
  resolveDailyPersonaStatePath,
  readDailyPersonaState,
  writeDailyPersonaState,
  resolvePresetProfileId,
  applyDailyPersonaStateToConfig,
};
