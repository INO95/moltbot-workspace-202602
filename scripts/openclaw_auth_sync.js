#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, composeEnvArgs } = require('./env_runtime');

const AUTH_ROOT = '/home/node/.openclaw';
const AUTH_PATH = `${AUTH_ROOT}/auth-profiles.json`;
const AUTH_AGENT_DIR = `${AUTH_ROOT}/agents/main/agent`;
const AUTH_AGENT_PATH = `${AUTH_AGENT_DIR}/auth-profiles.json`;

const PROFILE_META = {
  dev: { container: 'moltbot-dev', service: 'openclaw-dev', composeProfile: 'live' },
  anki: { container: 'moltbot-anki', service: 'openclaw-anki', composeProfile: 'live' },
  research: { container: 'moltbot-research', service: 'openclaw-research', composeProfile: 'live' },
  daily: { container: 'moltbot-daily', service: 'openclaw-daily', composeProfile: 'live' },
  dev_bak: { container: 'moltbot-dev-bak', service: 'openclaw-dev-bak', composeProfile: 'backup' },
  anki_bak: { container: 'moltbot-anki-bak', service: 'openclaw-anki-bak', composeProfile: 'backup' },
  research_bak: { container: 'moltbot-research-bak', service: 'openclaw-research-bak', composeProfile: 'backup' },
  daily_bak: { container: 'moltbot-daily-bak', service: 'openclaw-daily-bak', composeProfile: 'backup' },
};

const LIVE_PROFILES = ['dev', 'anki', 'research', 'daily'];
const BACKUP_PROFILES = ['dev_bak', 'anki_bak', 'research_bak', 'daily_bak'];

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    ok: !res.error && res.status === 0,
    code: res.status == null ? 1 : res.status,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
    error: res.error ? String(res.error.message || res.error) : '',
  };
}

function mustRun(cmd, args, opts = {}) {
  const out = run(cmd, args, opts);
  if (out.ok) return out;
  const details = out.stderr || out.stdout || out.error || 'unknown error';
  throw new Error(`${cmd} ${args.join(' ')} failed: ${details}`);
}

