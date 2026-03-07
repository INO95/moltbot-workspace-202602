const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES_PER_SESSION = 3;
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_FOLLOWUP_KEYWORDS = Object.freeze([
  '결과를 보여',
  '결과 보여',
  '방금한거',
  '방금 한거',
  '직전 결과',
  '아까 한거',
  '아까 한 것',
  '다시 보여',
  '보여달라고',
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeSessionKey(value) {
  return normalizeText(value);
}

function normalizeKeywordList(keywords = []) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(keywords) ? keywords : []) {
    const token = normalizeText(raw).toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function parseIsoMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : NaN;
}

function isResultFollowupQuery(text, keywords = []) {
  const raw = normalizeText(text).toLowerCase();
  if (!raw) return false;

  const canonical = [
    /(?:결과|직전 결과|방금|아까).*(?:보여|요약|다시)/i,
    /^(?:결과|결과만|결과를|방금한거|방금 한거|아까 한거|아까 한 것)$/i,
    /^(?:방금한거|방금 한거|아까 한거|아까 한 것)$/i,
  ];
  if (canonical.some((re) => re.test(raw))) return true;

  const customKeywords = normalizeKeywordList(
    keywords.length > 0 ? keywords : DEFAULT_FOLLOWUP_KEYWORDS,
  );
  return customKeywords.some((token) => raw.includes(token));
}

function normalizeEntry(row = {}) {
  const route = normalizeText(row.route || '').toLowerCase() || 'none';
  const reply = String(row.telegramReply || '').trim();
  const timestamp = normalizeText(row.timestamp || nowIso()) || nowIso();
  return {
    route,
    success: row.success === true,
    telegramReply: reply,
    timestamp,
  };
}

function normalizeState(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const sessionsIn = source.sessions && typeof source.sessions === 'object'
    ? source.sessions
    : {};
  const sessions = {};
  for (const [key, row] of Object.entries(sessionsIn)) {
    const sessionKey = normalizeSessionKey(key);
    if (!sessionKey) continue;
    const item = row && typeof row === 'object' ? row : {};
    const entries = Array.isArray(item.entries)
      ? item.entries
        .map((entry) => normalizeEntry(entry))
        .filter((entry) => entry.success && entry.telegramReply)
      : [];
    if (entries.length === 0) continue;
    sessions[sessionKey] = {
      updatedAt: normalizeText(item.updatedAt || entries[0].timestamp || nowIso()) || nowIso(),
      entries,
    };
  }
  return {
    version: DEFAULT_STATE_VERSION,
    updatedAt: normalizeText(source.updatedAt || nowIso()) || nowIso(),
    sessions,
  };
}

function readFollowupState(statePath) {
  try {
    if (!statePath || !fs.existsSync(statePath)) {
      return normalizeState({});
    }
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return normalizeState(parsed);
  } catch (_) {
    return normalizeState({});
  }
}

function writeFollowupState(statePath, state) {
  if (!statePath) return;
  const normalized = normalizeState(state);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, statePath);
}

function pruneState(stateInput = {}, opts = {}) {
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const ttlMs = Number.isFinite(Number(opts.ttlMs))
    ? Math.max(1000, Number(opts.ttlMs))
    : DEFAULT_TTL_MS;
  const maxEntriesPerSession = Number.isFinite(Number(opts.maxEntriesPerSession))
    ? Math.max(1, Math.floor(Number(opts.maxEntriesPerSession)))
    : DEFAULT_MAX_ENTRIES_PER_SESSION;
  const maxSessions = Number.isFinite(Number(opts.maxSessions))
    ? Math.max(1, Math.floor(Number(opts.maxSessions)))
    : DEFAULT_MAX_SESSIONS;

  const state = normalizeState(stateInput);
  const sessionRows = [];
  for (const [sessionKey, row] of Object.entries(state.sessions || {})) {
    const sourceEntries = Array.isArray(row.entries) ? row.entries : [];
    const entries = [];
    for (const entry of sourceEntries) {
      const item = normalizeEntry(entry);
      if (!item.success || !item.telegramReply) continue;
      const ts = parseIsoMs(item.timestamp);
      if (Number.isFinite(ts) && nowMs - ts > ttlMs) continue;
      entries.push(item);
      if (entries.length >= maxEntriesPerSession) break;
    }
    if (entries.length === 0) continue;
    const updatedAt = normalizeText(row.updatedAt || entries[0].timestamp || nowIso()) || nowIso();
    sessionRows.push({ sessionKey, updatedAt, entries });
  }

  sessionRows.sort((a, b) => {
    const aMs = parseIsoMs(a.updatedAt);
    const bMs = parseIsoMs(b.updatedAt);
    return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
  });

  const sessions = {};
  for (const row of sessionRows.slice(0, maxSessions)) {
    sessions[row.sessionKey] = {
      updatedAt: row.updatedAt,
      entries: row.entries,
    };
  }

  return {
    version: DEFAULT_STATE_VERSION,
    updatedAt: nowIso(),
    sessions,
  };
}

function rememberActionableResult(sessionKey, row, opts = {}) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return { ok: false, reason: 'session_key_required' };

  const entry = normalizeEntry(row);
  if (!entry.success || !entry.telegramReply) return { ok: false, reason: 'not_actionable' };

  const statePath = String(opts.statePath || '').trim();
  const readState = typeof opts.readState === 'function' ? opts.readState : readFollowupState;
  const writeState = typeof opts.writeState === 'function' ? opts.writeState : writeFollowupState;
  const current = pruneState(readState(statePath), opts);

  const previous = current.sessions[key] && Array.isArray(current.sessions[key].entries)
    ? current.sessions[key].entries
    : [];
  const merged = [entry, ...previous];

  const deduped = [];
  const seen = new Set();
  for (const item of merged) {
    const sig = `${item.route}|${item.telegramReply}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    deduped.push(item);
    if (deduped.length >= (Number(opts.maxEntriesPerSession) || DEFAULT_MAX_ENTRIES_PER_SESSION)) break;
  }

  current.sessions[key] = {
    updatedAt: entry.timestamp,
    entries: deduped,
  };
  const next = pruneState(current, opts);
  writeState(statePath, next);
  return { ok: true, sessionKey: key, entry };
}

function resolveRecentResult(sessionKey, opts = {}) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return null;

  const statePath = String(opts.statePath || '').trim();
  const readState = typeof opts.readState === 'function' ? opts.readState : readFollowupState;
  const writeState = typeof opts.writeState === 'function' ? opts.writeState : writeFollowupState;

  const rawState = readState(statePath);
  const pruned = pruneState(rawState, opts);
  writeState(statePath, pruned);
  const session = pruned.sessions && pruned.sessions[key];
  if (!session || !Array.isArray(session.entries) || session.entries.length === 0) return null;
  return normalizeEntry(session.entries[0]);
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES_PER_SESSION,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_FOLLOWUP_KEYWORDS,
  isResultFollowupQuery,
  readFollowupState,
  writeFollowupState,
  rememberActionableResult,
  resolveRecentResult,
};
