const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const MAIL_DRAFTS_PATH = path.join(ROOT, 'ops', 'state', 'mail_send_drafts.jsonl');

function commandExists(command) {
    const res = spawnSync('sh', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
    return !res.error && res.status === 0;
}

function ensureParent(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendJsonl(filePath, payload) {
    ensureParent(filePath);
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function normalizeAction(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) return 'list';
    if (key === 'list') return 'list';
    if (key === 'summary') return 'summary';
    if (key === 'send') return 'send';
    return null;
}

function buildConnectorStatus() {
    const available = commandExists('himalaya');
    return {
        available,
        command: 'himalaya',
        install_hint: available
            ? ''
            : 'mail connector unavailable: install `himalaya` and configure account credentials before enabling mail actions.',
    };
}

function plan(input = {}) {
    const action = normalizeAction(input.action);
    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: `Unsupported mail action: ${input.action || ''}`,
            plan: null,
        };
    }

    const payload = (input.payload && typeof input.payload === 'object') ? input.payload : {};
    const connector = buildConnectorStatus();
    const mutating = action === 'send';

    const blockers = [];
    if (!connector.available) {
        blockers.push({ code: 'CONNECTOR_UNAVAILABLE', message: connector.install_hint });
    }
    if (action === 'send') {
        if (!String(payload.recipient || '').trim()) {
            blockers.push({ code: 'RECIPIENT_REQUIRED', message: 'mail send requires recipient.' });
        }
        if (!String(payload.subject || '').trim()) {
            blockers.push({ code: 'SUBJECT_REQUIRED', message: 'mail send requires subject.' });
        }
    }

    return {
        ok: true,
        plan: {
            command_kind: 'capability',
            capability: 'mail',
            action,
            intent_action: `capability:mail:${action}`,
            payload,
            connector,
            blockers,
            risk_tier: action === 'send' ? 'HIGH' : 'MEDIUM',
            mutating,
            requires_approval: action === 'send',
            required_flags: action === 'send' ? ['force'] : [],
            plan_summary: `mail ${action}`,
            operations: [{ kind: action }],
            rollback_instructions: [],
        },
    };
}

function execute(input = {}) {
    const planPayload = input.plan && typeof input.plan === 'object' ? input.plan : {};
    const action = normalizeAction(input.action || planPayload.action);
    const payload = (planPayload.payload && typeof planPayload.payload === 'object') ? planPayload.payload : {};
    const connector = planPayload.connector || buildConnectorStatus();

    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: `Unsupported mail action: ${input.action || ''}`,
        };
    }

    if (!connector.available) {
        return {
            ok: false,
            error_code: 'CONNECTOR_UNAVAILABLE',
            error: connector.install_hint,
            action,
        };
    }

    if (action === 'list') {
        return {
            ok: true,
            action,
            messages: [],
            note: 'mail connector detected. safe-mode list is enabled with placeholder output.',
        };
    }

    if (action === 'summary') {
        return {
            ok: true,
            action,
            summary: [],
            note: 'mail connector detected. safe-mode summary is enabled with placeholder output.',
        };
    }

    if (action === 'send') {
        const draft = {
            created_at: new Date().toISOString(),
            recipient: String(payload.recipient || '').trim(),
            subject: String(payload.subject || '').trim(),
            body: String(payload.body || payload.content || '').trim(),
            account: String(payload.account || '').trim(),
            attachment: String(payload.attachment || '').trim(),
            requested_by: String(planPayload.requested_by || 'unknown'),
            mode: 'safe_draft',
        };
        appendJsonl(MAIL_DRAFTS_PATH, draft);
        return {
            ok: true,
            action,
            dry_run: true,
            draft_path: MAIL_DRAFTS_PATH,
            note: 'mail send recorded as draft (safe mode).',
        };
    }

    return {
        ok: false,
        error_code: 'UNSUPPORTED_ACTION',
        error: `Unsupported mail action: ${action}`,
    };
}

module.exports = {
    capability: 'mail',
    supportedActions: ['list', 'summary', 'send'],
    plan,
    execute,
};
