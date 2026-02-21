const storage = require('./personal_storage');

function normalize(text) {
    return storage.normalizeSpace(text);
}

function detectWorkoutType(text) {
    const raw = String(text || '');
    const rules = [
        { re: /(러닝|달리기|런닝|run)/i, type: '러닝' },
        { re: /(걷기|산책|walk)/i, type: '걷기' },
        { re: /(상체|push|벤치|가슴)/i, type: '상체' },
        { re: /(하체|스쿼트|leg)/i, type: '하체' },
        { re: /(당기기|등운동|pull)/i, type: '당기기' },
        { re: /(전신|full body)/i, type: '전신' },
        { re: /(요가|스트레칭)/i, type: '요가/스트레칭' },
        { re: /(사이클|자전거|cycle)/i, type: '사이클' },
        { re: /(수영|swim)/i, type: '수영' },
    ];
    for (const row of rules) {
        if (row.re.test(raw)) return row.type;
    }
    return '기타운동';
}

function detectIntensity(text) {
    const raw = String(text || '');
    if (/(고강도|빡셈|hard|intense)/i.test(raw)) return 'high';
    if (/(저강도|가볍게|light)/i.test(raw)) return 'low';
    return 'medium';
}

function parseMetrics(text) {
    const raw = String(text || '');
    const duration = raw.match(/(\d{1,4})\s*(분|min)/i);
    const calories = raw.match(/(\d{2,5})\s*(kcal|칼로리)/i);
    const distance = raw.match(/(\d+(?:\.\d+)?)\s*(km|킬로)/i);

    return {
        durationMin: duration ? Number(duration[1]) : null,
        calories: calories ? Number(calories[1]) : null,
        distanceKm: distance ? Number(distance[1]) : null,
    };
}

function parseMonthToken(text) {
    const m = String(text || '').match(/(20\d{2}-\d{2}|20\d{2}\d{2})/);
    if (!m) return '';
    const raw = String(m[1]);
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}`;
}

function isSummaryCommand(text) {
    return /^(통계|요약|summary|status)(?:\s|$)/i.test(String(text || '').trim());
}

function isListCommand(text) {
    return /^(목록|내역|list|history)(?:\s|$)/i.test(String(text || '').trim());
}

function formatRecent(rows) {
    if (!rows.length) return '- 최근 운동 없음';
    return rows.slice(0, 6).map((row) => {
        const dur = row.duration_min == null ? '-' : `${row.duration_min}분`;
        const dist = row.distance_km == null ? '-' : `${row.distance_km}km`;
        return `- #${row.id} ${row.workout_date} ${row.workout_type} | ${dur} | ${dist}`;
    }).join('\n');
}

async function maybeAutoCheckinRoutine(eventId, text, options = {}) {
    const templates = storage.listRoutineTemplates({ ...options, onlyActive: true });
    const target = templates.find((row) => /(운동|러닝|헬스)/i.test(row.name));
    if (!target) return null;
    if (!/(운동|러닝|헬스|run|workout)/i.test(String(text || ''))) return null;

    return storage.logRoutineCheckin({
        eventId,
        templateId: target.id,
        status: 'done',
        note: 'workout-auto-checkin',
    }, options);
}

async function handleWorkoutCommand(payload, options = {}) {
    const raw = normalize(payload);
    if (!raw) {
        return {
            route: 'workout',
            success: false,
            action: 'error',
            telegramReply: '운동 입력이 비어있어. 예: 운동: 러닝 30분 5km',
        };
    }

    const month = parseMonthToken(raw);
    if (isSummaryCommand(raw)) {
        const summary = storage.summarizeWorkout({ ...options, month });
        return {
            route: 'workout',
            success: true,
            action: 'summary',
            summary,
            telegramReply: [
                month ? `운동 통계 (${month})` : '운동 통계',
                `- 세션: ${Number(summary.totals && summary.totals.sessions || 0)}회`,
                `- 총 운동시간: ${Number(summary.totals && summary.totals.total_duration_min || 0)}분`,
                `- 총 거리: ${Number(summary.totals && summary.totals.total_distance_km || 0)}km`,
                `- 활동일: ${Number(summary.totals && summary.totals.active_days || 0)}일`,
                `- 유형 상위: ${summary.byType && summary.byType.length ? summary.byType.map((x) => `${x.workout_type} ${x.count}회`).join(', ') : '-'}`,
            ].join('\n'),
        };
    }

    if (isListCommand(raw)) {
        const summary = storage.summarizeWorkout({ ...options, month });
        return {
            route: 'workout',
            success: true,
            action: 'list',
            summary,
            telegramReply: [
                month ? `운동 최근 내역 (${month})` : '운동 최근 내역',
                formatRecent(summary.recent || []),
            ].join('\n'),
        };
    }

    const metrics = parseMetrics(raw);
    const workoutType = detectWorkoutType(raw);
    const intensity = detectIntensity(raw);

    const event = storage.createEvent({
        route: 'workout',
        source: options.source || 'telegram',
        rawText: payload,
        normalizedText: raw,
        payload: { workoutType, intensity, ...metrics },
        dedupeMaterial: `workout:${storage.toIsoDate()}:${workoutType}:${metrics.durationMin || 0}:${metrics.distanceKm || 0}`,
    }, options);

    if (event.duplicate) {
        return {
            route: 'workout',
            success: true,
            action: 'duplicate',
            eventId: event.eventId,
            duplicate: true,
            telegramReply: '같은 운동 기록이 이미 있어서 중복 저장을 건너뛰었어.',
        };
    }

    try {
        const row = storage.recordWorkout({
            eventId: event.eventId,
            workoutType,
            durationMin: metrics.durationMin,
            calories: metrics.calories,
            distanceKm: metrics.distanceKm,
            intensity,
            note: raw,
        }, options);

        const autoRoutine = await maybeAutoCheckinRoutine(event.eventId, raw, options);
        return {
            route: 'workout',
            success: true,
            action: 'record',
            eventId: event.eventId,
            entityId: row && row.id,
            row,
            autoRoutine,
            telegramReply: [
                '운동 기록 완료',
                `- 유형: ${row.workout_type}`,
                `- 시간: ${row.duration_min == null ? '-' : `${row.duration_min}분`}`,
                `- 거리: ${row.distance_km == null ? '-' : `${row.distance_km}km`}`,
                `- 강도: ${row.intensity || '-'}`,
                autoRoutine ? `- 루틴 체크인 연동: ${autoRoutine.template_name}` : '- 루틴 체크인 연동: 없음',
            ].join('\n'),
        };
    } catch (error) {
        storage.markEventFailed(event.eventId, error && error.message ? error.message : String(error), options);
        return {
            route: 'workout',
            success: false,
            action: 'failed',
            eventId: event.eventId,
            telegramReply: `운동 기록 실패: ${error && error.message ? error.message : error}`,
        };
    }
}

module.exports = {
    handleWorkoutCommand,
};
