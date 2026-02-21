const storage = require('./personal_storage');

function normalize(text) {
    return storage.normalizeSpace(text);
}

function parseCommand(payload) {
    const raw = normalize(payload);
    if (!raw) return { action: 'empty', token: '', title: '' };

    if (/^(목록|리스트|list|status|통계|요약)(?:\s|$)/i.test(raw)) return { action: 'list', token: '', title: '' };

    const add = raw.match(/^(추가|add)\s+(.+)$/i);
    if (add) return { action: 'add', token: '', title: normalize(add[2]) };

    const done = raw.match(/^(완료|done|끝|체크)\s+(.+)$/i);
    if (done) return { action: 'done', token: normalize(done[2]), title: '' };

    const reopen = raw.match(/^(재개|다시|open)\s+(.+)$/i);
    if (reopen) return { action: 'reopen', token: normalize(reopen[2]), title: '' };

    const remove = raw.match(/^(삭제|지움|remove|drop)\s+(.+)$/i);
    if (remove) return { action: 'remove', token: normalize(remove[2]), title: '' };

    return { action: 'add', token: '', title: raw };
}

function formatTaskRow(row) {
    const due = row.due_date ? ` due:${row.due_date}` : '';
    return `- #${row.id} [${row.status}] ${row.title}${due}`;
}

function buildListReply(summary, rows) {
    const totals = summary.totals || {};
    const lines = [
        '투두 현황',
        `- open:${Number(totals.open || 0)} done:${Number(totals.done || 0)} archived:${Number(totals.archived || 0)}`,
        '- 최근 항목:',
    ];
    if (!rows.length) {
        lines.push('- (비어있음)');
    } else {
        lines.push(...rows.slice(0, 8).map(formatTaskRow));
    }
    lines.push('명령 예시: 투두: 추가 장보기 / 투두: 완료 12 / 투두: 삭제 12');
    return lines.join('\n');
}

async function handleTodoCommand(payload, options = {}) {
    const parsed = parseCommand(payload);
    if (parsed.action === 'empty') {
        return {
            route: 'todo',
            success: false,
            action: 'error',
            telegramReply: '투두 입력이 비어있어. 예: 투두: 추가 운동 가기',
        };
    }

    if (parsed.action === 'list') {
        const summary = storage.summarizeTasks(options);
        const rows = storage.listTasks({ ...options, limit: 20 });
        return {
            route: 'todo',
            success: true,
            action: 'list',
            summary,
            rows,
            telegramReply: buildListReply(summary, rows),
        };
    }

    const event = storage.createEvent({
        route: 'todo',
        source: options.source || 'telegram',
        rawText: payload,
        normalizedText: normalize(payload),
        payload: parsed,
        dedupeMaterial: `todo:${parsed.action}:${parsed.token}:${parsed.title}`,
    }, options);

    if (event.duplicate) {
        return {
            route: 'todo',
            success: true,
            action: 'duplicate',
            eventId: event.eventId,
            duplicate: true,
            telegramReply: '같은 투두 요청이 이미 처리되어 중복 저장을 건너뛰었어.',
        };
    }

    try {
        if (parsed.action === 'add') {
            const row = storage.createTask({
                eventId: event.eventId,
                title: parsed.title,
                status: 'open',
            }, options);
            const summary = storage.summarizeTasks(options);
            return {
                route: 'todo',
                success: true,
                action: 'add',
                eventId: event.eventId,
                entityId: row && row.id,
                row,
                summary,
                telegramReply: [
                    '투두 추가 완료',
                    formatTaskRow(row),
                    `- open:${Number(summary.totals && summary.totals.open || 0)}`,
                ].join('\n'),
            };
        }

        const target = storage.findTaskByToken(parsed.token, options);
        if (!target) {
            return {
                route: 'todo',
                success: false,
                action: 'not_found',
                eventId: event.eventId,
                telegramReply: `대상 투두를 찾지 못했어: ${parsed.token}`,
            };
        }

        if (parsed.action === 'done') {
            const row = storage.updateTaskStatus(target.id, 'done', options);
            return {
                route: 'todo',
                success: true,
                action: 'done',
                eventId: event.eventId,
                entityId: row && row.id,
                row,
                telegramReply: `투두 완료 처리: #${row.id} ${row.title}`,
            };
        }

        if (parsed.action === 'reopen') {
            const row = storage.updateTaskStatus(target.id, 'open', options);
            return {
                route: 'todo',
                success: true,
                action: 'reopen',
                eventId: event.eventId,
                entityId: row && row.id,
                row,
                telegramReply: `투두 재개 처리: #${row.id} ${row.title}`,
            };
        }

        if (parsed.action === 'remove') {
            const row = storage.archiveTask(target.id, options);
            return {
                route: 'todo',
                success: true,
                action: 'remove',
                eventId: event.eventId,
                entityId: row && row.id,
                row,
                telegramReply: `투두 보관 처리: #${row.id} ${row.title}`,
            };
        }

        return {
            route: 'todo',
            success: false,
            action: 'unsupported',
            eventId: event.eventId,
            telegramReply: `지원하지 않는 투두 명령: ${parsed.action}`,
        };
    } catch (error) {
        storage.markEventFailed(event.eventId, error && error.message ? error.message : String(error), options);
        return {
            route: 'todo',
            success: false,
            action: 'failed',
            eventId: event.eventId,
            telegramReply: `투두 처리 실패: ${error && error.message ? error.message : error}`,
        };
    }
}

module.exports = {
    parseCommand,
    handleTodoCommand,
};
