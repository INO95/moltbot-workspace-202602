const fs = require('fs');
const path = require('path');
const { DUEL_LOG_PATH, readEvents, computeDebateMetrics } = require('./duel_log');

const OUT_JSON = path.join(__dirname, '../logs/model_duel_report_latest.json');
const OUT_MD = path.join(__dirname, '../logs/model_duel_report_latest.md');

function ensureDirFor(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function groupByDebate(events) {
    const groups = new Map();
    for (const event of events) {
        const key = String(event.debateId || '').trim();
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(event);
    }
    return groups;
}

function average(values) {
    const filtered = values.filter((v) => Number.isFinite(v));
    if (!filtered.length) return null;
    const sum = filtered.reduce((acc, v) => acc + v, 0);
    return Number((sum / filtered.length).toFixed(4));
}

function buildReport() {
    const events = readEvents({ logPath: DUEL_LOG_PATH });
    const grouped = groupByDebate(events);

    const debates = [];
    for (const [debateId, debateEvents] of grouped.entries()) {
        const metrics = computeDebateMetrics(debateEvents);
        debates.push({
            debateId,
            eventCount: debateEvents.length,
            metrics,
            latestTimestamp: debateEvents[debateEvents.length - 1].timestamp || null,
        });
    }

    debates.sort((a, b) => String(a.latestTimestamp || '').localeCompare(String(b.latestTimestamp || '')));

    const summary = {
        generatedAt: new Date().toISOString(),
        logPath: DUEL_LOG_PATH,
        totals: {
            eventCount: events.length,
            debateCount: debates.length,
            degradedCount: debates.filter((d) => d.metrics.degraded).length,
            acceptanceRateAvg: average(debates.map((d) => d.metrics.acceptanceRate)),
            critiqueIssueCount: debates.reduce((acc, d) => acc + Number(d.metrics.critiqueIssueCount || 0), 0),
            revisionResponseCount: debates.reduce((acc, d) => acc + Number(d.metrics.revisionResponseCount || 0), 0),
        },
        debates,
    };

    return summary;
}

function toMarkdown(report) {
    const lines = [];
    lines.push('# Model Duel Report');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Log: ${report.logPath}`);
    lines.push('');
    lines.push('## Totals');
    lines.push(`- eventCount: ${report.totals.eventCount}`);
    lines.push(`- debateCount: ${report.totals.debateCount}`);
    lines.push(`- degradedCount: ${report.totals.degradedCount}`);
    lines.push(`- acceptanceRateAvg: ${report.totals.acceptanceRateAvg}`);
    lines.push(`- critiqueIssueCount: ${report.totals.critiqueIssueCount}`);
    lines.push(`- revisionResponseCount: ${report.totals.revisionResponseCount}`);
    lines.push('');

    lines.push('## Debates');
    if (!report.debates.length) {
        lines.push('- no debate records found');
    } else {
        for (const item of report.debates) {
            lines.push(`- ${item.debateId}: status=${item.metrics.finalStatus || 'n/a'}, acceptanceRate=${item.metrics.acceptanceRate}`);
        }
    }

    return lines.join('\n');
}

function main() {
    const report = buildReport();
    ensureDirFor(OUT_JSON);
    fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(OUT_MD, toMarkdown(report), 'utf8');

    console.log(JSON.stringify({ ok: true, outJson: OUT_JSON, outMd: OUT_MD, totals: report.totals }, null, 2));
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

module.exports = {
    buildReport,
};
