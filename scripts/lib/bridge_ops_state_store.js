const fsDefault = require('fs');

function readOpsSnapshot(filePath, deps = {}) {
  const fsModule = deps.fsModule || fsDefault;
  try {
    const raw = fsModule.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw);
    if (!json || !Array.isArray(json.containers)) return null;
    return json;
  } catch (_) {
    return null;
  }
}

function readPendingApprovalsState(filePath, deps = {}) {
  const fsModule = deps.fsModule || fsDefault;
  try {
    if (!fsModule.existsSync(filePath)) return [];
    const raw = fsModule.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed && parsed.pending) ? parsed.pending : [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  readOpsSnapshot,
  readPendingApprovalsState,
};
