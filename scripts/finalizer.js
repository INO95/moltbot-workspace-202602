const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PROMPT_PACK_PATH = path.join(ROOT, 'data', 'policy', 'finalizer_prompts.min.yaml');
const DEFAULT_PERSONA_MAP_PATH = path.join(ROOT, 'data', 'policy', 'bot_persona_map.json');
const DEFAULT_PREFS_PATH = path.join(ROOT, 'data', 'state', 'user_prefs.json');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'data', 'config.json');

let MODEL_CALLER_FOR_TEST = null;

function readTextSafe(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function resolveFilePath(maybePath, fallbackPath) {
  const raw = String(maybePath || '').trim();
  if (!raw) return fallbackPath;
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

function normalizeReportMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'ko') return 'ko';
  if (raw === 'ko+en') return 'ko+en';
  return '';
}

function isHeartbeatBypass(text) {
  const raw = String(text || '');
  return raw === 'HEARTBEAT_OK' || raw.startsWith('HEARTBEAT_');
}

function buildUserKey(context = {}) {
  const telegramContext = context && typeof context.telegramContext === 'object'
    ? context.telegramContext
    : null;
  if (telegramContext && String(telegramContext.provider || '').toLowerCase() === 'telegram') {
    const userId = String(telegramContext.userId || '').trim();
    if (userId) return `telegram:${userId}`;
  }
  const requestedBy = String(context.requestedBy || '').trim();
  if (requestedBy) return `request:${requestedBy}`;
  return 'default';
}

function loadRuntimeConfig() {
  const config = readJsonSafe(DEFAULT_CONFIG_PATH, {});
  const section = config && typeof config.telegramFinalizer === 'object'
    ? config.telegramFinalizer
    : {};
  const envEnabled = String(process.env.TELEGRAM_FINALIZER_ENABLED || '').trim().toLowerCase();
  const enabled = envEnabled
    ? !['0', 'false', 'off', 'no'].includes(envEnabled)
    : section.enabled !== false;
  const reportModeDefault = normalizeReportMode(
    process.env.TELEGRAM_FINALIZER_REPORT_MODE_DEFAULT
      || section.reportModeDefault
      || 'ko',
  ) || 'ko';

  const promptPackPath = resolveFilePath(
    process.env.TELEGRAM_FINALIZER_PROMPT_PACK_PATH || section.promptPackPath,
    DEFAULT_PROMPT_PACK_PATH,
  );
  const personaMapPath = resolveFilePath(
    process.env.TELEGRAM_FINALIZER_PERSONA_MAP_PATH || section.personaMapPath,
    DEFAULT_PERSONA_MAP_PATH,
  );
  const prefsPath = resolveFilePath(
    process.env.TELEGRAM_FINALIZER_PREFS_PATH || section.prefsPath,
    DEFAULT_PREFS_PATH,
  );

  const models = Array.isArray(section.models) && section.models.length > 0
    ? section.models.map((item) => String(item || '').trim()).filter(Boolean)
    : ['gpt-5.3-high', 'gpt-5.2-high'];

  return {
    enabled,
    reportModeDefault,
    promptPackPath,
    personaMapPath,
    prefsPath,
    models,
    fallbackModelAlias: String(section.fallbackModelAlias || 'gpt').trim() || 'gpt',
  };
}

