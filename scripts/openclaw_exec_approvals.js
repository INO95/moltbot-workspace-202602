#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE_MAP = {
  dev: {
    container: 'moltbot-dev',
    files: [
      {
        host: path.join(ROOT, 'configs', 'dev', 'exec-approvals.json'),
        container: '/home/node/.openclaw/workspace/configs/dev/exec-approvals.json',
      },
      {
        host: path.join(ROOT, 'configs', 'main', 'exec-approvals.json'),
        container: '/home/node/.openclaw/workspace/configs/main/exec-approvals.json',
      },
    ],
  },
  anki: {
    container: 'moltbot-anki',
    files: [
      {
        host: path.join(ROOT, 'configs', 'anki', 'exec-approvals.json'),
        container: '/home/node/.openclaw/workspace/configs/anki/exec-approvals.json',
      },
      {
        host: path.join(ROOT, 'configs', 'sub1', 'exec-approvals.json'),
        container: '/home/node/.openclaw/workspace/configs/sub1/exec-approvals.json',
      },
    ],
  },
  research: {
    container: 'moltbot-research',
    files: [
      {
        host: path.join(ROOT, 'configs', 'research', 'exec-approvals.json'),
        container: '/home/node/.openclaw/workspace/configs/research/exec-approvals.json',
      },
    ],
  },
  daily: {
    container: 'moltbot-daily',
    files: [
      {
        host: path.join(ROOT, 'configs', 'daily', 'exec-approvals.json'),
        container: '/home/node/.openclaw/workspace/configs/daily/exec-approvals.json',
      },
    ],
  },
};
const PROFILE_ALIASES = {
  main: 'dev',
  sub1: 'anki',
  trend: 'research',
};

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: ROOT,
    ...options,
  });
  return {
    ok: !res.error && res.status === 0,
    code: res.status == null ? 1 : res.status,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
    error: res.error ? String(res.error.message || res.error) : '',
  };
}

function mustRun(cmd, args, options = {}) {
  const result = run(cmd, args, options);
  if (result.ok) return result;
  throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.error || 'unknown error'}`);
}

function parseJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch (_) {
      // Keep scanning until we find a valid JSON line.
    }
  }
  return null;
}

function assertApprovalsPolicy(profile, parsed, filePath) {
  const defaults = parsed && parsed.defaults && typeof parsed.defaults === 'object'
    ? parsed.defaults
    : {};
  const mainAgent = parsed
    && parsed.agents
    && parsed.agents.main
    && typeof parsed.agents.main === 'object'
    ? parsed.agents.main
    : {};

  const requiredAsk = 'on-miss';
  const requiredSecurity = 'allowlist';
  const requiredFallback = 'deny';
  const currentAsk = String(mainAgent.ask || defaults.ask || '').trim().toLowerCase();
  const currentSecurity = String(mainAgent.security || defaults.security || '').trim().toLowerCase();
  const currentFallback = String(mainAgent.askFallback || defaults.askFallback || '').trim().toLowerCase();

  if (currentAsk !== requiredAsk) {
    throw new Error(`${filePath}: ${profile} approvals ask must be "${requiredAsk}"`);
  }
  if (currentSecurity !== requiredSecurity) {
    throw new Error(`${filePath}: ${profile} approvals security must be "${requiredSecurity}"`);
  }
  if (currentFallback !== requiredFallback) {
    throw new Error(`${filePath}: ${profile} approvals askFallback must be "${requiredFallback}"`);
  }

  const allowlist = Array.isArray(mainAgent.allowlist) ? mainAgent.allowlist : [];
  if (allowlist.length === 0) {
    throw new Error(`${filePath}: ${profile} approvals allowlist must not be empty`);
  }
}

function ensureTrackedFile(profile) {
  const target = PROFILE_MAP[profile];
  if (!target) throw new Error(`unsupported profile: ${profile}`);
  const selectedFile = (target.files || []).find((entry) => fs.existsSync(entry.host));
  if (!selectedFile) {
    const expected = (target.files || []).map((entry) => entry.host).join(', ');
    throw new Error(`missing approvals file: ${expected}`);
  }
  const parsed = JSON.parse(fs.readFileSync(selectedFile.host, 'utf8'));
  if (Number(parsed.version || 0) !== 1) {
    throw new Error(`${selectedFile.host}: version must be 1`);
  }
  assertApprovalsPolicy(profile, parsed, selectedFile.host);
  return {
    ...target,
    hostFile: selectedFile.host,
    containerFile: selectedFile.container,
  };
}

function inspectContainer(container) {
  const out = run('docker', ['inspect', '-f', '{{.State.Running}}', container]);
  return out.ok && out.stdout === 'true';
}

function applyProfile(profile) {
  const target = ensureTrackedFile(profile);
  if (!inspectContainer(target.container)) {
    throw new Error(`container is not running: ${target.container}`);
  }
  const out = mustRun('docker', [
    'exec',
    target.container,
    'node',
    'dist/index.js',
    'approvals',
    'set',
    '--gateway',
    '--file',
    target.containerFile,
    '--json',
  ]);
  return {
    profile,
    container: target.container,
    file: target.hostFile,
    result: parseJson(out.stdout) || { raw: out.stdout },
  };
}

function statusProfile(profile) {
  const target = ensureTrackedFile(profile);
  if (!inspectContainer(target.container)) {
    return {
      profile,
      container: target.container,
      running: false,
      status: 'container_not_running',
    };
  }
  const out = mustRun('docker', [
    'exec',
    target.container,
    'node',
    'dist/index.js',
    'approvals',
    'get',
    '--gateway',
    '--json',
  ]);
  return {
    profile,
    container: target.container,
    running: true,
    result: parseJson(out.stdout) || { raw: out.stdout },
  };
}

function parseArgs(argv) {
  const command = String(argv[0] || 'status').trim().toLowerCase();
  const profileArg = String(argv[1] || 'all').trim().toLowerCase();
  if (!['status', 'apply'].includes(command)) {
    throw new Error('command must be one of: status, apply');
  }
  const normalizedProfile = PROFILE_ALIASES[profileArg] || profileArg;
  const profiles = normalizedProfile === 'all' ? ['dev', 'anki', 'research', 'daily'] : [normalizedProfile];
  for (const profile of profiles) {
    if (!PROFILE_MAP[profile]) {
      throw new Error(`profile must be one of: dev, anki, research, daily, all (legacy aliases: main, sub1, trend) (received: ${profileArg})`);
    }
  }
  return { command, profiles };
}

function main() {
  const { command, profiles } = parseArgs(process.argv.slice(2));
  const rows = [];
  for (const profile of profiles) {
    rows.push(command === 'apply' ? applyProfile(profile) : statusProfile(profile));
  }
  console.log(JSON.stringify({
    ok: true,
    command,
    profiles: rows,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
