const opsFileControl = require('../ops_file_control');

function plan(input = {}) {
    const policy = input.policy || opsFileControl.loadPolicy({});
    const action = opsFileControl.normalizeIntentAction(input.action || input.intent_action || '');
    if (!action) {
        return {
            ok: false,
            error_code: 'UNSUPPORTED_ACTION',
            error: `Unsupported file action: ${input.action || ''}`,
            plan: null,
        };
    }

    const result = opsFileControl.computePlan({
        intentAction: action,
        payload: (input.payload && typeof input.payload === 'object') ? input.payload : {},
        requestedBy: input.requestedBy || 'unknown',
        telegramContext: input.telegramContext || null,
        policy,
    });
    if (!result.ok || !result.plan) return result;

    return {
        ok: true,
        plan: {
            command_kind: 'capability',
            capability: 'file',
            action,
            ...result.plan,
        },
    };
}

function execute(input = {}) {
    const planPayload = input.plan && typeof input.plan === 'object' ? input.plan : {};
    const policy = input.policy || opsFileControl.loadPolicy({});
    return opsFileControl.executePlan({
        plan: planPayload,
        policy,
    });
}

module.exports = {
    capability: 'file',
    supportedActions: [
        'list_files',
        'compute_plan',
        'move',
        'rename',
        'archive',
        'trash',
        'restore',
        'drive_preflight_check',
        'git_status',
        'git_diff',
        'git_mv',
        'git_add',
        'git_commit',
        'git_push',
    ],
    plan,
    execute,
};
