const fs = require('fs');

function countJsonFiles(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    return fs.readdirSync(dirPath).filter((name) => name.endsWith('.json')).length;
  } catch (_) {
    return 0;
  }
}

function runApprovalGc(store) {
  const before = {
    pending: countJsonFiles(store.APPROVAL_PENDING_DIR),
    consumed: countJsonFiles(store.APPROVAL_CONSUMED_DIR),
  };
  const gc = store.expirePendingTokens();
  store.syncPendingApprovalsMirror();
  const after = {
    pending: countJsonFiles(store.APPROVAL_PENDING_DIR),
    consumed: countJsonFiles(store.APPROVAL_CONSUMED_DIR),
  };
  return { before, gc, after };
}

module.exports = {
  runApprovalGc,
};
