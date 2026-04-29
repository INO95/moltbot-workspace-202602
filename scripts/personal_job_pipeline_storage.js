const storage = require('./personal_storage');

const JOB_STAGES = Object.freeze([
    'wishlist',
    'applied',
    'recruiter_contact',
    'screening',
    'coding_test',
    'interview_1',
    'interview_2',
    'final_interview',
    'offer',
    'rejected',
    'withdrawn',
    'on_hold',
]);

const CLOSED_STAGES = new Set(['rejected', 'withdrawn']);

function nowIso() {
    return storage.nowIso();
}

function normalizeText(text) {
    return storage.normalizeSpace(text);
}

function sqlQuote(value) {
    return storage.sqlQuote(value);
}

function safeJson(value, fallback = '{}') {
    try {
        return JSON.stringify(value == null ? {} : value);
    } catch (_) {
        return fallback;
    }
}

function normalizeNullable(value) {
    const text = normalizeText(value);
    return text || null;
}

function normalizeStage(value) {
    const raw = String(value || '').trim().toLowerCase();
    const alias = {
        wish: 'wishlist',
        관심: 'wishlist',
        찜: 'wishlist',
        지원전: 'wishlist',
        지원: 'applied',
        지원완료: 'applied',
        applied: 'applied',
        recruiter: 'recruiter_contact',
        리크루터: 'recruiter_contact',
        연락: 'recruiter_contact',
        서류: 'screening',
        스크리닝: 'screening',
        과제: 'coding_test',
        코딩테스트: 'coding_test',
        코테: 'coding_test',
        면접1: 'interview_1',
        '1차': 'interview_1',
        면접2: 'interview_2',
        '2차': 'interview_2',
        최종: 'final_interview',
        오퍼: 'offer',
        합격: 'offer',
        탈락: 'rejected',
        거절: 'withdrawn',
        보류: 'on_hold',
    };
    const normalized = alias[raw] || raw;
    return JOB_STAGES.includes(normalized) ? normalized : '';
}

function normalizeStatus(stage, explicitStatus = '') {
    const raw = String(explicitStatus || '').trim().toLowerCase();
    if (raw) return raw;
    if (CLOSED_STAGES.has(stage)) return 'closed';
    if (stage === 'on_hold') return 'on_hold';
    return 'active';
}

function toNumberOrNull(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function normalizePriority(value, fallback = 3) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(5, Math.round(n)));
}

function ensureDb(options = {}) {
    return storage.ensureStorage(options);
}

function insertTimelineEvent(input = {}, options = {}) {
    const dbPath = ensureDb(options);
    const eventAt = String(input.eventAt || nowIso());
    const createdAt = String(input.createdAt || nowIso());
    storage.runSql(
        dbPath,
        `
INSERT INTO job_timeline_events (
  event_id, opportunity_id, company_id, event_type, event_at, summary, raw_text, meta_json, created_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(Number(input.opportunityId))},
  ${sqlQuote(Number(input.companyId))},
  ${sqlQuote(String(input.eventType || 'note').trim() || 'note')},
  ${sqlQuote(eventAt)},
  ${sqlQuote(normalizeText(input.summary) || '기록')},
  ${sqlQuote(normalizeNullable(input.rawText))},
  ${sqlQuote(safeJson(input.meta || {}))},
  ${sqlQuote(createdAt)}
);
`,
    );
    return storage.runSqlJson(dbPath, 'SELECT * FROM job_timeline_events ORDER BY id DESC LIMIT 1;')[0] || null;
}

function upsertCompany(input = {}, options = {}) {
    const dbPath = ensureDb(options);
    const now = String(input.createdAt || nowIso());
    const name = normalizeText(input.name);
    if (!name) throw new Error('company name is required');

    storage.runSql(
        dbPath,
        `
INSERT INTO job_companies (
  event_id, name, website, country, location, work_mode, industry, notes, created_at, updated_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(name)},
  ${sqlQuote(normalizeNullable(input.website))},
  ${sqlQuote(normalizeNullable(input.country))},
  ${sqlQuote(normalizeNullable(input.location))},
  ${sqlQuote(normalizeNullable(input.workMode))},
  ${sqlQuote(normalizeNullable(input.industry))},
  ${sqlQuote(normalizeNullable(input.notes))},
  ${sqlQuote(now)},
  ${sqlQuote(now)}
)
ON CONFLICT(name) DO UPDATE SET
  website = COALESCE(excluded.website, job_companies.website),
  country = COALESCE(excluded.country, job_companies.country),
  location = COALESCE(excluded.location, job_companies.location),
  work_mode = COALESCE(excluded.work_mode, job_companies.work_mode),
  industry = COALESCE(excluded.industry, job_companies.industry),
  notes = COALESCE(excluded.notes, job_companies.notes),
  updated_at = excluded.updated_at;
`,
    );

    return storage.runSqlJson(
        dbPath,
        `SELECT * FROM job_companies WHERE name = ${sqlQuote(name)} LIMIT 1;`,
    )[0] || null;
}

