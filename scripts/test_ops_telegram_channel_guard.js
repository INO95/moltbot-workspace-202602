const assert = require('assert');

const supervisor = require('./ops_daily_supervisor');

function run() {
    const authFailureLog = [
        '2026-02-16T14:39:19.864Z [telegram] setMyCommands failed: Call to \'setMyCommands\' failed! (404: Not Found)',
        '2026-02-16T14:39:20.111Z [telegram] [default] channel exited: Call to \'getMe\' failed! (404: Not Found)',
    ].join('\n');
    const authFailure = supervisor.parseTelegramLogHealth(authFailureLog, { errorLineLimit: 5 });
    assert.strictEqual(authFailure.has_failure, true);
    assert.strictEqual(authFailure.has_auth_invalid, true);
    assert.ok(authFailure.channel_exits >= 1);
    assert.ok(authFailure.auth_invalids >= 1);
    assert.ok(Array.isArray(authFailure.error_lines) && authFailure.error_lines.length >= 1);

    const healthyLog = [
        '2026-02-16T14:41:05.819Z [telegram] [default] starting provider (@Open_Claw_ino2_bot)',
        '2026-02-16T14:41:05.825Z [telegram] autoSelectFamily=false (default-node22)',
    ].join('\n');
    const healthy = supervisor.parseTelegramLogHealth(healthyLog, { errorLineLimit: 5 });
    assert.strictEqual(healthy.has_failure, false);
    assert.strictEqual(healthy.has_auth_invalid, false);
    assert.ok(healthy.provider_starts >= 1);
    assert.strictEqual(healthy.channel_exits, 0);

    const channelExitLog = [
        '2026-02-16T14:52:01.000Z [telegram] [default] channel exited: network timeout',
    ].join('\n');
    const channelExit = supervisor.parseTelegramLogHealth(channelExitLog, { errorLineLimit: 5 });
    assert.strictEqual(channelExit.has_failure, true);
    assert.strictEqual(channelExit.has_auth_invalid, false);
    assert.strictEqual(channelExit.channel_exits, 1);

    const recoveredLog = [
        '2026-02-16T14:39:20.111Z [telegram] [default] channel exited: Call to \'getMe\' failed! (404: Not Found)',
        '2026-02-16T14:39:20.225Z [telegram] setMyCommands failed: Call to \'setMyCommands\' failed! (404: Not Found)',
        '2026-02-16T14:40:01.100Z [telegram] [default] starting provider (@ino_anki_bot)',
    ].join('\n');
    const recovered = supervisor.parseTelegramLogHealth(recoveredLog, { errorLineLimit: 5 });
    assert.strictEqual(recovered.has_failure, false);
    assert.strictEqual(recovered.has_auth_invalid, false);
    assert.strictEqual(recovered.channel_exits, 0);
}

run();
console.log('test_ops_telegram_channel_guard: ok');
