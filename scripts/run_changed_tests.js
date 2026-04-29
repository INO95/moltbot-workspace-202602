#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function runGit(args) {
  const res = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) return [];
  return String(res.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function collectChangedFiles(options = {}) {
  if (Array.isArray(options.files) && options.files.length > 0) {
    return [...new Set(options.files.map((file) => String(file || '').trim()).filter(Boolean))];
  }
  const files = [
    ...runGit(['diff', '--name-only', '--cached', '--']),
    ...runGit(['diff', '--name-only', '--']),
    ...runGit(['ls-files', '--others', '--exclude-standard']),
  ];
  return [...new Set(files)].sort();
}

function add(commands, command) {
  if (!commands.includes(command)) commands.push(command);
}

function planChangedTests(files = []) {
  const commands = [];
  const reasons = [];
  const normalized = files.map((file) => String(file || '').trim()).filter(Boolean);

  for (const file of normalized) {
    if (file === 'package.json' || file === 'package-lock.json' || file === '.gitignore') {
      add(commands, 'npm run -s check:scripts');
      reasons.push({ file, command: 'npm run -s check:scripts' });
    }
    if (/^scripts\/check_package_scripts\.js$|^scripts\/test_check_package_scripts\.js$/.test(file)) {
      add(commands, 'node scripts/test_check_package_scripts.js');
      add(commands, 'npm run -s check:scripts');
      reasons.push({ file, command: 'node scripts/test_check_package_scripts.js' });
    }
    if (/^scripts\/anki_|^scripts\/test_anki_/.test(file)) {
      add(commands, 'npm run -s test:scope:anki');
      reasons.push({ file, command: 'npm run -s test:scope:anki' });
    }
    if (/^scripts\/ops_|^scripts\/test_ops_|^ops\//.test(file)) {
      add(commands, 'npm run -s test:ops');
      reasons.push({ file, command: 'npm run -s test:ops' });
    }
    if (/^scripts\/bridge|^scripts\/lib\/bridge_|^scripts\/test_bridge_/.test(file)) {
      add(commands, 'npm run -s test:v1-release');
      reasons.push({ file, command: 'npm run -s test:v1-release' });
    }
    if (/^scripts\/news_|^scripts\/test_news_/.test(file)) {
      add(commands, 'npm run -s test:news');
      reasons.push({ file, command: 'npm run -s test:news' });
    }
    if (/^scripts\/personal_|^scripts\/test_personal_/.test(file)) {
      add(commands, 'npm run -s test:personal');
      reasons.push({ file, command: 'npm run -s test:personal' });
    }
  }

  if (commands.length === 0 && normalized.length > 0) {
    add(commands, 'npm run -s test:smoke');
    reasons.push({ file: '*', command: 'npm run -s test:smoke' });
  }

  return {
    ok: true,
    files: normalized,
    commands,
    reasons,
  };
}

function runCommand(command) {
  const res = spawnSync(command, {
    cwd: ROOT,
    shell: true,
    stdio: 'inherit',
    env: process.env,
  });
  return !res.error && res.status === 0;
}

function parseArgs(argv) {
  const out = {
    dryRun: false,
    json: false,
    files: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--file') {
      i += 1;
      out.files.push(argv[i]);
    } else if (arg.startsWith('--file=')) {
      out.files.push(arg.slice('--file='.length));
    } else {
      out.files.push(arg);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = collectChangedFiles({ files: args.files });
  const plan = planChangedTests(files);
  if (args.json || args.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
  }
  if (args.dryRun) return;
  for (const command of plan.commands) {
    const ok = runCommand(command);
    if (!ok) process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  collectChangedFiles,
  planChangedTests,
};
