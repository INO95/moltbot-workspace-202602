const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const blogAutomation = require('./blog_automation');
const { buildMemoirPost } = require('./blog_memoir_builder');
const { syncBlogMemoToNotion } = require('./notion_blog_sync');

const reportsDir = path.join(__dirname, '../logs/reports');
const publishStatePath = path.join(__dirname, '../data/blog_publish_state.json');
const allowedModes = ['log', 'briefing', 'project'];

function normalizeMode(input) {
    const mode = String(input || '').trim().toLowerCase();
    if (allowedModes.includes(mode)) return mode;
    return 'briefing';
}

function parseLangsArg(value) {
    if (!value) return [];
    return String(value)
        .split(',')
        .map(x => x.trim().toLowerCase())
        .filter(Boolean)
        .filter((x, idx, arr) => arr.indexOf(x) === idx)
        .filter(x => ['en', 'ja', 'ko'].includes(x));
}

function getDefaultLangsForMode(mode) {
    if (normalizeMode(mode) === 'log') return ['en'];
    return ['en', 'ja', 'ko'];
}

function shouldSyncToNotion({ category, lang }) {
    return String(category || '') === 'project' && String(lang || '') === 'en';
}

function parseArgs(argv) {
    const out = {
        hours: 48,
        maxReports: 4,
        deploy: true,
        dryRun: false,
        mode: 'briefing',
        langs: [],
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
        } else if (a === '--mode' && argv[i + 1]) {
            out.mode = normalizeMode(argv[i + 1]);
            i += 1;
        } else if (a === '--langs' && argv[i + 1]) {
            out.langs = parseLangsArg(argv[i + 1]);
            i += 1;
        }
    }
    if (!out.langs.length) out.langs = getDefaultLangsForMode(out.mode);
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

function buildSourceKey(files) {
    const basis = (files || [])
        .map((p) => {
            try {
                const st = fs.statSync(p);
                return `${path.basename(p)}:${Math.trunc(st.mtimeMs)}:${st.size}`;
            } catch {
                return path.basename(p);
            }
        })
        .join('|');
    return crypto.createHash('sha256').update(basis).digest('hex');
}

function loadPublishState() {
    try {
        if (!fs.existsSync(publishStatePath)) return {};
        return JSON.parse(fs.readFileSync(publishStatePath, 'utf8'));
    } catch {
        return {};
    }
}

function savePublishState(next) {
    fs.writeFileSync(publishStatePath, JSON.stringify(next, null, 2), 'utf8');
}

function buildModeTitle(mode, isoDate) {
    if (mode === 'log') return `Work Log ${isoDate}`;
    if (mode === 'project') return `Project Update ${isoDate}`;
    return `Daily Briefing ${isoDate}`;
}

async function buildEnglishSource(memoir, mode) {
    const isoDate = new Date().toISOString().slice(0, 10);
    const translated = await blogAutomation.translateOrFallback(
        'English',
        memoir.title,
        memoir.contentKo,
        'Korean',
    );
    const title = buildModeTitle(mode, isoDate);
    const markdown = String(translated && translated.content ? translated.content : memoir.contentKo).trim();
    return {
        title,
        markdown,
    };
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
    const sourceKey = buildSourceKey([...files, `mode:${opts.mode}`, `langs:${opts.langs.join(',')}`]);
    const state = loadPublishState();
    const stateKey = `h${opts.hours}-m${opts.maxReports}-${opts.mode}-${opts.langs.join('_')}`;
    if (!opts.dryRun && state[stateKey] && state[stateKey].sourceKey === sourceKey) {
        return {
            skipped: true,
            reason: 'same_source_reports_already_published',
            lookedBackHours: opts.hours,
            files,
            sourceKey,
            lastPublishedAt: state[stateKey].publishedAt || null,
            deploy: opts.deploy,
        };
    }

    // 원격 블로그 리포를 먼저 동기화해서 커밋 히스토리 충돌을 예방한다.
    blogAutomation.syncBlogRepo();

    const memoir = buildMemoirPost({
        hours: opts.hours,
        maxReports: opts.maxReports,
    });
    const source = await buildEnglishSource(memoir, opts.mode);
    const posts = await blogAutomation.createMultilingualPost(source.title, source.markdown, [
        ...(memoir.tags || []),
    ], {
        categories: [opts.mode],
        sourceLang: 'en',
        langs: opts.langs,
        skipTranslation: Boolean(opts.dryRun),
    });

    const enPost = posts.find(p => p.includes(`${path.sep}en${path.sep}`)) || posts[0] || '';
    const slug = enPost ? path.basename(enPost, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '') : '';
    let notion = { synced: false, skipped: true, reason: 'policy_filtered' };
    if (shouldSyncToNotion({ category: opts.mode, lang: 'en' })) {
        notion = await syncBlogMemoToNotion({
            slug,
            title: source.title,
            markdown: source.markdown,
            categories: [opts.mode],
            lang: 'en',
            tags: memoir.tags || [],
            sourceFiles: memoir.files || files,
        });
    }

    let deploy = null;
    if (opts.deploy) deploy = await blogAutomation.deployToGitHub();

    if (!opts.dryRun) {
        state[stateKey] = {
            sourceKey,
            publishedAt: new Date().toISOString(),
            files: files.map((f) => path.basename(f)),
            posts,
            mode: opts.mode,
            langs: opts.langs,
        };
        savePublishState(state);
    }

    return {
        skipped: false,
        lookedBackHours: opts.hours,
        files,
        posts,
        mode: opts.mode,
        langs: opts.langs,
        notion,
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

module.exports = {
    parseArgs,
    getDefaultLangsForMode,
    shouldSyncToNotion,
    publishFromReports,
};