function findOpportunityByCompanyAndTitle(dbPath, companyId, title) {
    const rows = storage.runSqlJson(
        dbPath,
        `
SELECT *
FROM job_opportunities
WHERE company_id = ${sqlQuote(Number(companyId))}
  AND LOWER(title) = LOWER(${sqlQuote(normalizeText(title))})
ORDER BY id DESC
LIMIT 1;
`,
    );
    return rows[0] || null;
}

function upsertOpportunity(input = {}, options = {}) {
    const dbPath = ensureDb(options);
    const now = String(input.createdAt || nowIso());
    const companyId = Number(input.companyId);
    const title = normalizeText(input.title || '미정 포지션');
    if (!Number.isFinite(companyId) || companyId <= 0) throw new Error('companyId is required');
    if (!title) throw new Error('opportunity title is required');

    const existing = findOpportunityByCompanyAndTitle(dbPath, companyId, title);
    if (existing) {
        storage.runSql(
            dbPath,
            `
UPDATE job_opportunities
SET team_or_project = COALESCE(${sqlQuote(normalizeNullable(input.teamOrProject))}, team_or_project),
    employment_type = COALESCE(${sqlQuote(normalizeNullable(input.employmentType))}, employment_type),
    tech_stack = COALESCE(${sqlQuote(normalizeNullable(input.techStack))}, tech_stack),
    salary_min = COALESCE(${sqlQuote(toNumberOrNull(input.salaryMin))}, salary_min),
    salary_max = COALESCE(${sqlQuote(toNumberOrNull(input.salaryMax))}, salary_max),
    currency = COALESCE(${sqlQuote(normalizeNullable(input.currency))}, currency),
    jd_url = COALESCE(${sqlQuote(normalizeNullable(input.jdUrl))}, jd_url),
    source = COALESCE(${sqlQuote(normalizeNullable(input.source))}, source),
    source_message = COALESCE(${sqlQuote(normalizeNullable(input.sourceMessage))}, source_message),
    fit_score = COALESCE(${sqlQuote(toNumberOrNull(input.fitScore))}, fit_score),
    interest_score = COALESCE(${sqlQuote(toNumberOrNull(input.interestScore))}, interest_score),
    pass_probability = COALESCE(${sqlQuote(toNumberOrNull(input.passProbability))}, pass_probability),
    priority = COALESCE(${sqlQuote(toNumberOrNull(input.priority))}, priority),
    location = COALESCE(${sqlQuote(normalizeNullable(input.location))}, location),
    updated_at = ${sqlQuote(now)}
WHERE id = ${sqlQuote(Number(existing.id))};
`,
        );
        return storage.runSqlJson(
            dbPath,
            `SELECT * FROM job_opportunities WHERE id = ${sqlQuote(Number(existing.id))} LIMIT 1;`,
        )[0] || null;
    }

    storage.runSql(
        dbPath,
        `
INSERT INTO job_opportunities (
  event_id, company_id, title, team_or_project, employment_type, tech_stack,
  salary_min, salary_max, currency, jd_url, source, source_message,
  fit_score, interest_score, pass_probability, priority, location, created_at, updated_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(companyId)},
  ${sqlQuote(title)},
  ${sqlQuote(normalizeNullable(input.teamOrProject))},
  ${sqlQuote(normalizeNullable(input.employmentType))},
  ${sqlQuote(normalizeNullable(input.techStack))},
  ${sqlQuote(toNumberOrNull(input.salaryMin))},
  ${sqlQuote(toNumberOrNull(input.salaryMax))},
  ${sqlQuote(normalizeNullable(input.currency))},
  ${sqlQuote(normalizeNullable(input.jdUrl))},
  ${sqlQuote(normalizeNullable(input.source))},
  ${sqlQuote(normalizeNullable(input.sourceMessage))},
  ${sqlQuote(toNumberOrNull(input.fitScore))},
  ${sqlQuote(toNumberOrNull(input.interestScore))},
  ${sqlQuote(toNumberOrNull(input.passProbability))},
  ${sqlQuote(toNumberOrNull(input.priority))},
  ${sqlQuote(normalizeNullable(input.location))},
  ${sqlQuote(now)},
  ${sqlQuote(now)}
);
`,
    );
    return storage.runSqlJson(dbPath, 'SELECT * FROM job_opportunities ORDER BY id DESC LIMIT 1;')[0] || null;
}

