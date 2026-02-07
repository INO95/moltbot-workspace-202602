const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OUT_PATH = path.join(__dirname, '../logs/model_routing_report_latest.json');

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
    const out = run('docker exec moltbot-main /bin/sh -lc "node dist/index.js sessions --json"');
    return parseJson(out, { sessions: [] }) || { sessions: [] };
}

function getModelStatus() {
    const out = run('docker exec moltbot-main /bin/sh -lc "node dist/index.js models status"');
    return String(out || '');
}

function getCodexCatalog() {
    const out = run(
        'docker exec moltbot-main /bin/sh -lc "node dist/index.js models list --all --provider openai-codex --plain"',
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

function buildRecommendations(summary, codexCatalog) {
    const rec = [];
    const codexBest =
        codexCatalog.find(m => m.includes('gpt-5.3-codex')) ||
        codexCatalog.find(m => m.includes('gpt-5.2-codex')) ||
        codexCatalog[0] ||
        null;

    rec.push({
        rule: 'default_route',
        value: 'google/gemini-3-flash-preview',
        reason: 'Low-cost baseline for routine logging and lightweight Q&A.',
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
            value: 'google/gemini-3-pro-preview',
            reason: 'Codex catalog unavailable; fallback to deep Gemini profile.',
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
    const recommendations = buildRecommendations(summary, codexCatalog);

    const report = {
        generatedAt: new Date().toISOString(),
        sessionStore: sessionsDoc.path || null,
        sessions: summary,
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
