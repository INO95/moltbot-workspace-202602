const {
    appendEvent,
    computeDebateMetrics,
    makeId,
    readEvents,
    RUBRIC_KEYS,
    REVISION_DECISIONS,
} = require('./duel_log');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_ROUNDS = 1;

function ensureString(value, fallback = '') {
    const out = String(value == null ? '' : value).trim();
    return out || fallback;
}

function clampRoundLimit(maxRounds) {
    const raw = Number(maxRounds);
    if (!Number.isFinite(raw) || raw < 1) return 1;
    return Math.min(Math.trunc(raw), MAX_ROUNDS);
}

function withTimeout(fn, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const timer = setTimeout(() => {
            if (finished) return;
            const error = new Error(`${label} timed out after ${timeoutMs}ms`);
            error.code = 'DUEL_TIMEOUT';
            reject(error);
        }, timeoutMs);

        Promise.resolve()
            .then(() => fn())
            .then((value) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                resolve(value);
            })
            .catch((error) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                reject(error);
            });
    });
}

function normalizeRubric(inputRubric) {
    const out = {};
    for (const key of RUBRIC_KEYS) {
        const score = Number(inputRubric && inputRubric[key]);
        out[key] = Number.isFinite(score) ? Math.max(1, Math.min(5, Math.trunc(score))) : 3;
    }
    return out;
}

function normalizeIssues(inputIssues, fallbackClaimPrefix) {
    const issues = Array.isArray(inputIssues) ? inputIssues : [];
    const out = issues
        .map((issue) => ({
            claim: ensureString(issue && issue.claim),
            evidence: ensureString(issue && issue.evidence),
            suggestedFix: ensureString(issue && issue.suggestedFix),
        }))
        .filter((issue) => issue.claim && issue.evidence && issue.suggestedFix);

    if (out.length > 0) return out;

    return [
        {
            claim: `${fallbackClaimPrefix}: key risks are not explicit enough`,
            evidence: 'The output does not include concrete failure modes and validation steps.',
            suggestedFix: 'Add explicit risk handling and acceptance-test mapping for each major step.',
        },
    ];
}

function normalizeResponses(inputResponses, issues) {
    const src = Array.isArray(inputResponses) ? inputResponses : [];
    const normalized = [];

    for (let i = 0; i < issues.length; i += 1) {
        const existing = src[i] || {};
        const decision = REVISION_DECISIONS.includes(String(existing.decision || '').trim())
            ? String(existing.decision).trim()
            : 'accepted';
        const rationale = ensureString(
            existing.rationale,
            `Applied improvement for issue #${i + 1}: ${issues[i].claim}`,
        );

        normalized.push({
            issueRef: existing.issueRef != null ? existing.issueRef : i,
            decision,
            rationale,
        });
    }

    return normalized;
}

function normalizeDraftResult(result, command) {
    if (typeof result === 'string') {
        return { content: ensureString(result, command) };
    }

    const content = ensureString(result && result.content, `Draft for command: ${command}`);
    return { content };
}

function normalizeCritiqueResult(result, draftContent) {
    if (typeof result === 'string') {
        return {
            content: ensureString(result, 'Antigravity critique generated.'),
            rubric: normalizeRubric(null),
            issues: normalizeIssues(null, 'Draft critique'),
        };
    }

    return {
        content: ensureString(
            result && result.content,
            'Antigravity critique generated with actionable fixes.',
        ),
        rubric: normalizeRubric(result && result.rubric),
        issues: normalizeIssues(result && result.issues, draftContent.slice(0, 80) || 'Draft critique'),
    };
}

function normalizeRevisionResult(result, critique) {
    if (typeof result === 'string') {
        const issues = normalizeIssues(critique && critique.issues, 'Revision');
        return {
            content: ensureString(result, 'Codex revision completed.'),
            rubric: normalizeRubric(critique && critique.rubric),
            issues,
            decision: 'partially_accepted',
            responses: normalizeResponses(null, issues),
        };
    }

    const issues = normalizeIssues(
        (result && result.issues) || (critique && critique.issues),
        'Revision',
    );
    const decision = REVISION_DECISIONS.includes(String(result && result.decision).trim())
        ? String(result.decision).trim()
        : 'partially_accepted';

    return {
        content: ensureString(result && result.content, 'Codex revision completed.'),
        rubric: normalizeRubric((result && result.rubric) || (critique && critique.rubric)),
        issues,
        decision,
        responses: normalizeResponses(result && result.responses, issues),
    };
}

function buildDefaultDraft(context) {
    return {
        content: [
            'Initial codex draft:',
            `- taskId: ${context.taskId}`,
            `- command: ${context.command}`,
            '- focus: provide concrete implementation-ready next actions.',
        ].join('\n'),
    };
}

function buildDefaultCritique(context) {
    return {
        content: [
            'Antigravity critique:',
            '- identify one major risk and one concrete improvement path.',
        ].join('\n'),
        rubric: {
            correctness: 3,
            feasibility: 4,
            risk: 3,
            clarity: 3,
            testability: 3,
        },
        issues: [
            {
                claim: 'The draft lacks explicit failure handling for async interactions.',
                evidence: context.draft.content,
                suggestedFix: 'Add timeout/degraded-state behavior and recovery steps.',
            },
        ],
    };
}

