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
  case "$container" in
    moltbot-anki)
      printf "running\\ttrue\\n"
      exit 0
      ;;
    moltbot-dev)
      printf "exited\\tfalse\\n"
      exit 0
      ;;
  esac
fi
if [[ "$cmd" == "logs" ]]; then
  container="\${@: -1}"
  case "$container" in
    moltbot-anki)
      printf "2026-02-17T07:59:00Z [telegram] [default] starting provider (@anki)\\n"
      exit 0
      ;;
    moltbot-dev)
      printf "2026-02-17T07:59:00Z [telegram] [default] channel exited: network timeout\\n"
      exit 0
      ;;
  esac
fi
printf "unsupported docker call: %s %s\\n" "$cmd" "$*" >&2
exit 1
`;
    fs.writeFileSync(scriptPath, body, { encoding: 'utf8', mode: 0o755 });
}

function run() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-down-v2-'));
    process.env.OPS_WORKSPACE_ROOT = tmpRoot;
    process.env.BRIDGE_DIR = path.join(tmpRoot, 'data', 'bridge');

    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-down-v2-bin-'));
    writeFakeDocker(fakeBin);
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;

    const configPath = path.join(tmpRoot, 'ops', 'config', 'daily_ops_mvp.json');
    writeJson(configPath, {
        schema_version: '1.0',
        timezone: 'Asia/Tokyo',
        alerting: {
            enabled: false,
            transport: 'bridge_queue',
            p2_consecutive_failures_threshold: 3,
            cooldown_hours: 2,
            quiet_hours: { start: '23:00', end: '07:00' },
        },
        briefings: { morning_time: '08:30', evening_time: '18:30', send: false },
        health_policy: {
            heartbeat_stall_minutes: 15,
            stale_warn_minutes: 45,
            down_heartbeat_minutes: 360,
            down_requires_telegram_failure_when_container_running: true,
            no_signal_status: 'UNKNOWN',
            idle_stale_status: 'WARN',
        },
        workers: {
            'bot-anki': {
                active: true,
                container: 'moltbot-anki',
                allow_telegram_signal_fallback: true,
            },
            'bot-dev': {
                active: true,
                container: 'moltbot-dev',
            },
        },
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

    writeJson(path.join(tmpRoot, 'logs', 'bot-dev', 'latest.json'), {
        schema_version: '1.0',
        bot_id: 'bot-dev',
        run_id: 'dev-run-1',
        last_event_ts: '2026-02-16T00:00:00+09:00',
        status: 'ok',
        severity: 'P3',
        last_success_ts: '2026-02-16T00:00:00+09:00',
        consecutive_failures_by_issue: {},
    });
    writeJson(path.join(tmpRoot, 'logs', 'bot-dev', 'heartbeat.json'), {
        schema_version: '1.0',
        bot_id: 'bot-dev',
        run_id: 'dev-run-1',
        ts: '2026-02-16T00:00:00+09:00',
        state: 'idle',
    });

    const supervisor = require('./ops_daily_supervisor');
    const out = supervisor.runScan({
        now: '2026-02-17T08:00:00+09:00',
        configPath,
        sendEnabled: false,
    });

    const devDown = out.findings.find((row) => row.issue_id === 'bot-dev:bot_down');
    assert.ok(devDown, 'bot-dev should be classified as bot_down');

    const ankiDown = out.findings.find((row) => row.issue_id === 'bot-anki:bot_down');
    assert.ok(!ankiDown, 'running container + healthy telegram fallback must not be bot_down');

    const issues = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'ops', 'state', 'issues.json'), 'utf8'));
    assert.strictEqual(issues.issues['bot-dev:bot_down'].status, 'open');
    assert.strictEqual(issues.issues['bot-dev:bot_down'].severity, 'P1');
    const ankiNoSignal = issues.issues['bot-anki:no_signal'];
    assert.ok(!ankiNoSignal || ankiNoSignal.status !== 'open', 'fallback bot should not keep no_signal open');

    const state = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'ops', 'state', 'state.json'), 'utf8'));
    assert.strictEqual(state.bot_health['bot-dev'].status, 'DOWN');
    assert.strictEqual(state.bot_health['bot-dev'].container_state.running, false);
    assert.strictEqual(state.bot_health['bot-anki'].signal_source, 'telegram_fallback');
    assert.notStrictEqual(state.bot_health['bot-anki'].status, 'DOWN');
}

run();
console.log('test_ops_bot_down_classification_v2: ok');
