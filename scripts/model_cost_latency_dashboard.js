const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { inferRouteFromCommand, decideApiLane, loadRoutingPolicy } = require('./oai_api_router');

const DASHBOARD_JSON_PATH = path.join(__dirname, '../logs/model_cost_latency_dashboard_latest.json');
const DASHBOARD_MD_PATH = path.join(__dirname, '../logs/model_cost_latency_dashboard_latest.md');
const HISTORY_JSONL_PATH = path.join(__dirname, '../logs/model_cost_latency_history.jsonl');
const BRIDGE_LOG_PATH = path.join(__dirname, '../data/bridge/inbox.jsonl');
const CONFIG_PATH = path.join(__dirname, '../data/config.json');

const LOCK_DIR = path.join(__dirname, '../data/locks');
const LOCK_PATH = path.join(LOCK_DIR, 'model_benchmark.lock');
const CODEX_PREFERRED = [
    'openai-codex/gpt-5.3-codex',
    'openai-codex/gpt-5.2-codex',
    'openai-codex/gpt-5.2',
    'openai-codex/gpt-5.1-codex-max',
    'openai-codex/gpt-5.1',
];

function ensureDirFor(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function runDocker(args, options = {}) {
    const result = spawnSync('docker', ['exec', 'moltbot-dev', ...args], {
        encoding: 'utf8',
        maxBuffer: 30 * 1024 * 1024,
        ...options,
    });
    if (result.status !== 0) {
        const stderr = String(result.stderr || '').trim();
        const stdout = String(result.stdout || '').trim();
        throw new Error(`docker exec failed: ${stderr || stdout || 'unknown error'}`);
    }
    return String(result.stdout || '');
}

function sleep(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        // short busy wait for lock retry loop.
    }
}

