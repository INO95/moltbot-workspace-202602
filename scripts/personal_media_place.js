const storage = require('./personal_storage');

function normalize(text) {
    return storage.normalizeSpace(text);
}

function parseMonthToken(text) {
    const m = String(text || '').match(/(20\d{2}-\d{2}|20\d{2}\d{2})/);
    if (!m) return '';
    const raw = String(m[1]);
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}`;
}

function parseTags(text) {
    return (String(text || '').match(/#[^\s#]+/g) || []).map((v) => v.replace(/^#/, '').trim()).filter(Boolean);
}

function parseRating(text) {
    const m = String(text || '').match(/([0-5](?:\.\d+)?)\s*점/);
    if (!m) return null;
    const value = Number(m[1]);
    return Number.isFinite(value) ? value : null;
}

function inferStatus(text, kind) {
    const raw = String(text || '');
    if (kind === 'place') {
        if (/(가고싶|가고 싶|찜|wishlist)/i.test(raw)) return 'wishlist';
        if (/(방문|다녀옴|다녀왔|갔다|후기)/i.test(raw)) return 'visited';
        return 'noted';
    }

    if (/(보고싶|보고 싶|찜|wishlist)/i.test(raw)) return 'wishlist';
    if (/(봤음|봄|완주|시청완료|후기)/i.test(raw)) return 'watched';
    return 'noted';
}

function cleanTitle(text) {
    return String(text || '')
        .replace(/^(콘텐츠|식당)\s*[:：]?\s*/i, '')
        .replace(/([0-5](?:\.\d+)?)\s*점/g, ' ')
        .replace(/#[^\s#]+/g, ' ')
        .replace(/\b(봤음|봄|완주|시청완료|후기|가고싶|가고\s*싶|찜|방문|다녀옴|다녀왔|갔다)\b/ig, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isSummaryCommand(text) {
    return /^(통계|요약|summary|status)(?:\s|$)/i.test(String(text || '').trim());
}

function isListCommand(text) {
    return /^(목록|리스트|list|history|내역)(?:\s|$)/i.test(String(text || '').trim());
}

function formatRows(rows) {
    if (!rows.length) return '- 항목 없음';
    return rows.slice(0, 8).map((row) => {
        const rating = row.rating == null ? '-' : `${row.rating}점`;
        return `- #${row.id} [${row.status || 'noted'}] ${row.title} (${rating})`;
    }).join('\n');
}

async function handleMediaPlaceCommand(payload, options = {}) {
    const raw = normalize(payload);
    const kind = String(options.kind || 'media').trim().toLowerCase();
    const route = kind === 'place' ? 'place' : 'media';

    if (!raw) {
        return {
            route,
            success: false,
            action: 'error',
            telegramReply: kind === 'place'
                ? '식당 입력이 비어있어. 예: 식당: 라멘집 가고싶음 #도쿄'
                : '콘텐츠 입력이 비어있어. 예: 콘텐츠: 듄2 봤음 4.5점',
        };
    }

    const month = parseMonthToken(raw);
    if (isSummaryCommand(raw)) {
        const summary = storage.summarizeMediaPlace(kind, options);
        return {
            route,
            success: true,
            action: 'summary',
            summary,
            telegramReply: [
                kind === 'place' ? '식당 통계' : '콘텐츠 통계',
                `- 항목 수: ${Number(summary.totals && summary.totals.count || 0)}개`,
                `- 평균 평점: ${summary.totals && summary.totals.avg_rating == null ? '-' : Number(summary.totals.avg_rating).toFixed(2)}`,
                `- 상태 분포: ${summary.byStatus && summary.byStatus.length ? summary.byStatus.map((x) => `${x.status} ${x.count}`).join(', ') : '-'}`,
                month ? `- 조회 월: ${month}` : '',
            ].filter(Boolean).join('\n'),
        };
    }

    if (isListCommand(raw)) {
        const rows = storage.listMediaPlace(kind, { ...options, limit: 20 });
        return {
            route,
            success: true,
            action: 'list',
            rows,
            telegramReply: [
                kind === 'place' ? '식당 최근 기록' : '콘텐츠 최근 기록',
                formatRows(rows),
            ].join('\n'),
        };
    }

    const rating = parseRating(raw);
    const tags = parseTags(raw);
    const status = inferStatus(raw, kind);
    const title = cleanTitle(raw);

    if (!title) {
        return {
            route,
            success: false,
            action: 'parse_error',
            telegramReply: kind === 'place'
                ? '식당명을 인식하지 못했어. 예: 식당: 모토무라 규카츠 가고싶음'
                : '콘텐츠 제목을 인식하지 못했어. 예: 콘텐츠: 더 베어 시즌3 완주',
        };
    }

    const event = storage.createEvent({
        route,
        source: options.source || 'telegram',
        rawText: payload,
        normalizedText: raw,
        payload: { kind, title, status, rating, tags },
        dedupeMaterial: `${kind}:${title}:${status}:${rating || 'na'}:${tags.join('|')}`,
    }, options);

    if (event.duplicate) {
        return {
            route,
            success: true,
            action: 'duplicate',
            eventId: event.eventId,
            duplicate: true,
            telegramReply: '같은 항목이 이미 기록되어 중복 저장을 건너뛰었어.',
        };
    }

    try {
        const row = storage.recordMediaPlace({
            eventId: event.eventId,
            kind,
            title,
            status,
            rating,
            memo: raw,
            tags,
        }, options);

        return {
            route,
            success: true,
            action: 'record',
            eventId: event.eventId,
            entityId: row && row.id,
            row,
            telegramReply: [
                kind === 'place' ? '식당 기록 완료' : '콘텐츠 기록 완료',
                `- 제목: ${row.title}`,
                `- 상태: ${row.status || '-'}`,
                `- 평점: ${row.rating == null ? '-' : `${row.rating}점`}`,
                `- 태그: ${tags.length ? tags.join(', ') : '-'}`,
            ].join('\n'),
        };
    } catch (error) {
        storage.markEventFailed(event.eventId, error && error.message ? error.message : String(error), options);
        return {
            route,
            success: false,
            action: 'failed',
            eventId: event.eventId,
            telegramReply: `${kind === 'place' ? '식당' : '콘텐츠'} 기록 실패: ${error && error.message ? error.message : error}`,
        };
    }
}

module.exports = {
    handleMediaPlaceCommand,
};
