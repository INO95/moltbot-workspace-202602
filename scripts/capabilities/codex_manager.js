const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const codexState = require('../lib/codex_queue_state');
const codexThreadTitles = require('../lib/codex_thread_titles');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_WORKDIR = ROOT;
const DEFAULT_TIMEOUT_MS = Math.max(10000, Number(process.env.CODEX_CAPABILITY_TIMEOUT_MS || 300000));
const DEFAULT_STALE_RUNNING_MS = 120000;
const DEFAULT_STALE_RUNNING_NO_THREAD_MS = 20000;
const PROCESS_SCAN_TIMEOUT_MS = 1500;
const OPEN_THREAD_TIMEOUT_MS = 1200;
const OPEN_THREAD_COOLDOWN_MS = Math.max(1000, Number(process.env.CODEX_CAPABILITY_OPEN_THREAD_COOLDOWN_MS || 3000));
const STATUS_MARKER = /\[\[CODEX_STATUS:(WAITING_INPUT|COMPLETED|FAILED)\]\]/i;
const WAITING_HINT = /(추가\s*정보|정보가\s*필요|알려\s*주세요|확인\s*필요|원하시나요|무엇을|어떤)/i;
const QUESTION_HINT = /[?？]/;
const THREAD_ID_HINT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let lastDesktopThreadOpenAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix = 'cdx') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function trimText(value) {
  return String(value || '').trim();
}

