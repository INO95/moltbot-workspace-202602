/**
 * Antigravity Bridge Client
 * OpenClaw(Moltbot)에서 Antigravity(AI Agent)로 명령을 전달하는 인터페이스
 *
 * 기본: outbox 기반 응답 대기
 * 확장: --duel 모드 시 model_duel.jsonl 기반 2-pass 비평 루프 수행 (outbox는 fallback)
 */

const fs = require('fs');
const path = require('path');
const { enqueueBridgeCommand, BRIDGE_DIR } = require('./bridge_queue');
const { runTwoPassDebate, DEFAULT_TIMEOUT_MS } = require('./duel_orchestrator');
const { DUEL_LOG_PATH, RUBRIC_KEYS } = require('./duel_log');

const OUTBOX_PATH = path.join(BRIDGE_DIR, 'outbox.json');
const DEFAULT_OUTBOX_TIMEOUT_MS = 60000;
const DEFAULT_DUEL_CRITIQUE_MAX_CHARS = 5000;

function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0;
}

function truncate(text, maxLen = 180) {
    const raw = String(text || '').trim();
    if (raw.length <= maxLen) return raw;
    return `${raw.slice(0, Math.max(0, maxLen - 3))}...`;
}

function toNumber(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.trunc(n);
}

function waitForOutbox(taskId, options = {}) {
    const timeoutMs = toNumber(options.timeoutMs, DEFAULT_OUTBOX_TIMEOUT_MS);
    const pollIntervalMs = toNumber(options.pollIntervalMs, 500);

    return new Promise((resolve, reject) => {
        const startedAt = Date.now();

        const poll = () => {
            if (Date.now() - startedAt > timeoutMs) {
                reject(new Error(`Antigravity response timeout via outbox (${timeoutMs}ms)`));
                return;
            }

            if (!fs.existsSync(OUTBOX_PATH)) {
                setTimeout(poll, pollIntervalMs);
                return;
            }

            try {
                const response = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8'));
                if (response && response.taskId === taskId) {
                    resolve(response);
                    return;
                }
            } catch {
                // Ignore temporary read/parse failures caused by concurrent writes.
            }

            setTimeout(poll, pollIntervalMs);
        };

        poll();
    });
}

function extractJsonObject(rawText) {
    const text = String(rawText || '').trim();
    if (!text) throw new Error('empty critique payload');

    try {
        return JSON.parse(text);
    } catch {
        // fallthrough
    }

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
        try {
            return JSON.parse(String(fenced[1] || '').trim());
        } catch {
            // fallthrough
        }
    }

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        const candidate = text.slice(firstBrace, lastBrace + 1);
        return JSON.parse(candidate);
    }

    throw new Error('structured critique JSON not found');
}

function normalizeRubricScore(value, key) {
    const score = Number(value);
    if (!Number.isFinite(score) || Math.trunc(score) !== score || score < 1 || score > 5) {
        throw new Error(`invalid rubric.${key} (must be integer 1~5)`);
    }
    return score;
}

function normalizeStructuredCritique(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('structured critique payload must be an object');
    }

    const content = String(payload.content || '').trim();
    if (!content) throw new Error('structured critique missing content');

    const rubric = {};
    for (const key of RUBRIC_KEYS) {
        rubric[key] = normalizeRubricScore(payload.rubric && payload.rubric[key], key);
    }

    if (!Array.isArray(payload.issues) || payload.issues.length === 0) {
        throw new Error('structured critique issues must be a non-empty array');
    }

    const issues = payload.issues
        .map((issue) => ({
            claim: String(issue && issue.claim || '').trim(),
            evidence: String(issue && issue.evidence || '').trim(),
            suggestedFix: String(issue && issue.suggestedFix || '').trim(),
        }))
        .filter((issue) => issue.claim && issue.evidence && issue.suggestedFix);

    if (issues.length === 0) {
        throw new Error('structured critique has no valid issue entries');
    }

    return { content, rubric, issues };
}

