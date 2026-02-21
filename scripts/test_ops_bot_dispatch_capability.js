const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeFakeDocker(binDir) {
    const scriptPath = path.join(binDir, 'docker');
    const body = `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
shift || true
if [[ "$cmd" == "exec" ]]; then
  printf '{"route":"work","success":true,"telegramReply":"delegated work ok"}\\n'
  exit 0
fi
printf "unsupported docker call: %s %s\\n" "$cmd" "$*" >&2
exit 1
`;
    fs.writeFileSync(scriptPath, body, { encoding: 'utf8', mode: 0o755 });
}

function run() {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-dispatch-bin-'));
    writeFakeDocker(fakeBin);
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;

    const botManager = require('./capabilities/bot_manager');

    const planned = botManager.plan({
        action: 'dispatch',
        payload: {
            target_profile: 'dev',
            route: 'work',
            original_message: '작업: 요청: hub test; 대상: repo; 완료기준: done',
        },
    });
    assert.strictEqual(planned.ok, true);
    assert.strictEqual(planned.plan.action, 'dispatch');
    assert.strictEqual(planned.plan.payload.target_profile, 'dev');
    assert.strictEqual(planned.plan.payload.target, 'moltbot-dev');

    const executed = botManager.execute({
        action: 'dispatch',
        plan: planned.plan,
    });
    assert.strictEqual(executed.ok, true);
    assert.strictEqual(executed.action, 'dispatch');
    assert.strictEqual(executed.target_profile, 'dev');
    assert.strictEqual(executed.route, 'work');
    assert.strictEqual(executed.telegramReply, 'delegated work ok');

    const blocked = botManager.plan({
        action: 'dispatch',
        payload: {
            target_profile: 'daily',
            route: 'ops',
            original_message: '운영: 액션: 상태; 대상: all',
        },
    });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.error_code, 'TARGET_NOT_ALLOWED');
}

run();
console.log('test_ops_bot_dispatch_capability: ok');
