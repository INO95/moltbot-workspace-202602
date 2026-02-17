const storage = require('./personal_storage');

const CATEGORY_RULES = [
    { key: '식비', re: /(식비|점심|저녁|아침|카페|커피|배달|음식|외식)/i },
    { key: '교통비', re: /(교통|지하철|버스|택시|기름|주유)/i },
    { key: '생활용품', re: /(생활|아마존|다이소|생필품|세제|화장품|옷|의류)/i },
    { key: '교육', re: /(교육|강의|수강|책|독서|학습|스터디)/i },
    { key: '월세', re: /(월세|임대료|rent)/i },
    { key: '통신비', re: /(통신|핸드폰|요금제|인터넷)/i },
    { key: '정산환급', re: /(환급|정산|돌려받)/i },
    { key: '급여', re: /(급여|월급|salary|보너스)/i },
];

function money(n) {
    const value = Number(n || 0);
    if (!Number.isFinite(value)) return '0';
    return Math.round(value).toLocaleString('en-US');
}

function normalizeText(text) {
    return storage.normalizeSpace(text);
}

function parseMonthToken(text) {
    const m = String(text || '').match(/(20\d{2}-\d{2}|20\d{2}\d{2})/);
    if (!m) return '';
    const raw = String(m[1]);
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    if (/^\d{6}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}`;
    return '';
}

function detectEntryType(text) {
    const raw = String(text || '');
    if (/(환급|정산|reimburse|refund)/i.test(raw)) return 'refund';
    if (/(수입|입금|급여|월급|보너스|income|salary|받음)/i.test(raw)) return 'income';
    if (/(이체|송금|transfer)/i.test(raw)) return 'transfer';
    return 'expense';
}

function detectPaymentMethod(text) {
    const raw = String(text || '');
    if (/(현금|cash)/i.test(raw)) return '현금';
    if (/(카드|credit|visa|master)/i.test(raw)) return '카드';
    if (/(계좌|송금|transfer|bank)/i.test(raw)) return '계좌이체';
    return '미지정';
}

function detectCategory(text, entryType) {
    if (entryType === 'income') return '급여';
    if (entryType === 'refund') return '정산환급';
    const raw = String(text || '');
    for (const row of CATEGORY_RULES) {
        if (row.re.test(raw)) return row.key;
    }
    return '기타';
}

function extractCurrencyAmount(text) {
    const raw = String(text || '').replace(/,/g, '');

    const manYen = raw.match(/(-?\d+(?:\.\d+)?)\s*만엔/i);
    if (manYen) {
        return {
            amount: Number(manYen[1]) * 10000,
            currency: 'JPY',
            token: manYen[0],
        };
    }

    const patterns = [
        { re: /(-?\d+(?:\.\d+)?)\s*(엔|円|jpy)/i, currency: 'JPY' },
        { re: /(-?\d+(?:\.\d+)?)\s*(원|krw)/i, currency: 'KRW' },
        { re: /(-?\d+(?:\.\d+)?)\s*(달러|usd)/i, currency: 'USD' },
        { re: /(\$)\s*(-?\d+(?:\.\d+)?)/i, currency: 'USD', amountGroup: 2 },
        { re: /(-?\d+(?:\.\d+)?)\s*(eur|유로)/i, currency: 'EUR' },
    ];

    for (const row of patterns) {
        const m = raw.match(row.re);
        if (!m) continue;
        const amount = Number(m[row.amountGroup || 1]);
        if (!Number.isFinite(amount)) continue;
        return {
            amount,
            currency: row.currency,
            token: m[0],
        };
    }

    const fallbackNums = raw.match(/-?\d{3,9}(?:\.\d+)?/g) || [];
    if (fallbackNums.length > 0) {
        const amount = Number(fallbackNums[fallbackNums.length - 1]);
        if (Number.isFinite(amount)) {
            return {
                amount,
                currency: 'JPY',
                token: fallbackNums[fallbackNums.length - 1],
            };
        }
    }

    return { amount: NaN, currency: 'JPY', token: '' };
}

function normalizeSignedAmount(amount, entryType) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return n;
    if (entryType === 'expense') return n > 0 ? -n : n;
    if (entryType === 'income' || entryType === 'refund') return n < 0 ? Math.abs(n) : n;
    return n;
}

function extractItem(text, token) {
    const raw = String(text || '').trim();
    let cleaned = raw;
    if (token) {
        cleaned = cleaned.replace(token, ' ');
    }
    cleaned = cleaned
        .replace(/^(가계|지출|수입|환급|이체|기록|추가)\s*[:：]?\s*/i, '')
        .replace(/\b(현금|카드|계좌이체|계좌|transfer|income|expense|refund)\b/ig, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || '가계부 항목';
}

function parseFinanceEntry(payload) {
    const text = normalizeText(payload);
    const entryType = detectEntryType(text);
    const extracted = extractCurrencyAmount(text);
    const amount = normalizeSignedAmount(extracted.amount, entryType);
    const item = extractItem(text, extracted.token);

    return {
        raw: text,
        entryType,
        currency: extracted.currency,
        amount,
        item,
        category: detectCategory(text, entryType),
        paymentMethod: detectPaymentMethod(text),
    };
}

function isStatsCommand(payload) {
    return /^(통계|요약|summary|status)(?:\s|$)/i.test(String(payload || '').trim());
}

function isListCommand(payload) {
    return /^(목록|내역|list|history)(?:\s|$)/i.test(String(payload || '').trim());
}

function formatRecentRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '최근 내역 없음';
    return rows
        .slice(0, 6)
        .map((row) => {
            const amountText = `${money(row.amount)} ${row.currency || ''}`.trim();
            const jpy = row.amount_jpy == null ? '-' : `${money(row.amount_jpy)} JPY`;
            return `- #${row.id} ${row.entry_date} ${row.item} | ${row.entry_type} | ${amountText} (≈ ${jpy})`;
        })
        .join('\n');
}