function compactText(value, max = 500) {
  const raw = trimText(value);
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 3)}...`;
}

function parseIsoMs(value) {
  const raw = trimText(value);
  if (!raw) return NaN;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : NaN;
}

function resolveStaleRunningMs() {
  const raw = Number(process.env.CODEX_CAPABILITY_STALE_RUNNING_MS || DEFAULT_STALE_RUNNING_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STALE_RUNNING_MS;
  return Math.max(5000, Math.floor(raw));
}

function resolveStaleRunningNoThreadMs() {
  const raw = Number(
    process.env.CODEX_CAPABILITY_STALE_RUNNING_NO_THREAD_MS
    || DEFAULT_STALE_RUNNING_NO_THREAD_MS,
  );
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STALE_RUNNING_NO_THREAD_MS;
  return Math.max(3000, Math.floor(raw));
}

function shouldCheckLiveCodexProcess() {
  return isTruthyEnv('CODEX_CAPABILITY_STALE_PROCESS_CHECK', true);
}

function isLiveCodexProcessPresent() {
  if (!shouldCheckLiveCodexProcess()) return false;
  const probe = spawnSync('pgrep', ['-f', 'codex exec --json'], {
    encoding: 'utf8',
    timeout: PROCESS_SCAN_TIMEOUT_MS,
  });
  if (probe.error) return false;
  if (probe.status !== 0) return false;
  return Boolean(trimText(probe.stdout));
}

function isDryRun() {
  const raw = String(process.env.CODEX_CAPABILITY_DRY_RUN || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

function resolveCodexCli() {
  return trimText(process.env.CODEX_CAPABILITY_CLI || 'codex') || 'codex';
}

function resolveWorkdir(payload = {}) {
  const direct = trimText(payload.cwd || payload.path || '');
  const envWorkdir = trimText(process.env.CODEX_CAPABILITY_WORKDIR || '');
  const raw = direct || envWorkdir || DEFAULT_WORKDIR;
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

function resolveModel(payload = {}) {
  return trimText(payload.model || process.env.CODEX_CAPABILITY_MODEL || '');
}

function isTruthyEnv(name, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

function extractPromptFromPayload(payload = {}) {
  return trimText(
    payload.prompt
    || payload.task
    || payload.command
    || payload.content
    || payload.body
    || payload.message
    || '',
  );
}

function extractAnswerFromPayload(payload = {}) {
  return trimText(
    payload.answer
    || payload.response
    || payload.message
    || payload.content
    || payload.body
    || payload.command
    || payload.task
    || '',
  );
}

function buildControlPrompt(mode, userText) {
  const base = [
    'You are operating through a Telegram bridge.',
    'Always end your final assistant message with exactly one status marker on its own line:',
    '[[CODEX_STATUS:WAITING_INPUT]] or [[CODEX_STATUS:COMPLETED]] or [[CODEX_STATUS:FAILED]].',
    'If waiting for input, ask one clear question in Korean before the marker.',
    'If completed, provide a concise Korean progress report before the marker.',
    'Do not emit multiple markers.',
  ].join('\n');

  if (mode === 'answer') {
    return [
      base,
      '',
      '[사용자 추가 답변]',
      trimText(userText),
      '',
      'Continue the task and follow the status marker contract strictly.',
    ].join('\n');
  }

  return [
    base,
    '',
    '[사용자 작업 요청]',
    trimText(userText),
  ].join('\n');
}

function parseJsonLine(line) {
  const raw = trimText(line);
  if (!raw) return null;
  if (!raw.startsWith('{') || !raw.endsWith('}')) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function parseCodexOutput(stdout, stderr, fallbackThreadId = '') {
  const combined = `${String(stdout || '')}\n${String(stderr || '')}`;
  const lines = combined.split('\n');
  const events = [];
  const plainLines = [];
  let threadId = trimText(fallbackThreadId || '');
  const agentMessages = [];

  for (const line of lines) {
    const parsed = parseJsonLine(line);
    if (parsed && parsed.type) {
      events.push(parsed);
      if (parsed.type === 'thread.started') {
        const eventThreadId = trimText(parsed.thread_id || '');
        if (eventThreadId) threadId = eventThreadId;
      }
      if (
        parsed.type === 'item.completed'
        && parsed.item
        && parsed.item.type === 'agent_message'
      ) {
        const message = trimText(parsed.item.text || '');
        if (message) agentMessages.push(message);
      }
      continue;
    }
    const raw = trimText(line);
    if (!raw) continue;
    if (/^\d{4}-\d{2}-\d{2}T.*\b(?:WARN|ERROR)\b/i.test(raw)) continue;
    plainLines.push(raw);
  }

  const lastAgentMessage = agentMessages.length > 0
    ? agentMessages[agentMessages.length - 1]
    : trimText(plainLines.join('\n'));

  return {
    thread_id: threadId,
    events,
    last_agent_message: lastAgentMessage,
  };
}

function parseStatusMarker(text) {
  const raw = trimText(text);
  if (!raw) return { status: '', cleaned: '' };
  const match = raw.match(STATUS_MARKER);
  const cleaned = raw.replace(/\[\[CODEX_STATUS:[A-Z_]+\]\]/gi, '').trim();
  if (!match) return { status: '', cleaned };
  return {
    status: String(match[1] || '').trim().toLowerCase(),
    cleaned,
  };
}

function inferStatusFromText(text) {
  const raw = trimText(text);
  if (!raw) return 'failed';
  if (WAITING_HINT.test(raw) && QUESTION_HINT.test(raw)) return 'waiting_input';
  return 'completed';
}

function syncThreadTitle(threadId, rawTitle) {
  const id = trimText(threadId);
  if (!id) return;
  const title = compactText(rawTitle || '', 120) || 'Telegram Codex task';
  const titleOut = codexThreadTitles.upsertThreadTitle({
    threadId: id,
    title,
  });
  const sourceOut = codexThreadTitles.upsertSessionMetaSource({
    threadId: id,
    source: 'vscode',
    originator: 'Codex Desktop',
  });
  if (!titleOut || titleOut.ok !== true) {
    console.warn('[codex_manager] thread title sync failed', {
      thread_id: id,
      error: titleOut && titleOut.error ? titleOut.error : 'unknown_error',
      state_path: titleOut && titleOut.statePath ? titleOut.statePath : '',
    });
  }
  if (
    (!sourceOut || sourceOut.ok !== true)
    && (!sourceOut || sourceOut.error !== 'session_file_not_found')
  ) {
    console.warn('[codex_manager] session meta source sync failed', {
      thread_id: id,
      error: sourceOut && sourceOut.error ? sourceOut.error : 'unknown_error',
      sessions_root: sourceOut && sourceOut.sessionsRoot ? sourceOut.sessionsRoot : '',
      file_path: sourceOut && sourceOut.filePath ? sourceOut.filePath : '',
    });
  }
}

function syncSessionThreadTitles(session) {
  if (!session || typeof session !== 'object') return;
  const seen = new Set();
  const history = Array.isArray(session.history) ? session.history : [];
  // Preserve recency ordering: process oldest -> newest so the newest ends up at the top.
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const row = history[i];
    const threadId = trimText(row && row.thread_id || '');
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    syncThreadTitle(
      threadId,
      row && (row.summary || row.request_id) ? (row.summary || row.request_id) : 'Telegram Codex task',
    );
  }
  const active = session.active && typeof session.active === 'object' ? session.active : null;
  if (active) {
    const activeThreadId = trimText(active.thread_id || '');
    if (activeThreadId) {
      syncThreadTitle(
        activeThreadId,
        active.prompt || active.last_question || active.last_message || 'Telegram Codex task',
      );
    }
  }
}

function shouldResumeLatestWorkspaceThread() {
  return isTruthyEnv('CODEX_CAPABILITY_RESUME_LATEST_THREAD', false);
}

function resolveSessionPreferredThreadId(session = null) {
  if (!session || typeof session !== 'object') return '';
  const activeThreadId = trimText(session && session.active && session.active.thread_id || '');
  return activeThreadId;
}

function shouldOpenDesktopThreadViaDeepLink() {
  if (isDryRun()) return false;
  if (isTruthyEnv('CODEX_CAPABILITY_DISABLE_THREAD_DEEPLINK', false)) return false;
  if (isTruthyEnv('CODEX_CAPABILITY_FORCE_THREAD_DEEPLINK', false)) return true;
  if (process.platform !== 'darwin') return false;
  const botId = trimText(process.env.MOLTBOT_BOT_ID || '').toLowerCase();
  return botId === 'bot-daily-bak' || botId === 'bot-codex';
}

function openDesktopThreadViaDeepLink(threadId, reason = '') {
  const id = trimText(threadId);
  if (!id || !THREAD_ID_HINT.test(id)) return;
  if (!shouldOpenDesktopThreadViaDeepLink()) return;

  const now = Date.now();
  if (now - lastDesktopThreadOpenAt < OPEN_THREAD_COOLDOWN_MS) return;
  lastDesktopThreadOpenAt = now;

  const link = `codex://threads/${id}`;
  const run = spawnSync('open', [link], {
    encoding: 'utf8',
    timeout: OPEN_THREAD_TIMEOUT_MS,
  });
  if (run.error || run.status !== 0) {
    console.warn('[codex_manager] desktop thread deeplink failed', {
      thread_id: id,
      reason: trimText(reason),
      error: trimText(run.error && (run.error.message || run.error) || ''),
      status: Number.isInteger(run.status) ? run.status : null,
    });
  }
}

