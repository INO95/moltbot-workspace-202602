const fsDefault = require('fs');
const pathDefault = require('path');

function writeJsonFileSafe(filePath, payload, deps = {}) {
  const fsModule = deps.fsModule || fsDefault;
  const pathModule = deps.pathModule || pathDefault;
  try {
    fsModule.mkdirSync(pathModule.dirname(filePath), { recursive: true });
    fsModule.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function readJsonFileSafe(filePath, deps = {}) {
  const fsModule = deps.fsModule || fsDefault;
  try {
    if (!fsModule.existsSync(filePath)) return null;
    return JSON.parse(fsModule.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveLastProjectBootstrap(fields = {}, bootstrap = null, deps = {}) {
  const writeFn = typeof deps.writeJsonFileSafe === 'function'
    ? deps.writeJsonFileSafe
    : (filePath, payload) => writeJsonFileSafe(filePath, payload, deps);
  const statePath = String(deps.statePath || '').trim();
  const nowIso = typeof deps.nowIso === 'function'
    ? deps.nowIso
    : () => new Date().toISOString();

  if (!statePath) return false;
  if (!fields || typeof fields !== 'object') return false;
  if (!bootstrap || typeof bootstrap !== 'object') return false;

  const snapshot = {
    savedAt: nowIso(),
    fields: {
      프로젝트명: String(fields.프로젝트명 || '').trim(),
      목표: String(fields.목표 || '').trim(),
      스택: String(fields.스택 || '').trim(),
      경로: String(fields.경로 || '').trim(),
      완료기준: String(fields.완료기준 || '').trim(),
      초기화: String(fields.초기화 || bootstrap.initMode || 'plan').trim(),
    },
    bootstrap: {
      projectName: String(bootstrap.projectName || '').trim(),
      targetPath: String(bootstrap.targetPath || '').trim(),
      template: String(bootstrap.template || '').trim(),
      templateLabel: String(bootstrap.templateLabel || '').trim(),
      initMode: String(bootstrap.initMode || '').trim(),
      pathAllowed: Boolean(bootstrap.pathPolicy && bootstrap.pathPolicy.allowed),
    },
  };
  return writeFn(statePath, snapshot);
}

function loadLastProjectBootstrap(maxAgeHours = 48, deps = {}) {
  const readFn = typeof deps.readJsonFileSafe === 'function'
    ? deps.readJsonFileSafe
    : (filePath) => readJsonFileSafe(filePath, deps);
  const statePath = String(deps.statePath || '').trim();
  const nowMs = typeof deps.nowMs === 'function'
    ? deps.nowMs
    : () => Date.now();

  if (!statePath) return null;

  const parsed = readFn(statePath);
  if (!parsed || typeof parsed !== 'object') return null;
  const savedAt = Date.parse(String(parsed.savedAt || ''));
  if (!Number.isFinite(savedAt)) return null;
  const ageMs = nowMs() - savedAt;
  if (ageMs < 0 || ageMs > maxAgeHours * 60 * 60 * 1000) return null;
  const fields = parsed.fields && typeof parsed.fields === 'object' ? parsed.fields : {};
  if (!String(fields.프로젝트명 || '').trim()) return null;
  return parsed;
}

function resolveDefaultProjectBasePath(deps = {}) {
  const pathModule = deps.pathModule || pathDefault;
  return pathModule.resolve('/Users/inho-baek/Projects');
}

function toProjectTemplatePayload(fields = {}, options = {}, deps = {}) {
  const sanitizeProjectName = deps.sanitizeProjectName;
  const resolveDefaultBasePath = typeof deps.resolveDefaultProjectBasePath === 'function'
    ? deps.resolveDefaultProjectBasePath
    : () => resolveDefaultProjectBasePath(deps);
  if (typeof sanitizeProjectName !== 'function') {
    throw new Error('toProjectTemplatePayload requires sanitizeProjectName dependency');
  }

  const forceExecute = Boolean(options && options.forceExecute);
  const projectName = sanitizeProjectName(fields.프로젝트명 || fields.projectName || 'rust-tap-game');
  const goal = String(fields.목표 || fields.goal || '모바일에서 실행 가능한 Rust 웹게임 템플릿 생성').trim();
  const stack = String(fields.스택 || fields.stack || 'rust wasm web').trim();
  const basePathRaw = String(fields.경로 || fields.path || resolveDefaultBasePath()).trim();
  const done = String(fields.완료기준 || fields.done || '프로젝트 폴더와 기본 Rust/WASM 파일 생성').trim();
  const initRaw = String(fields.초기화 || fields.initMode || 'execute').trim();
  const initMode = forceExecute ? 'execute' : (initRaw || 'execute');
  return [
    `프로젝트명: ${projectName}`,
    `목표: ${goal}`,
    `스택: ${stack}`,
    `경로: ${basePathRaw}`,
    `완료기준: ${done}`,
    `초기화: ${initMode}`,
  ].join('; ');
}

module.exports = {
  writeJsonFileSafe,
  readJsonFileSafe,
  saveLastProjectBootstrap,
  loadLastProjectBootstrap,
  resolveDefaultProjectBasePath,
  toProjectTemplatePayload,
};