function parsePromptPack(rawYaml) {
  const raw = String(rawYaml || '');
  const out = {
    reportModeDefault: 'ko',
    common: {
      system: [
        'FINALIZER. Rewrite ONLY style into natural Korean. Preserve meaning. No new facts. No tool/meta.',
        'Preserve EXACTLY: fenced code blocks ```...```, inline code `...`, JSON/logs/stack traces, URLs, file paths, IDs/timestamps/hashes/tokens, and any line starting with "/".',
        'Output Korean. If MODE="ko+en", append a short English summary (max 3 lines).',
        'BYPASS: if text == "HEARTBEAT_OK" or starts with "HEARTBEAT_", return as-is.',
      ].join('\n'),
      userTemplate: 'MODE={{MODE}}\nPERSONA={{PERSONA}}\nSTYLE={{STYLE}}\nDRAFT:\n{{DRAFT}}',
    },
    personas: {
      zeke: {
        personaName: '지크 예거',
        personaStyle: '냉정/전략/효율. 결론→근거→조치→리스크→다음.',
      },
      hange: {
        personaName: '한지 단장',
        personaStyle: '호기심/연구자/학습코치. 목표→핵심→예시→복습.',
      },
      armin: {
        personaName: '아르민',
        personaStyle: '분석/신중/근거. 요약→근거→해석→리스크→다음확인.',
      },
      erwin: {
        personaName: '엘빈 단장',
        personaStyle: '목표/우선순위/작전. 상황→목표→우선순위→다음 행동→체크인 질문.',
      },
    },
  };

  const reportModeMatch = raw.match(/^report_mode_default:\s*"([^"]+)"/m);
  if (reportModeMatch) {
    out.reportModeDefault = normalizeReportMode(reportModeMatch[1]) || out.reportModeDefault;
  }

  const commonMatch = raw.match(/common:\n\s{2}system:\s*\|-\n([\s\S]*?)\n\s{2}user_template:\s*\|-\n([\s\S]*?)\n\npersonas:/);
  if (commonMatch) {
    out.common.system = String(commonMatch[1] || '').replace(/^\s{4}/gm, '').trim();
    out.common.userTemplate = String(commonMatch[2] || '').replace(/^\s{4}/gm, '').trim();
  }

  const personaPattern = /\n\s{2}(\w+):\n\s{4}persona_name:\s*"([^"]+)"\n\s{4}persona_style:\s*"([^"]+)"/g;
  let row = personaPattern.exec(raw);
  while (row) {
    const key = String(row[1] || '').trim();
    if (key) {
      out.personas[key] = {
        personaName: String(row[2] || '').trim(),
        personaStyle: String(row[3] || '').trim(),
      };
    }
    row = personaPattern.exec(raw);
  }

  return out;
}

function loadPromptPack(filePath) {
  const yaml = readTextSafe(filePath, '');
  return parsePromptPack(yaml);
}

function loadPersonaMap(filePath) {
  const parsed = readJsonSafe(filePath, {});
  if (!parsed || typeof parsed !== 'object') return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    const key = String(rawKey || '').trim().toLowerCase();
    const value = String(rawValue || '').trim().toLowerCase();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

function resolvePersonaForRuntime(context = {}) {
  const runtime = loadRuntimeConfig();
  const personaMap = loadPersonaMap(runtime.personaMapPath);

  const botId = String(context.botId || process.env.MOLTBOT_BOT_ID || '').trim().toLowerCase();
  const botRole = String(context.botRole || process.env.MOLTBOT_BOT_ROLE || '').trim().toLowerCase();
  const telegramContext = context && typeof context.telegramContext === 'object'
    ? context.telegramContext
    : null;

  if (botId && personaMap[botId]) return personaMap[botId];

  if (botId && botId.endsWith('-bak')) {
    const base = botId.replace(/-bak$/, '');
    if (personaMap[base]) return personaMap[base];
  }

  const isTelegramDm = telegramContext
    && String(telegramContext.provider || '').toLowerCase() === 'telegram'
    && String(telegramContext.userId || '').trim()
    && !String(telegramContext.groupId || '').trim();
  if (isTelegramDm && personaMap.main) return personaMap.main;

  if (botRole === 'supervisor' && personaMap.main) return personaMap.main;

  if (personaMap.main) return personaMap.main;
  return 'erwin';
}

function readUserPrefs(runtime) {
  const fallback = { users: {} };
  const parsed = readJsonSafe(runtime.prefsPath, fallback);
  if (!parsed || typeof parsed !== 'object') return fallback;
  if (!parsed.users || typeof parsed.users !== 'object') {
    return { ...parsed, users: {} };
  }
  return parsed;
}

function readReportMode(context = {}) {
  const runtime = loadRuntimeConfig();
  const promptPack = loadPromptPack(runtime.promptPackPath);
  const fallbackMode = normalizeReportMode(promptPack.reportModeDefault)
    || normalizeReportMode(runtime.reportModeDefault)
    || 'ko';

  const prefs = readUserPrefs(runtime);
  const userKey = buildUserKey(context);
  const entry = prefs.users && typeof prefs.users[userKey] === 'object'
    ? prefs.users[userKey]
    : null;
  const mode = normalizeReportMode(entry && entry.reportMode);
  if (mode) return mode;

  const userEntries = Object.values(prefs.users || {})
    .filter((row) => row && typeof row === 'object')
    .map((row) => normalizeReportMode(row.reportMode))
    .filter(Boolean);
  if (userEntries.length === 1) return userEntries[0];
  return fallbackMode;
}

function writeReportMode(context = {}) {
  const mode = normalizeReportMode(context.mode);
  if (!mode) return { ok: false, reason: 'invalid_mode' };

  const runtime = loadRuntimeConfig();
  const prefs = readUserPrefs(runtime);
  const userKey = buildUserKey(context);
  const current = normalizeReportMode(
    prefs.users
    && prefs.users[userKey]
    && prefs.users[userKey].reportMode,
  );
  if (current === mode) {
    return { ok: true, changed: false, mode, userKey, path: runtime.prefsPath };
  }

  const next = {
    ...prefs,
    users: {
      ...(prefs.users || {}),
      [userKey]: {
        reportMode: mode,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  writeJsonAtomic(runtime.prefsPath, next);
  return { ok: true, changed: true, mode, userKey, path: runtime.prefsPath };
}

function registerToken(state, value) {
  const idx = state.tokens.length;
  state.tokens.push(String(value));
  return `__PRESERVE_${String(idx).padStart(4, '0')}__`;
}

function replaceSimple(text, regex, state) {
  return text.replace(regex, (match) => registerToken(state, match));
}

function replaceWithBoundary(text, regex, state) {
  return text.replace(regex, (match, prefix, captured) => {
    const leader = typeof prefix === 'string' ? prefix : '';
    const body = typeof captured === 'string' ? captured : match;
    return `${leader}${registerToken(state, body)}`;
  });
}

function maskProtectedSegments(text) {
  const state = { tokens: [] };
  let out = String(text || '');

  out = replaceSimple(out, /```[\s\S]*?```/g, state);
  out = replaceSimple(out, /`[^`\n]+`/g, state);
  out = replaceSimple(out, /^\/[^\n]*$/gm, state);
  out = replaceSimple(out, /^\s*at\s.+$/gm, state);
  out = replaceSimple(out, /^\s*(?:\{.*\}|\[.*\])\s*$/gm, state);

  out = replaceSimple(out, /\bhttps?:\/\/[^\s<>'"`]+/gi, state);
  out = replaceSimple(out, /\b[A-Za-z]:\\[^\s<>'"`]+/g, state);
  out = replaceWithBoundary(out, /(^|[^A-Za-z0-9_])(\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+)/g, state);

  out = replaceSimple(out, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, state);
  out = replaceSimple(out, /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, state);
  out = replaceSimple(out, /\b[a-f0-9]{32,64}\b/gi, state);
  out = replaceSimple(out, /\b(?:sk|ghp|tok|token|sha)[-_][A-Za-z0-9_-]{8,}\b/g, state);

  return { maskedText: out, state };
}

function restoreProtectedSegments(text, state) {
  let out = String(text || '');
  const tokens = state && Array.isArray(state.tokens) ? state.tokens : [];
  for (let i = 0; i < tokens.length; i += 1) {
    const placeholder = `__PRESERVE_${String(i).padStart(4, '0')}__`;
    out = out.split(placeholder).join(String(tokens[i] || ''));
  }
  return out;
}

function slashLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => String(line || ''))
    .filter((line) => line.startsWith('/'));
}

function hasAllPlaceholders(text, total) {
  const raw = String(text || '');
  for (let i = 0; i < total; i += 1) {
    const placeholder = `__PRESERVE_${String(i).padStart(4, '0')}__`;
    if (!raw.includes(placeholder)) return false;
  }
  return true;
}

function extractResponseText(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (typeof parsed.output_text === 'string' && parsed.output_text.trim()) {
    return parsed.output_text.trim();
  }

  const output = Array.isArray(parsed.output) ? parsed.output : [];
  const lines = [];
  for (const row of output) {
    const content = Array.isArray(row && row.content) ? row.content : [];
    for (const block of content) {
      const text = String(
        (block && (block.text || block.output_text || block.value))
          || '',
      ).trim();
      if (!text) continue;
      lines.push(text);
    }
  }
  return lines.join('\n').trim();
}

function callModelViaProxy(params = {}) {
  const url = `http://127.0.0.1:${String(process.env.CODEX_PROXY_PORT || '3000').trim()}/v1/responses`;
  const payload = {
    model: params.model,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: String(params.systemPrompt || '') }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: String(params.userPrompt || '') }],
      },
    ],
  };

  const run = spawnSync('curl', [
    '-sS',
    '--max-time', String(Number(process.env.TELEGRAM_FINALIZER_TIMEOUT_SEC || 20)),
    '-X', 'POST',
    url,
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify(payload),
  ], { encoding: 'utf8' });

  if (run.error || run.status !== 0) {
    return { ok: false, text: '', error: String((run.error && run.error.message) || run.stderr || `curl_exit_${run.status}`) };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(String(run.stdout || '{}'));
  } catch (_) {
    return { ok: false, text: '', error: 'proxy_invalid_json' };
  }

  if (parsed && parsed.error) {
    return {
      ok: false,
      text: '',
      error: typeof parsed.error === 'string'
        ? parsed.error
        : String(parsed.error.message || parsed.error.error || 'proxy_error'),
    };
  }

  const text = extractResponseText(parsed);
  if (!text) {
    return { ok: false, text: '', error: 'empty_model_output' };
  }
  return { ok: true, text, error: '' };
}