function ensureApplicationProcess(input = {}, options = {}) {
    const dbPath = ensureDb(options);
    const now = String(input.createdAt || nowIso());
    const opportunityId = Number(input.opportunityId);
    if (!Number.isFinite(opportunityId) || opportunityId <= 0) throw new Error('opportunityId is required');
    const stage = normalizeStage(input.stage) || 'wishlist';
    const status = normalizeStatus(stage, input.status);
    const appliedAt = input.appliedAt || (stage === 'applied' ? now : null);

    storage.runSql(
        dbPath,
        `
INSERT INTO job_application_processes (
  event_id, opportunity_id, current_stage, status, applied_at, last_contact_at,
  next_action_at, owner_note, result_reason, created_at, updated_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(opportunityId)},
  ${sqlQuote(stage)},
  ${sqlQuote(status)},
  ${sqlQuote(normalizeNullable(appliedAt))},
  ${sqlQuote(normalizeNullable(input.lastContactAt))},
  ${sqlQuote(normalizeNullable(input.nextActionAt))},
  ${sqlQuote(normalizeNullable(input.ownerNote))},
  ${sqlQuote(normalizeNullable(input.resultReason))},
  ${sqlQuote(now)},
  ${sqlQuote(now)}
)
ON CONFLICT(opportunity_id) DO UPDATE SET
  current_stage = excluded.current_stage,
  status = excluded.status,
  applied_at = COALESCE(job_application_processes.applied_at, excluded.applied_at),
  last_contact_at = COALESCE(excluded.last_contact_at, job_application_processes.last_contact_at),
  next_action_at = COALESCE(excluded.next_action_at, job_application_processes.next_action_at),
  owner_note = COALESCE(excluded.owner_note, job_application_processes.owner_note),
  result_reason = COALESCE(excluded.result_reason, job_application_processes.result_reason),
  updated_at = excluded.updated_at;
`,
    );

    return storage.runSqlJson(
        dbPath,
        `SELECT * FROM job_application_processes WHERE opportunity_id = ${sqlQuote(opportunityId)} LIMIT 1;`,
    )[0] || null;
}

function getOpportunityDetailById(opportunityId, options = {}) {
    const dbPath = ensureDb(options);
    return storage.runSqlJson(
        dbPath,
        `
SELECT
  c.id AS company_id,
  c.name AS company_name,
  c.website AS company_website,
  c.location AS company_location,
  c.work_mode AS company_work_mode,
  c.industry AS company_industry,
  c.notes AS company_notes,
  o.id AS opportunity_id,
  o.title,
  o.team_or_project,
  o.employment_type,
  o.tech_stack,
  o.jd_url,
  o.source,
  o.fit_score,
  o.interest_score,
  o.pass_probability,
  o.priority,
  o.location AS opportunity_location,
  p.id AS process_id,
  p.current_stage,
  p.status,
  p.applied_at,
  p.last_contact_at,
  p.next_action_at,
  p.owner_note,
  p.result_reason,
  p.updated_at AS process_updated_at
FROM job_opportunities o
JOIN job_companies c ON c.id = o.company_id
LEFT JOIN job_application_processes p ON p.opportunity_id = o.id
WHERE o.id = ${sqlQuote(Number(opportunityId))}
LIMIT 1;
`,
    )[0] || null;
}

