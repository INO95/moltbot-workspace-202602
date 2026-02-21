const fs = require('fs');
const path = require('path');

function resolveWorkspaceRootHint(deps = {}) {
  const env = deps.env && typeof deps.env === 'object'
    ? deps.env
    : process.env;
  const fsModule = deps.fsModule || fs;
  const pathModule = deps.pathModule || path;
  const fallbackWorkspaceRoot = String(
    deps.fallbackWorkspaceRoot || pathModule.resolve(__dirname, '..', '..'),
  ).trim();
  const writableFlag = fsModule.constants && typeof fsModule.constants.W_OK === 'number'
    ? fsModule.constants.W_OK
    : fs.constants.W_OK;

  const candidates = [
    String(env.OPENCLAW_RUNTIME_WORKSPACE_ROOT || '').trim(),
    String(env.OPENCLAW_WORKSPACE || '').trim(),
    '/Users/moltbot/Projects/Moltbot_Workspace',
    fallbackWorkspaceRoot,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = pathModule.resolve(candidate);
    try {
      fsModule.accessSync(resolved, writableFlag);
      return resolved;
    } catch (_) {
      // continue
    }
  }
  return pathModule.resolve(fallbackWorkspaceRoot);
}

function normalizeIncomingCommandText(text, deps = {}) {
  let out = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!out) return '';

  // OpenClaw telegram wrapper metadata: "... [message_id: 123]".
  out = out.replace(/\s*\[message_id:\s*\d+\]\s*$/i, '').trim();

  // Preserve the user's message and drop quoted reply block.
  out = out.replace(/\s*\[Replying to [^\]]+\][\s\S]*$/i, '').trim();

  // Remove leading transport envelope, e.g. "[Telegram ...] 작업: ...".
  const envelope = out.match(/^\s*\[(Telegram|WhatsApp|Discord|Slack|Signal|Line|Matrix|KakaoTalk|Kakao|iMessage|SMS)\b[^\]]*\]\s*([\s\S]*)$/i);
  if (envelope) {
    out = String(envelope[2] || '').trim();
  }

  const resolveWorkspaceRootHintFn = typeof deps.resolveWorkspaceRootHint === 'function'
    ? deps.resolveWorkspaceRootHint
    : () => resolveWorkspaceRootHint(deps);
  const workspaceRoot = resolveWorkspaceRootHintFn();
  out = out
    .replace(/\~\/\.openclaw\/workspace/gi, workspaceRoot)
    .replace(/\/home\/node\/\.openclaw\/workspace/gi, workspaceRoot);

  // Some Telegram relays prepend "$" before command prefixes (e.g. "$운영: ...").
  out = out.replace(/^\s*\$(?=\S)/, '').trim();

  return out;
}

module.exports = {
  resolveWorkspaceRootHint,
  normalizeIncomingCommandText,
};