function buildCritiqueFromText(text, draftContent) {
    const critiqueText = truncate(text || '(empty critique)');
    const draftSnippet = truncate(draftContent || '(no draft content)');
    return {
        content: critiqueText,
        rubric: {
            correctness: 3,
            feasibility: 3,
            risk: 3,
            clarity: 3,
            testability: 3,
        },
        issues: [
            {
                claim: 'Current draft needs stronger verification and rollback clarity.',
                evidence: `Draft snippet: ${draftSnippet}`,
                suggestedFix: `Apply critique: ${critiqueText}`,
            },
        ],
    };
}

function parseCritiqueFromOutboxResponse(response, draftContent) {
    const rawCritique = isNonEmptyString(response && response.result)
        ? String(response.result)
        : JSON.stringify(response || {});

    try {
        const parsed = extractJsonObject(rawCritique);
        const critique = normalizeStructuredCritique(parsed);
        return { structured: true, critique, parseError: null, rawCritique };
    } catch (error) {
        return {
            structured: false,
            critique: buildCritiqueFromText(rawCritique, draftContent),
            parseError: error instanceof Error ? error.message : String(error),
            rawCritique,
        };
    }
}

function buildStructuredCritiqueRequest({ debateId, taskId, ackId, command, draftContent }) {
    const schema = {
        content: 'string',
        rubric: {
            correctness: 'integer 1~5',
            feasibility: 'integer 1~5',
            risk: 'integer 1~5',
            clarity: 'integer 1~5',
            testability: 'integer 1~5',
        },
        issues: [
            {
                claim: 'string',
                evidence: 'string',
                suggestedFix: 'string',
            },
        ],
    };

    const payload = {
        protocol: 'model_duel_critique_v1',
        debateId,
        taskId,
        ackId,
        objective: 'Critique codex draft and provide actionable fixes.',
        constraints: [
            'Return JSON only (no markdown, no explanation outside JSON).',
            'rubric scores must be integers in 1..5.',
            'issues must include at least one item with claim/evidence/suggestedFix.',
        ],
        input: {
            command: String(command || ''),
            draft: truncate(draftContent || '', DEFAULT_DUEL_CRITIQUE_MAX_CHARS),
        },
        outputSchema: schema,
    };

    return [
        '[DUEL_CRITIQUE_REQUEST:v1]',
        'Analyze the draft and return structured critique JSON only.',
        JSON.stringify(payload, null, 2),
    ].join('\n');
}

async function requestStructuredCritiqueFromAntigravity(context, options = {}) {
    const critiqueCommand = buildStructuredCritiqueRequest(context);
    const critiquePayload = enqueueBridgeCommand(critiqueCommand, { prefix: 'bridge-critique' });

    const outboxResponse = await waitForOutbox(critiquePayload.taskId, {
        timeoutMs: toNumber(options.outboxTimeoutMs, DEFAULT_OUTBOX_TIMEOUT_MS),
        pollIntervalMs: toNumber(options.pollIntervalMs, 500),
    });

    const parsed = parseCritiqueFromOutboxResponse(outboxResponse, context.draftContent);
    if (!parsed.structured && options.requireStructuredCritique) {
        throw new Error(`Structured critique required but parsing failed: ${parsed.parseError}`);
    }

    return {
        critiqueTaskId: critiquePayload.taskId,
        outboxResponse,
        critique: parsed.critique,
        structured: parsed.structured,
        parseError: parsed.parseError,
    };
}

function buildRevisionFromCritique(critique) {
    const issues = Array.isArray(critique.issues) ? critique.issues : [];
    return {
        content: [
            'Codex revision generated from Antigravity critique.',
            `Addressed issues: ${issues.length}`,
        ].join('\n'),
        rubric: critique.rubric,
        issues,
        decision: 'partially_accepted',
        responses: issues.map((issue, idx) => ({
            issueRef: idx,
            decision: 'partially_accepted',
            rationale: `Applied issue #${idx + 1}: ${issue.claim}`,
        })),
    };
}

