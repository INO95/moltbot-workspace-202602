/**
 * Weekly Report
 * - 월간 가계부 누계
 * - 건강 대시보드(데이터 없는 경우 기본 메시지)
 */

const fs = require('fs');
const path = require('path');
const moltEngine = require('./molt_engine');
const healthCapture = require('./health_capture');
const financeManager = require('./finance_manager');

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

async function buildWeeklyReport() {
    const now = new Date();
    const date = now.toISOString().split('T')[0];

    let monthly = { income: 0, expense: 0, balance: 0, byCategory: {}, effectiveExpense: 0 };
    let health = null;
    let liabilities = {};

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
        health = healthCapture.getMonthlySummary();
    } catch (e) {
        health = { error: `건강 대시보드 조회 실패: ${e.message}` };
    }

    try {
        liabilities = moltEngine.getCreditLiabilityStatus();
    } catch {
        liabilities = {};
    }

    const categoryText =
        monthly.error || !monthly.byCategory
            ? '- 없음'
            : Object.entries(monthly.byCategory)
                  .sort((a, b) => a[1] - b[1])
                  .map(([k, v]) => `- ${k}: ${v}`)
                  .join('\n');

    const lines = [
        `# Weekly Report (${date})`,
        '',
        '## Monthly Finance Snapshot',
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
            : Object.entries(liabilities)
                  .map(([k, v]) => `- ${k}: ${v}`)
                  .join('\n'),
        '',
        '## Category Breakdown',
        categoryText,
        '',
        '## Health',
        health.error
            ? `- ${health.error}`
            : [
                  `- Running: ${health.running.sessions} sessions / ${health.running.distanceKm} km`,
                  `- Workout: ${health.workouts.sessions} sessions / ${health.workouts.totalVolumeKg} kg volume`,
                  `- Missing Areas: ${(health.workouts.missingAreas || []).join(', ') || '없음'}`,
              ].join('\n'),
        '',
    ];

    const output = lines.join('\n');
    const outDir = path.join(__dirname, '../logs/reports');
    ensureDir(outDir);
    const outPath = path.join(outDir, `weekly-report-${date}.md`);
    fs.writeFileSync(outPath, output, 'utf8');

    return { date, outPath, output };
}

if (require.main === module) {
    buildWeeklyReport()
        .then(({ outPath, output }) => {
            console.log(output);
            console.log(`Saved: ${outPath}`);
        })
        .catch(err => {
            console.error('Weekly report failed:', err);
            process.exit(1);
        });
}

module.exports = { buildWeeklyReport };
