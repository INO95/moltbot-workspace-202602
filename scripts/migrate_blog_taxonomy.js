const fs = require('fs');
const path = require('path');

const postsRoot = path.join(__dirname, '../blog/_posts');
const languages = ['en', 'ja', 'ko'];
const reportPathDefault = path.join(__dirname, '../logs/blog_taxonomy_migration_latest.json');

const projectKeywords = [
    'portfolio', 'project', '포트폴리오', '프로젝트', 'case study', 'integration', 'showcase',
];
const logKeywords = [
    'work log', 'daily log', 'ops log', 'ops-log', '운영 로그', '활용 일지', '작업 로그', '일지',
];
const briefingKeywords = [
    'briefing', '비망록', '브리핑', 'memoir', 'daily briefing', '작업 정리',
];

function parseArgs(argv) {
    const out = {
        apply: false,
        reportPath: reportPathDefault,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--apply') out.apply = true;
        else if (a === '--report' && argv[i + 1]) {
            out.reportPath = path.resolve(argv[i + 1]);
            i += 1;
        }
    }
    return out;
}

function listPostFiles() {
    const files = [];
    for (const lang of languages) {
        const dir = path.join(postsRoot, lang);
        if (!fs.existsSync(dir)) continue;
        const names = fs.readdirSync(dir).filter(name => name.endsWith('.md'));
        for (const name of names) files.push(path.join(dir, name));
    }
    return files.sort();
}

function parseFrontMatter(raw) {
    const m = String(raw || '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) {
        return {
            hasFrontMatter: false,
            frontMap: {},
            body: String(raw || ''),
        };
    }
    const frontMap = {};
    const lines = m[1].split('\n');
    for (const line of lines) {
        const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (!mm) continue;
        frontMap[mm[1]] = mm[2];
    }
    return {
        hasFrontMatter: true,
        frontMap,
        body: m[2] || '',
    };
}

function parseArrayLike(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return [];
    if (raw.startsWith('[') && raw.endsWith(']')) {
        return raw.slice(1, -1)
            .split(',')
            .map(x => x.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, ''))
            .filter(Boolean);
    }
    return [raw.replace(/^"|"$/g, '').replace(/^'|'$/g, '')];
}

function classifyCategory(title, body, currentCategories = []) {
    const titleLower = String(title || '').toLowerCase();
    const bodyLower = String(body || '').toLowerCase();
    const categoriesLower = (currentCategories || []).map(x => String(x || '').toLowerCase());
    const bag = `${titleLower}\n${bodyLower}\n${categoriesLower.join(' ')}`;

    if (projectKeywords.some(k => bag.includes(String(k).toLowerCase()))) return 'project';

    // 제목/기존 카테고리에서 로그 신호가 명확하면 briefing보다 우선한다.
    if (logKeywords.some(k => titleLower.includes(String(k).toLowerCase()))) return 'log';
    if (categoriesLower.some(x => ['daily-log', 'ops-log', 'log'].includes(x))) return 'log';

    // 제목/기존 카테고리에서 briefing 신호가 명확한 경우.
    if (briefingKeywords.some(k => titleLower.includes(String(k).toLowerCase()))) return 'briefing';
    if (categoriesLower.some(x => ['memoir', 'briefing'].includes(x))) return 'briefing';

    // 본문 신호는 제목보다 신뢰도가 낮아 후순위로 판정한다.
    if (logKeywords.some(k => bodyLower.includes(String(k).toLowerCase()))) return 'log';
    if (briefingKeywords.some(k => bodyLower.includes(String(k).toLowerCase()))) return 'briefing';

    return 'log';
}

function buildFrontMatter(frontMap, lang, category, published) {
    const map = { ...frontMap };
    map.categories = `[${category}]`;
    map.lang = lang;
    if (published == null) delete map.published;
    else map.published = published ? 'true' : 'false';

    const preferred = ['layout', 'title', 'date', 'categories', 'tags', 'lang', 'published'];
    const unknown = Object.keys(map).filter(k => !preferred.includes(k)).sort();
    const keys = [...preferred.filter(k => Object.prototype.hasOwnProperty.call(map, k)), ...unknown];
    const lines = ['---'];
    for (const key of keys) {
        lines.push(`${key}: ${map[key]}`);
    }
    lines.push('---', '');
    return lines.join('\n');
}

function migrateFile(filePath, apply) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = parseFrontMatter(raw);
    if (!parsed.hasFrontMatter) {
        return {
            filePath,
            changed: false,
            reason: 'missing_front_matter',
        };
    }

    const lang = path.basename(path.dirname(filePath));
    const currentCategories = parseArrayLike(parsed.frontMap.categories);
    const title = String(parsed.frontMap.title || '').replace(/^"|"$/g, '');
    const category = classifyCategory(title, parsed.body, currentCategories);
    const published = (category === 'log' && lang !== 'en') ? false : null;
    const next = `${buildFrontMatter(parsed.frontMap, lang, category, published)}${parsed.body}`;
    const changed = next !== raw;

    if (apply && changed) fs.writeFileSync(filePath, next, 'utf8');

    return {
        filePath,
        changed,
        lang,
        category,
        published,
        beforeCategories: currentCategories,
    };
}

function migrateTaxonomy({ apply = false, reportPath = reportPathDefault } = {}) {
    const files = listPostFiles();
    const results = files.map(filePath => migrateFile(filePath, apply));
    const summary = {
        scanned: files.length,
        changed: results.filter(x => x.changed).length,
        byCategory: {
            log: results.filter(x => x.category === 'log').length,
            briefing: results.filter(x => x.category === 'briefing').length,
            project: results.filter(x => x.category === 'project').length,
        },
        unpublishedLogLocalized: results.filter(x => x.category === 'log' && x.lang !== 'en' && x.published === false).length,
        apply,
    };

    const payload = {
        generatedAt: new Date().toISOString(),
        summary,
        results,
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2), 'utf8');
    return payload;
}

if (require.main === module) {
    const opts = parseArgs(process.argv);
    const out = migrateTaxonomy({ apply: opts.apply, reportPath: opts.reportPath });
    console.log(JSON.stringify({
        summary: out.summary,
        reportPath: opts.reportPath,
    }, null, 2));
}

module.exports = {
    classifyCategory,
    migrateTaxonomy,
};
