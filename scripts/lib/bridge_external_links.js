const fs = require('fs');
const path = require('path');

function normalizeHttpsBase(value) {
  const out = String(value || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+$/i.test(out) ? out : null;
}

function getPublicBases(deps = {}) {
  const env = deps.env && typeof deps.env === 'object' ? deps.env : process.env;
  const pathModule = deps.pathModule || path;
  const fsModule = deps.fsModule || fs;
  const execDocker = typeof deps.execDocker === 'function' ? deps.execDocker : () => ({ ok: false, stdout: '', stderr: '' });
  const bridgeDir = String(deps.bridgeDir || pathModule.resolve(__dirname, '..')).trim();

  const promptEnv = normalizeHttpsBase(env.PROMPT_PUBLIC_BASE_URL || '');
  const genericEnv = normalizeHttpsBase(env.DEV_TUNNEL_PUBLIC_BASE_URL || '');
  if (promptEnv || genericEnv) {
    return {
      promptBase: promptEnv || genericEnv || null,
      genericBase: genericEnv || null,
    };
  }

  try {
    const statePath = pathModule.join(bridgeDir, '..', 'data', 'runtime', 'tunnel_state.json');
    const raw = fsModule.readFileSync(statePath, 'utf8');
    const json = JSON.parse(raw);
    const candidate = normalizeHttpsBase(json && json.publicUrl ? json.publicUrl : '');
    if (candidate) {
      return {
        promptBase: candidate,
        genericBase: candidate,
      };
    }
  } catch (_) {
    // no-op: fall through to docker logs probing
  }

  const logs = execDocker(['logs', '--tail', '200', 'moltbot-dev-tunnel']);
  if (!logs || !logs.ok) return { promptBase: null, genericBase: null };
  const matched = String(`${logs.stdout || ''}\n${logs.stderr || ''}`)
    .match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
  if (!matched || !matched.length) return { promptBase: null, genericBase: null };
  const base = matched[matched.length - 1];
  return {
    promptBase: base,
    genericBase: base,
  };
}

function getTunnelPublicBaseUrl(deps = {}) {
  const getPublicBasesFn = typeof deps.getPublicBases === 'function'
    ? deps.getPublicBases
    : () => getPublicBases(deps);
  const bases = getPublicBasesFn();
  return bases.promptBase || bases.genericBase || null;
}

function buildExternalLinksText(deps = {}) {
  const getPublicBasesFn = typeof deps.getPublicBases === 'function'
    ? deps.getPublicBases
    : () => getPublicBases(deps);
  const { promptBase } = getPublicBasesFn();
  if (!promptBase) return null;
  const lines = ['외부 확인 링크'];
  lines.push(`- 프롬프트: ${promptBase}/prompt/`);
  return lines.join('\n');
}

function rewriteLocalLinks(text, bases) {
  const raw = String(text || '');
  const promptBase = String((bases && bases.promptBase) || '').trim().replace(/\/+$/, '');
  if (!promptBase) return raw;

  return raw
    .replace(/https?:\/\/127\.0\.0\.1:18788\/prompt\/?/gi, `${promptBase}/prompt/`)
    .replace(/https?:\/\/localhost:18788\/prompt\/?/gi, `${promptBase}/prompt/`)
    .replace(/https?:\/\/127\.0\.0\.1:18787\/prompt\/?/gi, `${promptBase}/prompt/`)
    .replace(/https?:\/\/localhost:18787\/prompt\/?/gi, `${promptBase}/prompt/`);
}

function appendExternalLinks(reply, deps = {}) {
  const getPublicBasesFn = typeof deps.getPublicBases === 'function'
    ? deps.getPublicBases
    : () => getPublicBases(deps);
  const rewriteLocalLinksFn = typeof deps.rewriteLocalLinks === 'function'
    ? deps.rewriteLocalLinks
    : rewriteLocalLinks;
  const buildExternalLinksTextFn = typeof deps.buildExternalLinksText === 'function'
    ? deps.buildExternalLinksText
    : () => buildExternalLinksText(deps);

  const bases = getPublicBasesFn();
  const rewritten = rewriteLocalLinksFn(reply, bases);
  const links = buildExternalLinksTextFn();
  if (!links) return rewritten;
  if (/(^|\n)외부 확인 링크(\n|$)/.test(String(rewritten || ''))) {
    return String(rewritten || '').trim();
  }
  return `${String(rewritten || '').trim()}\n\n${links}`.trim();
}

module.exports = {
  normalizeHttpsBase,
  getTunnelPublicBaseUrl,
  getPublicBases,
  buildExternalLinksText,
  rewriteLocalLinks,
  appendExternalLinks,
};
