const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const opsApprovalStore = require('./ops_approval_store');
const opsFileControl = require('./ops_file_control');

const REQUEST_PREFIX = 'test-ops-file-git-gating';

function run(cmd, args, cwd) {
    const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
    }
    return String(res.stdout || '').trim();
}

function cleanupTokens() {
    for (const dir of [opsApprovalStore.APPROVAL_PENDING_DIR, opsApprovalStore.APPROVAL_CONSUMED_DIR]) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.json')) continue;
            const filePath = path.join(dir, name);
            try {
                const row = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (String(row.request_id || '').startsWith(REQUEST_PREFIX)) {
                    fs.rmSync(filePath, { force: true });
                }
            } catch (_) {
                // no-op
            }
        }
    }
}

function expectCode(fn, code) {
    let thrown = null;
    try {
        fn();
    } catch (error) {
        thrown = error;
    }
    assert.ok(thrown, `expected error code=${code}`);
    assert.strictEqual(thrown.code, code);
}

function main() {
    cleanupTokens();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsfc-git-'));
    const repoRoot = path.join(root, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });

    run('git', ['init'], repoRoot);
    run('git', ['config', 'user.name', 'Ops Test'], repoRoot);
    run('git', ['config', 'user.email', 'ops-test@example.com'], repoRoot);

    fs.writeFileSync(path.join(repoRoot, 'alpha.txt'), 'alpha', 'utf8');
    run('git', ['add', 'alpha.txt'], repoRoot);
    run('git', ['commit', '-m', 'init'], repoRoot);

    const policy = opsFileControl.loadPolicy({
        opsFileControlPolicy: {
            allowedRoots: [root],
            mediumRoots: [root],
            highRoots: [root],
            gitAllowedRoots: [root],
            telegramGuard: { enabled: false },
            trashRoot: path.join(root, '.trash'),
        },
    });

    const mvPlan = opsFileControl.computePlan({
        intentAction: 'git_mv',
        payload: {
            path: path.join(repoRoot, 'alpha.txt'),
            target_path: path.join(repoRoot, 'beta.txt'),
            repository: repoRoot,
        },
        requestedBy: '7704103236',
        policy,
    });
    assert.strictEqual(mvPlan.ok, true);
    assert.strictEqual(mvPlan.plan.risk_tier, 'GIT_AWARE');
    assert.deepStrictEqual(mvPlan.plan.required_flags, ['force']);

    const mvToken = opsApprovalStore.createApprovalToken({
        requestId: `${REQUEST_PREFIX}-mv`,
        requestedBy: '7704103236',
        requiredFlags: mvPlan.plan.required_flags,
        plan: mvPlan.plan,
    });

    expectCode(() => {
        opsApprovalStore.validateApproval({
            token: mvToken.token,
            requestedBy: '7704103236',
            providedFlags: [],
        });
    }, 'APPROVAL_FLAGS_REQUIRED');

    const pushPlan = opsFileControl.computePlan({
        intentAction: 'git_push',
        payload: {
            repository: repoRoot,
        },
        requestedBy: '7704103236',
        policy,
    });
    assert.strictEqual(pushPlan.ok, true);
    assert.strictEqual(pushPlan.plan.risk_tier, 'GIT_AWARE');
    assert.deepStrictEqual(pushPlan.plan.required_flags, ['force', 'push']);

    const pushToken = opsApprovalStore.createApprovalToken({
        requestId: `${REQUEST_PREFIX}-push`,
        requestedBy: '7704103236',
        requiredFlags: pushPlan.plan.required_flags,
        plan: pushPlan.plan,
    });

    expectCode(() => {
        opsApprovalStore.validateApproval({
            token: pushToken.token,
            requestedBy: '7704103236',
            providedFlags: ['force'],
        });
    }, 'APPROVAL_FLAGS_REQUIRED');

    const validatedPush = opsApprovalStore.validateApproval({
        token: pushToken.token,
        requestedBy: '7704103236',
        providedFlags: ['force', 'push'],
    });
    assert.strictEqual(validatedPush.token, pushToken.token);

    cleanupTokens();
    console.log('test_ops_file_git_gating: ok');
}

main();
