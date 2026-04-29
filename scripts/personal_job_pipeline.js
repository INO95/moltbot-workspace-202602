const personalStorage = require('./personal_storage');
const jobs = require('./personal_job_pipeline_storage');

function normalize(text) {
    return personalStorage.normalizeSpace(text);
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

function stripLead(text) {
    return normalize(text)
        .replace(/^(지원처|지원|채용|job)\s*[:：]?\s*/i, '')
        .trim();
}

function parseKeyValueFields(text) {
    const raw = String(text || '');
    const keyRe = /(회사명|회사|company|포지션|직무|role|position|title|링크|url|jd_url|스택|기술스택|tech_stack|위치|지역|location|근무형태|work_mode|단계|stage|면접일|interview_at|fit_score|fit|interest_score|interest|pass_probability|확률|priority|우선순위|다음액션|next_action|액션|마감|due|source|출처|담당자|리크루터|recruiter)\s*[=:]\s*/gi;
    const matches = [];
    let match;
    while ((match = keyRe.exec(raw)) != null) {
        matches.push({
            key: String(match[1] || '').trim().toLowerCase(),
            valueStart: keyRe.lastIndex,
            start: match.index,
        });
    }
    const out = {};
    for (let i = 0; i < matches.length; i += 1) {
        const cur = matches[i];
        const next = matches[i + 1];
        const value = raw.slice(cur.valueStart, next ? next.start : raw.length).trim();
        if (value) out[cur.key] = value.replace(/^["']|["']$/g, '').trim();
    }
    return out;
}

function firstField(fields, keys = []) {
    for (const key of keys) {
        const value = fields[String(key).toLowerCase()];
        if (value != null && String(value).trim()) return String(value).trim();
    }
    return '';
}

function parseScore(value) {
    if (value == null || value === '') return null;
    const n = Number(String(value).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : null;
}

function formatTimeFromRaw(text) {
    const raw = String(text || '');
    const colon = raw.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (colon) return `${String(Number(colon[1])).padStart(2, '0')}:${colon[2]}`;
    const match = raw.match(/(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분?)?/);
    if (!match) return '';
    const meridiem = String(match[1] || '').trim();
    let hour = Number(match[2]);
    const minute = Number(match[3] || 0);
    if (!Number.isFinite(hour) || hour < 0 || hour > 24) return '';
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return '';
    if (meridiem === '오후' && hour < 12) hour += 12;
    if (meridiem === '오전' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function appendTimeIfPresent(dateText, raw) {
    const date = String(dateText || '').trim();
    if (!date) return '';
    const time = formatTimeFromRaw(raw);
    return time ? `${date} ${time}` : date;
}

function parseDateToken(text, options = {}) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const iso = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (iso) return appendTimeIfPresent(iso[1], raw);
    const compact = raw.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
    if (compact) return appendTimeIfPresent(`${compact[1]}-${compact[2]}-${compact[3]}`, raw);
    const slash = raw.match(/\b(\d{1,2})[./](\d{1,2})\b/);
    if (slash) {
        const year = tokyoDate(options.now).slice(0, 4);
        return appendTimeIfPresent(`${year}-${String(slash[1]).padStart(2, '0')}-${String(slash[2]).padStart(2, '0')}`, raw);
    }
    const korean = raw.match(/(?:(20\d{2})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    if (korean) {
        const year = korean[1] || tokyoDate(options.now).slice(0, 4);
        return appendTimeIfPresent(`${year}-${String(korean[2]).padStart(2, '0')}-${String(korean[3]).padStart(2, '0')}`, raw);
    }
    const today = tokyoDate(options.now);
    if (/오늘/.test(raw)) return appendTimeIfPresent(today, raw);
    if (/내일/.test(raw)) return appendTimeIfPresent(addDays(today, 1), raw);
    if (/모레/.test(raw)) return appendTimeIfPresent(addDays(today, 2), raw);
    if (/다음\s*주|next\s*week/i.test(raw)) return appendTimeIfPresent(addDays(today, 7), raw);
    if (/이번\s*주|this\s*week/i.test(raw)) return appendTimeIfPresent(addDays(today, 7), raw);
    return '';
}

function parseTags(text) {
    return (String(text || '').match(/#[^\s#]+/g) || [])
        .map((v) => v.replace(/^#/, '').trim())
        .filter(Boolean);
}

function parseAddCommand(raw) {
    const fields = parseKeyValueFields(raw);
    const companyName = firstField(fields, ['회사명', '회사', 'company']);
    const title = firstField(fields, ['포지션', '직무', 'role', 'position', 'title']) || '미정 포지션';
    if (!companyName) return null;

    return {
        action: 'add',
        company: {
            name: companyName,
            website: firstField(fields, ['링크', 'url']).match(/^https?:\/\//i) ? firstField(fields, ['링크', 'url']) : '',
            location: firstField(fields, ['위치', '지역', 'location']),
            workMode: firstField(fields, ['근무형태', 'work_mode']),
        },
        opportunity: {
            title,
            jdUrl: firstField(fields, ['jd_url']) || (firstField(fields, ['링크', 'url']).match(/^https?:\/\//i) ? firstField(fields, ['링크', 'url']) : ''),
            techStack: firstField(fields, ['스택', '기술스택', 'tech_stack']),
            location: firstField(fields, ['위치', '지역', 'location']),
            source: firstField(fields, ['source', '출처']),
            fitScore: parseScore(firstField(fields, ['fit_score', 'fit'])),
            interestScore: parseScore(firstField(fields, ['interest_score', 'interest'])),
            passProbability: parseScore(firstField(fields, ['pass_probability', '확률'])),
            priority: parseScore(firstField(fields, ['priority', '우선순위'])),
        },
        stage: jobs.normalizeStage(firstField(fields, ['단계', 'stage'])) || 'wishlist',
        nextActionTitle: firstField(fields, ['면접일', 'interview_at'])
            ? actionTitleForStage(jobs.normalizeStage(firstField(fields, ['단계', 'stage'])) || 'interview_1')
            : '',
        dueAt: parseDateToken(firstField(fields, ['면접일', 'interview_at']), {}),
    };
}

function parseStageCommand(raw) {
    const explicit = raw.match(/^(.+?)\s+(?:현재\s*)?단계\s*(?:를|을|은|는|=|:)?\s*([a-z0-9_가-힣]+)\s*(?:로|으로)?\s*(?:변경|업데이트|수정)?$/i);
    if (explicit) {
        return {
            action: 'stage',
            token: normalize(explicit[1]),
            stage: normalize(explicit[2]).replace(/(?:으로|로)$/i, ''),
        };
    }
    const fields = parseKeyValueFields(raw);
    const stage = jobs.normalizeStage(firstField(fields, ['단계', 'stage']));
    if (stage) {
        const token = raw.slice(0, raw.search(/(단계|stage)\s*[=:]/i)).trim();
        if (token) return { action: 'stage', token, stage };
    }
    return null;
}

function parseNextActionCommand(raw, options = {}) {
    const fields = parseKeyValueFields(raw);
    const keyedTitle = firstField(fields, ['다음액션', 'next_action', '액션']);
    if (keyedTitle) {
        const token = raw.slice(0, raw.search(/(다음액션|next_action|액션)\s*[=:]/i)).trim();
        return {
            action: 'next_action',
            token: token || firstField(fields, ['회사', '회사명', 'company']),
            title: keyedTitle,
            dueAt: parseDateToken(firstField(fields, ['마감', 'due']) || raw, options),
            priority: parseScore(firstField(fields, ['priority', '우선순위'])),
        };
    }
    const m = raw.match(/^(.+?)\s+(?:다음\s*액션|다음액션|next\s*action)\s*(?:=|:|은|는)?\s*(.+)$/i);
    if (!m) return null;
    return {
        action: 'next_action',
        token: normalize(m[1]),
        title: normalize(m[2].replace(/(?:마감|due)\s*[=:]\s*\S+/i, '')),
        dueAt: parseDateToken(m[2], options),
    };
}

function parseNoteCommand(raw) {
    const lead = raw.match(/^(?:리크루터\s*)?메모\s*(?:저장|추가)?\s+(\S+)\s+(.+)$/i);
    if (lead) {
        return {
            action: 'note',
            token: normalize(lead[1]),
            content: normalize(lead[2]),
            eventType: /리크루터/i.test(raw) ? 'recruiter_note' : 'note',
        };
    }
    const tail = raw.match(/^(.+?)\s+메모\s*(?:저장|추가)?\s+(.+)$/i);
    if (tail) {
        return {
            action: 'note',
            token: normalize(tail[1]),
            content: normalize(tail[2]),
            eventType: 'note',
        };
    }
    return null;
}

function parseContactCommand(raw) {
    const m = raw.match(/^(?:연락처|컨택트|담당자)\s*(?:추가|저장)?\s+(\S+)\s+(.+)$/i);
    if (!m) return null;
    const body = normalize(m[2]);
    const fields = parseKeyValueFields(body);
    return {
        action: 'contact',
        token: normalize(m[1]),
        name: firstField(fields, ['담당자', '리크루터', 'recruiter']) || body.split(/\s+/)[0],
        role: /hiring|채용|매니저|manager/i.test(body) ? 'hiring_manager' : 'recruiter',
        channel: /linkedin|링크드인/i.test(body) ? 'linkedin' : '',
        contactUrlOrEmail: (body.match(/https?:\/\/\S+|[^\s@]+@[^\s@]+\.[^\s@]+/i) || [''])[0],
        notes: body,
    };
}

function stripCompanyParticle(token) {
    return normalize(token)
        .replace(/(?:은|는|이|가|을|를|에서|의)$/u, '')
        .trim();
}

function inferNaturalStage(raw) {
    if (/(탈락|불합격|리젝|rejected)/i.test(raw)) return 'rejected';
    if (/(철회|withdrawn)/i.test(raw)) return 'withdrawn';
    if (/(보류|on_hold)/i.test(raw)) return 'on_hold';
    if (/(오퍼|offer|합격)/i.test(raw) && !/서류\s*합격/i.test(raw)) return 'offer';
    if (/(캐주얼\s*(면접|면담)|면담)/i.test(raw)) return 'recruiter_contact';
    if (/(최종|final)\s*면접/i.test(raw)) return 'final_interview';
    if (/(2차|second)\s*면접/i.test(raw)) return 'interview_2';
    if (/(1차|first)\s*면접/i.test(raw)) return 'interview_1';
    if (/(코딩\s*테스트|코테|과제)/i.test(raw)) return 'coding_test';
    if (/(리크루터|recruiter|채용\s*담당자).*(연락|contact)/i.test(raw)) return 'recruiter_contact';
    if (/(서류|screening).*(통과|합격|검토|대기)/i.test(raw)) return 'screening';
    if (/(지원\s*완료|지원했|applied)/i.test(raw)) return 'applied';
    return '';
}

function actionTitleForStage(stage) {
    const titles = {
        recruiter_contact: '리크루터 연락',
        screening: '서류 진행 확인',
        coding_test: '코딩 테스트',
        interview_1: '1차 면접',
        interview_2: '2차 면접',
        final_interview: '최종 면접',
        offer: '오퍼 확인',
        rejected: '결과 정리',
        withdrawn: '철회 정리',
        on_hold: '보류 상태 확인',
    };
    return titles[stage] || '지원 상태 확인';
}

function actionTitleFromText(raw, stage) {
    if (/캐주얼\s*면담/i.test(raw)) return '캐주얼 면담';
    if (/캐주얼\s*면접/i.test(raw)) return '캐주얼 면접';
    return actionTitleForStage(stage);
}

function buildNaturalProcessNote(raw, stage, dueAt) {
    const parts = [];
    if (/서류\s*(통과|합격)/i.test(raw)) parts.push('서류 통과');
    if (dueAt && /(면접|면담)/i.test(raw)) parts.push(`${actionTitleFromText(raw, stage)} 일정은 ${dueAt}`);
    if (/(대기중|대기\s*중|대기)/i.test(raw) && !parts.some((part) => /대기/.test(part))) {
        parts.push(`${actionTitleFromText(raw, stage)} 대기중`);
    }
    const source = extractContactSource(raw);
    if (source) parts.push(`${source}로 연락중`);
    return parts.length ? parts.join(', ') : normalize(raw);
}

function extractContactSource(raw) {
    const text = String(raw || '');
    const scoped = text.match(/여기는\s*([^\s,，]+)\s*(?:로|으로)\s*연락\s*중/i);
    if (scoped) return normalize(scoped[1]);
    const match = text.match(/([^\s,，]+)\s*(?:로|으로)\s*연락\s*중/i);
    return match ? normalize(match[1]) : '';
}

function parseNaturalProcessUpdate(raw, options = {}) {
    if (!/(서류|면접|면담|코딩\s*테스트|코테|오퍼|탈락|불합격|보류|철회|지원\s*완료|지원했)/i.test(raw)) return null;
    const lead = raw.match(/^([^\s,，]+)\s+(.+)$/);
    if (!lead) return null;
    const token = stripCompanyParticle(lead[1]);
    const body = normalize(lead[2]);
    if (!token || !body) return null;
    if (/^(지원처|지원|채용|job|서류|면접|코테|코딩)$/i.test(token)) return null;

    const stage = inferNaturalStage(raw);
    const dueAt = parseDateToken(raw, options);
    if (!stage && !dueAt) return null;

    return {
        action: 'process_update',
        token,
        stage,
        nextActionTitle: dueAt ? actionTitleFromText(raw, stage) : '',
        dueAt,
        note: buildNaturalProcessNote(raw, stage, dueAt),
        autoCreate: true,
        source: extractContactSource(raw),
    };
}

function cleanupDatedProcessBody(body) {
    return normalize(body)
        .replace(/^(그리고|또|,|，)\s*/i, '')
        .replace(/\s*(그리고|또)\s*$/i, '')
        .replace(/\s*(있고|있어|있음|예정이야|예정|이야|야|입니다|임)\s*$/i, '')
        .trim();
}

function dueAtFromDateMatch(match, options = {}) {
    const year = match[1] || tokyoDate(options.now).slice(0, 4);
    const date = `${year}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
    const meridiem = String(match[4] || '').trim();
    let hour = match[5] == null || match[5] === '' ? null : Number(match[5]);
    const minuteRaw = match[6] || match[7] || '';
    const minute = minuteRaw === '' ? 0 : Number(minuteRaw);
    if (hour == null || !Number.isFinite(hour)) return date;
    if (meridiem === '오후' && hour < 12) hour += 12;
    if (meridiem === '오전' && hour === 12) hour = 0;
    return `${date} ${String(hour).padStart(2, '0')}:${String(Number.isFinite(minute) ? minute : 0).padStart(2, '0')}`;
}

function parseDatedProcessBody(body, dueAt) {
    const cleaned = cleanupDatedProcessBody(body);
    if (!cleaned) return null;
    const stageMatch = cleaned.match(/(캐주얼\s*(?:면접|면담)|1차\s*면접|2차\s*면접|최종\s*면접|코딩\s*테스트|코테|면접|면담|오퍼|탈락|불합격|보류|철회)/i);
    if (!stageMatch) return null;

    const token = stripCompanyParticle(cleaned.slice(0, stageMatch.index).trim());
    if (!token) return null;
    const stageText = stageMatch[0];
    const stage = inferNaturalStage(stageText) || 'recruiter_contact';
    const title = actionTitleFromText(stageText, stage);
    const source = extractContactSource(cleaned);
    const noteParts = [`${title} 일정은 ${dueAt}`];
    if (source) noteParts.push(`${source}로 연락중`);
    return {
        action: 'process_update',
        token,
        stage,
        nextActionTitle: title,
        dueAt,
        note: noteParts.join(', '),
        autoCreate: true,
        source,
    };
}

function parseDatedProcessUpdates(raw, options = {}) {
    if (!/(면접|면담|코딩\s*테스트|코테|오퍼|탈락|불합격|보류|철회)/i.test(raw)) return null;
    const dateRe = /(?:(20\d{2})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*(?:(오전|오후)?\s*(\d{1,2})(?::(\d{2})|\s*시(?:\s*(\d{1,2})\s*분?)?)?)?\s*(?:에|에는|까지|로)?/gi;
    const matches = [];
    let match;
    while ((match = dateRe.exec(raw)) != null) {
        matches.push({
            match,
            start: match.index,
            end: dateRe.lastIndex,
            dueAt: dueAtFromDateMatch(match, options),
        });
    }
    if (!matches.length) return null;

    const items = [];
    for (let i = 0; i < matches.length; i += 1) {
        const cur = matches[i];
        const next = matches[i + 1];
        const body = raw.slice(cur.end, next ? next.start : raw.length);
        const item = parseDatedProcessBody(body, cur.dueAt);
        if (item) items.push(item);
    }
    if (items.length === 0) return null;
    return items.length === 1 ? items[0] : { action: 'bulk_process_update', items };
}

function parseCommand(payload, options = {}) {
    const raw = stripLead(payload);
    if (!raw) return { action: 'empty' };

    if (/^(도움말|help)$/i.test(raw)) return { action: 'help' };
    if (/(주간\s*요약|주간요약|weekly\s*summary)/i.test(raw)) return { action: 'weekly_summary' };
    if (/(이번\s*주|this\s*week|오늘).*(팔로업|follow.?up|액션|할\s*일|마감)|^(팔로업|액션)\s*(오늘|이번\s*주|목록)?/i.test(raw)) {
        return { action: 'pending', range: /오늘/.test(raw) ? 'today' : 'week' };
    }
    if (/^(목록|리스트|파이프라인|현황|list|status)(?:\s|$)/i.test(raw)) return { action: 'list' };

    const search = raw.match(/^(검색|찾아|search)\s+(.+)$/i);
    if (search) return { action: 'search', query: normalize(search[2]) };

    const detail = raw.match(/^(상세|보기|summary|detail)\s+(.+)$/i);
    if (detail) return { action: 'detail', token: normalize(detail[2]) };

    const datedUpdates = parseDatedProcessUpdates(raw, options);
    if (datedUpdates) return datedUpdates;

    const add = /^(추가|등록|add)\b/i.test(raw) || /회사(?:명)?\s*[=:]/i.test(raw)
        ? parseAddCommand(raw)
        : null;
    if (add) return add;

    return parseStageCommand(raw)
        || parseNextActionCommand(raw, options)
        || parseNoteCommand(raw)
        || parseContactCommand(raw)
        || parseNaturalProcessUpdate(raw, options)
        || { action: 'unknown', raw };
}

function formatOpportunityLine(row) {
    const stage = row.current_stage || 'wishlist';
    const next = row.next_action_title || row.next_action_at
        ? ` / 다음: ${row.next_action_title || '-'}${row.next_action_at ? ` (${row.next_action_at})` : ''}`
        : '';
    return `- #${row.opportunity_id} ${row.company_name} / ${row.title} [${stage}]${next}`;
}

function buildListReply(rows) {
    const lines = ['지원 파이프라인'];
    if (!rows.length) {
        lines.push('- 아직 기록이 없어.');
        return lines.join('\n');
    }
    let currentStage = '';
    for (const row of rows) {
        const stage = row.current_stage || 'wishlist';
        if (stage !== currentStage) {
            currentStage = stage;
            lines.push(`[${stage}]`);
        }
        lines.push(formatOpportunityLine(row));
    }
    return lines.join('\n');
}

function buildPendingReply(rows, range) {
    const title = range === 'today' ? '오늘 확인할 지원 액션' : '이번 주까지 확인할 지원 액션';
    if (!rows.length) return `${title}\n- 없음`;
    return [
        title,
        ...rows.map((row) => `- ${row.due_at || '-'} #${row.id} ${row.company_name} / ${row.opportunity_title}: ${row.title}`),
    ].join('\n');
}

function buildDetailReply(payload) {
    const d = payload.detail;
    const lines = [
        `${d.company_name} / ${d.title}`,
        `- 단계: ${d.current_stage || 'wishlist'}`,
        `- 상태: ${d.status || 'active'}`,
        `- 기술/위치: ${d.tech_stack || '-'} / ${d.opportunity_location || d.company_location || '-'}`,
        `- 링크: ${d.jd_url || d.company_website || '-'}`,
    ];
    const openAction = (payload.actions || []).find((row) => row.status === 'open');
    if (openAction) lines.push(`- 다음 액션: ${openAction.title}${openAction.due_at ? ` (${openAction.due_at})` : ''}`);
    if (payload.contacts && payload.contacts.length) {
        lines.push(`- 연락처: ${payload.contacts.slice(0, 3).map((row) => row.name || row.role || '담당자').join(', ')}`);
    }
    if (payload.timeline && payload.timeline.length) {
        lines.push('- 최근 타임라인:');
        lines.push(...payload.timeline.slice(0, 5).map((row) => `  - ${String(row.event_at || '').slice(0, 10)} ${row.summary}`));
    }
    return lines.join('\n');
}

function buildWeeklySummaryReply(summary) {
    const stageText = summary.byStage.length
        ? summary.byStage.map((row) => `${row.current_stage}:${row.count}`).join(', ')
        : '-';
    const lines = [
        `지원 주간 요약 (${summary.since} ~ ${summary.today})`,
        `- 전체 단계 분포: ${stageText}`,
        `- 최근 7일 기록: ${summary.changedCount}건`,
        `- 이번 주 액션: ${summary.pending.length}건`,
    ];
    if (summary.pending.length) {
        lines.push(...summary.pending.slice(0, 5).map((row) => `  - ${row.due_at || '-'} ${row.company_name}: ${row.title}`));
    }
    if (summary.stageChanges.length) {
        lines.push('- 단계 변경:');
        lines.push(...summary.stageChanges.map((row) => `  - ${row.company_name} / ${row.title}: ${row.summary}`));
    }
    return lines.join('\n');
}

function buildHelpReply() {
    return [
        '지원 파이프라인 사용 예시',
        '- 지원처 추가 회사명=OOO 포지션=Backend Engineer 링크=https://...',
        '- OOO 현재 단계 interview_1로 변경',
        '- 리크루터 메모 저장 OOO 다음 주에 답장 필요',
        '- OOO 다음액션=포트폴리오 보내기 마감=2026-05-03',
        '- 지원: 목록 / 지원: 검색 react / 지원: 상세 OOO / 지원: 주간요약',
    ].join('\n');
}

function mutationDedupeMaterial(parsed) {
    if (parsed.action === 'bulk_process_update') {
        return `job:${parsed.action}:${JSON.stringify(parsed.items || [])}`;
    }
    return `job:${parsed.action}:${parsed.token || ''}:${parsed.query || ''}:${parsed.stage || ''}:${parsed.company && parsed.company.name || ''}:${parsed.opportunity && parsed.opportunity.title || ''}:${parsed.title || parsed.nextActionTitle || ''}:${parsed.dueAt || ''}:${parsed.content || parsed.note || ''}`;
}

function applyProcessUpdate(parsed, event, payload, options = {}) {
    let target = jobs.resolveOpportunity(parsed.token, options);
    let stageResult = null;
    if (!target && parsed.autoCreate) {
        const created = jobs.createApplication({
            eventId: event.eventId,
            rawText: payload,
            company: { name: parsed.token },
            opportunity: {
                title: '미정 포지션',
                source: parsed.source,
            },
            stage: parsed.stage || 'wishlist',
            ownerNote: parsed.note,
        }, options);
        target = created.detail;
        stageResult = { process: created.process, detail: created.detail, created: true };
    }
    if (!target) return null;

    if (parsed.stage && !stageResult) {
        stageResult = jobs.updateStage({
            eventId: event.eventId,
            rawText: payload,
            token: parsed.token,
            stage: parsed.stage,
            note: parsed.note,
        }, options);
        if (!stageResult) return null;
    }

    let actionResult = null;
    if (parsed.nextActionTitle && parsed.dueAt) {
        actionResult = jobs.setNextAction({
            eventId: event.eventId,
            rawText: payload,
            token: parsed.token,
            title: parsed.nextActionTitle,
            dueAt: parsed.dueAt,
        }, options);
        if (!actionResult) return null;
    }

    let noteResult = null;
    if (parsed.note) {
        noteResult = jobs.recordNote({
            eventId: event.eventId,
            rawText: payload,
            token: parsed.token,
            content: parsed.note,
            eventType: 'process_note',
            tags: parseTags(parsed.note),
        }, options);
        if (!noteResult) return null;
    }

    const detail = (actionResult && actionResult.detail)
        || (stageResult && stageResult.detail)
        || (noteResult && noteResult.detail)
        || target;
    return { stage: stageResult, nextAction: actionResult, note: noteResult, detail };
}

async function handleJobPipelineCommand(payload, options = {}) {
    const parsed = parseCommand(payload, options);
    if (parsed.action === 'empty') {
        return {
            route: 'job',
            success: false,
            action: 'error',
            telegramReply: '지원 파이프라인 입력이 비어있어. 예: 지원처 추가 회사명=OOO 포지션=Backend Engineer',
        };
    }
    if (parsed.action === 'help') {
        return { route: 'job', success: true, action: 'help', telegramReply: buildHelpReply() };
    }
    if (parsed.action === 'list') {
        const rows = jobs.listPipeline(options);
        return { route: 'job', success: true, action: 'list', rows, telegramReply: buildListReply(rows) };
    }
    if (parsed.action === 'pending') {
        const rows = jobs.listPendingActions(parsed.range, options);
        return { route: 'job', success: true, action: 'pending', rows, telegramReply: buildPendingReply(rows, parsed.range) };
    }
    if (parsed.action === 'search') {
        const rows = jobs.searchPipeline(parsed.query, options);
        return {
            route: 'job',
            success: true,
            action: 'search',
            rows,
            telegramReply: rows.length ? ['지원 검색 결과', ...rows.map(formatOpportunityLine)].join('\n') : '지원 검색 결과\n- 없음',
        };
    }
    if (parsed.action === 'detail') {
        const detail = jobs.getDetail(parsed.token, options);
        return detail
            ? { route: 'job', success: true, action: 'detail', detail, telegramReply: buildDetailReply(detail) }
            : { route: 'job', success: false, action: 'not_found', telegramReply: `지원 기록을 찾지 못했어: ${parsed.token}` };
    }
    if (parsed.action === 'weekly_summary') {
        const summary = jobs.buildWeeklySummary(options);
        return { route: 'job', success: true, action: 'weekly_summary', summary, telegramReply: buildWeeklySummaryReply(summary) };
    }
    if (!['add', 'stage', 'note', 'next_action', 'contact', 'process_update', 'bulk_process_update'].includes(parsed.action)) {
        return {
            route: 'job',
            success: false,
            action: 'unknown',
            telegramReply: '지원 명령을 알아듣지 못했어. 예: 지원: 도움말',
        };
    }

    const event = personalStorage.createEvent({
        route: 'job',
        source: options.source || 'telegram',
        rawText: payload,
        normalizedText: normalize(payload),
        payload: parsed,
        dedupeMaterial: mutationDedupeMaterial(parsed),
    }, options);

    if (event.duplicate) {
        return {
            route: 'job',
            success: true,
            action: 'duplicate',
            eventId: event.eventId,
            duplicate: true,
            telegramReply: '같은 지원 파이프라인 요청이 이미 처리되어 중복 저장을 건너뛰었어.',
        };
    }

    try {
        if (parsed.action === 'add') {
            const result = jobs.createApplication({
                eventId: event.eventId,
                rawText: payload,
                company: parsed.company,
                opportunity: parsed.opportunity,
                stage: parsed.stage,
            }, options);
            return {
                route: 'job',
                success: true,
                action: 'add',
                eventId: event.eventId,
                entityId: result.opportunity && result.opportunity.id,
                result,
                telegramReply: [
                    '지원처 추가 완료',
                    `- 회사: ${result.company.name}`,
                    `- 포지션: ${result.opportunity.title}`,
                    `- 단계: ${result.process.current_stage}`,
                ].join('\n'),
            };
        }
        if (parsed.action === 'bulk_process_update') {
            const results = [];
            for (const item of parsed.items || []) {
                const result = applyProcessUpdate(item, event, payload, options);
                if (!result) {
                    return { route: 'job', success: false, action: 'not_found', telegramReply: `지원 기록을 찾지 못했어: ${item.token}` };
                }
                results.push({ item, result });
            }
            return {
                route: 'job',
                success: true,
                action: 'bulk_process_update',
                eventId: event.eventId,
                result: results,
                telegramReply: [
                    `지원 일정 ${results.length}건 반영 완료`,
                    ...results.map(({ item }) => `- ${item.token}: ${item.nextActionTitle || actionTitleForStage(item.stage)}${item.dueAt ? ` / ${item.dueAt}` : ''}`),
                ].join('\n'),
            };
        }
        if (parsed.action === 'stage') {
            const result = jobs.updateStage({
                eventId: event.eventId,
                rawText: payload,
                token: parsed.token,
                stage: parsed.stage,
            }, options);
            if (!result) {
                return { route: 'job', success: false, action: 'not_found', telegramReply: `지원 기록을 찾지 못했어: ${parsed.token}` };
            }
            return {
                route: 'job',
                success: true,
                action: 'stage',
                eventId: event.eventId,
                entityId: result.detail && result.detail.opportunity_id,
                result,
                telegramReply: `${result.detail.company_name} 단계 변경 완료: ${result.detail.current_stage}`,
            };
        }
        if (parsed.action === 'note') {
            const result = jobs.recordNote({
                eventId: event.eventId,
                rawText: payload,
                token: parsed.token,
                content: parsed.content,
                eventType: parsed.eventType,
                tags: parseTags(parsed.content),
            }, options);
            if (!result) return { route: 'job', success: false, action: 'not_found', telegramReply: `지원 기록을 찾지 못했어: ${parsed.token}` };
            return {
                route: 'job',
                success: true,
                action: 'note',
                eventId: event.eventId,
                entityId: result.note && result.note.id,
                result,
                telegramReply: `${result.detail.company_name} 메모 저장 완료`,
            };
        }
        if (parsed.action === 'next_action') {
            const result = jobs.setNextAction({
                eventId: event.eventId,
                rawText: payload,
                token: parsed.token,
                title: parsed.title,
                dueAt: parsed.dueAt,
                priority: parsed.priority,
            }, options);
            if (!result) return { route: 'job', success: false, action: 'not_found', telegramReply: `지원 기록을 찾지 못했어: ${parsed.token}` };
            return {
                route: 'job',
                success: true,
                action: 'next_action',
                eventId: event.eventId,
                entityId: result.action && result.action.id,
                result,
                telegramReply: `${result.detail.company_name} 다음 액션 저장 완료: ${result.action.title}${result.action.due_at ? ` (${result.action.due_at})` : ''}`,
            };
        }
        if (parsed.action === 'contact') {
            const result = jobs.recordContact({
                eventId: event.eventId,
                rawText: payload,
                token: parsed.token,
                name: parsed.name,
                role: parsed.role,
                channel: parsed.channel,
                contactUrlOrEmail: parsed.contactUrlOrEmail,
                notes: parsed.notes,
            }, options);
            if (!result) return { route: 'job', success: false, action: 'not_found', telegramReply: `지원 기록을 찾지 못했어: ${parsed.token}` };
            return {
                route: 'job',
                success: true,
                action: 'contact',
                eventId: event.eventId,
                entityId: result.contact && result.contact.id,
                result,
                telegramReply: `${result.detail.company_name} 연락처 저장 완료: ${result.contact.name || result.contact.role || '담당자'}`,
            };
        }
        if (parsed.action === 'process_update') {
            const result = applyProcessUpdate(parsed, event, payload, options);
            if (!result) return { route: 'job', success: false, action: 'not_found', telegramReply: `지원 기록을 찾지 못했어: ${parsed.token}` };
            const detail = result.detail;
            const lines = [`${detail.company_name} 반영 완료`];
            if (parsed.stage) lines.push(`- 단계: ${parsed.stage}`);
            if (parsed.nextActionTitle && parsed.dueAt) lines.push(`- 다음 액션: ${parsed.nextActionTitle} / ${parsed.dueAt}`);
            if (parsed.note) lines.push(`- 메모: ${parsed.note}`);
            return {
                route: 'job',
                success: true,
                action: 'process_update',
                eventId: event.eventId,
                entityId: detail && detail.opportunity_id,
                result,
                telegramReply: lines.join('\n'),
            };
        }
    } catch (error) {
        personalStorage.markEventFailed(event.eventId, error && error.message ? error.message : String(error), options);
        return {
            route: 'job',
            success: false,
            action: 'failed',
            eventId: event.eventId,
            telegramReply: `지원 파이프라인 처리 실패: ${error && error.message ? error.message : error}`,
        };
    }

    return {
        route: 'job',
        success: false,
        action: 'unsupported',
        eventId: event.eventId,
        telegramReply: `지원하지 않는 지원 명령: ${parsed.action}`,
    };
}

module.exports = {
    parseCommand,
    handleJobPipelineCommand,
};
