const assert = require('assert');
const { buildProjectBootstrapPlan } = require('./project_bootstrap');

function main() {
    const nextPlan = buildProjectBootstrapPlan({
        프로젝트명: 'My New App',
        목표: '테스트',
        스택: 'next.js typescript pnpm',
        경로: '/Users/moltbot/Projects',
        완료기준: 'dev server 실행',
        초기화: '실행',
    });

    assert.strictEqual(nextPlan.projectName, 'my-new-app');
    assert.strictEqual(nextPlan.template, 'next-ts');
    assert.strictEqual(nextPlan.targetPath, '/Users/moltbot/Projects/my-new-app');
    assert.strictEqual(nextPlan.packageManager, 'pnpm');
    assert.strictEqual(nextPlan.initMode, 'execute');
    assert.strictEqual(nextPlan.requiresApproval, true);
    assert.ok(Array.isArray(nextPlan.approvalReasons));
    assert.ok(nextPlan.approvalReasons.includes('init_mode_execute'));
    assert.ok(Array.isArray(nextPlan.commands) && nextPlan.commands.length > 0);
    assert.ok(nextPlan.commands.some((cmd) => cmd.includes('create next-app')));
    assert.ok(Array.isArray(nextPlan.qualityGates) && nextPlan.qualityGates.length >= 3);
    assert.ok(nextPlan.pathPolicy && nextPlan.pathPolicy.allowed === true);
    assert.ok(nextPlan.script.includes('\n'));

    const nodePlan = buildProjectBootstrapPlan({
        프로젝트명: 'api-server',
        스택: 'node express yarn',
        경로: '/Users/moltbot/Projects/services',
    });
    assert.strictEqual(nodePlan.template, 'node-express');
    assert.strictEqual(nodePlan.packageManager, 'yarn');
    assert.strictEqual(nodePlan.initMode, 'plan');
    assert.strictEqual(nodePlan.requiresApproval, false);
    assert.ok(nodePlan.commands.some((cmd) => cmd.includes('yarn add express')));

    const relativePathPlan = buildProjectBootstrapPlan({
        프로젝트명: 'relative-app',
        스택: 'vite react',
        경로: 'sandbox/apps',
    });
    assert.ok(relativePathPlan.targetPath.endsWith('/sandbox/apps/relative-app'));
    assert.strictEqual(relativePathPlan.pathPolicy.basePathSource, 'relative');
    assert.ok(Array.isArray(relativePathPlan.warnings) && relativePathPlan.warnings.length > 0);

    const blockedPathPlan = buildProjectBootstrapPlan({
        프로젝트명: 'outside-app',
        스택: 'vite react',
        경로: '/tmp/outside',
        허용경로: '/Users/moltbot/Projects',
    });
    assert.strictEqual(blockedPathPlan.pathPolicy.allowed, false);
    assert.strictEqual(blockedPathPlan.requiresApproval, true);
    assert.ok(blockedPathPlan.approvalReasons.includes('path_outside_allowed_root'));

    console.log('test_project_bootstrap: ok');
}

main();
