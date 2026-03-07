const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean);
}

async function run() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-briefing-'));
    process.env.OPS_WORKSPACE_ROOT = tmpRoot;
    process.env.BRIDGE_DIR = path.join(tmpRoot, 'data', 'bridge');
    const personalBriefing = require('./personal_briefing');
    const personalStorage = require('./personal_storage');

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
        briefings: { morning_time: '08:30', evening_time: '18:30', send: true },
        workers: {
            'bot-dev': { active: true },
            'bot-anki': { active: true },
            'bot-research': { active: true },
        },
    });

    writeJson(path.join(tmpRoot, 'ops', 'state', 'state.json'), {
        schema_version: '1.0',
        updated_at: '2026-02-16T08:00:00+09:00',
        timezone: 'Asia/Tokyo',
        scan_cursor_ts_by_bot: {},
        bot_health: {
            'bot-dev': {
                status: 'OK',
                last_success_ts: '2026-02-16T07:59:00+09:00',
                last_run_ts: '2026-02-16T07:59:00+09:00',
                staleness_minutes: 1,
                runs_observed: 1,
                retries_recovered: 0,
            },
            'bot-anki': {
                status: 'WARN',
                last_success_ts: '2026-02-16T07:40:00+09:00',
                last_run_ts: '2026-02-16T07:50:00+09:00',
                staleness_minutes: 20,
                runs_observed: 2,
                retries_recovered: 1,
            },
            'bot-research': {
                status: 'ERROR',
                last_success_ts: '2026-02-16T06:30:00+09:00',
                last_run_ts: '2026-02-16T07:30:00+09:00',
                staleness_minutes: 60,
                runs_observed: 2,
                retries_recovered: 0,
            },
        },
        last_briefing_sent: {
            morning: null,
            evening: null,
        },
    });
    writeJson(path.join(tmpRoot, 'ops', 'state', 'issues.json'), {
        schema_version: '1.0',
        updated_at: '2026-02-16T08:00:00+09:00',
        issues: {
            'bot-research:fp_test_1': {
                issue_id: 'bot-research:fp_test_1',
                bot_id: 'bot-research',
                fingerprint: 'fp_test_1',
                status: 'open',
                severity: 'P2',
                first_seen_ts: '2026-02-16T07:00:00+09:00',
                last_seen_ts: '2026-02-16T07:30:00+09:00',
                consecutive_failures: 3,
                last_alert_ts: null,
                quiet_hours_suppressed_count: 1,
                evidence: {
                    run_ids: ['research-run-1'],
                    log_paths: ['/tmp/log-a'],
                },
                summary: 'Upstream service returned 503.',
                resolved_at: null,
            },
            'bot-anki:fp_resolved': {
                issue_id: 'bot-anki:fp_resolved',
                bot_id: 'bot-anki',
                fingerprint: 'fp_resolved',
                status: 'resolved',
                severity: 'P2',
                first_seen_ts: '2026-02-16T05:00:00+09:00',
                last_seen_ts: '2026-02-16T07:20:00+09:00',
                consecutive_failures: 0,
                last_alert_ts: '2026-02-16T06:00:00+09:00',
                quiet_hours_suppressed_count: 0,
                evidence: {
                    run_ids: ['anki-run-9'],
                    log_paths: ['/tmp/log-b'],
                },
                summary: 'Resolved after dependency recovery.',
                resolved_at: '2026-02-16T07:20:00+09:00',
            },
        },
    });
    writeJson(path.join(tmpRoot, 'logs', 'midnight_recursive_improve_latest.json'), {
        runAt: '2026-02-16T00:00:00+09:00',
        ok: false,
        skipped: false,
        error: 'stage1_failed:node scripts/test_bridge_nl_inference.js',
        consecutiveFailures: 2,
        preflight: {
            worktreePath: path.join(tmpRoot, '.worktrees', 'nightly-recursive-improve'),
            valid: true,
            gitdirPath: '',
            registered: true,
            repaired: true,
            repairAction: 'remove_broken_worktree_path',
        },
        retry: {
            attempted: false,
            reason: '',
            succeeded: false,
        },
        delivery: {
            prAttempted: false,
            prUrl: '',
            briefingEligible: true,
        },
        pr: {
            attempted: false,
            ok: false,
            action: 'none',
            number: null,
            url: '',
            error: '',
        },
    });

    const supervisor = require('./ops_daily_supervisor');
    const morning = supervisor.runBriefing('morning', {
        now: '2026-02-16T08:30:00+09:00',
        configPath,
        sendEnabled: false,
    });
    assert.strictEqual(morning.ok, true);
    assert.ok(morning.result && morning.result.reportPath, 'morning report path should exist');
    const morningText = fs.readFileSync(morning.result.reportPath, 'utf8');
    assert.ok(morningText.includes('Morning Briefing'));
    assert.ok(morningText.includes('bot-research:fp_test_1'));
    assert.ok(morningText.includes('Midnight recursive improve'));

    const evening = supervisor.runBriefing('evening', {
        now: '2026-02-16T18:30:00+09:00',
        configPath,
        sendEnabled: false,
    });
    assert.strictEqual(evening.ok, true);
    const eveningText = fs.readFileSync(evening.result.reportPath, 'utf8');
    assert.ok(eveningText.includes('Evening Briefing'));
    assert.ok(eveningText.includes('Open Issues Carrying Over'));

    const personalDbPath = path.join(tmpRoot, 'data', 'personal', 'personal.sqlite');
    personalStorage.ensureStorage({ dbPath: personalDbPath });

    const personalMorningEmpty = personalBriefing.buildMorningText({
        now: '2026-02-16T08:30:00+09:00',
        dbPath: personalDbPath,
    });
    assert.ok(!personalMorningEmpty.includes('단어 활동:'), 'word section should be hidden when there is no activity');

    const personalEveningEmpty = personalBriefing.buildEveningText({
        now: '2026-02-16T18:30:00+09:00',
        dbPath: personalDbPath,
    });
    assert.ok(!personalEveningEmpty.includes('단어 활동:'), 'evening word section should be hidden when there is no activity');

    const sameDaySaved = [
        ['activate', '2026-02-16T01:00:00+09:00'],
        ['align', '2026-02-16T01:30:00+09:00'],
        ['brief', '2026-02-16T02:00:00+09:00'],
        ['compose', '2026-02-16T02:30:00+09:00'],
        ['dedupe', '2026-02-16T03:00:00+09:00'],
        ['escalate', '2026-02-16T03:30:00+09:00'],
    ];
    sameDaySaved.forEach(([word, createdAt], index) => {
        personalStorage.recordVocabLog({
            eventId: `same-day-${index}`,
            word,
            deck: 'TOEIC_AI',
            noteId: index + 1,
            saveStatus: 'saved',
            createdAt,
        }, { dbPath: personalDbPath });
    });
    personalStorage.recordVocabLog({
        eventId: 'same-day-failed',
        word: 'fragle',
        deck: 'TOEIC_AI',
        saveStatus: 'failed',
        errorText: 'parse_failed',
        createdAt: '2026-02-16T04:00:00+09:00',
    }, { dbPath: personalDbPath });
    personalStorage.recordVocabLog({
        eventId: 'prev-day-saved',
        word: 'yesterday',
        deck: 'TOEIC_AI',
        noteId: 99,
        saveStatus: 'saved',
        createdAt: '2026-02-15T22:00:00+09:00',
    }, { dbPath: personalDbPath });

    const personalMorning = personalBriefing.buildMorningText({
        now: '2026-02-16T08:30:00+09:00',
        dbPath: personalDbPath,
    });
    assert.ok(personalMorning.includes('단어 활동:'), 'morning word section should render on active day');
    assert.ok(personalMorning.includes('저장: 6건'));
    assert.ok(personalMorning.includes('실패: 1건'));
    assert.ok(personalMorning.includes('escalate'));
    assert.ok(!personalMorning.includes('activate'), 'oldest saved word should be excluded from recent list');
    assert.ok(!personalMorning.includes('yesterday'), 'previous-day word should be excluded');

    const personalEvening = personalBriefing.buildEveningText({
        now: '2026-02-16T18:30:00+09:00',
        dbPath: personalDbPath,
    });
    assert.ok(personalEvening.includes('단어 활동:'), 'evening word section should render on active day');
    assert.ok(personalEvening.includes('저장: 6건'));
    assert.ok(personalEvening.includes('실패: 1건'));
    assert.ok(personalEvening.includes('escalate'));
    assert.ok(!personalEvening.includes('activate'));
    assert.ok(!personalEvening.includes('yesterday'));

    const personalRun = await personalBriefing.run('morning', {
        enqueue: false,
        now: '2026-02-16T08:30:00+09:00',
        dbPath: personalDbPath,
    });
    assert.strictEqual(personalRun.ok, true);
    assert.strictEqual(personalRun.enqueue, false);
    assert.ok(personalRun.text.includes('단어 활동:'));

    const scanNow = '2026-02-17T08:30:00+09:00';
    const scan1 = supervisor.runScan({
        now: scanNow,
        configPath,
        sendEnabled: true,
    });
    const scan2 = supervisor.runScan({
        now: scanNow,
        configPath,
        sendEnabled: true,
    });
    assert.strictEqual(scan1.ok, true);
    assert.strictEqual(scan2.ok, true);
    assert.ok(scan1.findings.some((row) => row.issue_id === 'system:midnight_recursive_improve'));
    const issuesAfterScan = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'ops', 'state', 'issues.json'), 'utf8'));
    assert.strictEqual(issuesAfterScan.issues['system:midnight_recursive_improve'].severity, 'P2');
    assert.strictEqual(issuesAfterScan.issues['system:midnight_recursive_improve'].consecutive_failures, 2);
    const inboxRows = readJsonl(path.join(tmpRoot, 'data', 'bridge', 'inbox.jsonl'));
    const morningRows = inboxRows.filter((row) => (
        String(row.notification_kind || '') === 'briefing'
        && String(row.dedupe_key || '').includes('ops-briefing:morning:2026-02-17')
    ));
    assert.strictEqual(morningRows.length, 1, 'morning briefing should be deduped to one message per window');
    assert.strictEqual(morningRows[0].source_kind, 'scheduled_background');
    assert.strictEqual(morningRows[0].user_visible, true);
    assert.ok(typeof morningRows[0].classification_reason === 'string' && morningRows[0].classification_reason.length > 0);

    const briefingAfterScan = supervisor.runBriefing('morning', {
        now: scanNow,
        configPath,
        sendEnabled: true,
    });
    assert.strictEqual(briefingAfterScan.ok, true);
    assert.strictEqual(briefingAfterScan.result, null, 'explicit briefing should skip when same-day briefing already exists');

    const inboxAfterExplicit = readJsonl(path.join(tmpRoot, 'data', 'bridge', 'inbox.jsonl'));
    const morningRowsAfterExplicit = inboxAfterExplicit.filter((row) => (
        String(row.notification_kind || '') === 'briefing'
        && String(row.dedupe_key || '').includes('ops-briefing:morning:2026-02-17')
    ));
    assert.strictEqual(morningRowsAfterExplicit.length, 1, 'explicit briefing should not create a duplicate after scan');

    const briefingDate = '2026-02-18T18:30:00+09:00';
    const explicitEvening1 = supervisor.runBriefing('evening', {
        now: briefingDate,
        configPath,
        sendEnabled: true,
    });
    const explicitEvening2 = supervisor.runBriefing('evening', {
        now: briefingDate,
        configPath,
        sendEnabled: true,
    });
    assert.strictEqual(explicitEvening1.ok, true);
    assert.ok(explicitEvening1.result && explicitEvening1.result.delivered === true);
    assert.strictEqual(explicitEvening2.ok, true);
    assert.strictEqual(explicitEvening2.result, null, 'repeated explicit briefing should skip on the same date');

    const inboxAfterRepeated = readJsonl(path.join(tmpRoot, 'data', 'bridge', 'inbox.jsonl'));
    const eveningRows = inboxAfterRepeated.filter((row) => (
        String(row.notification_kind || '') === 'briefing'
        && String(row.dedupe_key || '').includes('ops-briefing:evening:2026-02-18')
    ));
    assert.strictEqual(eveningRows.length, 1, 'same-day explicit briefing should only enqueue once');
}

run()
    .then(() => {
        console.log('test_ops_briefing_generation: ok');
    })
    .catch((error) => {
        console.error(String(error && error.stack ? error.stack : error));
        process.exit(1);
    });
