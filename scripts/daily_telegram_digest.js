const fs = require('fs');
const path = require('path');
const axios = require('axios');

const moltEngine = require('./molt_engine');
const healthDashboard = require('./health_dashboard');
const { buildGitReport } = require('./github_status_report');
const healthCapture = require('./health_capture');
const { enqueueBridgePayload } = require('./bridge_queue');

const localFinanceDbPath = path.join(__dirname, '../data/finance_db.json');
const localTodosPath = path.join(__dirname, '../data/todos.csv');

function extractRssTitles(xml, limit = 5) {
    const matches = [...String(xml).matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g)];
    const titles = matches
        .map(m => (m[1] || m[2] || '').trim())
        .filter(Boolean)
        .filter(t => !/Google 뉴스|Google News/i.test(t));
    return titles.slice(0, limit);
}

async function getNewsHeadlines() {
    const rssUrl =
        'https://news.google.com/rss/search?q=(OpenAI%20OR%20Gemini%20OR%20AI%20agent)%20when:1d&hl=ko&gl=KR&ceid=KR:ko';
    try {
        const resp = await axios.get(rssUrl, { timeout: 10000 });
        return extractRssTitles(resp.data, 5);
    } catch (error) {
        return [`뉴스 수집 실패: ${error.message}`];
    }
}

async function buildDigestText() {
    const now = new Date();
    const date = now.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });

    let financeText = '가계부 요약 조회 실패';
    let creditLiabilityText = '신용카드 미결제: 조회 실패';
    let checklistText = '체크리스트 조회 실패';
    let healthText = '건강 요약 조회 실패';

    try {
        const stats = await moltEngine.getMonthlyStats();
        financeText = `수입 +${stats.income} / 총지출 ${stats.expense} / 실질지출 ${stats.effectiveExpense} / 잔액 ${stats.balance}`;
    } catch (error) {
        financeText = buildLocalFinanceFallback(error);
    }

    try {
        const liabilities = moltEngine.getCreditLiabilityStatus();
        const parts = Object.entries(liabilities)
            .filter(([, v]) => Number(v) > 0)
            .map(([k, v]) => `${k}:${v}`);
        creditLiabilityText = parts.length > 0 ? parts.join(', ') : '없음';
    } catch (error) {
        creditLiabilityText = `신용카드 미결제 조회 실패: ${error.message}`;
    }

    try {
        const summary = await moltEngine.getTodaySummary();
        const kv = Object.entries(summary).map(([k, v]) => `${k}:${v}`).join(', ');
        checklistText = kv || '오늘 체크리스트 기록 없음';
    } catch (error) {
        checklistText = buildLocalChecklistFallback(error);
    }

    try {
        const monthlyHealth = healthCapture.getMonthlySummary();
        healthText = [
            `러닝 ${monthlyHealth.running.sessions}회/${monthlyHealth.running.distanceKm}km`,
            `웨이트 ${monthlyHealth.workouts.sessions}회/${monthlyHealth.workouts.totalVolumeKg}kg`,
            `부족부위: ${monthlyHealth.workouts.missingAreas.join(', ') || '없음'}`,
        ].join(' | ');
    } catch (error) {
        try {
            const health = await healthDashboard.generateDashboard({ sleepData: [], exerciseHistory: [] });
            healthText = health.summary.replace(/\n/g, ' | ');
        } catch (inner) {
            healthText = `건강 요약 조회 실패: ${inner.message}`;
        }
    }

    const git = buildGitReport();
    const news = await getNewsHeadlines();

    const lines = [
        `📌 Daily Digest (${date})`,
        '',
        `💰 Finance: ${financeText}`,
        `💳 Credit Pending: ${creditLiabilityText}`,
        `✅ Checklist: ${checklistText}`,
        `🏥 Health: ${healthText}`,
        '',
        '🧰 GitHub Code Status:',
        git.ok ? git.text : git.error,
        '',
        '📰 AI/Tech Headlines:',
        ...news.map(t => `- ${t}`),
    ];

    return lines.join('\n');
}

function getMonthPrefix(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-`;
}

function getTodayIso(date = new Date()) {
    return date.toISOString().split('T')[0];
}

function buildLocalFinanceFallback(sourceError) {
    try {
        if (!fs.existsSync(localFinanceDbPath)) {
            return `가계부 로컬 폴백 없음 (${sourceError.message})`;
        }
        const payload = JSON.parse(fs.readFileSync(localFinanceDbPath, 'utf8'));
        const txs = Array.isArray(payload.transactions) ? payload.transactions : [];
        const monthPrefix = getMonthPrefix();
        const monthly = txs.filter(t => String(t.date || '').startsWith(monthPrefix));
        const income = monthly.filter(t => Number(t.amount) > 0).reduce((s, t) => s + Number(t.amount || 0), 0);
        const expense = monthly.filter(t => Number(t.amount) < 0).reduce((s, t) => s + Number(t.amount || 0), 0);
        return `로컬기준 수입 +${income} / 지출 ${expense} / 잔액 ${income + expense}`;
    } catch (error) {
        return `가계부 조회 실패(원격/로컬): ${error.message}`;
    }
}

function buildLocalChecklistFallback(sourceError) {
    try {
        if (!fs.existsSync(localTodosPath)) {
            return `체크리스트 로컬 폴백 없음 (${sourceError.message})`;
        }
        const today = getTodayIso();
        const lines = fs.readFileSync(localTodosPath, 'utf8').split('\n').slice(1).filter(Boolean);
        const todayRows = lines
            .map(line => line.split(','))
            .filter(parts => parts[0] === today);
        if (todayRows.length === 0) {
            return '오늘 체크리스트 기록 없음(로컬)';
        }
        const compact = todayRows
            .slice(-8)
            .map(parts => `${parts[1]}:${parts[2]}`)
            .join(', ');
        return compact;
    } catch (error) {
        return `체크리스트 조회 실패(원격/로컬): ${error.message}`;
    }
}

async function sendDigestToInbox() {
    const message = await buildDigestText();
    const payload = {
        taskId: `digest-${Date.now()}`,
        command: `[NOTIFY] ${message}`,
        timestamp: new Date().toISOString(),
        status: 'pending',
    };
    enqueueBridgePayload(payload);
    console.log('Digest queued to bridge inbox');
    return message;
}

if (require.main === module) {
    sendDigestToInbox()
        .then(msg => console.log(msg))
        .catch(err => {
            console.error('Digest failed:', err);
            process.exit(1);
        });
}

module.exports = { buildDigestText, sendDigestToInbox };