function resolveOpportunity(token, options = {}) {
    const dbPath = ensureDb(options);
    const raw = normalizeText(token);
    if (!raw) return null;

    if (/^\d+$/.test(raw)) {
        const byId = getOpportunityDetailById(Number(raw), options);
        if (byId) return byId;
    }

    const like = `%${raw.toLowerCase()}%`;
    return storage.runSqlJson(
        dbPath,
        `
SELECT
  c.id AS company_id,
  c.name AS company_name,
  c.website AS company_website,
  c.location AS company_location,
  c.work_mode AS company_work_mode,
  c.industry AS company_industry,
  c.notes AS company_notes,
  o.id AS opportunity_id,
  o.title,
  o.team_or_project,
  o.employment_type,
  o.tech_stack,
  o.jd_url,
  o.source,
  o.fit_score,
  o.interest_score,
  o.pass_probability,
  o.priority,
  o.location AS opportunity_location,
  p.id AS process_id,
  p.current_stage,
  p.status,
  p.applied_at,
  p.last_contact_at,
  p.next_action_at,
  p.owner_note,
  p.result_reason,
  p.updated_at AS process_updated_at
FROM job_opportunities o
JOIN job_companies c ON c.id = o.company_id
LEFT JOIN job_application_processes p ON p.opportunity_id = o.id
WHERE LOWER(c.name) LIKE ${sqlQuote(like)}
   OR LOWER(o.title) LIKE ${sqlQuote(like)}
   OR LOWER(COALESCE(o.tech_stack, '')) LIKE ${sqlQuote(like)}
ORDER BY datetime(COALESCE(p.updated_at, o.updated_at)) DESC, o.id DESC
LIMIT 1;
`,
    )[0] || null;
}

function createApplication(input = {}, options = {}) {
    const company = upsertCompany(input.company || {}, options);
    const opportunity = upsertOpportunity({
        ...(input.opportunity || {}),
        eventId: input.eventId,
        companyId: company.id,
    }, options);
    const process = ensureApplicationProcess({
        eventId: input.eventId,
        opportunityId: opportunity.id,
        stage: input.stage || 'wishlist',
        appliedAt: input.appliedAt,
        ownerNote: input.ownerNote,
    }, options);
    insertTimelineEvent({
        eventId: input.eventId,
        companyId: company.id,
        opportunityId: opportunity.id,
        eventType: 'application_created',
        summary: `${company.name} / ${opportunity.title} 추가`,
        rawText: input.rawText,
        meta: { stage: process.current_stage },
    }, options);
    return {
        company,
        opportunity,
        process,
        detail: getOpportunityDetailById(opportunity.id, options),
    };
}

function updateStage(input = {}, options = {}) {
    const target = resolveOpportunity(input.token, options);
    if (!target) return null;
    const stage = normalizeStage(input.stage);
    if (!stage) throw new Error(`unsupported job stage: ${input.stage}`);
    const process = ensureApplicationProcess({
        eventId: input.eventId,
        opportunityId: target.opportunity_id,
        stage,
        status: normalizeStatus(stage),
        ownerNote: input.note,
        appliedAt: stage === 'applied' ? nowIso() : null,
    }, options);
    insertTimelineEvent({
        eventId: input.eventId,
        companyId: target.company_id,
        opportunityId: target.opportunity_id,
        eventType: 'stage_changed',
        summary: `단계 변경: ${target.current_stage || '-'} -> ${stage}`,
        rawText: input.rawText,
        meta: { from: target.current_stage || null, to: stage },
    }, options);
    return {
        process,
        detail: getOpportunityDetailById(target.opportunity_id, options),
    };
}

function recordContact(input = {}, options = {}) {
    const target = resolveOpportunity(input.token, options);
    if (!target) return null;
    const dbPath = ensureDb(options);
    const now = String(input.createdAt || nowIso());
    storage.runSql(
        dbPath,
        `
INSERT INTO job_contacts (
  event_id, company_id, opportunity_id, name, role, channel, contact_url_or_email,
  notes, created_at, updated_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(Number(target.company_id))},
  ${sqlQuote(Number(target.opportunity_id))},
  ${sqlQuote(normalizeNullable(input.name))},
  ${sqlQuote(normalizeNullable(input.role || 'recruiter'))},
  ${sqlQuote(normalizeNullable(input.channel))},
  ${sqlQuote(normalizeNullable(input.contactUrlOrEmail))},
  ${sqlQuote(normalizeNullable(input.notes))},
  ${sqlQuote(now)},
  ${sqlQuote(now)}
);
`,
    );
    const contact = storage.runSqlJson(dbPath, 'SELECT * FROM job_contacts ORDER BY id DESC LIMIT 1;')[0] || null;
    insertTimelineEvent({
        eventId: input.eventId,
        companyId: target.company_id,
        opportunityId: target.opportunity_id,
        eventType: 'contact_added',
        summary: `연락처 추가: ${contact.name || contact.role || '담당자'}`,
        rawText: input.rawText,
        meta: { contactId: contact.id },
    }, options);
    return { contact, detail: getOpportunityDetailById(target.opportunity_id, options) };
}

