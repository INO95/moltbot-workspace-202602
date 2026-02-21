const assert = require('assert');
const opsLogger = require('./ops_logger');

function run() {
    const errA = {
        name: 'TimeoutError',
        code: 'ETIMEDOUT',
        message: 'Request timed out after 15s',
        stack: 'stack-a',
    };
    const errB = {
        name: 'TimeoutError',
        code: 'ETIMEDOUT',
        message: 'Request timed out after 15s',
        stack: 'stack-b',
    };
    const errC = {
        name: 'TimeoutError',
        code: 'EAI_AGAIN',
        message: 'Request timed out after 15s',
    };

    const fpA = opsLogger.fingerprintError(errA, { component: 'fetcher', action: 'GET /v1' });
    const fpB = opsLogger.fingerprintError(errB, { component: 'fetcher', action: 'GET /v1' });
    const fpC = opsLogger.fingerprintError(errC, { component: 'fetcher', action: 'GET /v1' });

    assert.strictEqual(fpA, fpB);
    assert.notStrictEqual(fpA, fpC);
}

run();
console.log('test_ops_fingerprint_stability: ok');
