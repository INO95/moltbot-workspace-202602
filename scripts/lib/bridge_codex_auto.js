const codexManager = require('../capabilities/codex_manager');

function trimText(value) {
  return String(value || '').trim();
}

function resolveCodexBotIds(env = process.env) {
  const raw = trimText(env.CODEX_AUTOROUTE_BOT_IDS || '');
  const defaults = ['bot-codex', 'bot-daily-bak'];
  if (!raw) return defaults;
  const out = [];
  const seen = new Set();
  for (const token of raw.split(',')) {
    const key = trimText(token).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.length > 0 ? out : defaults;
}

function isCodexBotRuntime(env = process.env) {
  const botId = trimText(env.MOLTBOT_BOT_ID || '').toLowerCase();
  const profile = trimText(env.MOLTBOT_PROFILE || env.OPENCLAW_PROFILE || '').toLowerCase();
  const codexBotIds = resolveCodexBotIds(env);
  if (codexBotIds.includes(botId)) return true;
  return botId === 'codex'
    || profile === 'codex';
}

function buildHelpReply() {
  return [
    '코덱스 봇 사용법',
    '- 작업 시작: 그냥 요청을 보내거나 `코덱스: <요청>`',
    '- 질문 답변: 코덱스가 질문하면 답장을 그대로 보내기',
    '- 대기열 다음 작업 실행: `/next`',
    '- 상태: `/status`',
    '- 취소: `/cancel`',
  ].join('\n');
}

function normalizeCodexCommand(text, waitingInput = false) {
  const raw = trimText(text);
  if (!raw) return { action: 'help', payload: {} };
  if (/^운영\s*[:：]/i.test(raw)) return { action: 'passthrough', payload: {} };

  const lower = raw.toLowerCase();
  if (lower === '/help' || lower === 'help' || lower === '도움말' || lower === '사용법') {
    return { action: 'help', payload: {} };
  }
  if (lower === '/status' || lower === 'status' || lower === '상태') {
    return { action: 'status', payload: {} };
  }
  if (lower === '/cancel' || lower === '/stop' || lower === '취소' || lower === '중단') {
    return { action: 'cancel', payload: {} };
  }
  if (lower === '/next' || lower === 'next' || lower === '다음') {
    return { action: 'start', payload: { use_queue: true } };
  }

  const startMatch = raw.match(/^\/start(?:\s+(.+))?$/i);
  if (startMatch) {
    const prompt = trimText(startMatch[1] || '');
    if (!prompt) return { action: 'start', payload: { use_queue: true } };
    return { action: 'start', payload: { prompt } };
  }

  const prefixed = raw.match(/^코덱스\s*[:：]\s*(.+)$/i);
  if (prefixed) {
    return { action: 'start', payload: { prompt: trimText(prefixed[1] || '') } };
  }

  if (waitingInput) {
    return { action: 'answer', payload: { answer: raw } };
  }

  return { action: 'start', payload: { prompt: raw } };
}

function toBridgeResult(base = {}, action = '') {
  const status = trimText(base.status || '');
  const queued = Boolean(base.queued);
  const requestId = trimText(base.request_id || '');
  const threadId = trimText(base.thread_id || '');
  const errorCode = trimText(base.error_code || '');
  const errorText = trimText(base.error || '');
  return {
    route: 'codex',
    templateValid: true,
    success: Boolean(base.ok),
    capability: 'codex',
    capabilityAction: trimText(action || base.action || ''),
    queued,
    waitingInput: status === 'waiting_input',
    status: status || undefined,
    requestId: requestId || undefined,
    threadId: threadId || undefined,
    queueLength: Number.isFinite(base.queue_length) ? Number(base.queue_length) : undefined,
    errorCode: errorCode || undefined,
    error: errorText || undefined,
    telegramReply: trimText(base.telegramReply || '') || (base.ok ? '코덱스 작업을 처리했습니다.' : '코덱스 작업 처리에 실패했습니다.'),
  };
}

function handleCodexBotAutoCommand(input = {}) {
  const env = input.env || process.env;
  if (!isCodexBotRuntime(env)) return null;
  const normalizedText = trimText(input.normalizedText || input.rawText || '');

  const snapshot = codexManager.getSessionSnapshot({
    requested_by: input.requestedBy || '',
    telegram_context: input.telegramContext || null,
  });
  const waitingInput = Boolean(
    snapshot
    && snapshot.session
    && snapshot.session.active
    && snapshot.session.active.status === 'waiting_input',
  );

  const command = normalizeCodexCommand(normalizedText, waitingInput);
  if (command.action === 'passthrough') return null;
  if (command.action === 'help') {
    return {
      route: 'codex',
      templateValid: true,
      success: true,
      capability: 'codex',
      capabilityAction: 'help',
      telegramReply: buildHelpReply(),
    };
  }

  const executed = codexManager.execute({
    action: command.action,
    payload: command.payload,
    requested_by: input.requestedBy || '',
    telegram_context: input.telegramContext || null,
  });
  return toBridgeResult(executed, command.action);
}

module.exports = {
  isCodexBotRuntime,
  resolveCodexBotIds,
  normalizeCodexCommand,
  handleCodexBotAutoCommand,
  buildHelpReply,
};