function acquireLock(timeoutMs = 90000) {
    ensureDirFor(LOCK_PATH);
    const start = Date.now();
    while (true) {
        try {
            const fd = fs.openSync(LOCK_PATH, 'wx');
            fs.writeFileSync(fd, String(process.pid), 'utf8');
            return fd;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Failed to acquire lock: ${LOCK_PATH}`);
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

function getModelStatusPlain() {
    return runDocker(['node', 'dist/index.js', 'models', 'status', '--plain']).trim();
}

function setModel(model) {
    runDocker(['node', 'dist/index.js', 'models', 'set', model]);
}

function getCodexCatalog() {
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

function getSessions() {
    const out = runDocker(['node', 'dist/index.js', 'sessions', '--json']);
    return JSON.parse(out);
}

function chooseCodexModel(catalog) {
    for (const c of CODEX_PREFERRED) {
        if (catalog.includes(c)) return c;
    }
    return null;
}

function summarizeSessions(sessions) {
    const byModel = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalTokens = 0;
    for (const s of sessions) {
        const m = s.model || 'unknown';
        byModel[m] = byModel[m] || {
            sessions: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
        };
        byModel[m].sessions += 1;
        byModel[m].inputTokens += Number(s.inputTokens || 0);
        byModel[m].outputTokens += Number(s.outputTokens || 0);
        byModel[m].totalTokens += Number(s.totalTokens || 0);
        totalInput += Number(s.inputTokens || 0);
        totalOutput += Number(s.outputTokens || 0);
        totalTokens += Number(s.totalTokens || 0);
    }
    return { byModel, totalInput, totalOutput, totalTokens, sessionCount: sessions.length };
}

function parseBridgeRouteCounts() {
    const counts = { log: 0, word: 0, health: 0, report: 0, work: 0, other: 0 };
    const system = { cronFail: 0, otherSystem: 0, total: 0 };
    const apiLanes = {
        total: 0,
        byLane: {
            'oauth-codex': 0,
            'api-key-openai': 0,
            'local-only': 0,
        },
        blocked: 0,
        blockedByReason: {},
    };
    if (!fs.existsSync(BRIDGE_LOG_PATH)) return { counts, total: 0, system, apiLanes };

    const cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
    const commandPrefixes = cfg.commandPrefixes || {};
    const budgetPolicy = loadBudgetPolicy();
    const routingPolicy = loadRoutingPolicy();

    const lines = fs
        .readFileSync(BRIDGE_LOG_PATH, 'utf8')
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean);
    for (const line of lines) {
        let obj = null;
        try {
            obj = JSON.parse(line);
        } catch {
            continue;
        }
        const cmd = String(obj.command || '').trim();
        const source = String(obj.source || '').trim().toLowerCase();
        const isCronFail = source === 'cron-guard' || cmd.startsWith('[CRON FAIL]');
        const looksSystemEvent = /^\[(ALERT|NOTIFY|CRON FAIL)\]/i.test(cmd);
        if (isCronFail) {
            system.cronFail += 1;
            system.total += 1;
            continue;
        }
        if (source && source !== 'user' && looksSystemEvent) {
            system.otherSystem += 1;
            system.total += 1;
            continue;
        }
        if (!cmd) {
            counts.other += 1;
            continue;
        }
        const inferred = inferRouteFromCommand(cmd, { commandPrefixes });
        const decision = decideApiLane(
            {
                route: inferred.route,
                commandText: inferred.payload || cmd,
            },
            {
                policy: routingPolicy,
                budgetPolicy,
                env: process.env,
            },
        );
        apiLanes.total += 1;
        if (!Object.prototype.hasOwnProperty.call(apiLanes.byLane, decision.apiLane)) {
            apiLanes.byLane[decision.apiLane] = 0;
        }
        apiLanes.byLane[decision.apiLane] += 1;
        if (decision.blocked) {
            apiLanes.blocked += 1;
            const reason = decision.blockReason || 'unknown';
            apiLanes.blockedByReason[reason] = (apiLanes.blockedByReason[reason] || 0) + 1;
        }

        if (cmd.startsWith('기록:') || cmd.startsWith('메모:')) counts.log += 1;
        else if (cmd.startsWith('단어:') || cmd.startsWith('학습:')) counts.word += 1;
        else if (cmd.startsWith('운동:')) counts.health += 1;
        else if (cmd.startsWith('리포트:')) counts.report += 1;
        else if (cmd.startsWith('작업:')) counts.work += 1;
        else counts.other += 1;
    }
    const userTotal = Object.values(counts).reduce((acc, value) => acc + Number(value || 0), 0);
    return { counts, total: userTotal, system, apiLanes };
}

function loadBudgetPolicy() {
    const cfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
    const policy = cfg.budgetPolicy || {};
    return {
        monthlyApiBudgetYen: Number(policy.monthlyApiBudgetYen || 0),
        paidApiRequiresApproval: Boolean(policy.paidApiRequiresApproval),
    };
}

function runLatencyProbe({ label, thinking = 'minimal' }) {
    const sid = `latency-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const t0 = Date.now();
    const out = runDocker([
        'node',
        'dist/index.js',
        'agent',
        '--session-id',
        sid,
        '--message',
        'Reply with exactly: OK',
        '--thinking',
        thinking,
        '--json',
    ]);
    const elapsedMs = Date.now() - t0;
    const parsed = JSON.parse(out);
    const meta = (((parsed || {}).result || {}).meta || {});
    const agentMeta = meta.agentMeta || {};
    return {
        label,
        provider: agentMeta.provider || 'unknown',
        model: agentMeta.model || 'unknown',
        elapsedMs,
        durationMs: Number(meta.durationMs || 0),
    };
}

function benchmarkLatencies(codexModel) {
    const lockFd = acquireLock();
    let original = '';
    try {
        original = getModelStatusPlain();
        const probes = [];

        probes.push(runLatencyProbe({ label: 'default', thinking: 'minimal' }));
        if (codexModel) {
            setModel(codexModel);
            probes.push(runLatencyProbe({ label: 'codex', thinking: 'low' }));
        }
        return probes;
    } finally {
        try {
            if (original) setModel(original);
        } finally {
            releaseLock(lockFd);
        }
    }
}

function estimateCostYen() {
    // Current policy is OpenAI Codex OAuth only; direct API-key spend remains 0 unless explicitly enabled.
    return 0;
}

function appendHistory(snapshot) {
    ensureDirFor(HISTORY_JSONL_PATH);
    fs.appendFileSync(HISTORY_JSONL_PATH, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

function markdownReport(report) {
    const lines = [];
    lines.push(`# Model Cost/Latency Dashboard`);
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push('');
    lines.push(`- Default model: ${report.runtime.defaultModel}`);
    lines.push(`- Codex best available: ${report.runtime.bestCodexModel || 'N/A'}`);
    lines.push(`- Estimated API cost (JPY): ${report.cost.estimatedMonthlyYen}`);
    lines.push(`- Budget limit (JPY): ${report.cost.budgetPolicy.monthlyApiBudgetYen}`);
    lines.push('');

    lines.push(`## Latency Probes`);
    for (const p of report.latency.probes) {
        lines.push(
            `- ${p.label}: ${p.provider}/${p.model} (elapsed ${p.elapsedMs}ms, agent ${p.durationMs}ms)`,
        );
    }
    lines.push('');

    lines.push(`## Route Volume`);
    lines.push(`- Total user command events: ${report.routes.total}`);
    for (const [k, v] of Object.entries(report.routes.counts)) {
        lines.push(`- ${k}: ${v}`);
    }
    if (report.routes.system) {
        lines.push(`- system.total: ${report.routes.system.total}`);
        lines.push(`- system.cronFail: ${report.routes.system.cronFail}`);
        lines.push(`- system.otherSystem: ${report.routes.system.otherSystem}`);
    }
    lines.push('');

    lines.push(`## API Lane Volume`);
    lines.push(`- total: ${report.routes.apiLanes.total}`);
    for (const [k, v] of Object.entries(report.routes.apiLanes.byLane || {})) {
        lines.push(`- ${k}: ${v}`);
    }
    lines.push(`- blocked: ${report.routes.apiLanes.blocked}`);
    for (const [k, v] of Object.entries(report.routes.apiLanes.blockedByReason || {})) {
        lines.push(`- blocked.${k}: ${v}`);
    }
    lines.push('');

    lines.push(`## Sessions by model`);
    for (const [model, info] of Object.entries(report.sessions.byModel)) {
        lines.push(`- ${model}: sessions=${info.sessions}, totalTokens=${info.totalTokens}`);
    }
    lines.push('');
    return lines.join('\n');
}

function main() {
    const sessionsDoc = getSessions();
    const sessions = Array.isArray(sessionsDoc.sessions) ? sessionsDoc.sessions : [];
    const sessionSummary = summarizeSessions(sessions);
    const routes = parseBridgeRouteCounts();
    const budgetPolicy = loadBudgetPolicy();
    const codexCatalog = getCodexCatalog();
    const bestCodexModel = chooseCodexModel(codexCatalog);
    const defaultModel = getModelStatusPlain();
    const probes = benchmarkLatencies(bestCodexModel);

    const report = {
        generatedAt: new Date().toISOString(),
        runtime: {
            defaultModel,
            bestCodexModel,
            codexCatalog,
        },
        sessions: sessionSummary,
        routes,
        latency: {
            probes,
        },
        cost: {
            estimatedMonthlyYen: estimateCostYen(),
            budgetPolicy,
            note: 'Dual-lane routing active; direct API key spend is blocked by default until explicit approval.',
        },
    };

    ensureDirFor(DASHBOARD_JSON_PATH);
    fs.writeFileSync(DASHBOARD_JSON_PATH, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(DASHBOARD_MD_PATH, markdownReport(report), 'utf8');
    appendHistory({
        t: report.generatedAt,
        defaultModel,
        bestCodexModel,
        routes: report.routes.counts,
        routeSystem: report.routes.system,
        routeApiLanes: report.routes.apiLanes,
        latency: report.latency.probes,
        sessions: {
            total: sessionSummary.sessionCount,
            totalTokens: sessionSummary.totalTokens,
        },
        costYen: report.cost.estimatedMonthlyYen,
    });

    console.log(
        JSON.stringify(
            {
                ok: true,
                json: DASHBOARD_JSON_PATH,
                markdown: DASHBOARD_MD_PATH,
                history: HISTORY_JSONL_PATH,
                report,
            },
            null,
            2,
        ),
    );
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
