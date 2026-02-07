const fs = require('fs');
const path = require('path');

const historyPath = path.join(__dirname, '../logs/notion_sync_history.jsonl');
const outJsonPath = path.join(__dirname, '../logs/notion_sync_dashboard_latest.json');
const outMdPath = path.join(__dirname, '../logs/notion_sync_dashboard_latest.md');

function parseHistory() {
    if (!fs.existsSync(historyPath)) return [];
    return fs.readFileSync(historyPath, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

function summarize(items) {
    const total = items.length;
    const success = items.filter(x => x.ok).length;
    const failed = items.filter(x => x.ok === false).length;
    const skipped = items.filter(x => x.action === 'skip').length;
    const recent = items.slice(-20);

    const byAction = {};
    const failureReasons = {};
    for (const item of items) {
        const k = item.action || 'unknown';
        byAction[k] = (byAction[k] || 0) + 1;
        if (item.ok === false) {
            const reason = item.reason || 'unknown';
            failureReasons[reason] = (failureReasons[reason] || 0) + 1;
        }
    }

    let consecutiveFailures = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i] && items[i].ok === false) {
            consecutiveFailures += 1;
        } else {
            break;
        }
    }

    const topFailureReasons = Object.entries(failureReasons)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count }));

    const latestFailure = [...items].reverse().find(x => x && x.ok === false) || null;
    const latestFailureDetail = latestFailure
        ? `${latestFailure.timestamp || '-'} | ${latestFailure.action || 'unknown'} | ${latestFailure.slug || '-'} | ${latestFailure.reason || '-'}`
        : null;

    return {
        generatedAt: new Date().toISOString(),
        total,
        success,
        failed,
        skipped,
        successRate: total > 0 ? Math.round((success / total) * 10000) / 100 : null,
        byAction,
        failureReasons,
        topFailureReasons,
        consecutiveFailures,
        consecutiveFailureAlert: consecutiveFailures >= 3,
        latestFailureDetail,
        recent,
    };
}

function renderMarkdown(summary) {
    const lines = [];
    lines.push(`# Notion Sync Dashboard (${new Date().toISOString()})`);
    lines.push('');
    lines.push(`- Total: ${summary.total}`);
    lines.push(`- Success: ${summary.success}`);
    lines.push(`- Failed: ${summary.failed}`);
    lines.push(`- Skipped(unchanged): ${summary.skipped}`);
    lines.push(`- Success rate: ${summary.successRate == null ? '-' : `${summary.successRate}%`}`);
    lines.push(`- Consecutive failures: ${summary.consecutiveFailures}${summary.consecutiveFailureAlert ? ' (ALERT)' : ''}`);
    lines.push(`- Latest failure detail: ${summary.latestFailureDetail || 'none'}`);
    lines.push('');
    lines.push('## By Action');
    for (const [k, v] of Object.entries(summary.byAction)) {
        lines.push(`- ${k}: ${v}`);
    }
    lines.push('');
    lines.push('## Failure Top N');
    if (!summary.topFailureReasons.length) {
        lines.push('- none');
    } else {
        for (const row of summary.topFailureReasons) {
            lines.push(`- ${row.reason}: ${row.count}`);
        }
    }
    lines.push('');
    lines.push('## Recent');
    for (const item of summary.recent) {
        lines.push(`- ${item.timestamp} | ${item.ok ? 'OK' : 'FAIL'} | ${item.action} | ${item.slug || '-'} | ${item.reason || '-'}`);
    }
    return lines.join('\n');
}

function main() {
    const history = parseHistory();
    const summary = summarize(history);
    fs.writeFileSync(outJsonPath, JSON.stringify(summary, null, 2), 'utf8');
    fs.writeFileSync(outMdPath, renderMarkdown(summary), 'utf8');
    console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
    main();
}
