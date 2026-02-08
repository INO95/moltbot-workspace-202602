#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const https = require('https');
const { URL } = require('url');

const ENV_PATH = path.join(__dirname, '..', '.env');
const STATE_PATH = path.join(__dirname, '..', 'data', 'runtime', 'tunnel_state.json');

function loadDotEnv() {
  try {
    if (!fs.existsSync(ENV_PATH)) return;
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (_) {}
}

function normalizeHttpsBase(v) {
  const out = String(v || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+$/i.test(out) ? out : null;
}

function loadStateBase() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const json = JSON.parse(raw);
    return normalizeHttpsBase(json && json.publicUrl ? json.publicUrl : '');
  } catch (_) {
    return null;
  }
}

function getBases() {
  const promptEnv = normalizeHttpsBase(process.env.PROMPT_PUBLIC_BASE_URL || '');
  const genericEnv = normalizeHttpsBase(process.env.DEV_TUNNEL_PUBLIC_BASE_URL || '');
  const stateBase = loadStateBase();
  const generic = genericEnv || stateBase || null;
  return {
    prompt: promptEnv || generic,
  };
}

function checkHttps(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', timeout: 7000 }, (res) => {
      resolve({ ok: true, statusCode: Number(res.statusCode || 0), error: '' });
      res.resume();
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      resolve({ ok: false, statusCode: 0, error: String(err && err.message ? err.message : err) });
    });
    req.end();
  });
}

async function checkHost(hostname) {
  try {
    const looked = await dns.lookup(hostname);
    return { ok: true, address: looked.address, family: looked.family, error: '' };
  } catch (error) {
    return { ok: false, address: '', family: 0, error: String(error && error.message ? error.message : error) };
  }
}

async function run() {
  loadDotEnv();
  const bases = getBases();
  const targets = [
    { key: 'prompt', label: '프롬프트', path: '/prompt/' },
  ];

  const rows = [];
  for (const t of targets) {
    const base = bases[t.key];
    if (!base) continue;
    const url = `${base}${t.path}`;
    let hostname = '';
    try {
      hostname = new URL(base).hostname;
    } catch (_) {}
    const dnsResult = hostname ? await checkHost(hostname) : { ok: false, address: '', family: 0, error: 'invalid hostname' };
    const httpsResult = await checkHttps(url);
    rows.push({
      key: t.key,
      label: t.label,
      base,
      url,
      hostname,
      dns: dnsResult,
      https: httpsResult,
    });
  }

  const out = {
    ok: true,
    checkedAt: new Date().toISOString(),
    targets: rows,
  };

  const wantText = process.argv.includes('--text');
  if (wantText) {
    const lines = ['외부 링크 점검'];
    for (const row of rows) {
      const dnsPart = row.dns.ok ? `DNS OK(${row.dns.address})` : `DNS FAIL(${row.dns.error})`;
      const httpsPart = row.https.ok
        ? `HTTPS ${row.https.statusCode}`
        : `HTTPS FAIL(${row.https.error})`;
      lines.push(`- ${row.label}: ${dnsPart}, ${httpsPart}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
