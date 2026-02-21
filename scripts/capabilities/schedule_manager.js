const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const REQUESTS_PATH = path.join(ROOT, 'ops', 'state', 'schedule_requests.jsonl');

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
    if (key === 'list') return 'list';
    if (key === 'create') return 'create';
    if (key === 'update') return 'update';
    if (key === 'delete') return 'delete';
    return null;
}

function plan(input = {}) {
    const action = normalizeAction(input.action);
    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: `Unsupported schedule action: ${input.action || ''}`,
            plan: null,
        };
    }

    const payload = (input.payload && typeof input.payload === 'object') ? input.payload : {};
    const connectorAvailable = commandExists('remindctl');
    const mutating = action !== 'list';
    const blockers = [];
    if (!connectorAvailable) {
        blockers.push({
            code: 'CONNECTOR_UNAVAILABLE',
            message: 'schedule connector unavailable: install `remindctl` before enabling schedule actions.',
        });
    }
    if (action !== 'list' && !String(payload.when || '').trim()) {
        blockers.push({
            code: 'TIME_REQUIRED',
            message: 'schedule create/update/delete requires 시간(when).',
        });
    }

    return {
        ok: true,
        plan: {
            command_kind: 'capability',
            capability: 'schedule',
            action,
            intent_action: `capability:schedule:${action}`,
            payload,
            connector: {
                available: connectorAvailable,
                command: 'remindctl',
            },
            blockers,
            risk_tier: action === 'list' ? 'MEDIUM' : 'HIGH',
            mutating,
            requires_approval: mutating,
            required_flags: mutating ? ['force'] : [],
            plan_summary: `schedule ${action}`,
            operations: [{ kind: action }],
            rollback_instructions: mutating
                ? ['schedule changes may require manual correction in upstream calendar/reminder app.']
                : [],
        },
    };
}

function execute(input = {}) {
    const planPayload = input.plan && typeof input.plan === 'object' ? input.plan : {};
    const action = normalizeAction(input.action || planPayload.action);
    const payload = (planPayload.payload && typeof planPayload.payload === 'object') ? planPayload.payload : {};
    const connector = planPayload.connector || { available: commandExists('remindctl') };

    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: `Unsupported schedule action: ${input.action || ''}`,
        };
    }

    if (!connector.available) {
        return {
            ok: false,
            error_code: 'CONNECTOR_UNAVAILABLE',
            error: 'schedule connector unavailable: install `remindctl` before enabling schedule actions.',
            action,
        };
    }

    if (action === 'list') {
        return {
            ok: true,
            action,
            schedules: [],
            note: 'schedule connector detected. safe-mode list is enabled with placeholder output.',
        };
    }

    const request = {
        created_at: new Date().toISOString(),
        action,
        identifier: String(payload.identifier || '').trim(),
        when: String(payload.when || '').trim(),
        subject: String(payload.subject || payload.content || '').trim(),
        body: String(payload.body || '').trim(),
        requested_by: String(planPayload.requested_by || 'unknown'),
        mode: 'safe_request',
    };
    appendJsonl(REQUESTS_PATH, request);
    return {
        ok: true,
        action,
        dry_run: true,
        request_path: REQUESTS_PATH,
        note: 'schedule mutation recorded as safe request.',
    };
}

module.exports = {
    capability: 'schedule',
    supportedActions: ['list', 'create', 'update', 'delete'],
    plan,
    execute,
};
