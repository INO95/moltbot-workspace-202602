const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const opsFileControl = require('./ops_file_control');

function run(cmd, args, cwd) {
    const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
    }
    return String(res.stdout || '').trim();
}

function buildPolicy(root) {
    const mediumRoot = path.join(root, 'medium');
    const highRoot = path.join(root, 'high');
    const gitRoot = path.join(root, 'repos');
    const trashRoot = path.join(root, '.assistant_trash');
    fs.mkdirSync(mediumRoot, { recursive: true });
    fs.mkdirSync(highRoot, { recursive: true });
    fs.mkdirSync(gitRoot, { recursive: true });
    fs.mkdirSync(trashRoot, { recursive: true });

    return {
        ...opsFileControl.loadPolicy({
            opsFileControlPolicy: {
                allowedRoots: [root, '/Volumes'],
                mediumRoots: [mediumRoot],
                highRoots: [highRoot],
                externalRoot: '/Volumes',
                gitAllowedRoots: [gitRoot],
                trashRoot,
                telegramGuard: {
                    enabled: false,
                },
            },
        }),
        mediumRoot,
        highRoot,
        gitRoot,
    };
}

function main() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opsfc-tier-'));
    const policy = buildPolicy(tmpRoot);

    const mediumSrc = path.join(policy.mediumRoot, 'a.txt');
    const mediumDst = path.join(policy.mediumRoot, 'dst');
    fs.mkdirSync(mediumDst, { recursive: true });
    fs.writeFileSync(mediumSrc, 'medium', 'utf8');

    const highSrc = path.join(policy.highRoot, 'b.txt');
    const highDst = path.join(policy.highRoot, 'dst');
    fs.mkdirSync(highDst, { recursive: true });
    fs.writeFileSync(highSrc, 'high', 'utf8');

    const mediumPlan = opsFileControl.computePlan({
        intentAction: 'move',
        payload: {
            path: mediumSrc,
            target_path: mediumDst,
        },
        requestedBy: 'test-user',
        policy,
    });
    assert.strictEqual(mediumPlan.ok, true);
    assert.strictEqual(mediumPlan.plan.risk_tier, 'MEDIUM');
    assert.deepStrictEqual(mediumPlan.plan.required_flags, []);

    const highPlan = opsFileControl.computePlan({
        intentAction: 'move',
        payload: {
            path: highSrc,
            target_path: highDst,
        },
        requestedBy: 'test-user',
        policy,
    });
    assert.strictEqual(highPlan.ok, true);
    assert.strictEqual(highPlan.plan.risk_tier, 'HIGH');
    assert.deepStrictEqual(highPlan.plan.required_flags, ['force']);

    const externalPlan = opsFileControl.computePlan({
        intentAction: 'move',
        payload: {
            path: mediumSrc,
            target_path: '/Volumes/TestDrive/Inbox',
        },
        requestedBy: 'test-user',
        policy,
    });
    assert.strictEqual(externalPlan.ok, true);
    assert.strictEqual(externalPlan.plan.risk_tier, 'HIGH_PRECHECK');
    assert.deepStrictEqual(externalPlan.plan.required_flags, ['force']);
    assert.ok(externalPlan.plan.preflight);

    const repoRoot = path.join(policy.gitRoot, 'demo');
    fs.mkdirSync(repoRoot, { recursive: true });
    run('git', ['init'], repoRoot);
    run('git', ['config', 'user.name', 'Ops Test'], repoRoot);
    run('git', ['config', 'user.email', 'ops-test@example.com'], repoRoot);
    const gitSrc = path.join(repoRoot, 'before.txt');
    const gitDst = path.join(repoRoot, 'after.txt');
    fs.writeFileSync(gitSrc, 'git', 'utf8');
    run('git', ['add', 'before.txt'], repoRoot);
    run('git', ['commit', '-m', 'init'], repoRoot);

    const gitPlan = opsFileControl.computePlan({
        intentAction: 'git_mv',
        payload: {
            path: gitSrc,
            target_path: gitDst,
            repository: repoRoot,
        },
        requestedBy: 'test-user',
        policy,
    });
    assert.strictEqual(gitPlan.ok, true);
    assert.strictEqual(gitPlan.plan.risk_tier, 'GIT_AWARE');
    assert.deepStrictEqual(gitPlan.plan.required_flags, ['force']);

    console.log('test_ops_file_policy_tiers: ok');
}

main();
