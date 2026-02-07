#!/usr/bin/env node
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/docker_safe_exec.js <docker ...>');
  process.exit(2);
}

const cmdText = args.join(' ').toLowerCase();
const dangerousPatterns = [
  /\brm\b/,
  /\brmi\b/,
  /\bimage\s+prune\b/,
  /\bsystem\s+prune\b/,
  /\bvolume\s+rm\b/,
  /\bvolume\s+prune\b/,
  /\bnetwork\s+prune\b/,
  /\bcompose\s+down\b/,
  /\bstop\b/,
  /\bkill\b/
];

const allowDestructive = String(process.env.ALLOW_DOCKER_DESTRUCTIVE || '').toLowerCase() === 'true';
if (!allowDestructive && dangerousPatterns.some((re) => re.test(cmdText))) {
  console.error('[blocked] destructive docker command is not allowed by default.');
  console.error('set ALLOW_DOCKER_DESTRUCTIVE=true only for intentional maintenance.');
  console.error(`requested: docker ${args.join(' ')}`);
  process.exit(10);
}

const result = spawnSync('docker', args, { stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
