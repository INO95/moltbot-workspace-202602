const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.FINANCE_WEB_PORT || 4380);
const host = process.env.FINANCE_WEB_HOST || '127.0.0.1';
const staticDir = path.join(__dirname, '../web/finance-mvp');
const snapshotPath = process.env.FINANCE_SNAPSHOT_PATH || path.join(__dirname, '../data/backups/final_sheet_snapshot_latest.json');
const financeDbPath = path.join(__dirname, '../data/finance_db.json');
const configPath = path.join(__dirname, '../data/config.json');
const DEFAULT_BUDGET_YEN = 60000;
const SUPPORTED_CURRENCIES = new Set(['JPY', 'KRW', 'USD']);

function toNumber(value) {
    const s = String(value == null ? '' : value).replace(/[,\s¥￥]/g, '').trim();
    if (!s) return 0;
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
}

function monthOf(dateText) {
    return String(dateText || '').slice(0, 7);
}

function monthToNumber(monthText) {
    const m = String(monthText || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 100 + Number(m[2]);
}

function inMonthRange(monthText, fromMonth, toMonth) {
    const n = monthToNumber(monthText);
    if (n == null) return false;
    const fromN = monthToNumber(fromMonth);
    const toN = monthToNumber(toMonth);
    if (fromN != null && n < fromN) return false;
    if (toN != null && n > toN) return false;
    return true;
}

function filterRowsByMonthScope(rows, { month = '', fromMonth = '', toMonth = '' } = {}) {
    if (month) return rows.filter(row => monthOf(row.date) === month);
    if (fromMonth || toMonth) return rows.filter(row => inMonthRange(monthOf(row.date), fromMonth, toMonth));
    return rows;
}

function normalizeSnapshotRow(row) {
    return {
        date: row['날짜'] || '',
        item: row['항목'] || '',
        income: toNumber(row['수입']),
        expense: toNumber(row['지출']),
        paymentMethod: row['결제수단'] || '',
        category: row['카테고리'] || '기타',
        memo: row['메모'] || '',
        currency: 'JPY',
        sumitomo: toNumber(row['스미토모 잔고']),
        rakuten: toNumber(row['라쿠텐 잔고']),
        cash: toNumber(row['현금 잔고']),
    };
}

function normalizeDbTx(tx) {
    const amount = Number(tx.amount || 0);
    const currency = SUPPORTED_CURRENCIES.has(String(tx.currency || 'JPY')) ? String(tx.currency || 'JPY') : 'JPY';
    return {
        id: tx.id || null,
        date: tx.date || '',
        item: tx.item || '',
        income: amount > 0 ? amount : 0,
        expense: amount < 0 ? Math.abs(amount) : 0,
        paymentMethod: tx.paymentMethod || '',
        category: tx.category || '기타',
        memo: tx.memo || '',
        currency,
        tags: Array.isArray(tx.tags) ? tx.tags : [],
        source: 'db',
        sumitomo: 0,
        rakuten: 0,
        cash: 0,
    };
}

function loadRows() {
    const out = [];
    if (fs.existsSync(snapshotPath)) {
        try {
            const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
            const financeSheet = (snapshot.sheets || []).find(s => s.title === '가계부_파이널');
            if (financeSheet && Array.isArray(financeSheet.rows) && financeSheet.rows.length > 0) {
                out.push(...financeSheet.rows.map(row => ({
                    ...normalizeSnapshotRow(row),
                    id: null,
                    tags: [],
                    source: 'snapshot',
                })));
            }
        } catch (error) {
            console.error(`snapshot parse error: ${error.message}`);
        }
    }

    if (fs.existsSync(financeDbPath)) {
        try {
            const db = JSON.parse(fs.readFileSync(financeDbPath, 'utf8'));
            const txs = Array.isArray(db.transactions) ? db.transactions : [];
            out.push(...txs.map(normalizeDbTx));
        } catch (error) {
            console.error(`finance_db parse error: ${error.message}`);
        }
    }
    return out;
}

function readFinanceDb() {
    if (!fs.existsSync(financeDbPath)) {
        return {
            config: { schemaVersion: 2, currency: 'JPY', owner: 'BAEK INHO', last_updated: null },
            transactions: [],
            liabilities: { creditCards: {} },
            categories: [],
        };
    }
    try {
        return JSON.parse(fs.readFileSync(financeDbPath, 'utf8'));
    } catch {
        return {
            config: { schemaVersion: 2, currency: 'JPY', owner: 'BAEK INHO', last_updated: null },
            transactions: [],
            liabilities: { creditCards: {} },
            categories: [],
        };
    }
}

function writeFinanceDb(db) {
    fs.writeFileSync(financeDbPath, JSON.stringify(db, null, 2), 'utf8');
}

function validatePaymentMethod(method) {
    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const map = cfg.paymentMethods || {};
        return Boolean(map[method]);
    } catch {
        return true;
    }
}

