function enqueueFileControlCommand(command = {}, deps = {}) {
  const makeRequestId = deps.makeRequestId;
  const enqueueCommand = deps.enqueueCommand;
  if (typeof makeRequestId !== 'function' || typeof enqueueCommand !== 'function') {
    throw new Error('enqueueFileControlCommand requires makeRequestId/enqueueCommand deps');
  }

  const normalized = {
    schema_version: '1.0',
    request_id: makeRequestId('opsfc'),
    phase: String(command.phase || 'plan'),
    intent_action: String(command.intent_action || '').trim(),
    requested_by: String(command.requested_by || '').trim() || 'unknown',
    telegram_context: (command.telegram_context && typeof command.telegram_context === 'object')
      ? command.telegram_context
      : null,
    payload: (command.payload && typeof command.payload === 'object') ? command.payload : {},
    created_at: new Date().toISOString(),
  };
  return enqueueCommand(normalized);
}

function enqueueCapabilityCommand(command = {}, deps = {}) {
  const makeRequestId = deps.makeRequestId;
  const enqueueCommand = deps.enqueueCommand;
  const env = (deps.env && typeof deps.env === 'object') ? deps.env : process.env;
  if (typeof makeRequestId !== 'function' || typeof enqueueCommand !== 'function') {
    throw new Error('enqueueCapabilityCommand requires makeRequestId/enqueueCommand deps');
  }

  const capability = String(command.capability || '').trim().toLowerCase();
  const action = String(command.action || '').trim().toLowerCase();
  const payload = (command.payload && typeof command.payload === 'object')
    ? { ...command.payload }
    : {};
  const originBotId = String(command.origin_bot_id || env.MOLTBOT_BOT_ID || '').trim();
  if (originBotId && !String(payload.origin_bot_id || '').trim()) {
    payload.origin_bot_id = originBotId;
  }
  const normalized = {
    schema_version: '1.0',
    request_id: makeRequestId('opsc'),
    command_kind: 'capability',
    phase: String(command.phase || 'plan').trim().toLowerCase(),
    capability,
    action,
    intent_action: `capability:${capability}:${action}`,
    risk_tier: String(command.risk_tier || 'MEDIUM').trim().toUpperCase(),
    requires_approval: Boolean(command.requires_approval),
    requested_by: String(command.requested_by || '').trim() || 'unknown',
    telegram_context: (command.telegram_context && typeof command.telegram_context === 'object')
      ? command.telegram_context
      : null,
    reason: String(command.reason || '').trim(),
    payload,
    created_at: new Date().toISOString(),
  };
  return enqueueCommand(normalized);
}

function queueOpsRequest(action, targetKey, targets, reason = '', deps = {}) {
  const fsModule = deps.fsModule;
  const pathModule = deps.pathModule;
  const queuePath = String(deps.queuePath || '').trim();
  const nowMs = typeof deps.nowMs === 'function' ? deps.nowMs : () => Date.now();
  const randomString = typeof deps.randomString === 'function'
    ? deps.randomString
    : () => Math.random().toString(36).slice(2, 8);

  if (!fsModule || typeof fsModule.mkdirSync !== 'function' || typeof fsModule.appendFileSync !== 'function') {
    throw new Error('queueOpsRequest requires fsModule with mkdirSync/appendFileSync');
  }
  if (!pathModule || typeof pathModule.dirname !== 'function') {
    throw new Error('queueOpsRequest requires pathModule with dirname');
  }
  if (!queuePath) {
    throw new Error('queueOpsRequest requires queuePath');
  }

  const id = `ops-${nowMs()}-${randomString()}`;
  const row = {
    id,
    createdAt: new Date().toISOString(),
    action,
    target: targetKey,
    targets,
    reason: String(reason || '').trim(),
    status: 'pending',
  };
  const dir = pathModule.dirname(queuePath);
  fsModule.mkdirSync(dir, { recursive: true });
  fsModule.appendFileSync(queuePath, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

module.exports = {
  enqueueFileControlCommand,
  enqueueCapabilityCommand,
  queueOpsRequest,
};
