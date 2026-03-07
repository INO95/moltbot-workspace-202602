const pathDefault = require('path');
const { spawnSync: spawnSyncDefault } = require('child_process');

function isInlineApprovalExecutionEnabled(envInput = process.env) {
  const env = envInput && typeof envInput === 'object' ? envInput : {};
  const raw = String(env.BRIDGE_INLINE_APPROVAL_EXECUTE || 'true').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

function triggerInlineOpsWorker(deps = {}) {
  const env = deps.env && typeof deps.env === 'object' ? deps.env : process.env;
  const isEnabled = typeof deps.isInlineApprovalExecutionEnabled === 'function'
    ? deps.isInlineApprovalExecutionEnabled
    : () => isInlineApprovalExecutionEnabled(env);
  if (!isEnabled()) {
    return { enabled: false, triggered: false, ok: false, error: '' };
  }

  const spawn = typeof deps.spawnSync === 'function' ? deps.spawnSync : spawnSyncDefault;
  const pathModule = deps.pathModule || pathDefault;
  const bridgeDir = String(deps.bridgeDir || __dirname).trim() || __dirname;
  const run = spawn('node', ['scripts/ops_host_worker.js'], {
    cwd: pathModule.resolve(bridgeDir, '..'),
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  const ok = !run.error && run.status === 0;
  return {
    enabled: true,
    triggered: true,
    ok,
    error: ok ? '' : String(
      run.error
        ? run.error.message || run.error
        : (run.stderr || run.stdout || 'ops_host_worker failed'),
    ).trim(),
  };
}

module.exports = {
  isInlineApprovalExecutionEnabled,
  triggerInlineOpsWorker,
};
