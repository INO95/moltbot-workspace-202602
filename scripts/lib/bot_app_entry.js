#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

const KNOWN_ROUTES = new Set([
  'auto', 'work', 'inspect', 'deploy', 'project', 'ops',
  'word', 'news', 'prompt', 'finance', 'todo', 'routine',
  'workout', 'media', 'place', 'status', 'link', 'memo', 'report',
]);

function parseRoutePayload(argv, defaultRoute) {
  const args = Array.isArray(argv) ? [...argv] : [];
  let route = String(defaultRoute || 'auto').trim().toLowerCase() || 'auto';
  if (args.length > 0) {
    const first = String(args[0] || '').trim().toLowerCase();
    if (KNOWN_ROUTES.has(first)) {
      route = first;
      args.shift();
    }
  }
  return {
    route,
    payload: args.join(' ').trim(),
  };
}

function runBotEntry({ botId, route: defaultRoute }) {
  const root = path.resolve(__dirname, '..', '..');
  const bridge = path.join(root, 'scripts', 'bridge.js');
  const parsed = parseRoutePayload(process.argv.slice(2), defaultRoute);
  const payload = parsed.payload;
  if (!payload) {
    console.error(`Usage: npm run start -- "[route] <message>" (bot=${botId}, defaultRoute=${defaultRoute})`);
    process.exit(1);
  }
  const env = {
    ...process.env,
    MOLTBOT_BOT_ID: botId,
  };
  const result = spawnSync('node', [bridge, parsed.route, payload], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  if (result.error) {
    console.error(String(result.error.message || result.error));
    process.exit(1);
  }
  process.exit(Number.isInteger(result.status) ? result.status : 1);
}

module.exports = {
  runBotEntry,
};
