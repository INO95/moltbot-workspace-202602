#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

function runNodeScriptAsBot({ botId, scriptRelativePath, args = [], extraEnv = {} }) {
  const root = path.resolve(__dirname, '..', '..');
  const target = path.join(root, scriptRelativePath);
  const env = {
    ...process.env,
    MOLTBOT_BOT_ID: String(botId || process.env.MOLTBOT_BOT_ID || '').trim(),
    ...extraEnv,
  };

  const result = spawnSync('node', [target, ...args], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  if (result.error) {
    throw result.error;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

module.exports = {
  runNodeScriptAsBot,
};
