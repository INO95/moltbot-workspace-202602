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
    const keyRe = /(회사명|회사|company|포지션|직무|role|position|title|링크|url|jd_url|스택|기술스택|tech_stack|위치|지역|location|근무형태|work_mode|단계|stage|fit_score|fit|interest_score|interest|pass_probability|확률|priority|우선순위|다음액션|next_action|액션|마감|due|source|출처|담당자|리크루터|recruiter)\s*[=:]\s*/gi;
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

function parseDateToken(text, options = {}) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const iso = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (iso) return iso[1];
    const compact = raw.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
    if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
    const slash = raw.match(/\b(\d{1,2})[./](\d{1,2})\b/);
    if (slash) {
        const year = tokyoDate(options.now).slice(0, 4);
        return `${year}-${String(slash[1]).padStart(2, '0')}-${String(slash[2]).padStart(2, '0')}`;
    }
    const today = tokyoDate(options.now);
    if (/오늘/.test(raw)) return today;
    if (/내일/.test(raw)) return addDays(today, 1);
    if (/모레/.test(raw)) return addDays(today, 2);
    if (/다음\s*주|next\s*week/i.test(raw)) return addDays(today, 7);
    if (/이번\s*주|this\s*week/i.test(raw)) return addDays(today, 7);
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

    const add = /^(추가|등록|add)\b/i.test(raw) || /회사(?:명)?\s*[=:]/i.test(raw)
        ? parseAddCommand(raw)
        : null;
    if (add) return add;

    return parseStageCommand(raw)
        || parseNextActionCommand(raw, options)
        || parseNoteCommand(raw)
        || parseContactCommand(raw)
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
    return `job:${parsed.action}:${parsed.token || ''}:${parsed.query || ''}:${parsed.stage || ''}:${parsed.company && parsed.company.name || ''}:${parsed.opportunity && parsed.opportunity.title || ''}:${parsed.title || ''}:${parsed.content || ''}`;
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
    if (!['add', 'stage', 'note', 'next_action', 'contact'].includes(parsed.action)) {
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
