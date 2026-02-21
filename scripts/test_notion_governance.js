const assert = require('assert');
const { assertNotionDbWriteAllowed, assertDbMetaMutationAllowed } = require('./notion_guard');

function main() {
    let approvalError = null;
    try {
        assertNotionDbWriteAllowed({ approvalToken: '', action: 'unit_test_db_write' });
    } catch (error) {
        approvalError = error;
    }
    assert.ok(approvalError, 'missing approval should throw');
    assert.strictEqual(approvalError.code, 'APPROVAL_REQUIRED');

    assert.doesNotThrow(() => {
        assertNotionDbWriteAllowed({ approvalToken: 'approved-token', action: 'unit_test_db_write' });
    });

    let metaError = null;
    try {
        assertDbMetaMutationAllowed({ action: 'unit_test_db_meta' });
    } catch (error) {
        metaError = error;
    }
    assert.ok(metaError, 'db meta mutation should be blocked');
    assert.strictEqual(metaError.code, 'DB_META_MUTATION_BLOCKED');

    console.log('test_notion_governance: ok');
}

main();
