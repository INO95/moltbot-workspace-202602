const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ensureTestOpsIsolation } = require('./lib/test_ops_isolation');

ensureTestOpsIsolation('ops-file-approval-flow');

const opsApprovalStore = require('./ops_approval_store');

const REQUEST_PREFIX = 'test-ops-file-approval-flow';

function cleanup() {
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
    opsApprovalStore.clearApprovalGrant(`${REQUEST_PREFIX}-grant-user`);
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
    const previousMode = process.env.OPS_UNIFIED_APPROVAL_IDENTITY_MODE;
    process.env.OPS_UNIFIED_APPROVAL_IDENTITY_MODE = 'strict_user_bot';
    opsApprovalStore.ensureLayout();
    cleanup();

    const plan = {
        intent_action: 'move',
        required_flags: ['force'],
        exact_paths: ['/tmp/a', '/tmp/b'],
    };

    const token1 = opsApprovalStore.createApprovalToken({
        requestId: `${REQUEST_PREFIX}-1`,
        requestedBy: '7704103236',
        requiredFlags: ['force'],
        plan,
        planSummary: {
            risk_tier: 'HIGH',
        },
    });

    expectCode(() => {
        opsApprovalStore.validateApproval({
            token: token1.token,
            requestedBy: '7704103236',
            providedFlags: [],
        });
    }, 'APPROVAL_FLAGS_REQUIRED');

    expectCode(() => {
        opsApprovalStore.validateApproval({
            token: token1.token,
            requestedBy: '999999',
            providedFlags: ['force'],
        });
    }, 'REQUESTER_MISMATCH');

    const validated = opsApprovalStore.validateApproval({
        token: token1.token,
        requestedBy: '7704103236',
        providedFlags: ['force'],
    });
    assert.strictEqual(validated.token, token1.token);

    const consumed = opsApprovalStore.consumeApproval({
        token: token1.token,
        consumedBy: '7704103236',
        executionRequestId: `${REQUEST_PREFIX}-exec1`,
    });
    assert.ok(consumed.consumed_at);

    expectCode(() => {
        opsApprovalStore.validateApproval({
            token: token1.token,
            requestedBy: '7704103236',
            providedFlags: ['force'],
        });
    }, 'TOKEN_CONSUMED');

    const token2 = opsApprovalStore.createApprovalToken({
        requestId: `${REQUEST_PREFIX}-2`,
        requestedBy: '7704103236',
        requiredFlags: [],
        plan,
        ttlPolicy: {
            defaultTtlSeconds: 1,
            minTtlSeconds: 1,
            maxTtlSeconds: 5,
        },
        ttlSeconds: 1,
    });

    const pendingPath = path.join(opsApprovalStore.APPROVAL_PENDING_DIR, `${token2.token}.json`);
    const row = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    row.expires_at = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(pendingPath, `${JSON.stringify(row, null, 2)}\n`, 'utf8');

    expectCode(() => {
        opsApprovalStore.validateApproval({
            token: token2.token,
            requestedBy: '7704103236',
            providedFlags: [],
        });
    }, 'TOKEN_EXPIRED');

    const grantRequester = `${REQUEST_PREFIX}-grant-user`;
    const grant = opsApprovalStore.createApprovalGrant({
        requestedBy: grantRequester,
        scope: 'all',
        ttlSeconds: 1,
        grantPolicy: {
            defaultTtlSeconds: 1,
            minTtlSeconds: 1,
            maxTtlSeconds: 5,
        },
    });
    const activeGrant = opsApprovalStore.hasActiveApprovalGrant({
        requestedBy: grantRequester,
        scope: 'all',
    });
    assert.strictEqual(activeGrant.active, true);
    assert.strictEqual(activeGrant.record.grant_id, grant.grant_id);

    const expiredGrant = opsApprovalStore.hasActiveApprovalGrant({
        requestedBy: grantRequester,
        scope: 'all',
        nowMs: Date.now() + (24 * 60 * 60 * 1000),
    });
    assert.strictEqual(expiredGrant.active, false);
    assert.strictEqual(expiredGrant.error_code, 'GRANT_EXPIRED');

    cleanup();
    if (previousMode == null) {
        delete process.env.OPS_UNIFIED_APPROVAL_IDENTITY_MODE;
    } else {
        process.env.OPS_UNIFIED_APPROVAL_IDENTITY_MODE = previousMode;
    }
    console.log('test_ops_file_approval_flow: ok');
}

main();
