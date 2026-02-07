const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const parser = require('./health_ingest_parser');
const recoveryEngine = require('./health_recovery_engine');

const DEFAULT_DB_PATH = path.join(__dirname, '../data/health/health.sqlite');
const MEDIA_ROOT = path.join(__dirname, '../data/health/media');
const DEFAULT_UPLOAD_ROOT = path.join(__dirname, '../data/health_upload_inbox');
const ALLOWED_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sqlValue(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = String(v).replace(/'/g, "''");
  return `'${s}'`;
}

function resolveSqliteShimPath() {
  const candidates = [
    process.env.HEALTH_SQLITE_SHIM_PATH,
    path.join(__dirname, '../sqlite_shim.py'),
    '/home/node/.openclaw/workspace/sqlite_shim.py',
  ].filter(Boolean);
  for (const p of candidates) {
    const abs = path.resolve(String(p));
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function runSqlCommandBinary(dbPath, sql, json) {
  const args = ['-cmd', '.timeout 5000'];
  if (json) args.push('-json');
  args.push(dbPath, sql);
  return spawnSync('sqlite3', args, { encoding: 'utf8' });
}

function runSqlCommandShim(dbPath, sql, json) {
  const shim = resolveSqliteShimPath();
  if (!shim) {
    return { status: 1, stderr: 'sqlite shim not found', stdout: '' };
  }
  const args = [shim, '-cmd', '.timeout 5000'];
  if (json) args.push('-json');
  args.push(dbPath, sql);
  return spawnSync('python3', args, { encoding: 'utf8' });
}

function runSql(dbPath = DEFAULT_DB_PATH, sql, { json = false } = {}) {
  ensureParent(dbPath);
  const maxRetry = 3;
  for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
    const forceShim = String(process.env.HEALTH_SQLITE_FORCE_SHIM || '').toLowerCase() === 'true';
    let r = forceShim
      ? runSqlCommandShim(dbPath, sql, json)
      : runSqlCommandBinary(dbPath, sql, json);

    if (!forceShim && (r.error?.code === 'ENOENT' || /not found/i.test(String(r.stderr || '')))) {
      r = runSqlCommandShim(dbPath, sql, json);
    }

    if (r.error || r.status !== 0) {
      const errText = String(r.stderr || r.error || 'sqlite3 error').trim();
      if (/database is locked/i.test(errText) && attempt < maxRetry) {
        continue;
      }
      throw new Error(errText);
    }
    const out = String(r.stdout || '').trim();
    if (!json) return out;
    if (!out) return [];
    try {
      return JSON.parse(out);
    } catch {
      return [];
    }
  }
  return json ? [] : '';
}

function init(dbPath = DEFAULT_DB_PATH) {
  const schemaSql = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    source TEXT,
    type TEXT NOT NULL,
    raw_text TEXT,
    image_path TEXT,
    parse_status TEXT NOT NULL,
    parse_error TEXT,
    dedupe_key TEXT UNIQUE
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id INTEGER,
    date TEXT NOT NULL,
    sport_type TEXT NOT NULL,
    duration_min INTEGER DEFAULT 0,
    calories INTEGER DEFAULT 0,
    distance_km REAL DEFAULT 0,
    volume_kg INTEGER DEFAULT 0,
    sets INTEGER DEFAULT 0,
    reps INTEGER DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(capture_id) REFERENCES captures(id)
  );

  CREATE TABLE IF NOT EXISTS session_areas (
    session_id INTEGER NOT NULL,
    area_code TEXT NOT NULL,
    PRIMARY KEY(session_id, area_code),
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS advice_cache (
    period_key TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    advice_text TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    model_used TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
  CREATE INDEX IF NOT EXISTS idx_sessions_type_date ON sessions(sport_type, date);
  CREATE INDEX IF NOT EXISTS idx_session_areas_area ON session_areas(area_code);
  `;
  runSql(dbPath, schemaSql);
  return { ok: true, dbPath };
}

function resolveUploadRoot() {
  return path.resolve(process.env.HEALTH_UPLOAD_ROOT || DEFAULT_UPLOAD_ROOT);
}

function validateIncomingImagePath(imagePath) {
  const src = String(imagePath || '').trim();
  if (!src) return { ok: true, absPath: null, code: null };
  const abs = path.resolve(src);

  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, absPath: null, code: 'image_path_not_found' };
  }

  const uploadRoot = resolveUploadRoot();
  const rel = path.relative(uploadRoot, abs);
  const insideUploadRoot = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!insideUploadRoot) {
    return { ok: false, absPath: null, code: 'image_path_not_allowed' };
  }

  const ext = path.extname(abs).toLowerCase();
  if (!ALLOWED_IMAGE_EXT.has(ext)) {
    return { ok: false, absPath: null, code: 'image_extension_not_allowed' };
  }
  return { ok: true, absPath: abs, code: null };
}

function normalizeImagePath(absImagePath, capturedAt = new Date()) {
  if (!absImagePath) return null;
  const y = String(capturedAt.getFullYear());
  const m = String(capturedAt.getMonth() + 1).padStart(2, '0');
  const dir = path.join(MEDIA_ROOT, y, m);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(absImagePath).replace(/[^A-Za-z0-9._-]/g, '_');
  const target = path.join(dir, `${Date.now()}_${base}`);
  fs.copyFileSync(absImagePath, target);
  return target;
}

function buildDedupeKey(parsed, source, imagePath) {
  const payload = {
    source: String(source || ''),
    imagePath: String(imagePath || ''),
    sessions: (parsed.sessions || []).map((s) => ({
      date: s.date,
      sportType: s.sportType,
      durationMin: s.durationMin || 0,
      calories: s.calories || 0,
      distanceKm: s.distanceKm || 0,
      volumeKg: s.volumeKg || 0,
      sets: s.sets || 0,
      reps: s.reps || 0,
      areas: Array.isArray(s.areas) ? [...s.areas].sort() : [],
      notes: s.notes || '',
    })),
  };
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function insertCaptureRow(dbPath, row) {
  const sql = `
    INSERT INTO captures (
      captured_at, source, type, raw_text, image_path, parse_status, parse_error, dedupe_key
    ) VALUES (
      ${sqlValue(row.capturedAt)},
      ${sqlValue(row.source)},
      ${sqlValue(row.type)},
      ${sqlValue(row.rawText)},
      ${sqlValue(row.imagePath)},
      ${sqlValue(row.parseStatus)},
      ${sqlValue(row.parseError)},
      ${sqlValue(row.dedupeKey)}
    );
    SELECT last_insert_rowid() as id;
  `;
  const rows = runSql(dbPath, sql, { json: true });
  return rows[0] ? Number(rows[0].id) : null;
}

function insertSessionRow(dbPath, captureId, session, capturedAtIso) {
  const sql = `
    INSERT INTO sessions (
      capture_id, date, sport_type, duration_min, calories, distance_km, volume_kg, sets, reps, notes, created_at
    ) VALUES (
      ${sqlValue(captureId)},
      ${sqlValue(session.date)},
      ${sqlValue(session.sportType)},
      ${sqlValue(session.durationMin || 0)},
      ${sqlValue(session.calories || 0)},
      ${sqlValue(session.distanceKm || 0)},
      ${sqlValue(session.volumeKg || 0)},
      ${sqlValue(session.sets || 0)},
      ${sqlValue(session.reps || 0)},
      ${sqlValue(session.notes || '')},
      ${sqlValue(capturedAtIso)}
    );
    SELECT last_insert_rowid() as id;
  `;
  const rows = runSql(dbPath, sql, { json: true });
  return rows[0] ? Number(rows[0].id) : null;
}

function ingest(dbPath = DEFAULT_DB_PATH, payload = {}) {
  init(dbPath);
  const source = String(payload.source || 'unknown');
  const capturedAt = new Date();
  const capturedAtIso = capturedAt.toISOString();
  const imageCheck = validateIncomingImagePath(payload.imagePath);
  if (!imageCheck.ok) {
    const captureId = insertCaptureRow(dbPath, {
      capturedAt: capturedAtIso,
      source,
      type: 'unknown',
      rawText: String(payload.text || ''),
      imagePath: null,
      parseStatus: 'failed',
      parseError: imageCheck.code,
      dedupeKey: null,
    });
    return {
      ok: false,
      captureId,
      saved: 0,
      duplicate: false,
      missingFields: [imageCheck.code],
      message: '이미지 경로 검증 실패',
    };
  }
  const imagePath = normalizeImagePath(imageCheck.absPath, capturedAt);

  const parserInput = payload.structured != null ? payload.structured : (payload.text != null ? payload.text : payload);
  const parsed = parser.parseCaptureInput(parserInput);

  if (!parsed.ok || !parsed.sessions || parsed.sessions.length === 0) {
    const captureId = insertCaptureRow(dbPath, {
      capturedAt: capturedAtIso,
      source,
      type: 'unknown',
      rawText: parsed.rawText || String(payload.text || ''),
      imagePath,
      parseStatus: 'failed',
      parseError: parsed.error || 'parse_failed',
      dedupeKey: null,
    });
    return {
      ok: false,
      captureId,
      saved: 0,
      duplicate: false,
      missingFields: parsed.missingFields || ['parse_failed'],
      message: '파싱 실패',
    };
  }

  const dedupeKey = buildDedupeKey(parsed, source, imagePath);
  const dupeRows = runSql(dbPath, `SELECT id FROM captures WHERE dedupe_key = ${sqlValue(dedupeKey)} LIMIT 1;`, { json: true });
  if (dupeRows.length > 0) {
    return {
      ok: true,
      duplicate: true,
      captureId: Number(dupeRows[0].id),
      saved: 0,
      sessions: [],
      missingFields: parsed.missingFields || [],
      message: '중복 캡처로 건너뜀',
    };
  }

  const captureType = parsed.sessions[0].sportType;
  const captureId = insertCaptureRow(dbPath, {
    capturedAt: capturedAtIso,
    source,
    type: captureType,
    rawText: parsed.rawText || String(payload.text || ''),
    imagePath,
    parseStatus: 'ok',
    parseError: null,
    dedupeKey,
  });

  const createdSessionIds = [];
  for (const session of parsed.sessions) {
    const sessionId = insertSessionRow(dbPath, captureId, session, capturedAtIso);
    if (!sessionId) continue;
    createdSessionIds.push(sessionId);
    for (const area of (session.areas || [])) {
      runSql(
        dbPath,
        `INSERT OR IGNORE INTO session_areas (session_id, area_code) VALUES (${sqlValue(sessionId)}, ${sqlValue(area)});`,
      );
    }
  }

  return {
    ok: true,
    duplicate: false,
    captureId,
    saved: createdSessionIds.length,
    sessions: parsed.sessions,
    missingFields: parsed.missingFields || [],
    imagePath,
    message: `저장 성공 ${createdSessionIds.length}건`,
  };
}

function buildFilterWhere(filters = {}) {
  const where = [];
  if (filters.from) where.push(`s.date >= ${sqlValue(filters.from)}`);
  if (filters.to) where.push(`s.date <= ${sqlValue(filters.to)}`);
  if (filters.type) where.push(`s.sport_type = ${sqlValue(filters.type)}`);
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

function mapSessionRow(row) {
  const areas = String(row.areas_csv || '').trim()
    ? String(row.areas_csv).split(',').map((x) => x.trim()).filter(Boolean)
    : [];
  return {
    id: Number(row.id),
    captureId: Number(row.capture_id),
    date: row.date,
    sportType: row.sport_type,
    durationMin: Number(row.duration_min || 0),
    calories: Number(row.calories || 0),
    distanceKm: Number(row.distance_km || 0),
    volumeKg: Number(row.volume_kg || 0),
    sets: Number(row.sets || 0),
    reps: Number(row.reps || 0),
    notes: row.notes || '',
    createdAt: row.created_at,
    areas,
    imagePath: row.image_path || null,
    imageUrl: row.image_path ? `api/health/captures/${row.capture_id}/image` : null,
    rawText: row.raw_text || '',
  };
}

function listSessions(dbPath = DEFAULT_DB_PATH, filters = {}) {
  init(dbPath);
  const limit = Math.max(1, Math.min(500, Number(filters.limit || 100)));
  const offset = Math.max(0, Number(filters.offset || 0));
  const where = buildFilterWhere(filters);

  const rows = runSql(
    dbPath,
    `
    SELECT
      s.id,
      s.capture_id,
      s.date,
      s.sport_type,
      s.duration_min,
      s.calories,
      s.distance_km,
      s.volume_kg,
      s.sets,
      s.reps,
      s.notes,
      s.created_at,
      c.image_path,
      c.raw_text,
      COALESCE(group_concat(sa.area_code, ','), '') AS areas_csv
    FROM sessions s
    LEFT JOIN captures c ON c.id = s.capture_id
    LEFT JOIN session_areas sa ON sa.session_id = s.id
    ${where}
    GROUP BY s.id
    ORDER BY s.date DESC, s.id DESC
    LIMIT ${limit} OFFSET ${offset};
    `,
    { json: true },
  );

  const countRows = runSql(
    dbPath,
    `SELECT COUNT(1) AS cnt FROM sessions s ${where};`,
    { json: true },
  );

  return {
    total: Number((countRows[0] && countRows[0].cnt) || 0),
    items: rows.map(mapSessionRow),
  };
}

function periodRange(period = 'month', refDate = new Date()) {
  const ref = new Date(refDate);
  if (Number.isNaN(ref.getTime())) {
    return periodRange(period, new Date());
  }
  const pad = (n) => String(n).padStart(2, '0');
  const toDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (period === 'year') {
    const start = new Date(ref.getFullYear(), 0, 1);
    const end = new Date(ref.getFullYear(), 11, 31);
    return { from: toDate(start), to: toDate(end) };
  }
  if (period === 'week') {
    const day = ref.getDay();
    const mondayDiff = day === 0 ? -6 : (1 - day);
    const start = new Date(ref);
    start.setDate(ref.getDate() + mondayDiff);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { from: toDate(start), to: toDate(end) };
  }
  const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  return { from: toDate(start), to: toDate(end) };
}

function buildRuleComment(summary) {
  const notes = [];
  if (summary.workout.sessions === 0 && summary.running.sessions === 0) {
    return '이번 기간 운동 기록이 없습니다. 가벼운 루틴부터 재시작을 권장합니다.';
  }
  if (summary.workout.sessions >= 4) {
    notes.push('웨이트 빈도가 안정적으로 유지되고 있습니다.');
  } else if (summary.workout.sessions > 0) {
    notes.push('웨이트 빈도를 주 3~4회로 맞추면 더 좋습니다.');
  }
  if (summary.running.distanceKm >= 20) {
    notes.push('러닝 볼륨이 충분합니다. 회복일을 꼭 확보하세요.');
  } else if (summary.running.sessions > 0) {
    notes.push('러닝 볼륨을 조금 더 늘리면 심폐지구력 개선에 유리합니다.');
  }

  const areaEntries = Object.entries(summary.workout.byArea || {}).sort((a, b) => b[1] - a[1]);
  if (areaEntries.length > 0) {
    const top = areaEntries[0][0];
    notes.push(`주요 자극 부위는 ${top}입니다.`);
  }

  if (!notes.length) {
    notes.push('기록 기반으로 다음 주기 강도를 조절해 보세요.');
  }
  return notes.slice(0, 2).join(' ');
}

function getSummary(dbPath = DEFAULT_DB_PATH, opts = {}) {
  const period = String(opts.period || 'month').toLowerCase();
  const refDate = opts.refDate || new Date();
  const range = periodRange(period, refDate);
  const listed = listSessions(dbPath, { from: range.from, to: range.to, limit: 500, offset: 0 });

  const running = {
    sessions: 0,
    distanceKm: 0,
    calories: 0,
    durationMin: 0,
  };
  const workout = {
    sessions: 0,
    volumeKg: 0,
    calories: 0,
    durationMin: 0,
    sets: 0,
    reps: 0,
    byArea: {},
  };

  for (const s of listed.items) {
    if (s.sportType === 'running') {
      running.sessions += 1;
      running.distanceKm += Number(s.distanceKm || 0);
      running.calories += Number(s.calories || 0);
      running.durationMin += Number(s.durationMin || 0);
    } else {
      workout.sessions += 1;
      workout.volumeKg += Number(s.volumeKg || 0);
      workout.calories += Number(s.calories || 0);
      workout.durationMin += Number(s.durationMin || 0);
      workout.sets += Number(s.sets || 0);
      workout.reps += Number(s.reps || 0);
      for (const area of s.areas || []) {
        workout.byArea[area] = (workout.byArea[area] || 0) + 1;
      }
    }
  }

  running.distanceKm = Math.round(running.distanceKm * 100) / 100;
  const recovery = recoveryEngine.computeRecoveryFromSessions(listed.items, refDate);

  const summary = {
    period,
    from: range.from,
    to: range.to,
    totalSessions: listed.total,
    running,
    workout,
    comment: '',
    recovery,
  };
  summary.comment = buildRuleComment(summary);
  return summary;
}

function getToday(dbPath = DEFAULT_DB_PATH, dateText = new Date().toISOString().slice(0, 10)) {
  const date = parser.normalizeDate(dateText);
  const listed = listSessions(dbPath, { from: date, to: date, limit: 200, offset: 0 });
  return {
    date,
    total: listed.total,
    sessions: listed.items,
  };
}

function getRecovery(dbPath = DEFAULT_DB_PATH, refDate = new Date()) {
  const listed = listSessions(dbPath, { limit: 1000, offset: 0 });
  return recoveryEngine.computeRecoveryFromSessions(listed.items, refDate);
}

function getCaptureImagePath(dbPath = DEFAULT_DB_PATH, captureId) {
  init(dbPath);
  const rows = runSql(
    dbPath,
    `SELECT image_path FROM captures WHERE id = ${sqlValue(captureId)} LIMIT 1;`,
    { json: true },
  );
  if (!rows.length) return null;
  const p = String(rows[0].image_path || '').trim();
  return p || null;
}

function cacheAdvice(dbPath, periodKey, mode, adviceText, modelUsed) {
  runSql(
    dbPath,
    `
      INSERT INTO advice_cache(period_key, mode, advice_text, generated_at, model_used)
      VALUES (
        ${sqlValue(periodKey)},
        ${sqlValue(mode)},
        ${sqlValue(adviceText)},
        ${sqlValue(new Date().toISOString())},
        ${sqlValue(modelUsed || null)}
      )
      ON CONFLICT(period_key) DO UPDATE SET
        mode=excluded.mode,
        advice_text=excluded.advice_text,
        generated_at=excluded.generated_at,
        model_used=excluded.model_used;
    `,
  );
}

function generateAdvice(dbPath = DEFAULT_DB_PATH, opts = {}) {
  const period = String(opts.period || 'week').toLowerCase();
  const refDate = opts.refDate || new Date();
  const mode = String(opts.mode || 'rule').toLowerCase();
  const summary = getSummary(dbPath, { period, refDate });

  let adviceText = summary.comment;
  let modelUsed = 'rule';
  if (mode === 'llm') {
    if (String(process.env.HEALTH_LLM_ADVICE_ENABLED || '').toLowerCase() === 'true') {
      // LLM path is intentionally conservative: keep deterministic fallback if external call is unavailable.
      adviceText = `${summary.comment} (LLM 확장 경로 활성화 시 심화 코멘트로 대체됩니다.)`;
      modelUsed = 'llm-fallback';
    } else {
      adviceText = `${summary.comment} (현재 LLM 심화 코멘트는 비활성화 상태입니다.)`;
      modelUsed = 'llm-disabled';
    }
  }

  const periodKey = `${period}:${summary.from}:${summary.to}`;
  cacheAdvice(dbPath, periodKey, mode, adviceText, modelUsed);

  return {
    period,
    from: summary.from,
    to: summary.to,
    mode,
    adviceText,
    modelUsed,
  };
}

module.exports = {
  DEFAULT_DB_PATH,
  init,
  ingest,
  listSessions,
  getToday,
  getSummary,
  getRecovery,
  getCaptureImagePath,
  generateAdvice,
};
