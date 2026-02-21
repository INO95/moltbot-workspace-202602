const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ensureTestOpsIsolation } = require('./lib/test_ops_isolation');

ensureTestOpsIsolation('approval-identity-modes');

const opsApprovalStore = require('./ops_approval_store');

function removeToken(token) {
  if (!token) return;
  fs.rmSync(path.join(opsApprovalStore.APPROVAL_PENDING_DIR, `${token}.json`), { force: true });
  fs.rmSync(path.join(opsApprovalStore.APPROVAL_CONSUMED_DIR, `${token}.json`), { force: true });
}

function createToken(requestId) {
  return opsApprovalStore.createApprovalToken({
    requestId,
    requestedBy: 'user-owner',
    botId: 'bot-dev',
    requiredFlags: [],
    plan: {
      command_kind: 'capability',
      capability: 'exec',
      action: 'run',
      intent_action: 'capability:exec:run',
      payload: { command: 'pwd' },
      risk_tier: 'MEDIUM',
      mutating: false,
      required_flags: [],
    },
    planSummary: {
      risk_tier: 'MEDIUM',
    },
  });
}

function main() {
  opsApprovalStore.ensureLayout();
  const previous = process.env.OPS_UNIFIED_APPROVAL_IDENTITY_MODE;

  const strict = createToken(`test-identity-strict-${Date.now()}`);
  process.env.OPS_UNIFIED_APPROVAL_IDENTITY_MODE = 'strict_user_bot';
  let strictCode = '';
  try {
    opsApprovalStore.validateApproval({
      token: strict.token,
      requestedBy: 'user-owner',
      botId: 'bot-anki',
      providedFlags: [],
    });
  } catch (error) {
    strictCode = String(error && error.code ? error.code : '');
  }
  assert.strictEqual(strictCode, 'BOT_MISMATCH');
  removeToken(strict.token);

  const sameUser = createToken(`test-identity-same-user-${Date.now()}`);
  process.env.OPS_UNIFIED_APPROVAL_IDENTITY_MODE = 'same_user_any_bot';
  const validatedSameUser = opsApprovalStore.validateApproval({
    token: sameUser.token,
    requestedBy: 'user-owner',
    botId: 'bot-research',
    providedFlags: [],
  });
  assert.strictEqual(validatedSameUser.token, sameUser.token);
  removeToken(sameUser.token);

  const anyUser = createToken(`test-identity-any-user-${Date.now()}`);
  process.env.OPS_UNIFIED_APPROVAL_IDENTITY_MODE = 'any_user_any_bot';
  const validatedAny = opsApprovalStore.validateApproval({
    token: anyUser.token,
    requestedBy: 'other-user',
    botId: 'bot-anki',
    providedFlags: [],
  });
  assert.strictEqual(validatedAny.token, anyUser.token);
  removeToken(anyUser.token);

  opsApprovalStore.syncPendingApprovalsMirror();
  if (previous == null) {
    delete process.env.OPS_UNIFIED_APPROVAL_IDENTITY_MODE;
  } else {
    process.env.OPS_UNIFIED_APPROVAL_IDENTITY_MODE = previous;
  }

  console.log('test_approval_identity_modes: ok');
}

main();
