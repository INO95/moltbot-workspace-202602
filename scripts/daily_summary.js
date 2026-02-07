/**
 * Daily Summary
 * - 오늘 체크리스트 요약
 * - 이번 달 가계부 누계
 */

const fs = require('fs');
const path = require('path');
const moltEngine = require('./molt_engine');
const financeManager = require('./finance_manager');

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

async function buildDailySummary() {
    const now = new Date();
    const date = now.toISOString().split('T')[0];

    let checklist = {};
    let monthly = { income: 0, expense: 0, balance: 0 };
    let liabilities = {};

    try {
        checklist = await moltEngine.getTodaySummary();
    } catch (e) {
        checklist = { error: `체크리스트 조회 실패: ${e.message}` };
    }

    try {
        monthly = await moltEngine.getMonthlyStats();
    } catch (e) {
        const now = new Date();
        const local = financeManager.getStats(now.getFullYear(), now.getMonth() + 1);
        monthly = {
            ...local,
            effectiveExpense: Math.abs(local.expense || 0),
            source: 'local-db',
            error: `원격 조회 실패, 로컬 폴백 사용: ${e.message}`,
        };
    }

    try {
        liabilities = moltEngine.getCreditLiabilityStatus();
    } catch {
        liabilities = {};
    }

    const lines = [
        `# Daily Summary (${date})`,
        '',
        '## Checklist',
        Object.keys(checklist).length === 0
            ? '- 데이터 없음'
            : Object.entries(checklist).map(([k, v]) => `- ${k}: ${v || '-'}`).join('\n'),
        '',
        '## Monthly Finance',
        monthly.error
            ? [
                  `- ${monthly.error}`,
                  `- Income: ${monthly.income || 0}`,
                  `- Expense: ${monthly.expense || 0}`,
                  `- Effective Expense: ${monthly.effectiveExpense || 0}`,
                  `- Balance: ${monthly.balance || 0}`,
              ].join('\n')
            : [
                  `- Income: ${monthly.income}`,
                  `- Expense: ${monthly.expense}`,
                  `- Effective Expense: ${monthly.effectiveExpense}`,
                  `- Balance: ${monthly.balance}`,
              ].join('\n'),
        '',
        '## Credit Pending',
        Object.keys(liabilities).length === 0
            ? '- 없음'
            : Object.entries(liabilities).map(([k, v]) => `- ${k}: ${v}`).join('\n'),
        '',
    ];

    const output = lines.join('\n');
    const outDir = path.join(__dirname, '../logs/reports');
    ensureDir(outDir);
    const outPath = path.join(outDir, `daily-summary-${date}.md`);
    fs.writeFileSync(outPath, output, 'utf8');

    return { date, outPath, output };
}

if (require.main === module) {
    buildDailySummary()
        .then(({ outPath, output }) => {
            console.log(output);
            console.log(`Saved: ${outPath}`);
        })
        .catch(err => {
            console.error('Daily summary failed:', err);
            process.exit(1);
        });
}

module.exports = { buildDailySummary };
