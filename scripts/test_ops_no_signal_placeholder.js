const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writeFakeDocker(binDir) {
    const scriptPath = path.join(binDir, 'docker');
    const body = `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
shift || true
if [[ "$cmd" == "inspect" ]]; then
  container="\${@: -1}"
  if [[ "$container" == "moltbot-dev" || "$container" == "moltbot-anki" ]]; then
    printf "running\\ttrue\\n"
    exit 0
  fi
fi
if [[ "$cmd" == "logs" ]]; then
  container="\${@: -1}"
  if [[ "$container" == "moltbot-dev" || "$container" == "moltbot-anki" ]]; then
    printf "2026-02-16T08:20:00Z [telegram] [default] starting provider (@moltbot)\\n"
    exit 0
  fi
fi
echo "unsupported docker args: $cmd $*" >&2
exit 1
`;
    fs.writeFileSync(scriptPath, body, { encoding: 'utf8', mode: 0o755 });
    return scriptPath;
}

function run() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-no-signal-'));
    process.env.OPS_WORKSPACE_ROOT = tmpRoot;
    process.env.BRIDGE_DIR = path.join(tmpRoot, 'data', 'bridge');
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-no-signal-bin-'));
    writeFakeDocker(fakeBin);
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;

    const configPath = path.join(tmpRoot, 'ops', 'config', 'daily_ops_mvp.json');
    writeJson(configPath, {
        schema_version: '1.0',
        timezone: 'Asia/Tokyo',
        alerting: {
            enabled: true,
            transport: 'bridge_queue',
            p2_consecutive_failures_threshold: 3,
            cooldown_hours: 2,
            quiet_hours: { start: '23:00', end: '07:00' },
        },
        briefings: { morning_time: '08:30', evening_time: '18:30', send: false },
        workers: {
            'bot-dev': { active: true, container: 'moltbot-dev' },
            'bot-anki': { active: true, container: 'moltbot-anki', allow_telegram_signal_fallback: true },
            'bot-research': { active: false },
        },
    });

    writeJson(path.join(tmpRoot, 'logs', 'bot-dev', 'latest.json'), {
        schema_version: '1.0',
        bot_id: 'bot-dev',
        run_id: null,
        last_event_ts: null,
        status: 'ok',
        severity: 'P3',
        last_success_ts: null,
        consecutive_failures_by_issue: {},
    });
    writeJson(path.join(tmpRoot, 'logs', 'bot-dev', 'heartbeat.json'), {
        schema_version: '1.0',
        bot_id: 'bot-dev',
        run_id: null,
        ts: null,
        state: 'idle',
    });

    writeJson(path.join(tmpRoot, 'logs', 'bot-anki', 'latest.json'), {
        schema_version: '1.0',
        bot_id: 'bot-anki',
        run_id: null,
        last_event_ts: null,
        status: 'ok',
        severity: 'P3',
        last_success_ts: null,
        consecutive_failures_by_issue: {},
    });
    writeJson(path.join(tmpRoot, 'logs', 'bot-anki', 'heartbeat.json'), {
        schema_version: '1.0',
        bot_id: 'bot-anki',
        run_id: null,
        ts: null,
        state: 'idle',
    });

    const supervisor = require('./ops_daily_supervisor');
    const result = supervisor.runScan({
        now: '2026-02-16T08:30:00+09:00',
        configPath,
        sendEnabled: false,
    });

    const strictFinding = result.findings.find((item) => item.issue_id === 'bot-dev:no_signal');
    assert.ok(strictFinding, 'scan findings should include bot-dev:no_signal');
    const fallbackFinding = result.findings.find((item) => item.issue_id === 'bot-anki:no_signal');
    assert.ok(!fallbackFinding, 'bot-anki no_signal should be suppressed when telegram fallback is healthy');

    const issues = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'ops', 'state', 'issues.json'), 'utf8'));
    const strictNoSignalIssue = issues.issues['bot-dev:no_signal'];
    assert.ok(strictNoSignalIssue, 'strict no_signal issue must be persisted');
    assert.strictEqual(strictNoSignalIssue.severity, 'P3');
    assert.strictEqual(strictNoSignalIssue.status, 'open');
    const fallbackNoSignalIssue = issues.issues['bot-anki:no_signal'];
    assert.ok(!fallbackNoSignalIssue || fallbackNoSignalIssue.status !== 'open', 'fallback no_signal must not remain open');

    const state = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'ops', 'state', 'state.json'), 'utf8'));
    assert.strictEqual(state.bot_health['bot-dev'].status, 'UNKNOWN');
    assert.notStrictEqual(state.bot_health['bot-anki'].status, 'UNKNOWN');
    assert.strictEqual(state.bot_health['bot-anki'].signal_source, 'telegram_fallback');
}

run();
console.log('test_ops_no_signal_placeholder: ok');