function recordNote(input = {}, options = {}) {
    const target = resolveOpportunity(input.token, options);
    if (!target) return null;
    const dbPath = ensureDb(options);
    const content = normalizeText(input.content);
    if (!content) throw new Error('note content is required');
    const createdAt = String(input.createdAt || nowIso());
    storage.runSql(
        dbPath,
        `
INSERT INTO job_notes (
  event_id, target_type, target_id, company_id, opportunity_id, content, tags_json, created_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote('opportunity')},
  ${sqlQuote(Number(target.opportunity_id))},
  ${sqlQuote(Number(target.company_id))},
  ${sqlQuote(Number(target.opportunity_id))},
  ${sqlQuote(content)},
  ${sqlQuote(safeJson(Array.isArray(input.tags) ? input.tags : []))},
  ${sqlQuote(createdAt)}
);
`,
    );
    const note = storage.runSqlJson(dbPath, 'SELECT * FROM job_notes ORDER BY id DESC LIMIT 1;')[0] || null;
    insertTimelineEvent({
        eventId: input.eventId,
        companyId: target.company_id,
        opportunityId: target.opportunity_id,
        eventType: input.eventType || 'note',
        summary: content.slice(0, 120),
        rawText: input.rawText,
        meta: { noteId: note.id },
    }, options);
    return { note, detail: getOpportunityDetailById(target.opportunity_id, options) };
}

function setNextAction(input = {}, options = {}) {
    const target = resolveOpportunity(input.token, options);
    if (!target) return null;
    const dbPath = ensureDb(options);
    const now = String(input.createdAt || nowIso());
    const title = normalizeText(input.title);
    if (!title) throw new Error('next action title is required');
    const existing = storage.runSqlJson(
        dbPath,
        `
SELECT *
FROM job_next_actions
WHERE opportunity_id = ${sqlQuote(Number(target.opportunity_id))}
  AND status = 'open'
  AND LOWER(title) = LOWER(${sqlQuote(title)})
ORDER BY id DESC
LIMIT 1;
`,
    )[0] || null;
    if (existing) {
        const prioritySql = input.priority == null || input.priority === ''
            ? 'priority'
            : sqlQuote(normalizePriority(input.priority));
        storage.runSql(
            dbPath,
            `
UPDATE job_next_actions
SET due_at = ${sqlQuote(normalizeNullable(input.dueAt))},
    status = ${sqlQuote(String(input.status || 'open').trim().toLowerCase() || 'open')},
    priority = ${prioritySql},
    note = COALESCE(${sqlQuote(normalizeNullable(input.note))}, note),
    updated_at = ${sqlQuote(now)},
    completed_at = NULL
WHERE id = ${sqlQuote(Number(existing.id))};
`,
        );
    } else {
        storage.runSql(
            dbPath,
            `
INSERT INTO job_next_actions (
  event_id, opportunity_id, title, due_at, status, priority, note, created_at, updated_at, completed_at
)
VALUES (
  ${sqlQuote(String(input.eventId || ''))},
  ${sqlQuote(Number(target.opportunity_id))},
  ${sqlQuote(title)},
  ${sqlQuote(normalizeNullable(input.dueAt))},
  ${sqlQuote(String(input.status || 'open').trim().toLowerCase() || 'open')},
  ${sqlQuote(normalizePriority(input.priority))},
  ${sqlQuote(normalizeNullable(input.note))},
  ${sqlQuote(now)},
  ${sqlQuote(now)},
  NULL
);
`,
        );
    }
    const action = existing
        ? storage.runSqlJson(dbPath, `SELECT * FROM job_next_actions WHERE id = ${sqlQuote(Number(existing.id))} LIMIT 1;`)[0] || null
        : storage.runSqlJson(dbPath, 'SELECT * FROM job_next_actions ORDER BY id DESC LIMIT 1;')[0] || null;
    storage.runSql(
        dbPath,
        `
UPDATE job_application_processes
SET next_action_at = ${sqlQuote(normalizeNullable(input.dueAt))},
    updated_at = ${sqlQuote(now)}
WHERE opportunity_id = ${sqlQuote(Number(target.opportunity_id))};
`,
    );
    insertTimelineEvent({
        eventId: input.eventId,
        companyId: target.company_id,
        opportunityId: target.opportunity_id,
        eventType: 'next_action_set',
        summary: `다음 액션: ${title}${action.due_at ? ` (${action.due_at})` : ''}`,
        rawText: input.rawText,
        meta: { nextActionId: action.id },
    }, options);
    return { action, detail: getOpportunityDetailById(target.opportunity_id, options) };
}