function callModel(params = {}) {
  if (MODEL_CALLER_FOR_TEST) {
    const out = MODEL_CALLER_FOR_TEST(params);
    const text = String(out || '').trim();
    if (!text) return { ok: false, text: '', error: 'test_model_empty' };
    return { ok: true, text, error: '' };
  }
  return callModelViaProxy(params);
}

function buildPrompts(maskedDraft, context = {}) {
  const runtime = loadRuntimeConfig();
  const pack = loadPromptPack(runtime.promptPackPath);
  const mode = normalizeReportMode(context.reportMode) || readReportMode(context);
  const personaKey = resolvePersonaForRuntime(context);
  const personaMeta = pack.personas[personaKey] || pack.personas.erwin;

  const systemPrompt = String(pack.common.system || '').trim();
  const userTemplate = String(pack.common.userTemplate || '').trim();
  const userPrompt = userTemplate
    .replace(/\{\{MODE\}\}/g, mode)
    .replace(/\{\{PERSONA\}\}/g, String(personaMeta.personaName || personaKey))
    .replace(/\{\{STYLE\}\}/g, String(personaMeta.personaStyle || ''))
    .replace(/\{\{DRAFT\}\}/g, maskedDraft);

  return {
    mode,
    persona: personaKey,
    systemPrompt,
    userPrompt,
  };
}

