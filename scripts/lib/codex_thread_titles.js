const fs = require('fs');
const os = require('os');
const path = require('path');

function trimText(value) {
  return String(value || '').trim();
}

function compactText(value, max = 120) {
  const raw = trimText(value).replace(/\s+/g, ' ');
  if (!raw) return '';
  if (raw.length <= max) return raw;
  return `${raw.slice(0, Math.max(1, max - 3))}...`;
}

function resolveGlobalStatePath() {
  const custom = trimText(process.env.CODEX_GLOBAL_STATE_PATH || '');
  if (custom) return path.isAbsolute(custom) ? custom : path.resolve(custom);
  return path.join(os.homedir(), '.codex', '.codex-global-state.json');
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function resolveDesktopWorkspaceRoot(statePath = '') {
  const pathHint = trimText(statePath || resolveGlobalStatePath());
  if (!pathHint) return '';
  const state = readJsonSafe(pathHint);
  const roots = Array.isArray(state['active-workspace-roots'])
    ? state['active-workspace-roots']
    : [];
  for (const root of roots) {
    const value = trimText(root);
    if (!value) continue;
    return value;
  }
  return '';
}

function parseSessionMetaHead(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const firstLine = trimText(raw.split('\n')[0] || '');
    if (!firstLine.startsWith('{')) return null;
    const head = JSON.parse(firstLine);
    if (!head || head.type !== 'session_meta' || !head.payload || typeof head.payload !== 'object') {
      return null;
    }
    return head;
  } catch (_) {
    return null;
  }
}