function buildSummaryReply(summary, month = '') {
    const totals = summary.totals || {};
    const byCategory = Array.isArray(summary.byCategory) ? summary.byCategory : [];
    const title = month ? `가계 통계 (${month})` : '가계 누적 통계';
    return [
        title,
        `- 거래 수: ${Number(totals.count || 0)}건`,
        `- 지출(JPY): ${money(totals.expense_jpy)}`,
        `- 수입/환급(JPY): ${money(totals.income_jpy)}`,
        `- 이체(JPY): ${money(totals.transfer_jpy)}`,
        `- 순합계(JPY): ${money(totals.net_jpy)}`,
        `- 카테고리 상위: ${byCategory.length ? byCategory.map((r) => `${r.category} ${money(r.amount_jpy)}`).join(', ') : '-'}`,
        '조회 명령: 가계: 통계 2026-02 / 가계: 목록',
    ].join('\n');
}

async function handleFinanceCommand(payload, options = {}) {
    const raw = normalizeText(payload);
    if (!raw) {
        return {
            route: 'finance',
            success: false,
            action: 'error',
            telegramReply: '가계 입력이 비어있어. 예: 가계: 점심 1200엔',
        };
    }

    const month = parseMonthToken(raw);

    if (isStatsCommand(raw)) {
        const summary = storage.summarizeLedger({ ...options, month });
        return {
            route: 'finance',
            success: true,
            action: 'summary',
            month: month || null,
            summary,
            telegramReply: buildSummaryReply(summary, month),
        };
    }

    if (isListCommand(raw)) {
        const summary = storage.summarizeLedger({ ...options, month });
        return {
            route: 'finance',
            success: true,
            action: 'list',
            month: month || null,
            summary,
            telegramReply: [
                month ? `가계 최근 내역 (${month})` : '가계 최근 내역',
                formatRecentRows(summary.recent),
            ].join('\n'),
        };
    }

    const parsed = parseFinanceEntry(raw);
    if (!Number.isFinite(parsed.amount)) {
        return {
            route: 'finance',
            success: false,
            action: 'parse_error',
            telegramReply: '금액을 인식하지 못했어. 예: 가계: 점심 1200엔',
        };
    }

    const event = storage.createEvent({
        route: 'finance',
        source: options.source || 'telegram',
        rawText: payload,
        normalizedText: raw,
        payload: parsed,
        dedupeMaterial: `finance:${parsed.entryType}:${parsed.currency}:${parsed.amount}:${parsed.item}`,
    }, options);

    if (event.duplicate) {
        return {
            route: 'finance',
            success: true,
            action: 'duplicate',
            eventId: event.eventId,
            duplicate: true,
            telegramReply: '이미 기록된 가계 항목이야. 중복 저장은 건너뛰었어.',
        };
    }

    try {
        const row = storage.insertLedgerEntry({
            eventId: event.eventId,
            entryDate: options.entryDate,
            entryType: parsed.entryType,
            item: parsed.item,
            amount: parsed.amount,
            currency: parsed.currency,
            category: parsed.category,
            paymentMethod: parsed.paymentMethod,
            memo: parsed.raw,
        }, options);

        const summary = storage.summarizeLedger({ ...options, month: parseMonthToken(row && row.entry_date) });

        return {
            route: 'finance',
            success: true,
            action: 'record',
            eventId: event.eventId,
            entityId: row && row.id,
            record: row,
            summary,
            telegramReply: [
                '가계 기록 완료',
                `- 항목: ${parsed.item}`,
                `- 유형: ${parsed.entryType}`,
                `- 금액: ${money(parsed.amount)} ${parsed.currency}`,
                `- 카테고리: ${parsed.category}`,
                `- 결제수단: ${parsed.paymentMethod}`,
                `- 월 지출(JPY): ${money(summary.totals && summary.totals.expense_jpy)}`,
            ].join('\n'),
        };
    } catch (error) {
        storage.markEventFailed(event.eventId, error && error.message ? error.message : String(error), options);
        return {
            route: 'finance',
            success: false,
            action: 'record_failed',
            eventId: event.eventId,
            telegramReply: `가계 기록 실패: ${error && error.message ? error.message : error}`,
        };
    }
}

module.exports = {
    parseFinanceEntry,
    handleFinanceCommand,
};
