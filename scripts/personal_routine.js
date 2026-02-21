const storage = require('./personal_storage');

function normalize(text) {
    return storage.normalizeSpace(text);
}

function parseCommand(payload) {
    const raw = normalize(payload);
    if (!raw) return { action: 'empty', target: '', note: '' };

    if (/^(목록|리스트|list|status)(?:\s|$)/i.test(raw)) return { action: 'list', target: '', note: '' };
    if (/^(통계|요약|summary)(?:\s|$)/i.test(raw)) return { action: 'summary', target: '', note: '' };
    if (/^(오늘|today)(?:\s|$)/i.test(raw)) return { action: 'today', target: '', note: '' };

    const add = raw.match(/^(등록|추가|add)\s+(.+)$/i);
    if (add) return { action: 'add', target: normalize(add[2]), note: '' };

    const on = raw.match(/^(활성|켜|on|enable)\s+(.+)$/i);
    if (on) return { action: 'activate', target: normalize(on[2]), note: '' };

    const off = raw.match(/^(비활성|중지|off|disable)\s+(.+)$/i);
    if (off) return { action: 'deactivate', target: normalize(off[2]), note: '' };

    const check = raw.match(/^(체크|완료|check|done)\s*(.*)$/i);
    if (check) {
        return {
            action: 'checkin',
            target: normalize(check[2] || ''),
            note: '',
        };
    }

    return { action: 'checkin', target: raw, note: '' };
}

function formatTemplateRow(row) {
    return `- #${row.id} [${row.active ? 'on' : 'off'}] ${row.name}`;
}

function resolveTemplateToken(token, options = {}) {
    const raw = String(token || '').trim();
    if (!raw) return null;
    return storage.findRoutineTemplate(raw, options);
}

function buildSummaryReply(summary, templates) {
    return [
        '루틴 통계',
        `- 체크인: ${Number(summary.totals && summary.totals.checkins || 0)}회`,
        `- 활동일: ${Number(summary.totals && summary.totals.active_days || 0)}일`,
        `- 템플릿 수: ${templates.length}개`,
        `- 상위 루틴: ${Array.isArray(summary.byTemplate) && summary.byTemplate.length ? summary.byTemplate.map((x) => `${x.name} ${x.count}회`).join(', ') : '-'}`,
    ].join('\n');
}

async function handleRoutineCommand(payload, options = {}) {
    const parsed = parseCommand(payload);
    if (parsed.action === 'empty') {
        return {
            route: 'routine',
            success: false,
            action: 'error',
            telegramReply: '루틴 입력이 비어있어. 예: 루틴: 등록 아침 스트레칭',
        };
    }

    if (parsed.action === 'list') {
        const templates = storage.listRoutineTemplates(options);
        return {
            route: 'routine',
            success: true,
            action: 'list',
            templates,
            telegramReply: [
                '루틴 템플릿 목록',
                ...(templates.length ? templates.map(formatTemplateRow) : ['- (비어있음)']),
                '명령 예시: 루틴: 등록 물 2L / 루틴: 체크 물 2L',
            ].join('\n'),
        };
    }

    if (parsed.action === 'summary' || parsed.action === 'today') {
        const month = parsed.action === 'today' ? storage.toIsoDate().slice(0, 7) : '';
        const summary = storage.summarizeRoutine({ ...options, month });
        const templates = storage.listRoutineTemplates(options);
        return {
            route: 'routine',
            success: true,
            action: parsed.action,
            summary,
            telegramReply: buildSummaryReply(summary, templates),
        };
    }

    const event = storage.createEvent({
        route: 'routine',
        source: options.source || 'telegram',
        rawText: payload,
        normalizedText: normalize(payload),
        payload: parsed,
        dedupeMaterial: `routine:${parsed.action}:${parsed.target}`,
    }, options);

    if (event.duplicate) {
        return {
            route: 'routine',
            success: true,
            action: 'duplicate',
            eventId: event.eventId,
            duplicate: true,
            telegramReply: '같은 루틴 요청이 이미 처리되어 중복 실행을 건너뛰었어.',
        };
    }

    try {
        if (parsed.action === 'add') {
            const template = storage.upsertRoutineTemplate({
                eventId: event.eventId,
                name: parsed.target,
                active: 1,
            }, options);
            return {
                route: 'routine',
                success: true,
                action: 'add',
                eventId: event.eventId,
                entityId: template && template.id,
                template,
                telegramReply: `루틴 등록/활성화 완료: #${template.id} ${template.name}`,
            };
        }

        let template = resolveTemplateToken(parsed.target, options);
        if (!template && parsed.action === 'checkin') {
            // token 없이 체크 명령이 오면 "운동루틴" 기본 템플릿으로 보정
            if (!parsed.target) {
                template = storage.upsertRoutineTemplate({
                    eventId: event.eventId,
                    name: '운동루틴',
                    active: 1,
                }, options);
            } else {
                template = storage.upsertRoutineTemplate({
                    eventId: event.eventId,
                    name: parsed.target,
                    active: 1,
                }, options);
            }
        }

        if (!template) {
            return {
                route: 'routine',
                success: false,
                action: 'not_found',
                eventId: event.eventId,
                telegramReply: `대상 루틴을 찾지 못했어: ${parsed.target}`,
            };
        }

        if (parsed.action === 'activate' || parsed.action === 'deactivate') {
            const row = storage.setRoutineTemplateActive(template.id, parsed.action === 'activate', options);
            return {
                route: 'routine',
                success: true,
                action: parsed.action,
                eventId: event.eventId,
                entityId: row && row.id,
                template: row,
                telegramReply: `루틴 ${parsed.action === 'activate' ? '활성화' : '비활성화'} 완료: #${row.id} ${row.name}`,
            };
        }

        if (parsed.action === 'checkin') {
            const row = storage.logRoutineCheckin({
                eventId: event.eventId,
                templateId: template.id,
                status: 'done',
                note: parsed.note || null,
            }, options);
            return {
                route: 'routine',
                success: true,
                action: 'checkin',
                eventId: event.eventId,
                entityId: row && row.id,
                row,
                telegramReply: `루틴 체크인 완료: ${row.template_name} (${row.log_date})`,
            };
        }

        return {
            route: 'routine',
            success: false,
            action: 'unsupported',
            eventId: event.eventId,
            telegramReply: `지원하지 않는 루틴 명령: ${parsed.action}`,
        };
    } catch (error) {
        storage.markEventFailed(event.eventId, error && error.message ? error.message : String(error), options);
        return {
            route: 'routine',
            success: false,
            action: 'failed',
            eventId: event.eventId,
            telegramReply: `루틴 처리 실패: ${error && error.message ? error.message : error}`,
        };
    }
}

module.exports = {
    parseCommand,
    handleRoutineCommand,
};