function walkSessionFiles(rootDir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkSessionFiles(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function findLatestWorkspaceThread(input = {}) {
  const sessionsRoot = trimText(input.sessionsRoot || resolveSessionsRoot());
  const workspaceCwd = trimText(input.cwd || input.workspaceCwd || resolveDesktopWorkspaceRoot(input.statePath || ''));
  const sourceFilter = trimText(input.source || '');
  const originatorFilter = trimText(input.originator || '');
  const excludes = Array.isArray(input.excludeThreadIds)
    ? new Set(input.excludeThreadIds.map((v) => trimText(v)).filter(Boolean))
    : new Set();

  if (!sessionsRoot) return { ok: false, error: 'sessions_root_missing' };
  if (!workspaceCwd) return { ok: false, error: 'workspace_cwd_missing' };

  const files = walkSessionFiles(sessionsRoot, []);
  let best = null;
  for (const filePath of files) {
    const head = parseSessionMetaHead(filePath);
    if (!head) continue;
    const payload = head.payload || {};
    const threadId = trimText(payload.id || '');
    if (!threadId || excludes.has(threadId)) continue;
    const cwd = trimText(payload.cwd || '');
    const source = trimText(payload.source || '');
    const originator = trimText(payload.originator || '');
    if (cwd !== workspaceCwd) continue;
    if (sourceFilter && source !== sourceFilter) continue;
    if (originatorFilter && originator !== originatorFilter) continue;
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      continue;
    }
    const mtimeMs = Number(stat && stat.mtimeMs || 0);
    if (!best || mtimeMs > best.mtimeMs) {
      best = {
        threadId,
        filePath,
        cwd,
        source,
        originator,
        mtimeMs,
      };
    }
  }
  if (!best) return { ok: false, error: 'thread_not_found', workspaceCwd, sessionsRoot };
  return { ok: true, ...best };
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function resolveSessionsRoot() {
  const custom = trimText(process.env.CODEX_SESSIONS_ROOT || '');
  if (custom) return path.isAbsolute(custom) ? custom : path.resolve(custom);
  return path.join(os.homedir(), '.codex', 'sessions');
}

function findSessionFilesByThreadId(threadId, rootDir, out = []) {
  const needle = trimText(threadId);
  if (!needle) return out;
  const root = trimText(rootDir);
  if (!root) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      findSessionFilesByThreadId(needle, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    if (entry.name.includes(needle)) out.push(full);
  }
  return out;
}

function findSessionFileByThreadId(threadId, rootDir) {
  const files = findSessionFilesByThreadId(threadId, rootDir, []);
  if (!Array.isArray(files) || files.length === 0) return '';
  let bestPath = '';
  let bestMtime = -1;
  for (const filePath of files) {
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      continue;
    }
    const mtimeMs = Number(stat && stat.mtimeMs || 0);
    if (!bestPath || mtimeMs > bestMtime) {
      bestPath = filePath;
      bestMtime = mtimeMs;
    }
  }
  return bestPath || files[0];
}

function upsertSessionMetaSource(input = {}) {
  const threadId = trimText(input.threadId || input.thread_id || '');
  if (!threadId) return { ok: false, error: 'thread_id_required' };
  const targetSource = trimText(input.source || 'vscode') || 'vscode';
  const targetCwd = trimText(input.cwd || '') || resolveDesktopWorkspaceRoot();
  const targetOriginator = trimText(input.originator || 'Codex Desktop') || 'Codex Desktop';
  const sessionsRoot = resolveSessionsRoot();
  const filePaths = findSessionFilesByThreadId(threadId, sessionsRoot, []);
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { ok: false, error: 'session_file_not_found', sessionsRoot, threadId };
  }

  const patchedFiles = [];
  let latestPatchedFilePath = '';
  let latestPatchedMtime = -1;
  try {
    for (const filePath of filePaths) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parts = raw.split('\n');
      const firstLine = trimText(parts[0] || '');
      if (!firstLine.startsWith('{')) continue;
      const head = JSON.parse(firstLine);
      if (!head || head.type !== 'session_meta' || !head.payload || typeof head.payload !== 'object') continue;
      if (trimText(head.payload.id) !== threadId) continue;

      head.payload.source = targetSource;
      if (targetCwd) head.payload.cwd = targetCwd;
      if (targetOriginator) head.payload.originator = targetOriginator;
      parts[0] = JSON.stringify(head);
      const merged = parts.join('\n');
      const dir = path.dirname(filePath);
      const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.jsonl`);
      fs.writeFileSync(tmp, merged, 'utf8');
      fs.renameSync(tmp, filePath);
      patchedFiles.push(filePath);

      let stat = null;
      try {
        stat = fs.statSync(filePath);
      } catch (_) {
        stat = null;
      }
      const mtimeMs = Number(stat && stat.mtimeMs || 0);
      if (!latestPatchedFilePath || mtimeMs > latestPatchedMtime) {
        latestPatchedFilePath = filePath;
        latestPatchedMtime = mtimeMs;
      }
    }

    if (patchedFiles.length === 0) {
      return { ok: false, error: 'session_meta_missing', threadId, sessionsRoot };
    }
    return {
      ok: true,
      filePath: latestPatchedFilePath || patchedFiles[0],
      filePaths: patchedFiles,
      threadId,
      source: targetSource,
      cwd: targetCwd,
      originator: targetOriginator,
    };
  } catch (error) {
    return {
      ok: false,
      threadId,
      filePaths,
      error: trimText(error && (error.message || error)) || 'failed_to_patch_session_meta',
    };
  }
}

function ensureThreadTitlesRoot(root) {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return { 'thread-titles': { titles: {}, order: [] } };
  const bucket = root['thread-titles'];
  const titles = bucket && typeof bucket.titles === 'object' && !Array.isArray(bucket.titles)
    ? { ...bucket.titles }
    : {};
  const order = bucket && Array.isArray(bucket.order)
    ? [...bucket.order].map((v) => trimText(v)).filter(Boolean)
    : [];
  root['thread-titles'] = { titles, order };
  return root;
}

function upsertThreadTitle(input = {}) {
  const threadId = trimText(input.threadId || input.thread_id || '');
  if (!threadId) {
    return { ok: false, error: 'thread_id_required' };
  }
  const title = compactText(input.title || 'Telegram Codex task', Number(input.maxTitleLength) || 120);
  const maxOrder = Math.max(20, Number(input.maxOrder) || 200);
  const statePath = resolveGlobalStatePath();

  try {
    const state = ensureThreadTitlesRoot(readJsonSafe(statePath));
    const bucket = state['thread-titles'];
    bucket.titles[threadId] = title || bucket.titles[threadId] || 'Telegram Codex task';
    bucket.order = [threadId, ...bucket.order.filter((id) => id !== threadId)].slice(0, maxOrder);
    writeJsonAtomic(statePath, state);
    return { ok: true, statePath, threadId };
  } catch (error) {
    return {
      ok: false,
      statePath,
      threadId,
      error: trimText(error && (error.message || error)) || 'failed_to_write',
    };
  }
}

module.exports = {
  findLatestWorkspaceThread,
  findSessionFileByThreadId,
  resolveDesktopWorkspaceRoot,
  upsertSessionMetaSource,
  upsertThreadTitle,
  resolveGlobalStatePath,
  resolveSessionsRoot,
};