async function sendCommand(command, options = {}) {
    const payload = enqueueBridgeCommand(command, { prefix: 'bridge' });
    const { taskId, ackId } = payload;

    console.log(`🚀 [OpenClaw] Antigravity에게 명령 전송 중: ${command}`);
    console.log(`🧾 [OpenClaw] ACK: ${ackId} (taskId=${taskId})`);

    if (!options.duelMode) {
        // Legacy mode: wait for outbox only.
        console.log('⏳ [OpenClaw] 결과를 기다리는 중... (Antigravity 작업 중)');
        return waitForOutbox(taskId, {
            timeoutMs: toNumber(options.timeoutMs, DEFAULT_OUTBOX_TIMEOUT_MS),
            pollIntervalMs: toNumber(options.pollIntervalMs, 500),
        });
    }

    console.log(`🧠 [OpenClaw] Duel mode enabled (2-pass). log=${DUEL_LOG_PATH}`);

    const timeoutMs = toNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    const outboxTimeoutMs = toNumber(options.outboxTimeoutMs, Math.min(timeoutMs, DEFAULT_OUTBOX_TIMEOUT_MS));
    let outboxResponse = null;
    let critiqueMeta = {
        source: 'none',
        structured: false,
        critiqueTaskId: null,
        parseError: null,
    };

    const duel = await runTwoPassDebate({
        taskId,
        ackId,
        command,
        maxRounds: 1,
        timeoutMs,
        runDraft: async (ctx) => {
            if (typeof options.runDraft === 'function') {
                return options.runDraft(ctx);
            }
            return {
                content: [
                    'Codex draft (duel mode):',
                    `- taskId: ${taskId}`,
                    `- command: ${command}`,
                    '- include explicit assumptions, edge cases, and acceptance checks.',
                ].join('\n'),
            };
        },
        runCritique: async (ctx) => {
            if (typeof options.runCritique === 'function') {
                critiqueMeta = { source: 'custom-runCritique', structured: true, critiqueTaskId: null, parseError: null };
                return options.runCritique(ctx);
            }

            if (isNonEmptyString(options.antigravityCritique)) {
                critiqueMeta = { source: 'inline-text', structured: false, critiqueTaskId: null, parseError: null };
                return buildCritiqueFromText(options.antigravityCritique, ctx.draft.content);
            }

            if (typeof options.getAntigravityCritique === 'function') {
                const provided = await options.getAntigravityCritique(ctx);
                if (provided) {
                    if (typeof provided === 'string') {
                        critiqueMeta = { source: 'external-provider-text', structured: false, critiqueTaskId: null, parseError: null };
                        return buildCritiqueFromText(provided, ctx.draft.content);
                    }
                    try {
                        const normalized = normalizeStructuredCritique(provided);
                        critiqueMeta = { source: 'external-provider-structured', structured: true, critiqueTaskId: null, parseError: null };
                        return normalized;
                    } catch (error) {
                        critiqueMeta = {
                            source: 'external-provider-invalid',
                            structured: false,
                            critiqueTaskId: null,
                            parseError: error instanceof Error ? error.message : String(error),
                        };
                        if (options.requireStructuredCritique) {
                            throw new Error(`Provided critique is not valid structured JSON: ${critiqueMeta.parseError}`);
                        }
                        return buildCritiqueFromText(JSON.stringify(provided), ctx.draft.content);
                    }
                }
            }

            const critiqueRequest = await requestStructuredCritiqueFromAntigravity(
                {
                    debateId: ctx.debateId,
                    taskId,
                    ackId,
                    command,
                    draftContent: ctx.draft.content,
                },
                {
                    outboxTimeoutMs,
                    pollIntervalMs: toNumber(options.pollIntervalMs, 500),
                    requireStructuredCritique: options.requireStructuredCritique !== false,
                },
            );

            outboxResponse = critiqueRequest.outboxResponse;
            critiqueMeta = {
                source: 'antigravity-structured-request',
                structured: critiqueRequest.structured,
                critiqueTaskId: critiqueRequest.critiqueTaskId,
                parseError: critiqueRequest.parseError,
            };
            return critiqueRequest.critique;
        },
        runRevision: async (ctx) => {
            if (typeof options.runRevision === 'function') {
                return options.runRevision(ctx);
            }
            return buildRevisionFromCritique(ctx.critique);
        },
    });

    return {
        taskId,
        ackId,
        result: duel.result,
        actions: outboxResponse && Array.isArray(outboxResponse.actions) ? outboxResponse.actions : [],
        outbox: outboxResponse,
        duel: {
            enabled: true,
            mode: 'two-pass',
            status: duel.status,
            debateId: duel.debateId,
            logPath: DUEL_LOG_PATH,
            metrics: duel.metrics,
            critique: critiqueMeta,
        },
    };
}

