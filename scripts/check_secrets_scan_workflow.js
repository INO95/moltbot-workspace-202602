#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'secrets-scan.yml');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getStepBlock(workflowText, stepName) {
  const stepHeader = `- name: ${stepName}`;
  const start = workflowText.indexOf(stepHeader);
  if (start < 0) return '';

  const remaining = workflowText.slice(start);
  const nextStep = remaining.slice(stepHeader.length).search(/\n\s*- name:/);
  if (nextStep < 0) return remaining;
  return remaining.slice(0, stepHeader.length + nextStep + 1);
}

function hasLine(block, pattern) {
  return new RegExp(`^\\s*${pattern}\\s*$`, 'm').test(block);
}

function main() {
  assert(fs.existsSync(WORKFLOW_PATH), `workflow file not found: ${WORKFLOW_PATH}`);
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  const prName = 'TruffleHog scan (pull_request)';
  const pushName = 'TruffleHog scan (push)';

  const prBlock = getStepBlock(text, prName);
  const pushBlock = getStepBlock(text, pushName);

  assert(prBlock, `missing step: ${prName}`);
  assert(pushBlock, `missing step: ${pushName}`);

  assert(hasLine(prBlock, "if: \\\${\\\{ github.event_name == 'pull_request' \\\}}"),
    `${prName} step must be gated by pull_request event`);
  assert(hasLine(pushBlock, "if: \\\${\\\{ github.event_name == 'push' \\\}}"),
    `${pushName} step must be gated by push event`);

  assert(hasLine(prBlock, `uses: ${escapeRegex('trufflesecurity/trufflehog@main')}`),
    `${prName} step must use trufflesecurity/trufflehog@main`);
  assert(hasLine(pushBlock, `uses: ${escapeRegex('trufflesecurity/trufflehog@main')}`),
    `${pushName} step must use trufflesecurity/trufflehog@main`);

  assert(hasLine(prBlock, "base: \\\${\\\{ github.event.pull_request.base.sha \\\}}"),
    `${prName} step must set pull_request base sha`);
  assert(hasLine(prBlock, "head: \\\${\\\{ github.event.pull_request.head.sha \\\}}"),
    `${prName} step must set pull_request head sha`);

  assert(!hasLine(pushBlock, 'base:'), `${pushName} step must not set base`);
  assert(!hasLine(pushBlock, 'head:'), `${pushName} step must not set head`);

  console.log(JSON.stringify({ ok: true, workflow: '.github/workflows/secrets-scan.yml' }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
}
