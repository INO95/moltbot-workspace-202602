#!/usr/bin/env node
const { runCommand } = require('./notion_personal_sync');
const { enqueueBridgePayload } = require('./bridge_queue');

function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv.slice() : [];
    const out = { _: [], noEnqueue: false };
    for (let i = 0; i < args.length; i += 1) {
        const token = String(args[i] || '').trim();
        if (!token) continue;
        if (token === '--no-enqueue') {
            out.noEnqueue = true;
            continue;
        }
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = args[i + 1];
            if (next != null && !String(next).startsWith('--')) {
                out[key] = String(next);
                i += 1;
            } else {
                out[key] = '1';
            }
            continue;
        }
        out._.push(token);
    }
    return out;
}

function notifyTelegram(text, source = 'notion-personal-sync') {
    const payload = {
        taskId: `notion-personal-sync-${Date.now()}`,
        command: `[NOTIFY] ${String(text || '').trim()}`,
        timestamp: new Date().toISOString(),
        status: 'pending',
        source,
    };
    return enqueueBridgePayload(payload);
}

async function run(argv = process.argv.slice(2)) {
    const parsed = parseArgs(argv);
    const mode = String(parsed._[0] || 'prepare').trim().toLowerCase();
    const enqueue = !parsed.noEnqueue;

    let result;
    if (mode === 'prepare') {
        result = await runCommand(['prepare']);
    } else if (mode === 'apply') {
        const batch = String(parsed.batch || '').trim();
        const approval = String(parsed.approval || '').trim();
        const cmdArgs = ['apply'];
        if (batch) cmdArgs.push('--batch', batch);
        if (approval) cmdArgs.push('--approval', approval);
        result = await runCommand(cmdArgs);
    } else {
        result = {
            ok: false,
            action: 'unknown',
            errorCode: 'UNKNOWN_MODE',
            telegramReply: `알 수 없는 모드: ${mode} (prepare|apply)`,
        };
    }

    let notified = false;
    let notifyTaskId = null;
    if (enqueue && result && result.telegramReply) {
        const queued = notifyTelegram(result.telegramReply, `notion-personal-sync:${mode}`);
        notified = true;
        notifyTaskId = queued.taskId;
    }

    return {
        ...result,
        scheduler: {
            mode,
            enqueue,
            notified,
            notifyTaskId,
        },
    };
}

async function main() {
    const result = await run(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    });
}

module.exports = {
    run,
};