function parseArgs(argv) {
  const out = {
    source: 'dev',
    targets: [...LIVE_PROFILES],
    includeBackup: false,
    restart: true,
    allowEmpty: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (!arg) continue;
    if (arg === '--include-backup') {
      out.includeBackup = true;
      continue;
    }
    if (arg === '--no-restart') {
      out.restart = false;
      continue;
    }
    if (arg === '--allow-empty') {
      out.allowEmpty = true;
      continue;
    }
    if (arg === '--source' && argv[i + 1]) {
      out.source = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
    if (arg === '--targets' && argv[i + 1]) {
      const v = String(argv[i + 1] || '');
      out.targets = v.split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    throw new Error(`unknown arg: ${arg}`);
  }

  if (out.includeBackup) {
    const merged = new Set([...out.targets, ...BACKUP_PROFILES]);
    out.targets = Array.from(merged);
  }
  return out;
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/openclaw_auth_sync.js [--source <profile>] [--targets <csv>] [--include-backup] [--no-restart] [--allow-empty]\n',
  );
}

function resolveProfileName(name) {
  const raw = String(name || '').trim();
  const aliases = {
    main: 'dev',
    sub1: 'anki',
    trend: 'research',
    main_bak: 'dev_bak',
    sub1_bak: 'anki_bak',
    trend_bak: 'research_bak',
  };
  return aliases[raw] || raw;
}

function assertProfile(profile) {
  if (!PROFILE_META[profile]) {
    throw new Error(`unsupported profile: ${profile}`);
  }
}

function ensureContainerRunning(profile) {
  const meta = PROFILE_META[profile];
  const running = run('docker', ['inspect', '-f', '{{.State.Running}}', meta.container]);
  if (running.ok && running.stdout === 'true') {
    return { container: meta.container, started: false };
  }
  const args = ['compose', ...composeEnvArgs({ allowLegacyFallback: true, required: false })];
  if (meta.composeProfile) args.push('--profile', meta.composeProfile);
  args.push('up', '-d', meta.service);
  mustRun('docker', args, { cwd: ROOT });
  return { container: meta.container, started: true };
}

function findSourcePath(container) {
  const paths = [AUTH_AGENT_PATH, AUTH_PATH];
  for (const p of paths) {
    const exists = run('docker', ['exec', container, 'sh', '-lc', `test -f ${JSON.stringify(p)}`]);
    if (exists.ok) return p;
  }
  return null;
}

function inspectAuthJson(authFilePath) {
  const raw = fs.readFileSync(authFilePath, 'utf8');
  const json = JSON.parse(raw);
  const profile = (json.profiles || {})['openai-codex:default'] || {};
  return {
    hasAccessToken: Boolean(profile.accessToken || profile.access_token || profile.access),
    hasRefreshToken: Boolean(profile.refreshToken || profile.refresh_token || profile.refresh),
    profileKeys: Object.keys(json.profiles || {}),
  };
}

function writeAuthJsonToContainer(container, content) {
  const payload = String(content || '').trim();
  if (!payload) throw new Error(`empty auth content for ${container}`);
  const writeRes = run(
    'docker',
    [
      'exec',
      '-i',
      container,
      'sh',
      '-lc',
      `umask 077; mkdir -p ${JSON.stringify(AUTH_ROOT)} ${JSON.stringify(AUTH_AGENT_DIR)}; rm -f ${JSON.stringify(AUTH_PATH)} ${JSON.stringify(AUTH_AGENT_PATH)}; cat > ${JSON.stringify(AUTH_PATH)}; cp ${JSON.stringify(AUTH_PATH)} ${JSON.stringify(AUTH_AGENT_PATH)}; chmod 600 ${JSON.stringify(AUTH_PATH)} ${JSON.stringify(AUTH_AGENT_PATH)}`,
    ],
    { input: `${payload}\n` },
  );
  if (!writeRes.ok) {
    const details = writeRes.stderr || writeRes.stdout || writeRes.error || 'unknown error';
    throw new Error(`write auth json failed in ${container}: ${details}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  const sourceProfile = resolveProfileName(args.source);
  assertProfile(sourceProfile);

  const targetProfiles = args.targets.map(resolveProfileName);
  for (const profile of targetProfiles) assertProfile(profile);

  const sourceRunning = ensureContainerRunning(sourceProfile);
  const sourceContainer = PROFILE_META[sourceProfile].container;
  const sourcePath = findSourcePath(sourceContainer);
  if (!sourcePath) {
    throw new Error(`source auth file not found in ${sourceContainer}`);
  }

  const tempPath = path.join(os.tmpdir(), `openclaw-auth-sync-${Date.now()}.json`);
  const sourceContent = mustRun('docker', ['exec', sourceContainer, 'sh', '-lc', `cat ${JSON.stringify(sourcePath)}`]);
  fs.writeFileSync(tempPath, `${sourceContent.stdout}\n`, 'utf8');

  const inspected = inspectAuthJson(tempPath);
  if (!args.allowEmpty && !inspected.hasAccessToken && !inspected.hasRefreshToken) {
    fs.unlinkSync(tempPath);
    throw new Error(
      'source auth-profiles.json has no openai-codex tokens. Run OAuth login first in source container.',
    );
  }

  const results = [];
  for (const profile of targetProfiles) {
    const running = ensureContainerRunning(profile);
    const container = PROFILE_META[profile].container;

    writeAuthJsonToContainer(container, sourceContent.stdout);

    let restarted = false;
    if (args.restart) {
      mustRun('docker', ['restart', container]);
      restarted = true;
    }

    results.push({
      profile,
      container,
      containerStarted: running.started,
      restarted,
    });
  }

  fs.unlinkSync(tempPath);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      source: {
        profile: sourceProfile,
        container: sourceContainer,
        path: sourcePath,
        containerStarted: sourceRunning.started,
      },
      inspected,
      targets: results,
    }, null, 2)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
}
