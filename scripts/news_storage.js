const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function getPaths(overrides = {}) {
    const dbPath = path.resolve(overrides.dbPath || process.env.NEWS_DB_PATH || path.join(ROOT, 'data', 'news', 'news.sqlite'));
    const sourcesPath = path.resolve(overrides.sourcesPath || process.env.NEWS_SOURCES_PATH || path.join(ROOT, 'data', 'news', 'news_sources.json'));
    const statePath = path.resolve(overrides.statePath || process.env.NEWS_STATE_PATH || path.join(ROOT, 'data', 'news', 'news_fetch_state.json'));
    return { rootPath: ROOT, dbPath, sourcesPath, statePath };
}

function ensureParentDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch (error) {
        return fallback;
    }
}

function writeJsonFile(filePath, value) {
    ensureParentDir(filePath);
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sqlQuote(value) {
    if (value == null) return 'NULL';
    return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumber(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(fallback);
    return String(n);
}

function execSql(dbPath, sql, options = {}) {
    ensureParentDir(dbPath);
    const args = ['-cmd', '.timeout 5000'];
    if (options.json) args.push('-json');
    args.push(dbPath, sql);
    try {
        return execFileSync('sqlite3', args, { encoding: 'utf8' });
    } catch (error) {
        const stderr = error && error.stderr ? String(error.stderr) : '';
        const message = stderr.trim() || String(error.message || error);
        throw new Error(`sqlite3 failed: ${message}`);
    }
}

function runSql(dbPath, sql) {
    return execSql(dbPath, sql, { json: false });
}

function runSqlJson(dbPath, sql) {
    const out = execSql(dbPath, sql, { json: true }).trim();
    if (!out) return [];
    return JSON.parse(out);
}

function ensureNewsSchema(dbPath) {
    runSql(dbPath, `
CREATE TABLE IF NOT EXISTS news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  community TEXT NOT NULL,
  post_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  comments_text TEXT,
  author TEXT,
  created_at TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  url TEXT,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS news_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS news_trends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  mention_count INTEGER NOT NULL,
  velocity REAL NOT NULL,
  top_refs_json TEXT,
  trend_score REAL NOT NULL,
  reason_text TEXT,
  level TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS news_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trend_id INTEGER,
  keyword TEXT NOT NULL,
  level TEXT,
  telegram_sent INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL,
  payload_json TEXT,
  FOREIGN KEY(trend_id) REFERENCES news_trends(id)
);
CREATE INDEX IF NOT EXISTS idx_news_items_created_at ON news_items(created_at);
CREATE INDEX IF NOT EXISTS idx_news_items_source_post ON news_items(source, post_id);
CREATE INDEX IF NOT EXISTS idx_news_trends_keyword_window ON news_trends(keyword, window_start, window_end);
CREATE INDEX IF NOT EXISTS idx_news_alerts_keyword_sent_at ON news_alerts(keyword, sent_at);
`);
}

function normalizeKeyword(keyword) {
    return String(keyword || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function ensureKeywordsFromConfig(dbPath, keywords = []) {
    const nowIso = new Date().toISOString();
    for (const kw of keywords) {
        const normalized = normalizeKeyword(kw);
        if (!normalized) continue;
        runSql(dbPath, `
INSERT OR IGNORE INTO news_keywords (keyword, enabled, created_at)
VALUES (${sqlQuote(normalized)}, 1, ${sqlQuote(nowIso)});
`);
    }
}

function listEnabledKeywords(dbPath) {
    const rows = runSqlJson(
        dbPath,
        `SELECT keyword FROM news_keywords WHERE enabled = 1 ORDER BY keyword ASC;`
    );
    return rows.map((row) => normalizeKeyword(row.keyword)).filter(Boolean);
}

function buildItemExistsQuery(item) {
    const clauses = [
        `(source = ${sqlQuote(item.source)} AND post_id = ${sqlQuote(item.post_id)})`,
    ];
    if (item.url) clauses.push(`url = ${sqlQuote(item.url)}`);
    clauses.push(`title = ${sqlQuote(item.title)}`);
    return `SELECT id FROM news_items WHERE ${clauses.join(' OR ')} LIMIT 1;`;
}

function insertNewsItems(dbPath, items = []) {
    let inserted = 0;
    let skipped = 0;

    for (const item of items) {
        const exists = runSqlJson(dbPath, buildItemExistsQuery(item));
        if (exists.length) {
            skipped += 1;
            continue;
        }
        runSql(dbPath, `
INSERT INTO news_items (
  source, community, post_id, title, body, comments_text,
  author, created_at, score, comments, url, fetched_at
)
VALUES (
  ${sqlQuote(item.source)},
  ${sqlQuote(item.community)},
  ${sqlQuote(item.post_id)},
  ${sqlQuote(item.title)},
  ${sqlQuote(item.body)},
  ${sqlQuote(item.comments_text)},
  ${sqlQuote(item.author)},
  ${sqlQuote(item.created_at)},
  ${sqlNumber(item.score, 0)},
  ${sqlNumber(item.comments, 0)},
  ${sqlQuote(item.url)},
  ${sqlQuote(item.fetched_at)}
);
`);
        inserted += 1;
    }

    return { inserted, skipped };
}

function listRecentFingerprints(dbPath, sinceIso) {
    const rows = runSqlJson(
        dbPath,
        `
SELECT url, title
FROM news_items
WHERE created_at >= ${sqlQuote(sinceIso)};
`
    );
    const set = new Set();
    for (const row of rows) {
        if (row.url) set.add(`url:${String(row.url).trim().toLowerCase()}`);
        if (row.title) {
            const normalizedTitle = String(row.title).toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').trim();
            if (normalizedTitle) set.add(`title:${normalizedTitle}`);
        }
    }
    return set;
}

module.exports = {
    getPaths,
    readJsonFile,
    writeJsonFile,
    ensureNewsSchema,
    ensureKeywordsFromConfig,
    listEnabledKeywords,
    insertNewsItems,
    listRecentFingerprints,
    runSql,
    runSqlJson,
    sqlQuote,
    sqlNumber,
    normalizeKeyword,
};