function loadConfigSafe() {
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        return {};
    }
}

function saveConfigSafe(cfg) {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 4), 'utf8');
}

function getFoodBudgetYen() {
    const cfg = loadConfigSafe();
    const n = Number(cfg?.financePolicy?.realFoodBudgetMonthlyYen);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
    return DEFAULT_BUDGET_YEN;
}

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1024 * 1024) req.destroy(new Error('payload too large'));
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

function isValidDateText(value) {
    const s = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return false;
    const normalized = d.toISOString().slice(0, 10);
    return normalized === s;
}

function isValidAmount(value) {
    if (!Number.isFinite(value)) return false;
    if (!Number.isInteger(value)) return false;
    if (value === 0) return false;
    return Math.abs(value) <= 1000000000;
}

function cleanText(value, max = 200) {
    return String(value == null ? '' : value).trim().slice(0, max);
}

function validateTransactionInput(body, { partial = false } = {}) {
    const errors = [];
    const has = key => Object.prototype.hasOwnProperty.call(body, key);

    if (!partial || has('date')) {
        if (!isValidDateText(body.date)) errors.push('date must be YYYY-MM-DD');
    }
    if (!partial || has('item')) {
        const item = cleanText(body.item, 120);
        if (!item) errors.push('item is required');
    }
    if (!partial || has('amount')) {
        const amount = Number(body.amount);
        if (!isValidAmount(amount)) errors.push('amount must be non-zero integer');
    }
    if (has('paymentMethod')) {
        const method = cleanText(body.paymentMethod, 80);
        if (!method) {
            errors.push('paymentMethod cannot be empty');
        } else if (!validatePaymentMethod(method)) {
            errors.push('unknown paymentMethod');
        }
    }
    if (has('category')) {
        const category = cleanText(body.category, 80);
        if (!category) errors.push('category cannot be empty');
    }
    if (!partial || has('currency')) {
        const currency = cleanText(body.currency || 'JPY', 8).toUpperCase();
        if (!SUPPORTED_CURRENCIES.has(currency)) errors.push('unsupported currency');
    }
    if (has('tags')) {
        if (!Array.isArray(body.tags)) errors.push('tags must be array');
    }

    return errors;
}

function toKoreanValidationMessage(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return '입력값을 확인해주세요.';
    if (errors.includes('amount must be non-zero integer')) return '금액을 찾을 수 없습니다.';
    if (errors.includes('date must be YYYY-MM-DD')) return '날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)';
    if (errors.includes('item is required')) return '항목을 입력해주세요.';
    if (errors.includes('unknown paymentMethod')) return '결제수단을 인식할 수 없습니다.';
    if (errors.includes('paymentMethod cannot be empty')) return '결제수단을 입력해주세요.';
    if (errors.includes('category cannot be empty')) return '카테고리를 입력해주세요.';
    if (errors.includes('unsupported currency')) return '통화는 JPY/KRW/USD만 가능합니다.';
    if (errors.includes('tags must be array')) return '태그 형식이 올바르지 않습니다.';
    if (errors.includes('add/remove must be arrays')) return '태그 추가/삭제 형식이 올바르지 않습니다.';
    return `입력값 오류: ${errors[0]}`;
}

