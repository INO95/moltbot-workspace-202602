const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const config = require('../data/config.json');
const opsLogger = require('./ops_logger');

function nowIso() {
  return new Date().toISOString();
}

function resolvePath(input, fallback) {
  const raw = String(input || '').trim();
  if (!raw) return fallback;
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

function resolveSettings() {
  const section = (config && typeof config.opsUnifiedApprovals === 'object')
    ? config.opsUnifiedApprovals
    : {};
  return {
    enabled: section.enabled !== false,
    auditLogDir: resolvePath(section.auditLogDir, path.join(ROOT, 'logs', 'approvals')),
  };
}

function logPathForDate(isoTs, settings = resolveSettings()) {
  const date = String(isoTs || nowIso()).slice(0, 10);
  return path.join(settings.auditLogDir, `${date}.jsonl`);
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function hashToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return '';
  return `tok_${hashValue(raw).slice(0, 16)}`;
}

function sanitizePayload(data = {}) {
  const source = (data && typeof data === 'object') ? { ...data } : {};
  if (Object.prototype.hasOwnProperty.call(source, 'token')) {
    source.token_hash = hashToken(source.token);
    delete source.token;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'token_id')) {
    source.token_id_hash = hashToken(source.token_id);
    delete source.token_id;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'payload')) {
    source.payload = opsLogger.redact(source.payload);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'plan')) {
    source.plan = opsLogger.redact(source.plan);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'command')) {
    source.command = opsLogger.redact(String(source.command || ''));
  }
  if (Object.prototype.hasOwnProperty.call(source, 'stdout')) {
    source.stdout = opsLogger.redact(String(source.stdout || ''));
  }
  if (Object.prototype.hasOwnProperty.call(source, 'stderr')) {
    source.stderr = opsLogger.redact(String(source.stderr || ''));
  }
  return opsLogger.redact(source);
}

function append(eventType, payload = {}) {
  const settings = resolveSettings();
  if (!settings.enabled) {
    return {
      ok: true,
      skipped: true,
      reason: 'disabled',
      path: '',
    };
  }

  const ts = nowIso();
  const logPath = logPathForDate(ts, settings);
  const row = sanitizePayload({
    schema_version: '1.0',
    ts,
    event_type: String(eventType || '').trim() || 'event',
    ...((payload && typeof payload === 'object') ? payload : {}),
  });

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, 'utf8');
  return {
    ok: true,
    skipped: false,
    path: logPath,
    row,
  };
}

module.exports = {
  append,
  resolveSettings,
  logPathForDate,
  hashToken,
};
