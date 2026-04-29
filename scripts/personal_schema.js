const path = require('path');
const { runSql } = require('./news_storage');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DB_PATH = path.join(ROOT, 'data', 'personal', 'personal.sqlite');

function resolveDbPath(options = {}) {
    return path.resolve(String(options.dbPath || process.env.PERSONAL_DB_PATH || DEFAULT_DB_PATH));
}

function ensurePersonalSchema(dbPathOrOptions = {}) {
    const dbPath = typeof dbPathOrOptions === 'string'
        ? path.resolve(dbPathOrOptions)
        : resolveDbPath(dbPathOrOptions);

    runSql(dbPath, `
CREATE TABLE IF NOT EXISTS event_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'telegram',
  route TEXT NOT NULL,
  raw_text TEXT,
  normalized_text TEXT,
  payload_json TEXT,
  dedupe_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  retained_until TEXT,
  ingest_status TEXT NOT NULL DEFAULT 'processed',
  error_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_inbox_route_created ON event_inbox(route, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_inbox_created ON event_inbox(created_at DESC);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  item TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY',
  fx_rate_to_jpy REAL,
  amount_jpy REAL,
  category TEXT,
  payment_method TEXT,
  memo TEXT,
  tags_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(event_id, item, amount, currency, entry_type)
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_date ON ledger_entries(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_type ON ledger_entries(entry_type);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 3,
  due_date TEXT,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS routine_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  schedule_hint TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routine_templates_active ON routine_templates(active, updated_at DESC);

CREATE TABLE IF NOT EXISTS routine_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  template_id INTEGER NOT NULL,
  log_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(template_id, log_date, status),
  FOREIGN KEY(template_id) REFERENCES routine_templates(id)
);
CREATE INDEX IF NOT EXISTS idx_routine_logs_date ON routine_logs(log_date DESC);

CREATE TABLE IF NOT EXISTS workout_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  workout_date TEXT NOT NULL,
  workout_type TEXT NOT NULL,
  duration_min INTEGER,
  calories INTEGER,
  distance_km REAL,
  intensity TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workout_logs_date ON workout_logs(workout_date DESC);

CREATE TABLE IF NOT EXISTS vocab_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  word TEXT NOT NULL,
  deck TEXT NOT NULL,
  note_id INTEGER,
  save_status TEXT NOT NULL,
  error_text TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(event_id, word, deck)
);
CREATE INDEX IF NOT EXISTS idx_vocab_logs_word ON vocab_logs(word, created_at DESC);

CREATE TABLE IF NOT EXISTS media_place_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT,
  rating REAL,
  memo TEXT,
  tags_json TEXT,
  visit_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_place_kind_date ON media_place_logs(kind, visit_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS job_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  name TEXT NOT NULL UNIQUE,
  website TEXT,
  country TEXT,
  location TEXT,
  work_mode TEXT,
  industry TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_companies_name ON job_companies(name);

CREATE TABLE IF NOT EXISTS job_opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  company_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  team_or_project TEXT,
  employment_type TEXT,
  tech_stack TEXT,
  salary_min REAL,
  salary_max REAL,
  currency TEXT,
  jd_url TEXT,
  source TEXT,
  source_message TEXT,
  fit_score REAL,
  interest_score REAL,
  pass_probability REAL,
  priority INTEGER,
  location TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(company_id) REFERENCES job_companies(id)
);
CREATE INDEX IF NOT EXISTS idx_job_opportunities_company ON job_opportunities(company_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_opportunities_title ON job_opportunities(title);

CREATE TABLE IF NOT EXISTS job_application_processes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  opportunity_id INTEGER NOT NULL UNIQUE,
  current_stage TEXT NOT NULL DEFAULT 'wishlist',
  status TEXT NOT NULL DEFAULT 'active',
  applied_at TEXT,
  last_contact_at TEXT,
  next_action_at TEXT,
  owner_note TEXT,
  result_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(opportunity_id) REFERENCES job_opportunities(id)
);
CREATE INDEX IF NOT EXISTS idx_job_processes_stage ON job_application_processes(current_stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_processes_next_action ON job_application_processes(next_action_at);

CREATE TABLE IF NOT EXISTS job_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  company_id INTEGER NOT NULL,
  opportunity_id INTEGER,
  name TEXT,
  role TEXT,
  channel TEXT,
  contact_url_or_email TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(company_id) REFERENCES job_companies(id),
  FOREIGN KEY(opportunity_id) REFERENCES job_opportunities(id)
);
CREATE INDEX IF NOT EXISTS idx_job_contacts_company ON job_contacts(company_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS job_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  company_id INTEGER,
  opportunity_id INTEGER,
  content TEXT NOT NULL,
  tags_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_notes_company ON job_notes(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_notes_opportunity ON job_notes(opportunity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS job_timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  opportunity_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  raw_text TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(opportunity_id) REFERENCES job_opportunities(id),
  FOREIGN KEY(company_id) REFERENCES job_companies(id)
);
CREATE INDEX IF NOT EXISTS idx_job_timeline_opportunity ON job_timeline_events(opportunity_id, event_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_job_timeline_company ON job_timeline_events(company_id, event_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS job_next_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  opportunity_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 3,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(opportunity_id) REFERENCES job_opportunities(id)
);
CREATE INDEX IF NOT EXISTS idx_job_next_actions_due ON job_next_actions(status, due_at, priority);
CREATE INDEX IF NOT EXISTS idx_job_next_actions_opportunity ON job_next_actions(opportunity_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sync_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  sync_target TEXT NOT NULL,
  sync_action TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_audit_target_created ON sync_audit(sync_target, created_at DESC);
`);

    return dbPath;
}

module.exports = {
    DEFAULT_DB_PATH,
    resolveDbPath,
    ensurePersonalSchema,
};