function computeEffectiveFood(rows, budgetYen = getFoodBudgetYen()) {
    let food = 0;
    let groupPay = 0;
    let reimburse = 0;
    for (const row of rows) {
        if (String(row.currency || 'JPY') !== 'JPY') continue;
        const c = String(row.category || '');
        const out = Number(row.expense || 0);
        const input = Number(row.income || 0);
        if (/^식비$/.test(c)) food += out;
        else if (/식비\(총무\)|총무/.test(c)) groupPay += out;
        else if (/식비받은거|현금받음\(식비\)|식비정산환급/.test(c)) reimburse += input > 0 ? input : out;
    }
    const effective = food + groupPay - reimburse;
    return {
        food,
        groupPay,
        reimburse,
        effective,
        budget: budgetYen,
        budgetDelta: budgetYen - effective,
        status: effective > budgetYen ? 'OVER' : 'OK',
    };
}

function monthParts(monthText) {
    const m = String(monthText || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    return { year: Number(m[1]), month: Number(m[2]) };
}

function countMonthsFromRange({ month = '', fromMonth = '', toMonth = '' } = {}, rows = []) {
    if (month) return 1;
    const from = monthParts(fromMonth);
    const to = monthParts(toMonth);
    if (from && to) {
        return Math.max(1, (to.year - from.year) * 12 + (to.month - from.month) + 1);
    }
    const uniqueMonths = new Set(rows.map(r => monthOf(r.date)).filter(Boolean));
    return Math.max(1, uniqueMonths.size);
}

function computeMonthlySummary(rows, budgetYen = getFoodBudgetYen()) {
    const monthly = new Map();
    for (const row of rows) {
        if (String(row.currency || 'JPY') !== 'JPY') continue;
        const m = monthOf(row.date);
        if (!m) continue;
        if (!monthly.has(m)) {
            monthly.set(m, {
                month: m,
                income: 0,
                expense: 0,
                byCategory: {},
                effectiveFood: {
                    food: 0,
                    groupPay: 0,
                    reimburse: 0,
                    effective: 0,
                    budget: budgetYen,
                    budgetDelta: budgetYen,
                    status: 'OK',
                },
            });
        }
        const bucket = monthly.get(m);
        bucket.income += row.income;
        bucket.expense += row.expense;
        const category = String(row.category || '기타');
        bucket.byCategory[category] = (bucket.byCategory[category] || 0) + row.expense;
    }
    for (const [m, bucket] of monthly.entries()) {
        const rowsInMonth = rows.filter(r => monthOf(r.date) === m);
        bucket.effectiveFood = computeEffectiveFood(rowsInMonth, budgetYen);
    }
    return [...monthly.values()].sort((a, b) => String(a.month).localeCompare(String(b.month)));
}

function computeUsageStats(rows) {
    const categoryUsage = {};
    const paymentMethodUsage = {};
    for (const row of rows) {
        const category = String(row.category || '').trim();
        const method = String(row.paymentMethod || '').trim();
        if (category) categoryUsage[category] = (categoryUsage[category] || 0) + 1;
        if (method) paymentMethodUsage[method] = (paymentMethodUsage[method] || 0) + 1;
    }
    return { categoryUsage, paymentMethodUsage };
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': process.env.FINANCE_CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Token',
};

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
    res.end(JSON.stringify(payload, null, 2));
}

function requireApiAuth(req, res) {
    const requiredToken = String(process.env.FINANCE_WEB_API_TOKEN || '').trim();
    if (!requiredToken) return true;
    const got = String(req.headers['x-api-token'] || '').trim();
    if (got === requiredToken) return true;
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return false;
}

