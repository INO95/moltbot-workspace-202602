const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { inferRouteFromCommand, decideApiLane, loadRoutingPolicy } = require('./oai_api_router');

const OUT_PATH = path.join(__dirname, '../logs/model_routing_report_latest.json');
const BRIDGE_LOG_PATH = path.join(__dirname, '../data/bridge/inbox.jsonl');
const CONFIG_PATH = path.join(__dirname, '../data/config.json');

function run(cmd) {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function parseJson(text, fallback = null) {
    try {
        return JSON.parse(String(text || ''));
    } catch {
        return fallback;
    }
}

function getSessions() {
    const out = run('docker exec moltbot-dev /bin/sh -lc "node dist/index.js sessions --json"');
    return parseJson(out, { sessions: [] }) || { sessions: [] };
}

function getModelStatus() {
    const out = run('docker exec moltbot-dev /bin/sh -lc "node dist/index.js models status"');
    return String(out || '');
}

function getCodexCatalog() {
    const out = run(
        'docker exec moltbot-dev /bin/sh -lc "node dist/index.js models list --all --provider openai-codex --plain"',
    );
    return out
        .split('\n')
        .map(v => v.trim())
        .filter(Boolean);
}

function summarizeSessions(sessions) {
    const byModel = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalAll = 0;
    for (const s of sessions) {
        const model = s.model || 'unknown';
        byModel[model] = byModel[model] || {
            sessions: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
        };
        byModel[model].sessions += 1;
        byModel[model].inputTokens += Number(s.inputTokens || 0);
        byModel[model].outputTokens += Number(s.outputTokens || 0);
        byModel[model].totalTokens += Number(s.totalTokens || 0);
        totalInput += Number(s.inputTokens || 0);
        totalOutput += Number(s.outputTokens || 0);
        totalAll += Number(s.totalTokens || 0);
    }
    return {
        count: sessions.length,
        byModel,
        totalInput,
        totalOutput,
        totalAll,
    };
}

function loadBudgetPolicy() {
    const cfg = fs.existsSync(CONFIG_PATH) ? parseJson(fs.readFileSync(CONFIG_PATH, 'utf8'), {}) : {};
    const policy = (cfg && cfg.budgetPolicy) || {};
    return {
        monthlyApiBudgetYen: Number(policy.monthlyApiBudgetYen || 0),
        paidApiRequiresApproval: Boolean(policy.paidApiRequiresApproval),
    };
}

function summarizeApiLanes() {
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
    if (!fs.existsSync(BRIDGE_LOG_PATH)) return apiLanes;

    const cfg = fs.existsSync(CONFIG_PATH) ? parseJson(fs.readFileSync(CONFIG_PATH, 'utf8'), {}) : {};
    const commandPrefixes = (cfg && cfg.commandPrefixes) || {};
    const budgetPolicy = loadBudgetPolicy();
    const routingPolicy = loadRoutingPolicy();

    const lines = fs.readFileSync(BRIDGE_LOG_PATH, 'utf8')
        .split('\n')
        .map(v => v.trim())
        .filter(Boolean);

    for (const line of lines) {
        const row = parseJson(line, null);
        if (!row) continue;
        const command = String(row.command || '').trim();
        const source = String(row.source || '').trim().toLowerCase();
        const looksSystemEvent = /^\[(ALERT|NOTIFY|CRON FAIL)\]/i.test(command);
        const isCronFail = source === 'cron-guard' || command.startsWith('[CRON FAIL]');
        if (!command || isCronFail) continue;
        if (source && source !== 'user' && looksSystemEvent) continue;

        const inferred = inferRouteFromCommand(command, { commandPrefixes });
        const decision = decideApiLane(
            {
                route: inferred.route,
                commandText: inferred.payload || command,
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
    }

    return apiLanes;
}

function buildRecommendations(summary, codexCatalog, apiLaneSummary) {
    const rec = [];
    const codexBest =
        codexCatalog.find(m => m.includes('gpt-5.3-codex')) ||
        codexCatalog.find(m => m.includes('gpt-5.2-codex')) ||
        codexCatalog[0] ||
        null;

    rec.push({
        rule: 'default_route',
        value: codexBest || 'openai-codex/gpt-5.3-codex',
        reason: 'OpenAI-only routing baseline for routine and medium-complexity tasks.',
    });
    if (codexBest) {
        rec.push({
            rule: 'complex_route',
            value: codexBest,
            reason: 'Use for architecture/code/accuracy-sensitive tasks via 작업: prefix.',
        });
    } else {
        rec.push({
            rule: 'complex_route',
            value: 'openai-codex/gpt-5.3-codex',
            reason: 'Codex catalog unavailable; keep OpenAI-only path and restore OAuth/catalog access.',
        });
    }

    const codexUsage = Object.entries(summary.byModel).filter(([name]) => name.includes('codex'));
    if (codexUsage.length === 0 && codexBest) {
        rec.push({
            rule: 'adoption_hint',
            value: 'Increase 작업: prefix usage for difficult tasks to improve quality.',
            reason: 'No codex session usage detected in current session store.',
        });
    }

    if (Number(apiLaneSummary && apiLaneSummary.blocked || 0) > 0) {
        rec.push({
            rule: 'api_key_lane_blocked',
            value: apiLaneSummary.blocked,
            reason: 'API-key lane requests were blocked by policy. Approve paid API only when necessary.',
        });
    }

    if (Number((apiLaneSummary && apiLaneSummary.byLane && apiLaneSummary.byLane['api-key-openai']) || 0) > 0) {
        rec.push({
            rule: 'api_key_lane_observed',
            value: apiLaneSummary.byLane['api-key-openai'],
            reason: 'API-key lane traffic exists. Keep monitoring budget and auth posture.',
        });
    }
    return rec;
}

function saveReport(report) {
    const dir = path.dirname(OUT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), 'utf8');
}

function main() {
    const sessionsDoc = getSessions();
    const sessions = Array.isArray(sessionsDoc.sessions) ? sessionsDoc.sessions : [];
    const summary = summarizeSessions(sessions);
    const codexCatalog = getCodexCatalog();
    const statusRaw = getModelStatus();
    const apiLaneSummary = summarizeApiLanes();
    const recommendations = buildRecommendations(summary, codexCatalog, apiLaneSummary);

    const report = {
        generatedAt: new Date().toISOString(),
        sessionStore: sessionsDoc.path || null,
        sessions: summary,
        apiLaneSummary,
        codexCatalog,
        modelStatusRaw: statusRaw,
        recommendations,
    };
    saveReport(report);
    console.log(JSON.stringify({ ok: true, out: OUT_PATH, summary: report.sessions, recommendations }, null, 2));
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