function listPipeline(options = {}) {
    const dbPath = ensureDb(options);
    const activeOnly = options.activeOnly !== false;
    const where = activeOnly ? "WHERE COALESCE(p.status, 'active') != 'closed'" : '';
    return storage.runSqlJson(
        dbPath,
        `
SELECT
  c.name AS company_name,
  o.id AS opportunity_id,
  o.title,
  o.tech_stack,
  o.priority,
  p.current_stage,
  p.status,
  p.next_action_at,
  (
    SELECT ja.title
    FROM job_next_actions ja
    WHERE ja.opportunity_id = o.id AND ja.status = 'open'
    ORDER BY ja.due_at IS NULL, ja.due_at ASC, ja.priority ASC, ja.id DESC
    LIMIT 1
  ) AS next_action_title
FROM job_opportunities o
JOIN job_companies c ON c.id = o.company_id
LEFT JOIN job_application_processes p ON p.opportunity_id = o.id
${where}
ORDER BY
  CASE p.current_stage
    WHEN 'wishlist' THEN 0
    WHEN 'applied' THEN 1
    WHEN 'recruiter_contact' THEN 2
    WHEN 'screening' THEN 3
    WHEN 'coding_test' THEN 4
    WHEN 'interview_1' THEN 5
    WHEN 'interview_2' THEN 6
    WHEN 'final_interview' THEN 7
    WHEN 'offer' THEN 8
    WHEN 'on_hold' THEN 9
    WHEN 'rejected' THEN 10
    WHEN 'withdrawn' THEN 11
    ELSE 12
  END,
  datetime(COALESCE(p.updated_at, o.updated_at)) DESC,
  o.id DESC
LIMIT ${Math.max(1, Number(options.limit || 80))};
`,
    );
}

function searchPipeline(query, options = {}) {
    const dbPath = ensureDb(options);
    const q = normalizeText(query).toLowerCase();
    if (!q) return [];
    const like = `%${q}%`;
    return storage.runSqlJson(
        dbPath,
        `
SELECT DISTINCT
  c.name AS company_name,
  o.id AS opportunity_id,
  o.title,
  o.tech_stack,
  o.location AS opportunity_location,
  p.current_stage,
  p.status,
  p.next_action_at
FROM job_opportunities o
JOIN job_companies c ON c.id = o.company_id
LEFT JOIN job_application_processes p ON p.opportunity_id = o.id
LEFT JOIN job_contacts ct ON ct.opportunity_id = o.id OR ct.company_id = c.id
WHERE LOWER(c.name) LIKE ${sqlQuote(like)}
   OR LOWER(o.title) LIKE ${sqlQuote(like)}
   OR LOWER(COALESCE(o.tech_stack, '')) LIKE ${sqlQuote(like)}
   OR LOWER(COALESCE(o.location, '')) LIKE ${sqlQuote(like)}
   OR LOWER(COALESCE(c.location, '')) LIKE ${sqlQuote(like)}
   OR LOWER(COALESCE(p.current_stage, '')) LIKE ${sqlQuote(like)}
   OR LOWER(COALESCE(p.status, '')) LIKE ${sqlQuote(like)}
   OR LOWER(COALESCE(ct.name, '')) LIKE ${sqlQuote(like)}
   OR LOWER(COALESCE(ct.role, '')) LIKE ${sqlQuote(like)}
ORDER BY datetime(COALESCE(p.updated_at, o.updated_at)) DESC, o.id DESC
LIMIT ${Math.max(1, Number(options.limit || 20))};
`,
    );
}

