const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function runCmd(cmd) {
    try {
        const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
        return { ok: true, output: out };
    } catch (error) {
        return {
            ok: false,
            output: (error.stderr || error.stdout || error.message || '').toString().trim(),
        };
    }
}

function checkFile(filePath) {
    const exists = fs.existsSync(filePath);
    return { path: filePath, exists };
}

function run() {
    const now = new Date().toISOString();
    const root = path.join(__dirname, '..');

    const checks = {
        timestamp: now,
        ghAuth: runCmd('gh auth status'),
        dockerPs: runCmd('docker ps --format "{{.Names}}"'),
        nodeVersion: runCmd('node -v'),
        files: [
            checkFile(path.join(root, 'data/config.json')),
            checkFile(path.join(root, 'data/secure/google_creds.json')),
            checkFile(path.join(root, 'scripts/molt_engine.js')),
            checkFile(path.join(root, 'scripts/prompt_form_webapp.js')),
        ],
    };

    const names = checks.dockerPs.ok ? checks.dockerPs.output.split('\n').filter(Boolean) : [];
    checks.moltbotContainer = {
        detected: names.includes('moltbot-dev'),
        names,
    };

    const logsDir = path.join(root, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const latest = path.join(logsDir, 'system_healthcheck_latest.json');
    fs.writeFileSync(latest, JSON.stringify(checks, null, 2), 'utf8');

    const summary = {
        ok:
            checks.nodeVersion.ok &&
            checks.files.every((f) => f.exists) &&
            checks.moltbotContainer.detected,
        latest,
        ghAuthOk: checks.ghAuth.ok,
        containerDetected: checks.moltbotContainer.detected,
    };

    console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
    run();
}