function parseCliArgs(argv) {
    const out = {
        duelMode: false,
        timeoutMs: DEFAULT_OUTBOX_TIMEOUT_MS,
        outboxTimeoutMs: DEFAULT_OUTBOX_TIMEOUT_MS,
        antigravityCritique: '',
        requireStructuredCritique: true,
        command: '',
    };

    const positional = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--duel') {
            out.duelMode = true;
            out.timeoutMs = DEFAULT_TIMEOUT_MS;
            continue;
        }
        if (arg === '--timeout-ms') {
            out.timeoutMs = toNumber(argv[i + 1], out.timeoutMs);
            i += 1;
            continue;
        }
        if (arg === '--outbox-timeout-ms') {
            out.outboxTimeoutMs = toNumber(argv[i + 1], out.outboxTimeoutMs);
            i += 1;
            continue;
        }
        if (arg === '--antigravity-critique') {
            out.antigravityCritique = String(argv[i + 1] || '');
            i += 1;
            continue;
        }
        if (arg === '--allow-unstructured-critique') {
            out.requireStructuredCritique = false;
            continue;
        }
        positional.push(arg);
    }

    out.command = positional.join(' ').trim();
    return out;
}

// CLI 실행 시
if (require.main === module) {
    const args = parseCliArgs(process.argv.slice(2));
    if (!args.command) {
        console.error('Usage: node ag_bridge_client.js [--duel] [--timeout-ms N] [--outbox-timeout-ms N] [--allow-unstructured-critique] "명령어"');
        process.exit(1);
    }

    sendCommand(args.command, {
        duelMode: args.duelMode,
        timeoutMs: args.timeoutMs,
        outboxTimeoutMs: args.outboxTimeoutMs,
        antigravityCritique: args.antigravityCritique,
        requireStructuredCritique: args.requireStructuredCritique,
    })
        .then((res) => {
            console.log('\n✅ [Antigravity 응답]');
            console.log(res.result);

            if (res.duel && res.duel.enabled) {
                console.log('\n🧪 [Duel]');
                console.log(`- debateId: ${res.duel.debateId}`);
                console.log(`- status: ${res.duel.status}`);
                console.log(`- log: ${res.duel.logPath}`);
                if (res.duel.critique) {
                    console.log(`- critiqueSource: ${res.duel.critique.source}`);
                    console.log(`- critiqueStructured: ${res.duel.critique.structured}`);
                    if (res.duel.critique.critiqueTaskId) {
                        console.log(`- critiqueTaskId: ${res.duel.critique.critiqueTaskId}`);
                    }
                }
            }

            if (res.actions && res.actions.length > 0) {
                console.log('\n🛠 [수행된 작업]');
                res.actions.forEach((a) => console.log(`- ${a}`));
            }
            process.exit(0);
        })
        .catch((err) => {
            console.error(`\n❌ 오류: ${err.message}`);
            process.exit(1);
        });
}

module.exports = {
    sendCommand,
    waitForOutbox,
    buildCritiqueFromText,
    extractJsonObject,
    normalizeStructuredCritique,
    parseCritiqueFromOutboxResponse,
    buildStructuredCritiqueRequest,
    requestStructuredCritiqueFromAntigravity,
};