function readTextFile(filePath) {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
}

function serveIndex(res) {
    const html = readTextFile(path.join(staticDir, 'index.html'));
    if (!html) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html not found');
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

function serveApp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const rows = loadRows();

    if (req.method === 'POST' && url.pathname === '/api/finance/transactions') {
        if (!requireApiAuth(req, res)) return;
        parseJsonBody(req).then(body => {
            const errors = validateTransactionInput(body, { partial: false });
            if (errors.length) {
                sendJson(res, 422, {
                    ok: false,
                    error: toKoreanValidationMessage(errors),
                    details: errors,
                    errorCode: 'validation_failed',
                });
                return;
            }

            const amount = Number(body.amount);
            const db = readFinanceDb();
            db.transactions = Array.isArray(db.transactions) ? db.transactions : [];
            const tx = {
                id: Date.now(),
                date: cleanText(body.date, 10),
                item: cleanText(body.item, 120),
                amount: amount,
                category: cleanText(body.category || '기타', 80),
                paymentMethod: cleanText(body.paymentMethod || '현금', 80),
                memo: cleanText(body.memo || '', 200),
                currency: cleanText(body.currency || 'JPY', 8).toUpperCase(),
                tags: Array.isArray(body.tags) ? body.tags.map(x => cleanText(x, 40)).filter(Boolean) : [],
                created_at: new Date().toISOString(),
            };
            db.transactions.push(tx);
            db.config = db.config || {};
            db.config.last_updated = tx.date;
            writeFinanceDb(db);
            sendJson(res, 200, { ok: true, transaction: tx });
        }).catch(err => sendJson(res, 400, { ok: false, error: err.message }));
        return;
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/finance/transactions/')) {
        if (!requireApiAuth(req, res)) return;
        parseJsonBody(req).then(body => {
            const id = Number(url.pathname.split('/').pop());
            if (!Number.isFinite(id)) {
                sendJson(res, 400, { ok: false, error: 'invalid id' });
                return;
            }
            const errors = validateTransactionInput(body, { partial: true });
            if (errors.length) {
                sendJson(res, 422, {
                    ok: false,
                    error: toKoreanValidationMessage(errors),
                    details: errors,
                    errorCode: 'validation_failed',
                });
                return;
            }
            const db = readFinanceDb();
            db.transactions = Array.isArray(db.transactions) ? db.transactions : [];
            const idx = db.transactions.findIndex(t => Number(t.id) === id);
            if (idx < 0) {
                sendJson(res, 404, { ok: false, error: 'transaction not found' });
                return;
            }
            const prev = db.transactions[idx];
            const next = {
                ...prev,
                ...(body.date ? { date: cleanText(body.date, 10) } : {}),
                ...(body.item ? { item: cleanText(body.item, 120) } : {}),
                ...(body.amount != null ? { amount: Number(body.amount) } : {}),
                ...(body.category ? { category: cleanText(body.category, 80) } : {}),
                ...(body.paymentMethod ? { paymentMethod: cleanText(body.paymentMethod, 80) } : {}),
                ...(body.memo != null ? { memo: cleanText(body.memo, 200) } : {}),
                ...(body.currency ? { currency: cleanText(body.currency, 8).toUpperCase() } : {}),
                ...(Array.isArray(body.tags) ? { tags: body.tags.map(x => cleanText(x, 40)).filter(Boolean) } : {}),
                updated_at: new Date().toISOString(),
            };
            db.transactions[idx] = next;
            writeFinanceDb(db);
            sendJson(res, 200, { ok: true, transaction: next });
        }).catch(err => sendJson(res, 400, { ok: false, error: err.message }));
        return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/finance/transactions/') && url.pathname.endsWith('/tags')) {
        if (!requireApiAuth(req, res)) return;
        parseJsonBody(req).then(body => {
            const parts = url.pathname.split('/').filter(Boolean);
            const id = Number(parts[3]);
            if (!Number.isFinite(id)) {
                sendJson(res, 400, { ok: false, error: 'invalid id' });
                return;
            }
            if ((body.add && !Array.isArray(body.add)) || (body.remove && !Array.isArray(body.remove))) {
                const details = ['add/remove must be arrays'];
                sendJson(res, 422, {
                    ok: false,
                    error: toKoreanValidationMessage(details),
                    details,
                    errorCode: 'validation_failed',
                });
                return;
            }
            const add = Array.isArray(body.add) ? body.add.map(x => cleanText(x, 40)).filter(Boolean) : [];
            const remove = Array.isArray(body.remove) ? body.remove.map(x => cleanText(x, 40)).filter(Boolean) : [];
            const db = readFinanceDb();
            db.transactions = Array.isArray(db.transactions) ? db.transactions : [];
            const idx = db.transactions.findIndex(t => Number(t.id) === id);
            if (idx < 0) {
                sendJson(res, 404, { ok: false, error: 'transaction not found' });
                return;
            }
            const before = Array.isArray(db.transactions[idx].tags) ? db.transactions[idx].tags : [];
            const set = new Set(before);
            for (const t of add) if (t) set.add(t);
            for (const t of remove) if (t) set.delete(t);
            db.transactions[idx].tags = [...set];
            db.transactions[idx].updated_at = new Date().toISOString();
            writeFinanceDb(db);
            sendJson(res, 200, { ok: true, tags: db.transactions[idx].tags, id });
        }).catch(err => sendJson(res, 400, { ok: false, error: err.message }));
        return;
    }

    if (url.pathname === '/api/finance/transactions') {
        const month = url.searchParams.get('month') || '';
        const fromMonth = url.searchParams.get('fromMonth') || '';
        const toMonth = url.searchParams.get('toMonth') || '';
        const category = url.searchParams.get('category') || '';
        const q = url.searchParams.get('q') || '';
        const memo = url.searchParams.get('memo') || '';
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 100)));
        const page = Math.max(1, Number(url.searchParams.get('page') || 1));
        const sort = String(url.searchParams.get('sort') || 'date_desc');
        let out = filterRowsByMonthScope(rows, { month, fromMonth, toMonth });
        if (category) out = out.filter(row => String(row.category) === category);
        if (memo) {
            const lower = memo.toLowerCase();
            out = out.filter(row => String(row.memo || '').toLowerCase().includes(lower));
        }
        if (q) {
            const lower = q.toLowerCase();
            out = out.filter(row =>
                [row.item, row.memo, row.paymentMethod, row.category]
                    .map(v => String(v || '').toLowerCase())
                    .some(v => v.includes(lower)),
            );
        }
        out.sort((a, b) => {
            const da = String(a.date || '');
            const db = String(b.date || '');
            if (sort === 'date_asc') return da.localeCompare(db);
            if (sort === 'expense_desc') return Number(b.expense || 0) - Number(a.expense || 0);
            if (sort === 'expense_asc') return Number(a.expense || 0) - Number(b.expense || 0);
            return db.localeCompare(da);
        });
        const total = out.length;
        const start = (page - 1) * limit;
        const paged = out.slice(start, start + limit);
        sendJson(res, 200, { total, page, limit, rows: paged });
        return;
    }

    if (url.pathname === '/api/finance/usage') {
        const usage = computeUsageStats(rows);
        sendJson(res, 200, usage);
        return;
    }

    if (url.pathname === '/api/finance/meta') {
        const categories = new Set(['식비', '교통비', '월세', '통신비', '교육', '건강', '생활', '취미', '기타']);
        const paymentMethods = new Set(['현금', '스미토모', '라쿠텐', '올리브 카드 (데빗)', '올리브 카드 (크레짓)', '아마존 카드']);
        try {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            for (const key of Object.keys(cfg.categories || {})) categories.add(String(key));
            for (const key of Object.keys(cfg.paymentMethods || {})) paymentMethods.add(String(key));
        } catch { }
        sendJson(res, 200, {
            currencies: ['JPY', 'KRW', 'USD'],
            categories: [...categories],
            paymentMethods: [...paymentMethods],
            foodBudgetYen: getFoodBudgetYen(),
        });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/finance/settings') {
        sendJson(res, 200, { foodBudgetYen: getFoodBudgetYen() });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/finance/settings') {
        if (!requireApiAuth(req, res)) return;
        parseJsonBody(req).then(body => {
            const nextBudget = Number(body.foodBudgetYen);
            if (!Number.isFinite(nextBudget) || nextBudget <= 0) {
                sendJson(res, 422, { ok: false, error: 'foodBudgetYen must be positive number' });
                return;
            }
            const cfg = loadConfigSafe();
            cfg.financePolicy = cfg.financePolicy || {};
            cfg.financePolicy.realFoodBudgetMonthlyYen = Math.trunc(nextBudget);
            saveConfigSafe(cfg);
            sendJson(res, 200, { ok: true, foodBudgetYen: cfg.financePolicy.realFoodBudgetMonthlyYen });
        }).catch(err => sendJson(res, 400, { ok: false, error: err.message }));
        return;
    }

    if (url.pathname === '/api/finance/summary') {
        const month = url.searchParams.get('month') || '';
        const fromMonth = url.searchParams.get('fromMonth') || '';
        const toMonth = url.searchParams.get('toMonth') || '';
        const scopedRows = filterRowsByMonthScope(rows, { month, fromMonth, toMonth });
        const monthly = computeMonthlySummary(scopedRows, getFoodBudgetYen());
        sendJson(res, 200, {
            rowCount: scopedRows.length,
            monthly,
            latestMonth: monthly.length ? monthly[monthly.length - 1] : null,
        });
        return;
    }

    if (url.pathname === '/api/finance/effective-food') {
        const month = url.searchParams.get('month') || '';
        const fromMonth = url.searchParams.get('fromMonth') || '';
        const toMonth = url.searchParams.get('toMonth') || '';
        const targetRows = filterRowsByMonthScope(rows, { month, fromMonth, toMonth });
        const budgetYen = getFoodBudgetYen();
        sendJson(res, 200, {
            month: month || 'all',
            ...computeEffectiveFood(targetRows, budgetYen),
        });
        return;
    }

    if (url.pathname === '/api/finance/alerts/real-food') {
        const month = url.searchParams.get('month') || '';
        const fromMonth = url.searchParams.get('fromMonth') || '';
        const toMonth = url.searchParams.get('toMonth') || '';
        const targetRows = filterRowsByMonthScope(rows, { month, fromMonth, toMonth });
        const baseBudgetYen = getFoodBudgetYen();
        const monthCount = countMonthsFromRange({ month, fromMonth, toMonth }, targetRows);
        const budgetYen = baseBudgetYen * monthCount;
        const food = computeEffectiveFood(targetRows, budgetYen);
        const ratio = food.budget > 0 ? Math.round((food.effective / food.budget) * 100) : 0;
        const level = food.effective > food.budget ? 'danger' : (food.effective > food.budget * 0.9 ? 'warn' : 'ok');
        const message = level === 'danger'
            ? '실질 식비가 월 예산을 초과했습니다.'
            : level === 'warn'
                ? '실질 식비가 예산의 90%를 넘었습니다.'
                : '실질 식비가 예산 범위입니다.';
        sendJson(res, 200, {
            month: month || 'all',
            level,
            ratio,
            message,
            monthCount,
            baseBudgetYen,
            ...food,
        });
        return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
        serveIndex(res);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
}

function startServer() {
    const server = http.createServer(serveApp);
    server.listen(PORT, host, () => {
        console.log(`Finance MVP running: http://${host}:${PORT}`);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = {
    loadRows,
    computeEffectiveFood,
    computeMonthlySummary,
    readFinanceDb,
};
