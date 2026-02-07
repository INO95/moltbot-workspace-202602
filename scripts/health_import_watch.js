const fs = require('fs');
const path = require('path');
const {
    parseAppleHealthXml,
    parseMiFitnessCsv,
    importRecords,
} = require('./health_import');

const DEFAULT_INBOX = path.join(__dirname, '../data/health_import_inbox');
const DEFAULT_ARCHIVE = path.join(__dirname, '../data/health_import_archive');
const DEFAULT_FAILED = path.join(__dirname, '../data/health_import_failed');
const DEFAULT_LOG_PATH = path.join(__dirname, '../logs/health_import_watch_latest.json');

function parseArgs(argv) {
    const opts = {
        mode: 'scan',
        inbox: DEFAULT_INBOX,
        archive: DEFAULT_ARCHIVE,
        failed: DEFAULT_FAILED,
        logPath: DEFAULT_LOG_PATH,
        intervalSec: 30,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--watch') opts.mode = 'watch';
        else if (arg === '--scan') opts.mode = 'scan';
        else if (arg === '--inbox' && argv[i + 1]) {
            opts.inbox = path.resolve(argv[i + 1]);
            i += 1;
        } else if (arg === '--archive' && argv[i + 1]) {
            opts.archive = path.resolve(argv[i + 1]);
            i += 1;
        } else if (arg === '--failed' && argv[i + 1]) {
            opts.failed = path.resolve(argv[i + 1]);
            i += 1;
        } else if (arg === '--log' && argv[i + 1]) {
            opts.logPath = path.resolve(argv[i + 1]);
            i += 1;
        } else if (arg === '--interval' && argv[i + 1]) {
            opts.intervalSec = Math.max(5, Number(argv[i + 1]) || 30);
            i += 1;
        }
    }
    return opts;
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function detectModeByExt(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.xml') return 'apple';
    if (ext === '.csv') return 'mifitness';
    return null;
}

function parseHealthRecords(mode, raw) {
    if (mode === 'apple') return parseAppleHealthXml(raw);
    if (mode === 'mifitness') return parseMiFitnessCsv(raw);
    throw new Error(`unsupported_mode:${mode}`);
}

function nextMovePath(dstDir, srcName) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = srcName.replace(/[^\w.\-]+/g, '_');
    let candidate = path.join(dstDir, `${stamp}_${safeName}`);
    let idx = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dstDir, `${stamp}_${idx}_${safeName}`);
        idx += 1;
    }
    return candidate;
}

function moveFile(srcPath, dstDir) {
    ensureDir(dstDir);
    const dstPath = nextMovePath(dstDir, path.basename(srcPath));
    fs.renameSync(srcPath, dstPath);
    return dstPath;
}

function listCandidates(inboxDir) {
    ensureDir(inboxDir);
    return fs
        .readdirSync(inboxDir)
        .map(name => path.join(inboxDir, name))
        .filter(p => fs.existsSync(p) && fs.statSync(p).isFile())
        .filter(p => {
            const ext = path.extname(p).toLowerCase();
            return ext === '.xml' || ext === '.csv';
        })
        .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

function processFile(filePath, opts) {
    const mode = detectModeByExt(filePath);
    if (!mode) {
        return {
            file: filePath,
            ok: false,
            mode: null,
            reason: 'unsupported_extension',
        };
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const records = parseHealthRecords(mode, raw);
        const runningCount = (records.running || []).length;
        const sleepCount = (records.sleep || []).length;
        if (runningCount === 0 && sleepCount === 0) {
            throw new Error('no_parseable_records');
        }

        const imported = importRecords(records, mode);
        const movedTo = moveFile(filePath, opts.archive);
        return {
            file: filePath,
            ok: true,
            mode,
            parsed: { running: runningCount, sleep: sleepCount },
            imported,
            movedTo,
        };
    } catch (error) {
        const movedTo = moveFile(filePath, opts.failed);
        return {
            file: filePath,
            ok: false,
            mode,
            reason: String(error.message || error),
            movedTo,
        };
    }
}

function writeLog(logPath, payload) {
    ensureDir(path.dirname(logPath));
    fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), 'utf8');
}

function scanOnce(opts) {
    const candidates = listCandidates(opts.inbox);
    const results = candidates.map(filePath => processFile(filePath, opts));
    const summary = {
        scanned: candidates.length,
        ok: results.filter(x => x.ok).length,
        failed: results.filter(x => !x.ok).length,
    };
    const payload = {
        timestamp: new Date().toISOString(),
        mode: opts.mode,
        inbox: opts.inbox,
        archive: opts.archive,
        failedDir: opts.failed,
        summary,
        results,
    };
    writeLog(opts.logPath, payload);
    return payload;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
    const opts = parseArgs(process.argv);
    if (opts.mode === 'scan') {
        const payload = scanOnce(opts);
        console.log(JSON.stringify(payload, null, 2));
        return;
    }

    // watch mode: periodic polling for 안정적인 cron/systemd 운영.
    while (true) {
        const payload = scanOnce(opts);
        console.log(JSON.stringify(payload.summary));
        await sleep(opts.intervalSec * 1000);
    }
}

if (require.main === module) {
    run().catch(error => {
        console.error(String(error.message || error));
        process.exit(1);
    });
}

module.exports = {
    scanOnce,
    parseArgs,
};
