#!/usr/bin/env node
const storage = require('./personal_storage');

function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv.slice() : [];
    const out = {
        apply: args.includes('--apply'),
        days: 90,
    };

    const idx = args.indexOf('--days');
    if (idx >= 0 && args[idx + 1]) {
        const n = Number(args[idx + 1]);
        if (Number.isFinite(n) && n > 0) out.days = n;
    }

    const dbIdx = args.indexOf('--db');
    if (dbIdx >= 0 && args[dbIdx + 1]) {
        out.dbPath = String(args[dbIdx + 1]);
    }
    return out;
}

function runRetention(options = {}) {
    const result = storage.pruneRawEvents({
        days: options.days || 90,
        apply: options.apply === true,
    }, options);

    return {
        ok: true,
        ...result,
        telegramReply: [
            `Retention ${result.applied ? 'APPLY' : 'DRY-RUN'} 완료`,
            `- cutoff: ${result.cutoff}`,
            `- candidates: ${result.candidates}`,
            `- purged: ${result.purged}`,
            `- remaining: ${result.remaining}`,
        ].join('\n'),
    };
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const result = runRetention(opts);
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    }
}

module.exports = {
    runRetention,
};
