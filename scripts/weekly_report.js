/**
 * Weekly Report
 * - 체크리스트 주간 리포트
 */

const fs = require('fs');
const path = require('path');
const moltEngine = require('./molt_engine');

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

async function buildWeeklyReport() {
    const now = new Date();
    const date = now.toISOString().split('T')[0];

    let checklist = {};

    try {
        checklist = await moltEngine.getTodaySummary();
    } catch (e) {
        checklist = { error: `체크리스트 조회 실패: ${e.message}` };
    }

    const lines = [
        `# Weekly Report (${date})`,
        '',
        '## Checklist Snapshot',
        checklist.error
            ? `- ${checklist.error}`
            : Object.keys(checklist).length === 0
                ? '- 데이터 없음'
                : Object.entries(checklist).map(([k, v]) => `- ${k}: ${v || '-'}`).join('\n'),
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
