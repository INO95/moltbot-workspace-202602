#!/usr/bin/env node
const opsApprovalStore = require('./ops_approval_store');

try {
  opsApprovalStore.ensureLayout();
  const result = opsApprovalStore.expirePendingTokens();
  console.log(JSON.stringify({
    ok: true,
    ...result,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: String(error && error.message ? error.message : error),
  }, null, 2));
  process.exit(1);
}
