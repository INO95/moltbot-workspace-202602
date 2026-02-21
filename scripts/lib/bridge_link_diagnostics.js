const path = require('path');
const { spawnSync } = require('child_process');

function isExternalLinkRequest(text) {
  const t = String(text || '').toLowerCase();
  const hasLink = /(링크|url|주소|접속)/i.test(t);
  const hasTarget = /(프롬프트|prompt|웹앱|webapp|web)/i.test(t);
  return hasLink && hasTarget;
}

function probeUrlStatus(url, deps = {}) {
  const target = String(url || '').trim();
  if (!target) return { ok: false, code: 'N/A', reason: 'empty' };
  const spawn = typeof deps.spawnSync === 'function'
    ? deps.spawnSync
    : spawnSync;
  const r = spawn(
    'curl',
    ['-sS', '-L', '--max-time', '6', '-o', '/dev/null', '-w', '%{http_code}', target],
    { encoding: 'utf8' },
  );
  if (r.error) return { ok: false, code: 'N/A', reason: 'curl-missing' };
  const code = String(r.stdout || '').trim() || '000';
  if (r.status !== 0 || code === '000') {
    return { ok: false, code, reason: (r.stderr || '').trim() || `exit:${r.status}` };
  }
  return { ok: true, code, reason: '' };
}

function buildLinkDiagnosticsText(deps = {}) {
  const pathModule = deps.pathModule || path;
  const spawn = typeof deps.spawnSync === 'function'
    ? deps.spawnSync
    : spawnSync;
  const getPublicBases = typeof deps.getPublicBases === 'function'
    ? deps.getPublicBases
    : () => ({ promptBase: '' });
  const probeUrlStatusFn = typeof deps.probeUrlStatus === 'function'
    ? deps.probeUrlStatus
    : (url) => probeUrlStatus(url, { spawnSync: spawn });
  const bridgeDir = String(deps.bridgeDir || pathModule.resolve(__dirname, '..')).trim();

  const scriptPath = pathModule.join(bridgeDir, 'tunnel_dns_check.js');
  const scriptRun = spawn('node', [scriptPath, '--json'], { encoding: 'utf8' });
  if (!scriptRun.error && scriptRun.status === 0) {
    try {
      const parsed = JSON.parse(String(scriptRun.stdout || '{}'));
      if (parsed && Array.isArray(parsed.targets) && parsed.targets.length > 0) {
        const lines = ['외부 링크 점검'];
        for (const row of parsed.targets) {
          const dnsPart = row && row.dns && row.dns.ok
            ? `DNS OK(${row.dns.address || '-'})`
            : `DNS FAIL(${(row && row.dns && row.dns.error) || 'unknown'})`;
          const httpsPart = row && row.https && row.https.ok
            ? `HTTPS ${row.https.statusCode || 0}`
            : `HTTPS FAIL(${(row && row.https && row.https.error) || 'unknown'})`;
          lines.push(`- ${row.label || row.key || 'link'}: ${dnsPart}, ${httpsPart}`);
        }
        return lines.join('\n');
      }
    } catch (_) {
      // fall through to curl-based fallback.
    }
  }

  const { promptBase } = getPublicBases();
  const checks = [];
  if (promptBase) checks.push({ label: '프롬프트', url: `${promptBase}/prompt/` });
  if (!checks.length) return '';
  const lines = ['외부 링크 점검'];
  for (const c of checks) {
    const p = probeUrlStatusFn(c.url);
    const msg = p.ok ? `${p.code} OK` : `${p.code} FAIL${p.reason ? ` (${p.reason})` : ''}`;
    lines.push(`- ${c.label}: ${msg}`);
  }
  return lines.join('\n');
}

function buildLinkOnlyReply(text, deps = {}) {
  const getPublicBases = typeof deps.getPublicBases === 'function'
    ? deps.getPublicBases
    : () => ({ promptBase: '' });
  const buildLinkDiagnosticsTextFn = typeof deps.buildLinkDiagnosticsText === 'function'
    ? deps.buildLinkDiagnosticsText
    : () => '';
  const t = String(text || '').toLowerCase();
  const { promptBase } = getPublicBases();

  if (!promptBase) {
    return '외부 링크를 찾을 수 없습니다. 터널 상태를 먼저 점검해주세요.';
  }
  if (/(프롬프트|prompt)/i.test(t)) {
    const baseReply = promptBase
      ? `외부 확인 링크\n- 프롬프트: ${promptBase}/prompt/`
      : '프롬프트 외부 링크를 찾을 수 없습니다.';
    const diag = /(점검|체크|status|확인)/i.test(t) ? buildLinkDiagnosticsTextFn() : '';
    return diag ? `${baseReply}\n\n${diag}` : baseReply;
  }

  const lines = ['외부 확인 링크'];
  if (promptBase) lines.push(`- 프롬프트: ${promptBase}/prompt/`);
  const out = lines.join('\n');
  const diag = /(점검|체크|status|확인)/i.test(t) ? buildLinkDiagnosticsTextFn() : '';
  return diag ? `${out}\n\n${diag}` : out;
}

function buildQuickStatusReply(payload, deps = {}) {
  const runOpsCommand = deps.runOpsCommand;
  const appendExternalLinks = deps.appendExternalLinks;
  const buildLinkDiagnosticsTextFn = typeof deps.buildLinkDiagnosticsText === 'function'
    ? deps.buildLinkDiagnosticsText
    : () => '';
  if (typeof runOpsCommand !== 'function') {
    throw new Error('runOpsCommand dependency is required');
  }
  if (typeof appendExternalLinks !== 'function') {
    throw new Error('appendExternalLinks dependency is required');
  }
  const raw = String(payload || '').trim();
  const target = raw ? raw : 'all';
  const out = runOpsCommand(`액션: 상태; 대상: ${target}`);
  const base = out && out.telegramReply ? out.telegramReply : '상태 조회 실패';
  const diag = buildLinkDiagnosticsTextFn();
  const merged = diag ? `${base}\n\n${diag}` : base;
  return appendExternalLinks(merged);
}

module.exports = {
  isExternalLinkRequest,
  probeUrlStatus,
  buildLinkDiagnosticsText,
  buildLinkOnlyReply,
  buildQuickStatusReply,
};
