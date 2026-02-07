const fs = require('fs');
const path = require('path');
const blogAutomation = require('./blog_automation');

const reportsDir = path.join(__dirname, '../logs/reports');

function parseArgs(argv) {
    const out = {
        hours: 48,
        maxReports: 4,
        deploy: true,
        dryRun: false,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--no-deploy') out.deploy = false;
        else if (a === '--dry-run') {
            out.deploy = false;
            out.dryRun = true;
        } else if (a === '--hours' && argv[i + 1]) {
            out.hours = Math.max(1, Number(argv[i + 1]) || 48);
            i += 1;
        } else if (a === '--max' && argv[i + 1]) {
            out.maxReports = Math.max(1, Number(argv[i + 1]) || 4);
            i += 1;
        }
    }
    return out;
}

function listRecentReports(hours = 48) {
    if (!fs.existsSync(reportsDir)) return [];
    const cutoff = Date.now() - hours * 3600 * 1000;
    return fs
        .readdirSync(reportsDir)
        .map(name => path.join(reportsDir, name))
        .filter(p => fs.statSync(p).isFile() && p.endsWith('.md'))
        .filter(p => fs.statSync(p).mtimeMs >= cutoff)
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function summarizeReport(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean);
    const title = lines.find(l => l.startsWith('#')) || path.basename(filePath);
    const bullets = lines.filter(l => l.startsWith('-')).slice(0, 6);
    return {
        title: title.replace(/^#+\s*/, ''),
        bullets,
        file: path.basename(filePath),
    };
}

function buildKoreanPost(reports) {
    const date = new Date().toLocaleDateString('ko-KR');
    const lines = [
        `# AI 운영 로그 (${date})`,
        '',
        '## 핵심 결과',
    ];
    if (reports.length === 0) {
        lines.push('- 최근 리포트가 없어 자동 발행을 건너뜀');
        return lines.join('\n');
    }
    for (const report of reports) {
        lines.push(`### ${report.title}`);
        lines.push(`- Source: ${report.file}`);
        if (report.bullets.length === 0) {
            lines.push('- 요약 항목 없음');
        } else {
            for (const b of report.bullets) lines.push(b);
        }
        lines.push('');
    }
    lines.push('---');
    lines.push('자동 생성된 운영 기록입니다. (언어 순서: 한국어 → 일본어 → 영어)');
    return lines.join('\n');
}

async function publishFromReports() {
    const opts = parseArgs(process.argv);
    const files = listRecentReports(opts.hours).slice(0, opts.maxReports);
    if (files.length === 0) {
        return {
            skipped: true,
            reason: 'no_recent_reports',
            lookedBackHours: opts.hours,
            deploy: opts.deploy,
        };
    }

    // 원격 블로그 리포를 먼저 동기화해서 커밋 히스토리 충돌을 예방한다.
    blogAutomation.syncBlogRepo();

    const summaries = files.map(summarizeReport);
    const contentKo = buildKoreanPost(summaries);
    const title = `AI 운영 로그 ${new Date().toISOString().split('T')[0]}`;
    const posts = await blogAutomation.createMultilingualPost(title, contentKo, [
        'ai-log',
        'moltbot',
        'automation',
    ]);

    let deploy = null;
    if (opts.deploy) deploy = await blogAutomation.deployToGitHub();

    return {
        skipped: false,
        lookedBackHours: opts.hours,
        files,
        posts,
        deploy,
    };
}

if (require.main === module) {
    publishFromReports()
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => {
            console.error(error.message);
            process.exit(1);
        });
}

module.exports = { publishFromReports };
