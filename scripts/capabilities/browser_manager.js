const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const REQUESTS_PATH = path.join(ROOT, 'ops', 'state', 'browser_requests.jsonl');
const MUTATING_ACTIONS = new Set(['checkout', 'post', 'send']);

function commandExists(command) {
    const res = spawnSync('sh', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
    return !res.error && res.status === 0;
}

function appendJsonl(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function normalizeAction(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) return 'list';
    if (key === 'open') return 'open';
    if (key === 'list') return 'list';
    if (key === 'click') return 'click';
    if (key === 'type') return 'type';
    if (key === 'wait') return 'wait';
    if (key === 'screenshot') return 'screenshot';
    if (key === 'checkout') return 'checkout';
    if (key === 'post') return 'post';
    if (key === 'send') return 'send';
    return null;
}

function requiredPayloadErrors(action, payload) {
    const out = [];
    if (action === 'open' && !String(payload.url || payload.path || '').trim()) {
        out.push({ code: 'URL_REQUIRED', message: 'browser open requires URL.' });
    }
    if (action === 'click' && !String(payload.selector || payload.identifier || '').trim()) {
        out.push({ code: 'SELECTOR_REQUIRED', message: 'browser click requires selector or identifier.' });
    }
    if (action === 'type' && !String(payload.selector || payload.identifier || '').trim()) {
        out.push({ code: 'SELECTOR_REQUIRED', message: 'browser type requires selector or identifier.' });
    }
    if (action === 'type' && !String(payload.value || payload.content || payload.body || '').trim()) {
        out.push({ code: 'VALUE_REQUIRED', message: 'browser type requires value/content.' });
    }
    return out;
}

function plan(input = {}) {
    const action = normalizeAction(input.action);
    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: `Unsupported browser action: ${input.action || ''}`,
            plan: null,
        };
    }

    const payload = (input.payload && typeof input.payload === 'object') ? input.payload : {};
    const mutating = MUTATING_ACTIONS.has(action);
    const connectorAvailable = commandExists('openclaw') || commandExists('playwright');
    const blockers = requiredPayloadErrors(action, payload);
    if (!connectorAvailable) {
        blockers.push({
            code: 'CONNECTOR_UNAVAILABLE',
            message: 'browser connector unavailable: configure OpenClaw browser runtime or Playwright before execute.',
        });
    }

    return {
        ok: true,
        plan: {
            command_kind: 'capability',
            capability: 'browser',
            action,
            intent_action: `capability:browser:${action}`,
            payload,
            connector: {
                available: connectorAvailable,
                command: connectorAvailable ? 'openclaw|playwright' : '',
            },
            blockers,
            risk_tier: mutating ? 'HIGH' : 'MEDIUM',
            mutating,
            requires_approval: mutating,
            required_flags: mutating ? ['force'] : [],
            plan_summary: `browser ${action}`,
            operations: [{ kind: action }],
            rollback_instructions: mutating
                ? ['browser mutating action: verify remote side effects manually and rollback in target system if needed.']
                : [],
        },
    };
}

function execute(input = {}) {
    const planPayload = input.plan && typeof input.plan === 'object' ? input.plan : {};
    const action = normalizeAction(input.action || planPayload.action);
    const payload = (planPayload.payload && typeof planPayload.payload === 'object') ? planPayload.payload : {};

    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: `Unsupported browser action: ${input.action || ''}`,
        };
    }

    if (!MUTATING_ACTIONS.has(action)) {
        return {
            ok: true,
            action,
            dry_run: true,
            note: 'browser non-mutating action is recorded in safe mode.',
            details: {
                url: String(payload.url || payload.path || '').trim(),
                selector: String(payload.selector || payload.identifier || '').trim(),
            },
        };
    }

    const request = {
        created_at: new Date().toISOString(),
        action,
        url: String(payload.url || payload.path || '').trim(),
        method: String(payload.method || '').trim() || (action === 'post' ? 'POST' : ''),
        selector: String(payload.selector || payload.identifier || '').trim(),
        value: String(payload.value || payload.content || payload.body || '').trim(),
        requested_by: String(planPayload.requested_by || 'unknown'),
        mode: 'safe_request',
    };
    appendJsonl(REQUESTS_PATH, request);
    return {
        ok: true,
        action,
        dry_run: true,
        request_path: REQUESTS_PATH,
        note: 'browser mutating action recorded as safe request.',
    };
}

module.exports = {
    capability: 'browser',
    supportedActions: ['open', 'list', 'click', 'type', 'wait', 'screenshot', 'checkout', 'post', 'send'],
    plan,
    execute,
};
