const fs = require('fs');
const os = require('os');
const path = require('path');

const MAIN_SESSION_KEY = 'agent:main:main';
const DEFAULT_PROMPT_FILES = Object.freeze(['AGENTS.md', 'IDENTITY.md', 'HEARTBEAT.md', 'TOOLS.md']);
const DEFAULT_MAX_TOTAL_TOKENS = 60000;
const DEFAULT_STALE_ROTATE_TOKENS = 30000;
const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;

function toFiniteNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toMillis(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function readJson(filePath, fsModule = fs) {
  return JSON.parse(fsModule.readFileSync(filePath, 'utf8'));
}

function buildMainSessionsDirCandidates({ root, homeDir = os.homedir(), env = process.env, pathModule = path } = {}) {
  return [
    pathModule.join(String(env.OPENCLAW_STATE_DIR || ''), 'agents', 'main', 'sessions'),
    pathModule.join(homeDir, '.openclaw-daily', 'agents', 'main', 'sessions'),
    pathModule.join(homeDir, '.openclaw', 'agents', 'main', 'sessions'),
    pathModule.join(root, 'configs', 'dev', 'agents', 'main', 'sessions'),
    pathModule.join(root, 'configs', 'main', 'agents', 'main', 'sessions'),
  ].filter((item) => String(item || '').trim().length > 0);
}

function resolveMainSessionPaths({
  root,
  homeDir = os.homedir(),
  env = process.env,
  fsModule = fs,
  pathModule = path,
} = {}) {
  const candidates = buildMainSessionsDirCandidates({ root, homeDir, env, pathModule });
  let firstExisting = null;
  for (const dir of candidates) {
    const sessionsJson = pathModule.join(dir, 'sessions.json');
    if (!fsModule.existsSync(sessionsJson)) continue;
    if (!firstExisting) firstExisting = { sessionsDir: dir, sessionsJson };
    try {
      const parsed = readJson(sessionsJson, fsModule);
      if (parsed && typeof parsed === 'object' && parsed[MAIN_SESSION_KEY]) {
        return { sessionsDir: dir, sessionsJson };
      }
    } catch (_) {
      // Keep scanning.
    }
  }
  if (firstExisting) return firstExisting;
  const fallbackDir = candidates[0];
  return {
    sessionsDir: fallbackDir,
    sessionsJson: pathModule.join(fallbackDir, 'sessions.json'),
  };
}

function readMainSessionState(options = {}) {
  const fsModule = options.fsModule || fs;
  const paths = resolveMainSessionPaths(options);
  if (!fsModule.existsSync(paths.sessionsJson)) {
    return { ok: false, reason: 'sessions.json not found', paths, sessions: null, current: null };
  }
  try {
    const sessions = readJson(paths.sessionsJson, fsModule);
    const current = sessions && typeof sessions === 'object' ? sessions[MAIN_SESSION_KEY] : null;
    if (!current) {
      return { ok: false, reason: 'main session key missing', paths, sessions, current: null };
    }
    return { ok: true, reason: 'ok', paths, sessions, current };
  } catch (error) {
    return { ok: false, reason: `parse error: ${error.message}`, paths, sessions: null, current: null };
  }
}

function getPromptFileSizeMap({
  root,
  promptFiles = DEFAULT_PROMPT_FILES,
  fsModule = fs,
  pathModule = path,
} = {}) {
  return promptFiles.reduce((acc, name) => {
    const filePath = pathModule.join(root, name);
    acc[name] = fsModule.existsSync(filePath) ? fsModule.statSync(filePath).size : null;
    return acc;
  }, {});
}

function sumFiniteValues(obj = {}) {
  return Object.values(obj).reduce((acc, value) => (
    Number.isFinite(Number(value)) ? acc + Number(value) : acc
  ), 0);
}

function summarizePromptSnapshot(report, promptFiles = DEFAULT_PROMPT_FILES) {
  const byFile = {};
  for (const name of promptFiles) byFile[name] = null;
  const injectedFiles = Array.isArray(report && report.injectedWorkspaceFiles)
    ? report.injectedWorkspaceFiles
    : [];
  let hasSnapshot = false;
  for (const row of injectedFiles) {
    const name = String(row && row.name || '').trim();
    if (!name || !Object.prototype.hasOwnProperty.call(byFile, name)) continue;
    const rawChars = toFiniteNumber(row && row.rawChars, row && row.injectedChars);
    byFile[name] = rawChars;
    hasSnapshot = true;
  }
  return {
    hasSnapshot,
    byFile,
    injectedWorkspaceChars: sumFiniteValues(byFile),
    toolSchemaChars: toFiniteNumber(report && report.tools && report.tools.schemaChars, 0) || 0,
    skillsPromptChars: toFiniteNumber(report && report.skills && report.skills.promptChars, 0) || 0,
  };
}

function evaluateMainSessionRotation(current, {
  root,
  nowMs = Date.now(),
  maxTotalTokens = DEFAULT_MAX_TOTAL_TOKENS,
  staleRotateTokens = DEFAULT_STALE_ROTATE_TOKENS,
  staleAgeMs = DEFAULT_STALE_AGE_MS,
  promptFiles = DEFAULT_PROMPT_FILES,
  fsModule = fs,
  pathModule = path,
} = {}) {
  const totalTokens = toFiniteNumber(current && current.totalTokens, current && current.contextTokens);
  const tokenSource = Number.isFinite(Number(current && current.totalTokens))
    ? 'totalTokens'
    : (Number.isFinite(Number(current && current.contextTokens)) ? 'contextTokens' : 'unknown');
  const updatedAtMs = toMillis(current && current.updatedAt);
  const isStale = Number.isFinite(updatedAtMs) ? (nowMs - updatedAtMs) >= staleAgeMs : false;
  const currentPromptSizes = getPromptFileSizeMap({ root, promptFiles, fsModule, pathModule });
  const snapshot = summarizePromptSnapshot(current && current.systemPromptReport, promptFiles);
  const mismatchedFiles = [];
  if (snapshot.hasSnapshot) {
    for (const name of promptFiles) {
      const currentSize = currentPromptSizes[name];
      const snapshotSize = snapshot.byFile[name];
      if (!Number.isFinite(Number(currentSize))) continue;
      if (!Number.isFinite(Number(snapshotSize)) || Number(snapshotSize) !== Number(currentSize)) {
        mismatchedFiles.push(name);
      }
    }
  }
  const promptSnapshotMismatch = mismatchedFiles.length > 0;

  let reason = 'below rotation threshold';
  let shouldRotate = false;
  if (promptSnapshotMismatch) {
    shouldRotate = true;
    reason = `prompt snapshot mismatch: ${mismatchedFiles.join(', ')}`;
  } else if (Number.isFinite(totalTokens) && totalTokens >= maxTotalTokens) {
    shouldRotate = true;
    reason = `main session token ceiling reached (${totalTokens} >= ${maxTotalTokens})`;
  } else if (Number.isFinite(totalTokens) && totalTokens >= staleRotateTokens && isStale) {
    shouldRotate = true;
    reason = `main session stale with large context (${totalTokens} >= ${staleRotateTokens})`;
  } else if (snapshot.hasSnapshot) {
    reason = 'prompt snapshot up to date';
  } else if (!Number.isFinite(totalTokens)) {
    reason = 'insufficient token metadata';
  }

  return {
    recommended: shouldRotate,
    reason,
    totalTokens,
    tokenSource,
    updatedAtMs,
    isStale,
    thresholds: {
      maxTotalTokens,
      staleRotateTokens,
      staleAgeMs,
    },
    promptBudget: {
      currentInjectedWorkspaceChars: sumFiniteValues(currentPromptSizes),
      snapshotInjectedWorkspaceChars: snapshot.injectedWorkspaceChars,
      toolSchemaChars: snapshot.toolSchemaChars,
      skillsPromptChars: snapshot.skillsPromptChars,
      currentByFile: currentPromptSizes,
      snapshotByFile: snapshot.byFile,
      mismatchedFiles,
    },
  };
}

function readLatestSystemPromptReport(options = {}) {
  const fsModule = options.fsModule || fs;
  const state = readMainSessionState(options);
  if (state.ok && state.current && state.current.systemPromptReport) {
    return state.current.systemPromptReport;
  }
  const dir = state.paths && state.paths.sessionsDir;
  if (!dir || !fsModule.existsSync(dir)) return null;
  const backups = fsModule.readdirSync(dir)
    .filter((name) => name.startsWith('sessions.json.bak.'))
    .sort()
    .reverse();
  for (const name of backups) {
    try {
      const parsed = readJson(path.join(dir, name), fsModule);
      const report = parsed && parsed[MAIN_SESSION_KEY] && parsed[MAIN_SESSION_KEY].systemPromptReport;
      if (report) return report;
    } catch (_) {
      // Keep scanning backups.
    }
  }
  return null;
}

function backupFilePath(filePath, fsModule = fs) {
  const backupPath = `${filePath}.bak.${Date.now()}`;
  fsModule.copyFileSync(filePath, backupPath);
  return backupPath;
}

function rotateMainSessionIfNeeded(options = {}) {
  const fsModule = options.fsModule || fs;
  const pathModule = options.pathModule || path;
  const state = readMainSessionState(options);
  if (!state.ok) {
    return { rotated: false, reason: state.reason };
  }
  const decision = evaluateMainSessionRotation(state.current, {
    root: options.root,
    nowMs: options.nowMs,
    fsModule,
    pathModule,
  });
  if (!decision.recommended) {
    return {
      rotated: false,
      reason: decision.reason,
      totalTokens: decision.totalTokens,
      tokenSource: decision.tokenSource,
      isStale: decision.isStale,
      promptBudget: decision.promptBudget,
    };
  }

  const sessionKey = String(options.sessionKey || MAIN_SESSION_KEY);
  const backupFn = typeof options.backupFn === 'function'
    ? options.backupFn
    : ((filePath) => backupFilePath(filePath, fsModule));
  const backups = {
    sessionsJson: backupFn(state.paths.sessionsJson),
    sessionFile: null,
  };
  const sessionId = String(state.current.sessionId || '').trim();
  const sessionFile = sessionId ? pathModule.join(state.paths.sessionsDir, `${sessionId}.jsonl`) : null;
  if (sessionFile && fsModule.existsSync(sessionFile)) {
    backups.sessionFile = backupFn(sessionFile);
  }
  delete state.sessions[sessionKey];
  fsModule.writeFileSync(state.paths.sessionsJson, JSON.stringify(state.sessions, null, 2), 'utf8');
  return {
    rotated: true,
    reason: decision.reason,
    totalTokens: decision.totalTokens,
    tokenSource: decision.tokenSource,
    isStale: decision.isStale,
    promptBudget: decision.promptBudget,
    backups,
  };
}

module.exports = {
  MAIN_SESSION_KEY,
  DEFAULT_PROMPT_FILES,
  DEFAULT_MAX_TOTAL_TOKENS,
  DEFAULT_STALE_ROTATE_TOKENS,
  DEFAULT_STALE_AGE_MS,
  resolveMainSessionPaths,
  readMainSessionState,
  rotateMainSessionIfNeeded,
  getPromptFileSizeMap,
  summarizePromptSnapshot,
  evaluateMainSessionRotation,
  readLatestSystemPromptReport,
};