function resolvePreferredStartThreadId(payload = {}, session = null) {
  const explicit = trimText(payload.thread_id || payload.threadId || '');
  if (explicit) return explicit;
  const sessionPreferred = resolveSessionPreferredThreadId(session);
  if (sessionPreferred) return sessionPreferred;
  if (!shouldResumeLatestWorkspaceThread()) return '';

  const currentThreadId = trimText(session && session.active && session.active.thread_id || '');
  const picked = codexThreadTitles.findLatestWorkspaceThread({
    source: 'vscode',
    originator: 'Codex Desktop',
    excludeThreadIds: currentThreadId ? [currentThreadId] : [],
  });
  if (!picked || picked.ok !== true) return '';
  return trimText(picked.threadId || '');
}

function runCodexTurn({ mode, prompt, threadId = '', payload = {} }) {
  if (isDryRun()) {
    const answerLike = /need[_ -]?input|질문\s*필요|\[ask\]/i.test(prompt);
    if (mode === 'start' && answerLike) {
      return {
        ok: true,
        thread_id: threadId || `dry-${makeId('thread')}`,
        last_agent_message: '진행을 위해 대상 저장소 경로를 알려주세요.\n[[CODEX_STATUS:WAITING_INPUT]]',
      };
    }
    if (mode === 'answer' && /more/i.test(prompt)) {
      return {
        ok: true,
        thread_id: threadId || `dry-${makeId('thread')}`,
        last_agent_message: '추가로 필요한 옵션 이름을 알려주세요.\n[[CODEX_STATUS:WAITING_INPUT]]',
      };
    }
    return {
      ok: true,
      thread_id: threadId || `dry-${makeId('thread')}`,
      last_agent_message: '작업을 완료했습니다. 변경사항과 확인 결과를 보고합니다.\n[[CODEX_STATUS:COMPLETED]]',
    };
  }

  const workdir = resolveWorkdir(payload);
  const model = resolveModel(payload);
  const codexCli = resolveCodexCli();
  const timeoutMs = Math.max(10000, Number(process.env.CODEX_CAPABILITY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  const dangerousMode = isTruthyEnv('CODEX_CAPABILITY_DANGEROUS_MODE', false);

  let args = ['exec', '--json', '--skip-git-repo-check', '--cd', workdir];
  if (dangerousMode) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--full-auto');
  }
  if (model) args.push('--model', model);

  if (mode === 'answer') {
    args = [...args, 'resume', '--json', trimText(threadId), prompt];
  } else {
    args.push(prompt);
  }

  const run = spawnSync(codexCli, args, {
    encoding: 'utf8',
    cwd: workdir,
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
  });

  const parsed = parseCodexOutput(run.stdout, run.stderr, threadId);
  const processError = run.error
    ? String(run.error.message || run.error)
    : '';
  const exitCode = Number.isInteger(run.status) ? run.status : 1;
  const timedOut = Boolean(run.error && run.error.code === 'ETIMEDOUT');

  if (timedOut) {
    return {
      ok: false,
      thread_id: parsed.thread_id || trimText(threadId),
      error_code: 'CODEX_TIMEOUT',
      error: `codex exec timed out after ${timeoutMs}ms`,
      last_agent_message: parsed.last_agent_message,
    };
  }

  const hasMessage = Boolean(trimText(parsed.last_agent_message));
  if (exitCode !== 0 && !hasMessage) {
    return {
      ok: false,
      thread_id: parsed.thread_id || trimText(threadId),
      error_code: 'CODEX_EXEC_FAILED',
      error: processError || `codex exec failed with code ${exitCode}`,
      last_agent_message: '',
    };
  }

  return {
    ok: true,
    thread_id: parsed.thread_id || trimText(threadId),
    last_agent_message: parsed.last_agent_message,
  };
}

function createWaitingReply(question, queueLength) {
  const lines = [
    '코덱스가 추가 확인을 요청했습니다.',
    question || '추가 정보가 필요합니다.',
    '- 답변을 그대로 보내면 이어서 진행합니다.',
    '- 상태: /status, 취소: /cancel',
  ];
  if (queueLength > 0) lines.push(`- 대기 작업: ${queueLength}개`);
  return lines.join('\n');
}

function createCompletionReply(summary, queueLength) {
  const lines = [
    '코덱스 작업 완료',
    summary || '완료 보고 메시지를 받지 못했습니다.',
  ];
  if (queueLength > 0) lines.push(`- 대기 작업: ${queueLength}개`);
  return lines.join('\n');
}

function createFailureReply(errorText, queueLength) {
  const lines = [
    '코덱스 작업 실패',
    errorText || '실행 중 오류가 발생했습니다.',
    '- 상태: /status, 취소: /cancel',
  ];
  if (queueLength > 0) lines.push(`- 대기 작업: ${queueLength}개`);
  return lines.join('\n');
}

function pushHistory(session, row) {
  const next = Array.isArray(session.history) ? [...session.history] : [];
  next.unshift(row);
  session.history = next.slice(0, 20);
}

function recoverStaleRunningIfNeeded(session) {
  if (!session || !session.active || session.active.status !== 'running') {
    return { recovered: false, reason: 'no_running_active' };
  }

  const active = session.active;
  const baseMs = parseIsoMs(active.updated_at) || parseIsoMs(active.created_at);
  if (!Number.isFinite(baseMs)) {
    return { recovered: false, reason: 'invalid_timestamp' };
  }

  const ageMs = Date.now() - baseMs;
  const activeThreadId = trimText(active.thread_id || '');
  const fastNoThread = !activeThreadId && ageMs >= resolveStaleRunningNoThreadMs();
  const baseThresholdPassed = ageMs >= resolveStaleRunningMs();
  if (!fastNoThread && !baseThresholdPassed) {
    return { recovered: false, reason: 'age_within_threshold', ageMs };
  }

  if (isLiveCodexProcessPresent()) {
    return { recovered: false, reason: 'live_codex_process_detected', ageMs };
  }

  const recoveredAt = nowIso();
  const summary = `stale running task auto-recovered after ${Math.round(ageMs / 1000)}s`;
  active.status = 'failed';
  active.last_message = summary;
  active.updated_at = recoveredAt;
  pushHistory(session, {
    request_id: active.request_id,
    thread_id: active.thread_id,
    status: 'failed',
    summary,
    created_at: active.created_at,
    finished_at: recoveredAt,
  });
  session.active = null;
  return { recovered: true, reason: 'stale_cleared', ageMs };
}

function saveSession(sessionKey, session, customStatePath = '') {
  const state = codexState.readState(customStatePath);
  const merged = codexState.setSession(state, sessionKey, session);
  codexState.writeState(merged, customStatePath);
}

function loadSession(sessionKey, customStatePath = '') {
  const state = codexState.readState(customStatePath);
  const session = codexState.getSession(state, sessionKey);
  return {
    state,
    session,
  };
}

function resolveSessionContext(input = {}) {
  const requestedBy = trimText(input.requestedBy || input.requested_by || '');
  const telegramContext = input.telegramContext && typeof input.telegramContext === 'object'
    ? input.telegramContext
    : (input.telegram_context && typeof input.telegram_context === 'object'
      ? input.telegram_context
      : null);
  const botId = trimText(process.env.MOLTBOT_BOT_ID || '');
  const sessionKey = codexState.buildSessionKey({
    telegramContext,
    requestedBy,
    botId,
  });
  return {
    requested_by: requestedBy,
    telegram_context: telegramContext,
    session_key: sessionKey,
  };
}

function applyTurnResult(session, active, turnResult) {
  const marker = parseStatusMarker(turnResult.last_agent_message || '');
  const inferred = marker.status || inferStatusFromText(turnResult.last_agent_message || '');
  const cleanedMessage = marker.cleaned || trimText(turnResult.last_agent_message || '');
  const status = inferred === 'waiting_input'
    ? 'waiting_input'
    : (inferred === 'failed' ? 'failed' : 'completed');

  active.thread_id = trimText(turnResult.thread_id || active.thread_id || '');
  active.last_message = compactText(cleanedMessage, 4000);
  active.updated_at = nowIso();

  if (status === 'waiting_input') {
    active.status = 'waiting_input';
    active.last_question = compactText(cleanedMessage, 1200);
    return {
      ok: true,
      status,
      active,
      summary: active.last_question,
    };
  }

  if (status === 'failed') {
    active.status = 'failed';
    return {
      ok: false,
      status,
      active,
      summary: cleanedMessage,
    };
  }

  active.status = 'completed';
  return {
    ok: true,
    status,
    active,
    summary: cleanedMessage,
  };
}

function buildStatusReply(session, sessionKey) {
  const active = session.active;
  const queueLength = Array.isArray(session.queue) ? session.queue.length : 0;
  if (!active) {
    const last = Array.isArray(session.history) && session.history.length > 0 ? session.history[0] : null;
    const lines = ['코덱스 상태: idle', `- 대기 작업: ${queueLength}개`];
    if (last) {
      lines.push(`- 최근 상태: ${String(last.status || 'unknown')}`);
      lines.push(`- 최근 완료: ${String(last.finished_at || last.created_at || '')}`);
    }
    return lines.join('\n');
  }
  const lines = [
    `코덱스 상태: ${active.status || 'running'}`,
    `- request: ${active.request_id || '-'}`,
    `- thread: ${active.thread_id || '-'}`,
    `- 대기 작업: ${queueLength}개`,
    `- 세션: ${sessionKey}`,
  ];
  if (active.status === 'waiting_input' && active.last_question) {
    lines.push(`- 최근 질문: ${compactText(active.last_question, 200)}`);
  }
  return lines.join('\n');
}

function handleStart(input = {}) {
  const payload = input.plan && input.plan.payload && typeof input.plan.payload === 'object'
    ? input.plan.payload
    : (input.payload && typeof input.payload === 'object' ? input.payload : {});
  const context = resolveSessionContext(input);
  const loaded = loadSession(context.session_key);
  const session = loaded.session;
  const staleRecovery = recoverStaleRunningIfNeeded(session);
  if (staleRecovery.recovered) {
    saveSession(context.session_key, session);
  }
  syncSessionThreadTitles(session);
  const active = session.active;
  let prompt = extractPromptFromPayload(payload);
  const useQueue = Boolean(payload.use_queue);
  let queuedSource = null;

  if (active && (active.status === 'running' || active.status === 'waiting_input')) {
    if (useQueue) {
      return {
        ok: false,
        error_code: 'CODEX_TASK_BUSY',
        error: 'active codex task is still running',
        status: active.status,
        telegramReply: '현재 코덱스 작업이 진행 중입니다. 먼저 질문에 답하거나 /cancel 후 다시 시도해 주세요.',
      };
    }
    if (!prompt) {
      return {
        ok: false,
        error_code: 'CODEX_PROMPT_REQUIRED',
        error: 'codex start requires prompt',
        telegramReply: '코덱스 작업 요청 내용이 필요합니다. 예: 코덱스: 현재 프로젝트 테스트 실패 원인 분석해줘',
      };
    }
    const queued = {
      request_id: makeId('cdxq'),
      prompt,
      requested_by: context.requested_by || 'unknown',
      created_at: nowIso(),
    };
    session.queue = Array.isArray(session.queue) ? [...session.queue, queued] : [queued];
    saveSession(context.session_key, session);
    return {
      ok: true,
      queued: true,
      request_id: queued.request_id,
      status: 'queued',
      queue_length: session.queue.length,
      thread_id: trimText(active.thread_id || ''),
      telegramReply: [
        '현재 코덱스 작업이 진행 중이라 대기열에 추가했습니다.',
        `- queue id: ${queued.request_id}`,
        `- 대기 작업: ${session.queue.length}개`,
        '- 현재 작업 상태 확인: /status',
      ].join('\n'),
    };
  }

  if (!prompt && useQueue) {
    const queue = Array.isArray(session.queue) ? [...session.queue] : [];
    if (queue.length > 0) {
      const first = queue.shift();
      prompt = trimText(first && first.prompt || '');
      queuedSource = first && typeof first === 'object' ? first : null;
      session.queue = queue;
    }
  }

  if (!prompt) {
    if (useQueue) {
      return {
        ok: false,
        error_code: 'CODEX_QUEUE_EMPTY',
        error: 'codex queue is empty',
        telegramReply: '실행할 대기 작업이 없습니다. 새 작업 요청을 보내주세요.',
      };
    }
    return {
      ok: false,
      error_code: 'CODEX_PROMPT_REQUIRED',
      error: 'codex start requires prompt',
      telegramReply: '코덱스 작업 요청 내용이 필요합니다. 예: 코덱스: 현재 프로젝트 테스트 실패 원인 분석해줘',
    };
  }

  const nextActive = {
    request_id: trimText(queuedSource && queuedSource.request_id) || makeId('cdxr'),
    thread_id: '',
    prompt: compactText(prompt, 2000),
    status: 'running',
    requested_by: trimText(queuedSource && queuedSource.requested_by) || context.requested_by || 'unknown',
    last_message: '',
    last_question: '',
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  session.active = nextActive;
  saveSession(context.session_key, session);

  const preferredThreadId = resolvePreferredStartThreadId(payload, session);
  const turnPrompt = buildControlPrompt('start', prompt);
  let turn = runCodexTurn({
    mode: preferredThreadId ? 'answer' : 'start',
    prompt: turnPrompt,
    threadId: preferredThreadId,
    payload,
  });
  if (!turn.ok && preferredThreadId) {
    turn = runCodexTurn({
      mode: 'start',
      prompt: turnPrompt,
      payload,
    });
  }

  if (!turn.ok) {
    nextActive.status = 'failed';
    nextActive.thread_id = trimText(turn.thread_id || '');
    syncThreadTitle(nextActive.thread_id, prompt);
    nextActive.last_message = compactText(turn.error || '', 1000);
    nextActive.updated_at = nowIso();
    pushHistory(session, {
      request_id: nextActive.request_id,
      thread_id: nextActive.thread_id,
      status: 'failed',
      summary: nextActive.last_message,
      created_at: nextActive.created_at,
      finished_at: nowIso(),
    });
    session.active = null;
    syncSessionThreadTitles(session);
    saveSession(context.session_key, session);
    openDesktopThreadViaDeepLink(nextActive.thread_id, 'start_exec_failed');
    return {
      ok: false,
      status: 'failed',
      request_id: nextActive.request_id,
      thread_id: nextActive.thread_id,
      error_code: turn.error_code || 'CODEX_EXEC_FAILED',
      error: turn.error || 'codex execution failed',
      telegramReply: createFailureReply(turn.error || '코덱스 실행 중 오류가 발생했습니다.', session.queue.length),
    };
  }

  const applied = applyTurnResult(session, nextActive, turn);
  syncThreadTitle(nextActive.thread_id, prompt);
  if (applied.status === 'waiting_input') {
    session.active = applied.active;
    saveSession(context.session_key, session);
    openDesktopThreadViaDeepLink(nextActive.thread_id, 'start_waiting_input');
    return {
      ok: true,
      status: 'waiting_input',
      request_id: nextActive.request_id,
      thread_id: nextActive.thread_id,
      waiting_input: true,
      telegramReply: createWaitingReply(applied.summary, session.queue.length),
    };
  }

  pushHistory(session, {
    request_id: nextActive.request_id,
    thread_id: nextActive.thread_id,
    status: applied.ok ? 'completed' : 'failed',
    summary: compactText(applied.summary || '', 1500),
    created_at: nextActive.created_at,
    finished_at: nowIso(),
  });
  session.active = null;
  syncSessionThreadTitles(session);
  saveSession(context.session_key, session);
  if (!applied.ok) {
    return {
      ok: false,
      status: 'failed',
      request_id: nextActive.request_id,
      thread_id: nextActive.thread_id,
      error_code: 'CODEX_STATUS_FAILED',
      error: applied.summary || '코덱스 작업 실패',
      telegramReply: createFailureReply(applied.summary, session.queue.length),
    };
  }
  openDesktopThreadViaDeepLink(nextActive.thread_id, 'start_completed');
  return {
    ok: true,
    status: 'completed',
    request_id: nextActive.request_id,
    thread_id: nextActive.thread_id,
    telegramReply: createCompletionReply(applied.summary, session.queue.length),
  };
}

function handleAnswer(input = {}) {
  const payload = input.plan && input.plan.payload && typeof input.plan.payload === 'object'
    ? input.plan.payload
    : (input.payload && typeof input.payload === 'object' ? input.payload : {});
  const answer = extractAnswerFromPayload(payload);
  if (!answer) {
    return {
      ok: false,
      error_code: 'CODEX_ANSWER_REQUIRED',
      error: 'codex answer requires message text',
      telegramReply: '코덱스에 전달할 답변이 필요합니다. 질문에 대한 답을 그대로 보내주세요.',
    };
  }
  const context = resolveSessionContext(input);
  const loaded = loadSession(context.session_key);
  const session = loaded.session;
  const staleRecovery = recoverStaleRunningIfNeeded(session);
  if (staleRecovery.recovered) {
    saveSession(context.session_key, session);
  }
  syncSessionThreadTitles(session);
  const active = session.active;

  if (!active) {
    return {
      ok: false,
      error_code: 'CODEX_NO_ACTIVE_TASK',
      error: 'no active codex task',
      telegramReply: '현재 진행 중인 코덱스 작업이 없습니다. 새 요청을 보내주세요.',
    };
  }
  if (active.status !== 'waiting_input') {
    return {
      ok: false,
      error_code: 'CODEX_NOT_WAITING_INPUT',
      error: `current task status=${active.status}`,
      telegramReply: `현재 작업 상태는 ${active.status} 입니다. /status 로 확인해 주세요.`,
    };
  }
  if (!active.thread_id) {
    return {
      ok: false,
      error_code: 'CODEX_THREAD_MISSING',
      error: 'active task thread id missing',
      telegramReply: '현재 작업의 스레드 정보가 없어 재개할 수 없습니다. /cancel 후 다시 시작해 주세요.',
    };
  }

  active.status = 'running';
  active.updated_at = nowIso();
  saveSession(context.session_key, session);

  const turnPrompt = buildControlPrompt('answer', answer);
  const turn = runCodexTurn({
    mode: 'answer',
    prompt: turnPrompt,
    threadId: active.thread_id,
    payload,
  });

  if (!turn.ok) {
    active.status = 'failed';
    syncThreadTitle(active.thread_id, active.prompt || answer);
    active.last_message = compactText(turn.error || '', 1200);
    active.updated_at = nowIso();
    pushHistory(session, {
      request_id: active.request_id,
      thread_id: active.thread_id,
      status: 'failed',
      summary: active.last_message,
      created_at: active.created_at,
      finished_at: nowIso(),
    });
    session.active = null;
    syncSessionThreadTitles(session);
    saveSession(context.session_key, session);
    openDesktopThreadViaDeepLink(active.thread_id, 'answer_exec_failed');
    return {
      ok: false,
      status: 'failed',
      request_id: active.request_id,
      thread_id: active.thread_id,
      error_code: turn.error_code || 'CODEX_EXEC_FAILED',
      error: turn.error || 'codex resume failed',
      telegramReply: createFailureReply(turn.error || '코덱스 재개 중 오류가 발생했습니다.', session.queue.length),
    };
  }

  const applied = applyTurnResult(session, active, turn);
  syncThreadTitle(active.thread_id, active.prompt || answer);
  if (applied.status === 'waiting_input') {
    session.active = applied.active;
    saveSession(context.session_key, session);
    openDesktopThreadViaDeepLink(active.thread_id, 'answer_waiting_input');
    return {
      ok: true,
      status: 'waiting_input',
      request_id: active.request_id,
      thread_id: active.thread_id,
      waiting_input: true,
      telegramReply: createWaitingReply(applied.summary, session.queue.length),
    };
  }

  pushHistory(session, {
    request_id: active.request_id,
    thread_id: active.thread_id,
    status: applied.ok ? 'completed' : 'failed',
    summary: compactText(applied.summary || '', 1500),
    created_at: active.created_at,
    finished_at: nowIso(),
  });
  session.active = null;
  syncSessionThreadTitles(session);
  saveSession(context.session_key, session);
  if (!applied.ok) {
    return {
      ok: false,
      status: 'failed',
      request_id: active.request_id,
      thread_id: active.thread_id,
      error_code: 'CODEX_STATUS_FAILED',
      error: applied.summary || '코덱스 작업 실패',
      telegramReply: createFailureReply(applied.summary, session.queue.length),
    };
  }
  openDesktopThreadViaDeepLink(active.thread_id, 'answer_completed');
  return {
    ok: true,
    status: 'completed',
    request_id: active.request_id,
    thread_id: active.thread_id,
    telegramReply: createCompletionReply(applied.summary, session.queue.length),
  };
}

function handleStatus(input = {}) {
  const context = resolveSessionContext(input);
  const loaded = loadSession(context.session_key);
  const session = loaded.session;
  const staleRecovery = recoverStaleRunningIfNeeded(session);
  if (staleRecovery.recovered) {
    saveSession(context.session_key, session);
  }
  syncSessionThreadTitles(session);
  return {
    ok: true,
    status: session.active ? String(session.active.status || 'running') : 'idle',
    queue_length: Array.isArray(session.queue) ? session.queue.length : 0,
    active: session.active || null,
    telegramReply: buildStatusReply(session, context.session_key),
  };
}

function handleCancel(input = {}) {
  const context = resolveSessionContext(input);
  const loaded = loadSession(context.session_key);
  const session = loaded.session;
  const staleRecovery = recoverStaleRunningIfNeeded(session);
  if (staleRecovery.recovered) {
    saveSession(context.session_key, session);
  }
  syncSessionThreadTitles(session);
  const active = session.active;
  if (!active) {
    return {
      ok: true,
      status: 'idle',
      cancelled: false,
      telegramReply: '취소할 코덱스 작업이 없습니다.',
    };
  }
  active.status = 'canceled';
  active.updated_at = nowIso();
  pushHistory(session, {
    request_id: active.request_id,
    thread_id: active.thread_id,
    status: 'canceled',
    summary: compactText(active.last_message || active.prompt || 'canceled', 1500),
    created_at: active.created_at,
    finished_at: nowIso(),
  });
  session.active = null;
  syncSessionThreadTitles(session);
  saveSession(context.session_key, session);
  return {
    ok: true,
    status: 'canceled',
    cancelled: true,
    queue_length: Array.isArray(session.queue) ? session.queue.length : 0,
    telegramReply: '현재 코덱스 작업을 취소했습니다.',
  };
}

function plan(input = {}) {
  const action = trimText(input.action || '').toLowerCase();
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  if (!['start', 'answer', 'status', 'cancel'].includes(action)) {
    return {
      ok: false,
      error_code: 'UNSUPPORTED_ACTION',
      error: `Unsupported codex action: ${action || '(empty)'}`,
      plan: null,
    };
  }

  if (action === 'start' && !extractPromptFromPayload(payload)) {
    return {
      ok: false,
      error_code: 'CODEX_PROMPT_REQUIRED',
      error: 'codex start requires prompt',
      plan: null,
    };
  }
  if (action === 'answer' && !extractAnswerFromPayload(payload)) {
    return {
      ok: false,
      error_code: 'CODEX_ANSWER_REQUIRED',
      error: 'codex answer requires message',
      plan: null,
    };
  }

  const summary = action === 'start'
    ? `codex start: ${compactText(extractPromptFromPayload(payload), 120)}`
    : `codex ${action}`;
  return {
    ok: true,
    plan: {
      command_kind: 'capability',
      capability: 'codex',
      action,
      intent_action: `capability:codex:${action}`,
      payload,
      risk_tier: 'MEDIUM',
      mutating: false,
      requires_approval: false,
      required_flags: [],
      blockers: [],
      warnings: [],
      operations: [{ kind: `codex:${action}` }],
      rollback_instructions: [],
      plan_summary: summary,
    },
  };
}

function execute(input = {}) {
  const action = trimText(input.action || (input.plan && input.plan.action) || '').toLowerCase();
  if (!action) {
    return {
      ok: false,
      error_code: 'ACTION_REQUIRED',
      error: 'codex action is required',
    };
  }
  if (action === 'start') return { capability: 'codex', action, ...handleStart(input) };
  if (action === 'answer') return { capability: 'codex', action, ...handleAnswer(input) };
  if (action === 'status') return { capability: 'codex', action, ...handleStatus(input) };
  if (action === 'cancel') return { capability: 'codex', action, ...handleCancel(input) };
  return {
    ok: false,
    capability: 'codex',
    action,
    error_code: 'UNSUPPORTED_ACTION',
    error: `Unsupported codex action: ${action}`,
    telegramReply: `지원하지 않는 코덱스 작업입니다: ${action}`,
  };
}

function getSessionSnapshot(input = {}) {
  const context = resolveSessionContext(input);
  const loaded = loadSession(context.session_key);
  return {
    session_key: context.session_key,
    session: loaded.session,
  };
}

module.exports = {
  capability: 'codex',
  supportedActions: ['start', 'answer', 'status', 'cancel'],
  plan,
  execute,
  getSessionSnapshot,
};