function buildDefaultRevision(context) {
    const issues = normalizeIssues(context.critique.issues, 'Revision');
    return {
        content: [
            'Codex revision:',
            '- integrated critique feedback into timeout handling and validation steps.',
        ].join('\n'),
        rubric: normalizeRubric(context.critique.rubric),
        issues,
        decision: 'accepted',
        responses: normalizeResponses(
            issues.map((_, idx) => ({
                issueRef: idx,
                decision: 'accepted',
                rationale: `Applied fix for critique issue #${idx + 1}.`,
            })),
            issues,
        ),
    };
}

async function runTwoPassDebate(options = {}) {
    const command = ensureString(options.command, '(empty command)');
    const taskId = ensureString(options.taskId, makeId('task'));
    const ackId = ensureString(options.ackId, makeId('ack'));
    const debateId = ensureString(options.debateId, makeId('debate'));

    const logPath = options.logPath;
    const lockPath = options.lockPath;
    const maxRoundsUsed = clampRoundLimit(options.maxRounds);
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Math.max(1, Math.trunc(Number(options.timeoutMs)))
        : DEFAULT_TIMEOUT_MS;

    const runDraft = typeof options.runDraft === 'function' ? options.runDraft : buildDefaultDraft;
    const runCritique = typeof options.runCritique === 'function' ? options.runCritique : buildDefaultCritique;
    const runRevision = typeof options.runRevision === 'function' ? options.runRevision : buildDefaultRevision;

    const append = (event) => appendEvent(event, { logPath, lockPath });

    let latestEvent = null;

    const requestEvent = append({
        debateId,
        taskId,
        ackId,
        round: 0,
        speaker: 'system',
        type: 'request',
        content: command,
        replyToEventId: null,
        status: 'ok',
    });
    latestEvent = requestEvent;

    try {
        const draftRaw = await withTimeout(
            () => runDraft({ command, taskId, ackId, debateId }),
            timeoutMs,
            'draft stage',
        );
        const draft = normalizeDraftResult(draftRaw, command);

        const draftEvent = append({
            debateId,
            taskId,
            ackId,
            round: 1,
            speaker: 'codex',
            type: 'draft',
            content: draft.content,
            replyToEventId: requestEvent.eventId,
            status: 'ok',
        });
        latestEvent = draftEvent;

        const critiqueRaw = await withTimeout(
            () => runCritique({ command, taskId, ackId, debateId, draft }),
            timeoutMs,
            'critique stage',
        );
        const critique = normalizeCritiqueResult(critiqueRaw, draft.content);

        const critiqueEvent = append({
            debateId,
            taskId,
            ackId,
            round: 1,
            speaker: 'antigravity',
            type: 'critique',
            content: critique.content,
            rubric: critique.rubric,
            issues: critique.issues,
            replyToEventId: draftEvent.eventId,
            status: 'ok',
        });
        latestEvent = critiqueEvent;

        const revisionRaw = await withTimeout(
            () => runRevision({ command, taskId, ackId, debateId, draft, critique }),
            timeoutMs,
            'revision stage',
        );
        const revision = normalizeRevisionResult(revisionRaw, critique);

        const revisionEvent = append({
            debateId,
            taskId,
            ackId,
            round: 1,
            speaker: 'codex',
            type: 'revision',
            content: revision.content,
            rubric: revision.rubric,
            issues: revision.issues,
            decision: revision.decision,
            responses: revision.responses,
            replyToEventId: critiqueEvent.eventId,
            status: 'ok',
        });
        latestEvent = revisionEvent;

        const finalEvent = append({
            debateId,
            taskId,
            ackId,
            round: 1,
            speaker: 'system',
            type: 'final',
            content: '2-pass critique loop complete.',
            replyToEventId: revisionEvent.eventId,
            status: 'completed',
        });

        const events = readEvents({ debateId, logPath });
        const metrics = computeDebateMetrics(events);

        return {
            ok: true,
            debateId,
            taskId,
            ackId,
            status: 'completed',
            maxRoundsUsed,
            timeoutMs,
            finalEvent,
            events,
            metrics,
            result: revisionEvent.content,
        };
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const finalStatus = 'degraded';

        const errorEvent = append({
            debateId,
            taskId,
            ackId,
            round: 1,
            speaker: 'system',
            type: 'error',
            content: err.message,
            replyToEventId: latestEvent ? latestEvent.eventId : requestEvent.eventId,
            status: 'error',
        });

        const finalEvent = append({
            debateId,
            taskId,
            ackId,
            round: 1,
            speaker: 'system',
            type: 'final',
            content: `Debate degraded: ${err.message}`,
            replyToEventId: errorEvent.eventId,
            status: finalStatus,
        });

        const events = readEvents({ debateId, logPath });
        const metrics = computeDebateMetrics(events);

        return {
            ok: false,
            debateId,
            taskId,
            ackId,
            status: 'degraded',
            maxRoundsUsed,
            timeoutMs,
            error: err.message,
            finalEvent,
            events,
            metrics,
            result: finalEvent.content,
        };
    }
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    MAX_ROUNDS,
    buildDefaultDraft,
    buildDefaultCritique,
    buildDefaultRevision,
    runTwoPassDebate,
};
