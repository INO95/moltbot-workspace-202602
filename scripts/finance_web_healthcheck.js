const http = require('http');
const { spawnSync } = require('child_process');
const path = require('path');

const target = process.env.FINANCE_WEB_HEALTH_URL || 'http://127.0.0.1:18788/finance/api/finance/summary';

function check(urlText) {
    return new Promise((resolve, reject) => {
        const req = http.get(urlText, res => {
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            if (!ok) {
                reject(new Error(`HTTP ${res.statusCode}`));
                res.resume();
                return;
            }
            res.resume();
            resolve({ ok: true, statusCode: res.statusCode });
        });
        req.setTimeout(6000, () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', reject);
    });
}

function runOpsWorkerBestEffort() {
    const worker = path.join(__dirname, 'ops_host_worker.js');
    const r = spawnSync('node', [worker], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return;
    const msg = String(r.stderr || r.error || '').trim();
    if (msg) console.warn(`[ops-worker] ${msg}`);
}

function runNightlyAutopilotTriggerBestEffort() {
    if (String(process.env.SKIP_AUTOPILOT_TRIGGER || '') === '1') return;
    const trigger = path.join(__dirname, 'nightly_autopilot_trigger.js');
    const r = spawnSync('node', [trigger], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return;
    const msg = String(r.stderr || r.error || '').trim();
    if (msg) console.warn(`[nightly-trigger] ${msg}`);
}

async function main() {
    if (String(process.env.SKIP_OPS_WORKER || '') !== '1') {
        runOpsWorkerBestEffort();
    }
    const started = Date.now();
    const result = await check(target);
    const elapsedMs = Date.now() - started;
    console.log(JSON.stringify({ target, elapsedMs, ...result }));
    runNightlyAutopilotTriggerBestEffort();
}

if (require.main === module) {
    main().catch(error => {
        console.error(`finance web healthcheck failed: ${error.message}`);
        process.exit(1);
    });
}
