const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const logPath = path.join(root, 'logs/private_sync_retry_latest.json');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
    return new Date().toISOString();
}

function parseArgs(argv) {
    const opts = {
        retries: 3,
        delaySec: 20,
        maxDelaySec: 300,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--retries' && argv[i + 1]) {
            opts.retries = Math.max(1, Number(argv[i + 1]) || 3);
            i += 1;
        } else if (a === '--delay' && argv[i + 1]) {
            opts.delaySec = Math.max(1, Number(argv[i + 1]) || 20);
            i += 1;
        } else if (a === '--max-delay' && argv[i + 1]) {
            opts.maxDelaySec = Math.max(1, Number(argv[i + 1]) || 300);
            i += 1;
        }
    }
    return opts;
}

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function runSync() {
    const startedAt = Date.now();
    try {
        const stdout = execSync('npm run -s private:sync', {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).toString('utf8');
        let parsed = null;
        try {
            parsed = JSON.parse(stdout);
        } catch {
            // Keep parsed as null; command still succeeded.
        }
        return {
            ok: true,
            durationMs: Date.now() - startedAt,
            stdout,
            parsed,
        };
    } catch (error) {
        return {
            ok: false,
            durationMs: Date.now() - startedAt,
            stdout: String(error.stdout || ''),
            stderr: String(error.stderr || ''),
            message: String(error.message || error),
        };
    }
}

async function main() {
    const opts = parseArgs(process.argv);
    const attempts = [];
    let delaySec = opts.delaySec;

    for (let i = 1; i <= opts.retries; i += 1) {
        const result = runSync();
        attempts.push({
            try: i,
            at: nowIso(),
            ...result,
        });
        if (result.ok) {
            const payload = {
                ok: true,
                attempts,
                retries: opts.retries,
            };
            ensureDir(logPath);
            fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), 'utf8');
            console.log(JSON.stringify(payload, null, 2));
            return;
        }
        if (i < opts.retries) {
            await sleep(delaySec * 1000);
            delaySec = Math.min(opts.maxDelaySec, delaySec * 2);
        }
    }

    const payload = {
        ok: false,
        attempts,
        retries: opts.retries,
        note: 'private sync failed after retries',
    };
    ensureDir(logPath);
    fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), 'utf8');
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
}

if (require.main === module) {
    main().catch(error => {
        console.error(String(error.message || error));
        process.exit(1);
    });
}