function getDetail(token, options = {}) {
    const detail = resolveOpportunity(token, options);
    if (!detail) return null;
    const dbPath = ensureDb(options);
    const contacts = storage.runSqlJson(
        dbPath,
        `
SELECT id, name, role, channel, contact_url_or_email, notes, updated_at
FROM job_contacts
WHERE opportunity_id = ${sqlQuote(Number(detail.opportunity_id))}
   OR company_id = ${sqlQuote(Number(detail.company_id))}
ORDER BY datetime(updated_at) DESC, id DESC
LIMIT 8;
`,
    );
    const notes = storage.runSqlJson(
        dbPath,
        `
SELECT id, content, created_at
FROM job_notes
WHERE opportunity_id = ${sqlQuote(Number(detail.opportunity_id))}
ORDER BY datetime(created_at) DESC, id DESC
LIMIT 5;
`,
    );
    const timeline = storage.runSqlJson(
        dbPath,
        `
SELECT id, event_type, event_at, summary
FROM job_timeline_events
WHERE opportunity_id = ${sqlQuote(Number(detail.opportunity_id))}
ORDER BY datetime(event_at) DESC, id DESC
LIMIT 8;
`,
    );
    const actions = storage.runSqlJson(
        dbPath,
        `
SELECT id, title, due_at, status, priority, note
FROM job_next_actions
WHERE opportunity_id = ${sqlQuote(Number(detail.opportunity_id))}
ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, due_at IS NULL, due_at ASC, id DESC
LIMIT 8;
`,
    );
    return { detail, contacts, notes, timeline, actions };
}

function tokyoDate(now = null) {
    const date = now ? new Date(now) : new Date();
    const fmt = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    return fmt.format(Number.isFinite(date.getTime()) ? date : new Date());
}

function addDays(dateText, days) {
    const date = new Date(`${dateText}T00:00:00+09:00`);
    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    return tokyoDate(date);
}

function listPendingActions(range = 'today', options = {}) {
    const dbPath = ensureDb(options);
    const today = tokyoDate(options.now);
    const end = range === 'week' ? addDays(today, 7) : today;
    return storage.runSqlJson(
        dbPath,
        `
SELECT
  ja.id,
  ja.title,
  ja.due_at,
  ja.priority,
  c.name AS company_name,
  o.title AS opportunity_title,
  p.current_stage
FROM job_next_actions ja
JOIN job_opportunities o ON o.id = ja.opportunity_id
JOIN job_companies c ON c.id = o.company_id
LEFT JOIN job_application_processes p ON p.opportunity_id = o.id
WHERE ja.status = 'open'
  AND ja.due_at IS NOT NULL
  AND substr(ja.due_at, 1, 10) <= ${sqlQuote(end)}
ORDER BY substr(ja.due_at, 1, 10) ASC, ja.priority ASC, ja.id DESC
LIMIT ${Math.max(1, Number(options.limit || 30))};
`,
    );
}

function buildWeeklySummary(options = {}) {
    const dbPath = ensureDb(options);
    const today = tokyoDate(options.now);
    const since = addDays(today, -7);
    const byStage = storage.runSqlJson(
        dbPath,
        `
SELECT p.current_stage, COUNT(*) AS count
FROM job_application_processes p
GROUP BY p.current_stage
ORDER BY count DESC, p.current_stage ASC;
`,
    );
    const changed = storage.runSqlJson(
        dbPath,
        `
SELECT COUNT(*) AS count
FROM job_timeline_events
WHERE substr(event_at, 1, 10) >= ${sqlQuote(since)};
`,
    )[0] || { count: 0 };
    const stageChanges = storage.runSqlJson(
        dbPath,
        `
SELECT c.name AS company_name, o.title, te.summary, te.event_at
FROM job_timeline_events te
JOIN job_companies c ON c.id = te.company_id
JOIN job_opportunities o ON o.id = te.opportunity_id
WHERE te.event_type = 'stage_changed'
  AND substr(te.event_at, 1, 10) >= ${sqlQuote(since)}
ORDER BY datetime(te.event_at) DESC, te.id DESC
LIMIT 5;
`,
    );
    const pending = listPendingActions('week', { ...options, limit: 8 });
    return {
        today,
        since,
        byStage,
        changedCount: Number(changed.count || 0),
        stageChanges,
        pending,
    };
}

module.exports = {
    JOB_STAGES,
    normalizeStage,
    createApplication,
    updateStage,
    recordContact,
    recordNote,
    setNextAction,
    listPipeline,
    searchPipeline,
    getDetail,
    listPendingActions,
    buildWeeklySummary,
    resolveOpportunity,
    insertTimelineEvent,
};
