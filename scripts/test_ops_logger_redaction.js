const assert = require('assert');
const opsLogger = require('./ops_logger');

function run() {
    const redacted = opsLogger.redact({
        authorization: 'Bearer abcdefg123',
        token: 'my-secret-token',
        message: 'api_key=xyz123 password=qwerty',
        owner_email: 'person@example.com',
    });

    assert.strictEqual(redacted.authorization, '[REDACTED]');
    assert.strictEqual(redacted.token, '[REDACTED]');
    assert.ok(!String(redacted.message).includes('xyz123'));
    assert.ok(!String(redacted.message).includes('qwerty'));
    assert.ok(String(redacted.owner_email).startsWith('email_hash:'));

    const line = opsLogger.redact('Authorization: Bearer abc token=xyz');
    assert.ok(!String(line).includes('abc'));
    assert.ok(!String(line).includes('xyz'));
}

run();
console.log('test_ops_logger_redaction: ok');
