/**
 * Daily Summary
 * - 오늘 체크리스트 요약
 */

const fs = require('fs');
const path = require('path');
const moltEngine = require('./molt_engine');

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

async function buildDailySummary() {
    const now = new Date();
    const date = now.toISOString().split('T')[0];

    let checklist = {};

    try {
        checklist = await moltEngine.getTodaySummary();
    } catch (e) {
        checklist = { error: `체크리스트 조회 실패: ${e.message}` };
    }

    const lines = [
        `# Daily Summary (${date})`,
        '',
        '## Checklist',
        Object.keys(checklist).length === 0
            ? '- 데이터 없음'
            : Object.entries(checklist).map(([k, v]) => `- ${k}: ${v || '-'}`).join('\n'),
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
