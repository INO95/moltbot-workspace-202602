const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LOCK_DIR = path.join(__dirname, '../data/locks');
const LOCK_PATH = path.join(LOCK_DIR, 'codex_model_switch.lock');

const PREFERRED_CODEX_MODELS = [
    'openai-codex/gpt-5.3-codex',
    'openai-codex/gpt-5.2-codex',
    'openai-codex/gpt-5.2',
    'openai-codex/gpt-5.1-codex-max',
    'openai-codex/gpt-5.1',
];

function sleep(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        // Busy wait is fine for this short-lived CLI utility.
    }
}

function ensureLockDir() {
    if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });
}

function acquireLock(timeoutMs = 120000) {
    ensureLockDir();
    const start = Date.now();
    while (true) {
        try {
            const fd = fs.openSync(LOCK_PATH, 'wx');
            fs.writeFileSync(fd, String(process.pid), 'utf8');
            return fd;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Failed to acquire lock within ${timeoutMs}ms: ${LOCK_PATH}`);
            }
            sleep(200);
        }
    }
}

function releaseLock(fd) {
    try {
        if (typeof fd === 'number') fs.closeSync(fd);
    } catch {}
    try {
        if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
    } catch {}
}

function runDocker(args, options = {}) {
    const res = spawnSync('docker', ['exec', 'moltbot-main', ...args], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        ...options,
    });
    if (res.status !== 0) {
        const stderr = String(res.stderr || '').trim();
        const stdout = String(res.stdout || '').trim();
        throw new Error(`docker exec failed: ${stderr || stdout || 'unknown error'}`);
    }
    return String(res.stdout || '');
}

function getDefaultModel() {
    return runDocker(['node', 'dist/index.js', 'models', 'status', '--plain']).trim();
}

function listCodexModels() {
    const out = runDocker([
        'node',
        'dist/index.js',
        'models',
        'list',
        '--all',
        '--provider',
        'openai-codex',
        '--plain',
    ]);
    return out
        .split('\n')
        .map(v => v.trim())
        .filter(Boolean);
}

function chooseBestCodexModel(available) {
    for (const m of PREFERRED_CODEX_MODELS) {
        if (available.includes(m)) return m;
    }
    return null;
}

function setDefaultModel(model) {
    runDocker(['node', 'dist/index.js', 'models', 'set', model]);
}

function parseAgentText(jsonText) {
    const parsed = JSON.parse(jsonText);
    const payloads = (((parsed || {}).result || {}).payloads || []);
    if (!Array.isArray(payloads) || payloads.length === 0) {
        throw new Error('Agent payload is empty');
    }
    const text = String(payloads[0].text || '').trim();
    if (!text) throw new Error('Agent returned empty text');
    return text;
}

function extractJsonObject(rawText) {
    const t = String(rawText || '').trim();
    try {
        return JSON.parse(t);
    } catch {}

    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
        try {
            return JSON.parse(fenced[1]);
        } catch {}
    }

    const firstBrace = t.indexOf('{');
    const lastBrace = t.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        const candidate = t.slice(firstBrace, lastBrace + 1);
        return JSON.parse(candidate);
    }
    throw new Error('Failed to parse JSON translation output');
}

function buildTranslatePrompt(sourceLang, targetLang, title, content) {
    return [
        'You are a professional translator for engineering operation logs.',
        `Translate from ${sourceLang} to ${targetLang}.`,
        'Rules:',
        '- Preserve markdown structure exactly (headings, bullets, code fences, tables).',
        '- Do not add or remove facts.',
        '- Keep numbers, dates, currencies, code identifiers, file paths, and product names unchanged.',
        '- Keep line breaks as natural markdown in the target language.',
        '- Return JSON only with keys: title, content.',
        '',
        'Input JSON:',
        JSON.stringify({ title, content }),
    ].join('\n');
}

function translateWithCodex({ sourceLang, targetLang, title, content, thinking = 'high' }) {
    const lockFd = acquireLock();
    let originalModel = '';
    let codexModel = '';
    try {
        originalModel = getDefaultModel();
        const availableCodex = listCodexModels();
        codexModel = chooseBestCodexModel(availableCodex);
        if (!codexModel) {
            throw new Error('No openai-codex model available in OpenClaw catalog');
        }

        if (originalModel !== codexModel) {
            setDefaultModel(codexModel);
        }

        const sessionId = `translate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const prompt = buildTranslatePrompt(sourceLang, targetLang, title, content);
        const out = runDocker([
            'node',
            'dist/index.js',
            'agent',
            '--session-id',
            sessionId,
            '--message',
            prompt,
            '--thinking',
            thinking,
            '--json',
        ]);

        const text = parseAgentText(out);
        const json = extractJsonObject(text);
        return {
            model: codexModel,
            title: String(json.title || '').trim(),
            content: String(json.content || '').trim(),
        };
    } finally {
        try {
            if (originalModel && codexModel && originalModel !== codexModel) {
                setDefaultModel(originalModel);
            }
        } finally {
            releaseLock(lockFd);
        }
    }
}

function parseArgs(argv) {
    const args = { source: 'Korean', target: '', title: '', content: '', thinking: 'high' };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--source') args.source = argv[++i] || args.source;
        else if (a === '--target') args.target = argv[++i] || '';
        else if (a === '--title') args.title = argv[++i] || '';
        else if (a === '--content') args.content = argv[++i] || '';
        else if (a === '--thinking') args.thinking = argv[++i] || 'high';
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.target || !args.title || !args.content) {
        console.error('Usage: node scripts/codex_oauth_translate.js --target <language> --title "<title>" --content "<markdown>" [--source Korean] [--thinking high]');
        process.exit(1);
    }
    const result = translateWithCodex({
        sourceLang: args.source,
        targetLang: args.target,
        title: args.title,
        content: args.content,
        thinking: args.thinking,
    });
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

module.exports = { translateWithCodex };
