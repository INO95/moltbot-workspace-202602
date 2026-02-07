const fs = require('fs');
const path = require('path');

const reportsDir = path.join(__dirname, '../logs/reports');
const defaultTemplatePath = path.join(__dirname, '../policies/blog_category_template.json');

function parseArgs(argv) {
    const out = {
        hours: 48,
        maxReports: 6,
        templatePath: defaultTemplatePath,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--hours' && argv[i + 1]) {
            out.hours = Math.max(1, Number(argv[i + 1]) || 48);
            i += 1;
        } else if (a === '--max' && argv[i + 1]) {
            out.maxReports = Math.max(1, Number(argv[i + 1]) || 6);
            i += 1;
        } else if (a === '--template' && argv[i + 1]) {
            out.templatePath = path.resolve(argv[i + 1]);
            i += 1;
        }
    }
    return out;
}

function loadTemplate(templatePath) {
    if (!fs.existsSync(templatePath)) {
        return {
            defaultCategories: ['memoir', 'automation'],
            categoryRules: [],
        };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
        return {
            defaultCategories: Array.isArray(raw.defaultCategories) ? raw.defaultCategories : ['memoir', 'automation'],
            categoryRules: Array.isArray(raw.categoryRules) ? raw.categoryRules : [],
            sectionTemplates: typeof raw.sectionTemplates === 'object' && raw.sectionTemplates ? raw.sectionTemplates : {},
        };
    } catch {
        return {
            defaultCategories: ['memoir', 'automation'],
            categoryRules: [],
            sectionTemplates: {},
        };
    }
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

function extractBullets(lines) {
    return lines
        .filter(line => line.startsWith('- '))
        .map(line => line.replace(/^- /, '').trim())
        .map(line => sanitizeBullet(line))
        .filter(Boolean);
}

function sanitizeBullet(line) {
    let out = String(line || '');
    // Noise reduction: network error internals are too verbose for memoir-style posts.
    out = out.replace(/request to https?:\/\/\S+ failed, reason:\s*/gi, '요청 실패: ');
    out = out.replace(/getaddrinfo ENOTFOUND\s+\S+/gi, '네트워크 DNS 실패');
    out = out.replace(/\s{2,}/g, ' ').trim();
    if (out.length > 180) out = `${out.slice(0, 177)}...`;
    return out;
}

function summarizeReport(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    const titleLine = lines.find(line => line.startsWith('#')) || path.basename(filePath);
    const title = titleLine.replace(/^#+\s*/, '').trim();
    const bullets = extractBullets(lines).slice(0, 7);
    const sections = lines.filter(line => line.startsWith('## ')).map(line => line.replace(/^##\s*/, ''));
    return {
        file: path.basename(filePath),
        title,
        bullets,
        sections,
        raw,
    };
}

function resolveCategories(text, template) {
    const hit = new Set(template.defaultCategories || []);
    const lower = String(text || '').toLowerCase();
    for (const rule of template.categoryRules || []) {
        const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
        if (!rule.category || keywords.length === 0) continue;
        if (keywords.some(keyword => lower.includes(String(keyword).toLowerCase()))) {
            hit.add(rule.category);
        }
    }
    return [...hit];
}

function collectActionItems(reportSummaries) {
    const items = [];
    for (const report of reportSummaries) {
        for (const bullet of report.bullets) {
            if (/실패|error|todo|확인|필요|미완|대기/i.test(bullet)) {
                items.push(bullet);
            }
        }
    }
    return items.slice(0, 8);
}

function buildMemoirMarkdown(dateLabel, reportSummaries, categories, template = {}) {
    const lines = [];
    lines.push(`# 작업 비망록 (${dateLabel})`);
    lines.push('');
    lines.push('## 오늘 한 일 한눈에 보기');
    if (reportSummaries.length === 0) {
        lines.push('- 최근 리포트가 없어 자동 정리를 건너뜀');
    } else {
        for (const report of reportSummaries) {
            const oneLine = report.bullets[0] || '핵심 항목 없음';
            lines.push(`- ${report.title}: ${oneLine}`);
        }
    }
    lines.push('');

    lines.push('## 카테고리');
    lines.push(`- ${categories.join(', ')}`);
    lines.push('');

    const sectionTemplates = template.sectionTemplates || {};
    const categoryHints = categories
        .map(category => String(sectionTemplates[category] || '').trim())
        .filter(Boolean);
    if (categoryHints.length > 0) {
        lines.push('## 카테고리 포인트');
        for (const hint of categoryHints) {
            lines.push(`- ${hint}`);
        }
        lines.push('');
    }

    lines.push('## 세부 정리');
    for (const report of reportSummaries) {
        lines.push(`### ${report.title}`);
        if (report.bullets.length === 0) {
            lines.push('- 요약 포인트 없음');
        } else {
            for (const bullet of report.bullets) {
                lines.push(`- ${bullet}`);
            }
        }
        lines.push('');
    }

    const actionItems = collectActionItems(reportSummaries);
    lines.push('## 다음 액션');
    if (actionItems.length === 0) {
        lines.push('- 실패/대기 항목 없음');
    } else {
        for (const action of actionItems) {
            lines.push(`- ${action}`);
        }
    }
    lines.push('');

    lines.push('## 참고 로그');
    if (reportSummaries.length === 0) {
        lines.push('- 없음');
    } else {
        for (const report of reportSummaries) {
            lines.push(`- ${report.file}`);
        }
    }
    lines.push('');
    lines.push('---');
    lines.push('자동 생성된 비망록형 작업 요약입니다.');
    return lines.join('\n');
}

function buildMemoirPost({ hours = 48, maxReports = 6, templatePath = defaultTemplatePath } = {}) {
    const template = loadTemplate(templatePath);
    const files = listRecentReports(hours).slice(0, maxReports);
    const summaries = files.map(summarizeReport);
    const combinedText = summaries.map(s => `${s.title}\n${s.raw}`).join('\n');
    const categories = resolveCategories(combinedText, template);

    const now = new Date();
    const dateIso = now.toISOString().split('T')[0];
    const dateLabel = now.toLocaleDateString('ko-KR');
    const title = `작업 비망록 ${dateIso}`;
    const contentKo = buildMemoirMarkdown(dateLabel, summaries, categories, template);

    return {
        title,
        contentKo,
        categories,
        tags: ['memoir', 'ops-log', 'moltbot'],
        files,
        summaries,
    };
}

if (require.main === module) {
    const opts = parseArgs(process.argv);
    const result = buildMemoirPost(opts);
    console.log(JSON.stringify({
        title: result.title,
        categories: result.categories,
        files: result.files,
        preview: result.contentKo.split('\n').slice(0, 28).join('\n'),
    }, null, 2));
}

module.exports = {
    buildMemoirPost,
    parseArgs,
};
