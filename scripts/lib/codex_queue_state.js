const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_STATE_PATH = path.join(ROOT, 'data', 'runtime', 'codex_queue_state.json');

function nowIso() {
  return new Date().toISOString();
}

function resolveStatePath(customPath = '') {
  const explicit = String(customPath || '').trim();
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(ROOT, explicit);
  }
  const envPath = String(process.env.CODEX_CAPABILITY_STATE_PATH || '').trim();
  if (!envPath) return DEFAULT_STATE_PATH;
  return path.isAbsolute(envPath) ? envPath : path.join(ROOT, envPath);
}

function normalizeQueueItem(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  return {
    request_id: String(row.request_id || '').trim(),
    prompt: String(row.prompt || '').trim(),
    requested_by: String(row.requested_by || '').trim(),
    created_at: String(row.created_at || '').trim() || nowIso(),
  };
}

function normalizeHistoryItem(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  return {
    request_id: String(row.request_id || '').trim(),
    thread_id: String(row.thread_id || '').trim(),
    status: String(row.status || '').trim().toLowerCase(),
    summary: String(row.summary || '').trim(),
    created_at: String(row.created_at || '').trim() || nowIso(),
    finished_at: String(row.finished_at || '').trim() || nowIso(),
  };
}

function normalizeActive(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const requestId = String(raw.request_id || '').trim();
  if (!requestId) return null;
  return {
    request_id: requestId,
    thread_id: String(raw.thread_id || '').trim(),
    prompt: String(raw.prompt || '').trim(),
    status: String(raw.status || '').trim().toLowerCase() || 'running',
    requested_by: String(raw.requested_by || '').trim(),
    last_message: String(raw.last_message || '').trim(),
    last_question: String(raw.last_question || '').trim(),
    created_at: String(raw.created_at || '').trim() || nowIso(),
    updated_at: String(raw.updated_at || '').trim() || nowIso(),
  };
}

function normalizeSession(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const queue = Array.isArray(row.queue)
    ? row.queue.map(normalizeQueueItem).filter((item) => item.request_id && item.prompt)
    : [];
  const history = Array.isArray(row.history)
    ? row.history.map(normalizeHistoryItem).filter((item) => item.request_id)
    : [];
  return {
    active: normalizeActive(row.active),
    queue,
    history: history.slice(0, 20),
    updated_at: String(row.updated_at || '').trim() || nowIso(),
  };
}

function normalizeState(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const sessionsRaw = row.sessions && typeof row.sessions === 'object' ? row.sessions : {};
  const sessions = {};
  for (const [keyRaw, value] of Object.entries(sessionsRaw)) {
    const key = String(keyRaw || '').trim();
    if (!key) continue;
    sessions[key] = normalizeSession(value);
  }
  return {
    version: 1,
    updated_at: String(row.updated_at || '').trim() || nowIso(),
    sessions,
  };
}

function readState(customPath = '') {
  const filePath = resolveStatePath(customPath);
  try {
    if (!fs.existsSync(filePath)) return normalizeState({});
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeState(parsed);
  } catch (_) {
    return normalizeState({});
  }
}

function writeState(state, customPath = '') {
  const filePath = resolveStatePath(customPath);
  const normalized = normalizeState(state);
  normalized.updated_at = nowIso();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    path: filePath,
    state: normalized,
  };
}

function buildSessionKey({ telegramContext = null, requestedBy = '', botId = '' } = {}) {
  const provider = String(telegramContext && telegramContext.provider || '').trim().toLowerCase();
  const userId = String(telegramContext && telegramContext.userId || '').trim();
  const groupId = String(telegramContext && telegramContext.groupId || '').trim();
  const requester = String(requestedBy || '').trim();
  const runtimeBot = String(botId || process.env.MOLTBOT_BOT_ID || '').trim().toLowerCase();

  if (provider && userId && groupId) return `${provider}:${userId}@${groupId}:${runtimeBot || 'bot'}`;
  if (provider && userId) return `${provider}:${userId}:${runtimeBot || 'bot'}`;
  if (requester) return `requester:${requester}:${runtimeBot || 'bot'}`;
  return `global:${runtimeBot || 'bot'}`;
}

function getSession(state, sessionKey) {
  const normalizedState = normalizeState(state);
  const key = String(sessionKey || '').trim();
  if (!key) return normalizeSession({});
  if (!normalizedState.sessions[key]) {
    normalizedState.sessions[key] = normalizeSession({});
  }
  return normalizedState.sessions[key];
}

function setSession(state, sessionKey, sessionValue) {
  const normalizedState = normalizeState(state);
  const key = String(sessionKey || '').trim();
  if (!key) return normalizedState;
  normalizedState.sessions[key] = normalizeSession(sessionValue);
  normalizedState.sessions[key].updated_at = nowIso();
  normalizedState.updated_at = nowIso();
  return normalizedState;
}

module.exports = {
  nowIso,
  resolveStatePath,
  normalizeState,
  normalizeSession,
  readState,
  writeState,
  buildSessionKey,
  getSession,
  setSession,
};