function finalizeTelegramReply(text, context = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return raw;
  if (context && context.finalizerApplied) return raw;
  if (isHeartbeatBypass(raw)) return raw;

  const runtime = loadRuntimeConfig();
  if (!runtime.enabled) return raw;

  const { maskedText, state } = maskProtectedSegments(raw);
  if (!maskedText.trim()) return raw;

  if (String(process.env.TELEGRAM_FINALIZER_ECHO_ONLY || '').trim().toLowerCase() === 'true') {
    const echoed = restoreProtectedSegments(maskedText, state);
    return echoed.trim() || raw;
  }

  const prompts = buildPrompts(maskedText, context);
  const models = [...runtime.models];
  const fallbackAlias = String(runtime.fallbackModelAlias || '').trim();
  if (fallbackAlias) models.push(fallbackAlias);

  let chosen = '';
  for (const model of models) {
    const modelName = String(model || '').trim();
    if (!modelName) continue;
    const called = callModel({
      model: modelName,
      systemPrompt: prompts.systemPrompt,
      userPrompt: prompts.userPrompt,
      context,
      draft: maskedText,
    });
    if (!called.ok || !called.text) continue;
    chosen = String(called.text || '').trim();
    if (chosen) break;
  }

  if (!chosen) return raw;
  if (!hasAllPlaceholders(chosen, state.tokens.length)) return raw;

  const restored = restoreProtectedSegments(chosen, state).trim();
  if (!restored) return raw;

  const beforeSlash = slashLines(raw);
  const afterSlash = slashLines(restored);
  if (beforeSlash.length !== afterSlash.length) return raw;
  for (let i = 0; i < beforeSlash.length; i += 1) {
    if (beforeSlash[i] !== afterSlash[i]) return raw;
  }

  return restored;
}

function __setModelCallerForTest(fn) {
  MODEL_CALLER_FOR_TEST = typeof fn === 'function' ? fn : null;
}

module.exports = {
  finalizeTelegramReply,
  resolvePersonaForRuntime,
  readReportMode,
  writeReportMode,
  isHeartbeatBypass,
  maskProtectedSegments,
  restoreProtectedSegments,
  __setModelCallerForTest,
};
