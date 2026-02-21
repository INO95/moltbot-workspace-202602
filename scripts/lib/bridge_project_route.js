const { spawnSync } = require('child_process');

function clampPreview(value, maxLen = 600) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...(truncated)`;
}

function executeProjectBootstrapScript(bootstrap, deps = {}) {
  if (!bootstrap || typeof bootstrap !== 'object') {
    return { ok: false, error: 'bootstrap payload missing' };
  }
  const script = String(bootstrap.script || '').trim();
  if (!script) {
    return { ok: false, error: 'bootstrap script is empty' };
  }
  const redact = typeof deps.redact === 'function'
    ? deps.redact
    : (text) => String(text || '');
  const spawn = typeof deps.spawnSync === 'function'
    ? deps.spawnSync
    : spawnSync;
  const timeoutMs = Number.isFinite(deps.timeoutMs)
    ? Number(deps.timeoutMs)
    : Number(process.env.PROJECT_BOOTSTRAP_TIMEOUT_MS || 180000);
  const run = spawn('sh', ['-lc', script], {
    encoding: 'utf8',
    timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180000,
    maxBuffer: 1024 * 1024 * 2,
  });
  const stdout = redact(String(run.stdout || ''));
  const stderr = redact(String(run.stderr || ''));
  const ok = !run.error && run.status === 0;
  return {
    ok,
    exitCode: Number.isFinite(run.status) ? run.status : null,
    stdout: clampPreview(stdout),
    stderr: clampPreview(stderr),
    error: run.error ? String(run.error.message || run.error) : '',
  };
}

function readDirectoryListPreview(targetPath, maxLen = 1600, deps = {}) {
  const dir = String(targetPath || '').trim();
  if (!dir) return '';
  const redact = typeof deps.redact === 'function'
    ? deps.redact
    : (text) => String(text || '');
  const spawn = typeof deps.spawnSync === 'function'
    ? deps.spawnSync
    : spawnSync;
  const escaped = dir.replace(/(["\\$`])/g, '\\$1');
  const run = spawn('sh', ['-lc', `ls -la "${escaped}"`], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  const text = redact(String(run.stdout || run.stderr || ''));
  if (!text.trim()) return '';
  return clampPreview(text, maxLen);
}

function buildProjectRoutePayload(parsed, deps = {}) {
  const buildProjectBootstrapPlan = deps.buildProjectBootstrapPlan;
  const saveLastProjectBootstrap = deps.saveLastProjectBootstrap;
  const appendExternalLinks = deps.appendExternalLinks;
  const executeProjectBootstrapScriptFn = deps.executeProjectBootstrapScript || executeProjectBootstrapScript;
  const readDirectoryListPreviewFn = deps.readDirectoryListPreview || readDirectoryListPreview;

  if (typeof appendExternalLinks !== 'function') {
    throw new Error('appendExternalLinks dependency is required');
  }

  const bootstrap = parsed && parsed.ok && typeof buildProjectBootstrapPlan === 'function'
    ? buildProjectBootstrapPlan(parsed.fields || {})
    : null;
  let execution = null;
  const summaryLines = [];

  if (bootstrap) {
    if (typeof saveLastProjectBootstrap === 'function') {
      saveLastProjectBootstrap(parsed.fields || {}, bootstrap);
    }
    summaryLines.push(`프로젝트 템플릿 확인 완료 (${bootstrap.templateLabel})`);
    summaryLines.push(`- 이름: ${bootstrap.projectName}`);
    summaryLines.push(`- 경로: ${bootstrap.targetPath}`);
    summaryLines.push(`- 패키지매니저: ${bootstrap.packageManager}`);
    summaryLines.push(`- 초기화 모드: ${bootstrap.initMode}`);
    summaryLines.push(`- 경로 정책: ${bootstrap.pathPolicy?.allowed ? `OK (${bootstrap.pathPolicy.matchedRoot})` : '승인 필요'}`);
    summaryLines.push(`- 품질 게이트: ${Array.isArray(bootstrap.qualityGates) ? bootstrap.qualityGates.join(' | ') : '-'}`);
    if (Array.isArray(bootstrap.warnings) && bootstrap.warnings.length > 0) {
      summaryLines.push(`- 주의: ${bootstrap.warnings.join(' / ')}`);
    }
    if (bootstrap.initMode === 'execute' && !bootstrap.requiresApproval) {
      execution = executeProjectBootstrapScriptFn(bootstrap);
      if (execution.ok) {
        summaryLines.push('- 초기화 실행: 완료');
        summaryLines.push(`- 실제 생성된 절대경로: ${bootstrap.targetPath}`);
        const lsPreview = readDirectoryListPreviewFn(bootstrap.targetPath);
        if (lsPreview) {
          summaryLines.push(`- 생성 파일 목록(ls -la):\n${lsPreview}`);
        }
        if (execution.stdout) summaryLines.push(`- 실행 로그(stdout):\n${execution.stdout}`);
        if (execution.stderr) summaryLines.push(`- 실행 로그(stderr):\n${execution.stderr}`);
      } else {
        summaryLines.push('- 초기화 실행: 실패');
        summaryLines.push('- 실제 생성된 절대경로: 없음');
        summaryLines.push('- 생성 파일 목록(ls -la): 없음');
        if (execution.error) summaryLines.push(`- 오류: ${execution.error}`);
        if (execution.stderr) summaryLines.push(`- stderr:\n${execution.stderr}`);
        if (execution.stdout) summaryLines.push(`- stdout:\n${execution.stdout}`);
      }
    } else if (bootstrap.requiresApproval) {
      const reasons = Array.isArray(bootstrap.approvalReasons) && bootstrap.approvalReasons.length > 0
        ? bootstrap.approvalReasons.join(',')
        : 'policy';
      summaryLines.push(`- 실행 요청 감지: 승인 후 초기화 실행 (${reasons})`);
    }
  }

  const telegramReply = appendExternalLinks(parsed && parsed.ok
    ? summaryLines.join('\n')
    : ((parsed && parsed.telegramReply) || '프로젝트 템플릿 오류'));
  const normalizedInstruction = parsed && parsed.ok && bootstrap
    ? `${parsed.normalizedInstruction}\n초기화 명령:\n${bootstrap.commands.map((line) => `- ${line}`).join('\n')}`
    : (parsed ? parsed.normalizedInstruction : '');

  return {
    route: 'project',
    templateValid: Boolean(parsed && parsed.ok),
    ...(parsed || {}),
    ...(bootstrap ? { bootstrap } : {}),
    ...(execution ? { execution } : {}),
    normalizedInstruction,
    telegramReply,
    ...(bootstrap && bootstrap.requiresApproval ? { needsApproval: true } : {}),
  };
}

module.exports = {
  clampPreview,
  executeProjectBootstrapScript,
  readDirectoryListPreview,
  buildProjectRoutePayload,
};
