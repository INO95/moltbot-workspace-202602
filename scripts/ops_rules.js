const crypto = require('crypto');

const REQUIRED_EVENT_FIELDS = [
    'schema_version',
    'ts',
    'bot_id',
    'run_id',
    'event_type',
    'status',
    'severity',
    'message',
    'component',
];

function nowDate(input) {
    if (input instanceof Date) return input;
    if (input) return new Date(input);
    return new Date();
}

function getTimeParts(input, timezone = 'Asia/Tokyo') {
    const date = nowDate(input);
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = Object.create(null);
    for (const p of fmt.formatToParts(date)) {
        parts[p.type] = p.value;
    }
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    };
}

function parseHourMinute(value, fallbackHour) {
    const raw = String(value || '').trim();
    const m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return { hour: fallbackHour, minute: 0 };
    return {
        hour: Number(m[1]),
        minute: Number(m[2]),
    };
}

function isQuietHours(input, config = {}) {
    const timezone = config.timezone || 'Asia/Tokyo';
    const quiet = config.quiet_hours || { start: '23:00', end: '07:00' };
    const start = parseHourMinute(quiet.start, 23);
    const end = parseHourMinute(quiet.end, 7);
    const parts = getTimeParts(input, timezone);
    const nowMinuteOfDay = (parts.hour * 60) + parts.minute;
    const startMinuteOfDay = (start.hour * 60) + start.minute;
    const endMinuteOfDay = (end.hour * 60) + end.minute;

    if (startMinuteOfDay === endMinuteOfDay) return false;
    if (startMinuteOfDay < endMinuteOfDay) {
        return nowMinuteOfDay >= startMinuteOfDay && nowMinuteOfDay < endMinuteOfDay;
    }
    return nowMinuteOfDay >= startMinuteOfDay || nowMinuteOfDay < endMinuteOfDay;
}

function isCooldownActive(lastAlertTs, cooldownHours, input) {
    if (!lastAlertTs) return false;
    const lastMs = Date.parse(String(lastAlertTs));
    if (!Number.isFinite(lastMs)) return false;
    const nowMs = nowDate(input).getTime();
    const cooldownMs = Number(cooldownHours || 2) * 60 * 60 * 1000;
    return (nowMs - lastMs) < cooldownMs;
}

function isBriefingTime(input, timezone, target) {
    const parts = getTimeParts(input, timezone || 'Asia/Tokyo');
    if (target === 'morning') return parts.hour === 8 && parts.minute === 30;
    if (target === 'evening') return parts.hour === 18 && parts.minute === 30;
    return false;
}

function validateEventSchema(event) {
    const missing = [];
    const payload = event && typeof event === 'object' ? event : {};
    for (const field of REQUIRED_EVENT_FIELDS) {
        const value = payload[field];
        if (value === undefined || value === null || value === '') {
            missing.push(field);
        }
    }
    return {
        valid: missing.length === 0,
        missing,
    };
}

function buildEventFingerprint(event) {
    const err = (event && event.error && typeof event.error === 'object') ? event.error : {};
    if (err.fingerprint) return String(err.fingerprint);
    const bits = [
        String((event && event.bot_id) || ''),
        String((event && event.component) || ''),
        String(err.type || ''),
        String(err.code || ''),
        String(err.message || (event && event.message) || ''),
    ];
    const raw = bits.join('|').toLowerCase().replace(/\s+/g, ' ').trim();
    const digest = crypto.createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 16);
    return `fp_${digest}`;
}

function computeIssueId(botId, event) {
    return `${botId}:${buildEventFingerprint(event)}`;
}

function classifySeverity(event) {
    const rawSeverity = String((event && event.severity) || '').toUpperCase();
    if (rawSeverity === 'P1' || rawSeverity === 'P2' || rawSeverity === 'P3') {
        return rawSeverity;
    }
    const status = String((event && event.status) || '').toLowerCase();
    const errCode = String((event && event.error && event.error.code) || '').toUpperCase();
    const msg = String((event && event.message) || '').toLowerCase();

    if (errCode.includes('EACCES') || msg.includes('permission denied')) return 'P1';
    if (msg.includes('secret') || msg.includes('token leakage')) return 'P1';
    if (status === 'error') return 'P2';
    if (status === 'warn') return 'P3';
    return 'P3';
}

function shouldAlertNow(issue, options = {}) {
    const now = nowDate(options.now);
    const timezone = options.timezone || 'Asia/Tokyo';
    const quietHours = options.quiet_hours || { start: '23:00', end: '07:00' };
    const cooldownHours = Number(options.cooldown_hours || 2);
    const p2Threshold = Number(options.p2_consecutive_failures_threshold || 3);
    const severity = String((issue && issue.severity) || 'P3').toUpperCase();
    const consecutive = Number((issue && issue.consecutive_failures) || 0);

    if (severity === 'P3') {
        return {
            send: false,
            reason: 'briefing_only',
            decision_rule: 'P3 briefing only',
        };
    }
    if (severity === 'P2' && consecutive < p2Threshold) {
        return {
            send: false,
            reason: 'threshold_not_reached',
            decision_rule: `P2 threshold ${p2Threshold} not reached`,
        };
    }
    if (severity !== 'P1' && isQuietHours(now, { timezone, quiet_hours: quietHours })) {
        return {
            send: false,
            reason: 'quiet_hours',
            decision_rule: 'quiet hours suppression for non-P1',
        };
    }
    if (isCooldownActive(issue && issue.last_alert_ts, cooldownHours, now)) {
        return {
            send: false,
            reason: 'cooldown',
            decision_rule: `cooldown ${cooldownHours}h active`,
        };
    }
    return {
        send: true,
        reason: 'send_now',
        decision_rule: severity === 'P1'
            ? 'P1 immediate alert'
            : `P2 consecutive failures >= ${p2Threshold}`,
    };
}

function isRetriableErrorLike(error) {
    const text = String(
        (error && (error.code || error.message || error.toString && error.toString())) || '',
    ).toLowerCase();
    return /(timed?out|etimedout|econnreset|eai_again|429|503|rate limit|temporar)/i.test(text);
}

module.exports = {
    REQUIRED_EVENT_FIELDS,
    getTimeParts,
    parseHourMinute,
    isQuietHours,
    isCooldownActive,
    isBriefingTime,
    validateEventSchema,
    buildEventFingerprint,
    computeIssueId,
    classifySeverity,
    shouldAlertNow,
    isRetriableErrorLike,
};
