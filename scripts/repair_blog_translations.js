const fs = require('fs');
const path = require('path');
const blogAutomation = require('./blog_automation');

const POSTS_DIR = path.join(__dirname, '..', 'blog', '_posts');

function listFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => path.join(dir, name));
}

function parseFrontMatter(raw) {
    const text = String(raw || '');
    const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return { front: {}, body: text };
    const frontBlock = m[1];
    const body = m[2] || '';
    const front = {};
    for (const line of frontBlock.split('\n')) {
        const mm = line.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
        if (!mm) continue;
        front[mm[1]] = mm[2];
    }
    return { front, body };
}

function buildFrontMatter(frontObj) {
    const lines = ['---'];
    const keys = ['layout', 'title', 'date', 'categories', 'tags', 'lang'];
    for (const key of keys) {
        if (frontObj[key] == null) continue;
        lines.push(`${key}: ${frontObj[key]}`);
    }
    lines.push('---', '');
    return lines.join('\n');
}

function hasBrokenTranslation(langCode, frontTitle, body) {
    const title = String(frontTitle || '');
    const content = String(body || '');
    if (langCode === 'ja' && /^\[JA\]/.test(title)) return true;
    if (langCode === 'en' && /^\[EN\]/.test(title)) return true;
    const compact = content.replace(/\s+/g, '');
    if (!compact) return true;
    const hangul = (compact.match(/[가-힣]/g) || []).length;
    const ratio = hangul / compact.length;
    if (langCode === 'en') return ratio > 0.15;
    if (langCode === 'ja') return ratio > 0.25;
    return false;
}

async function repairOne(filePath, langCode) {
    const koPath = path.join(POSTS_DIR, 'ko', path.basename(filePath));
    if (!fs.existsSync(koPath)) {
        return { ok: false, file: filePath, reason: 'missing_ko_pair' };
    }

    const targetRaw = fs.readFileSync(filePath, 'utf8');
    const koRaw = fs.readFileSync(koPath, 'utf8');
    const target = parseFrontMatter(targetRaw);
    const ko = parseFrontMatter(koRaw);
    const koTitle = String((ko.front.title || '').replace(/^"|"$/g, '')).trim();
    const koBody = String(ko.body || '').trim();

    const targetLangName = langCode === 'ja' ? 'Japanese' : 'English';
    const translated = await blogAutomation.translateOrFallback(targetLangName, koTitle, koBody);
    if (!translated || !translated.title || !translated.content) {
        return { ok: false, file: filePath, reason: 'translation_empty' };
    }

    const nextFront = { ...target.front };
    nextFront.title = `"${translated.title.replace(/"/g, '\\"')}"`;
    nextFront.lang = langCode;
    const next = `${buildFrontMatter(nextFront)}\n${translated.content}\n`;
    fs.writeFileSync(filePath, next, 'utf8');
    return { ok: true, file: filePath };
}

async function main() {
    const max = Math.max(1, Number(process.argv[2] || '20'));
    const jaFiles = listFiles(path.join(POSTS_DIR, 'ja'));
    const enFiles = listFiles(path.join(POSTS_DIR, 'en'));
    const candidates = [];

    for (const f of jaFiles) {
        const parsed = parseFrontMatter(fs.readFileSync(f, 'utf8'));
        if (hasBrokenTranslation('ja', parsed.front.title, parsed.body)) {
            candidates.push({ file: f, lang: 'ja' });
        }
    }
    for (const f of enFiles) {
        const parsed = parseFrontMatter(fs.readFileSync(f, 'utf8'));
        if (hasBrokenTranslation('en', parsed.front.title, parsed.body)) {
            candidates.push({ file: f, lang: 'en' });
        }
    }

    const picked = candidates.slice(0, max);
    const results = [];
    for (const item of picked) {
        // sequential to avoid model/context race on translation backend
        // and to keep cost deterministic.
        /* eslint-disable no-await-in-loop */
        const r = await repairOne(item.file, item.lang);
        results.push(r);
    }

    const ok = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    console.log(JSON.stringify({
        scanned: candidates.length,
        processed: results.length,
        ok,
        fail,
        results,
    }, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}

