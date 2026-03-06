const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const storage = require('./personal_storage');

function ensureStubGoogleCreds() {
    const secureDir = path.join(__dirname, '../data/secure');
    const credsPath = path.join(secureDir, 'google_creds.json');
    if (fs.existsSync(credsPath)) return null;
    fs.mkdirSync(secureDir, { recursive: true });
    fs.writeFileSync(credsPath, JSON.stringify({
        client_email: 'test@example.com',
        private_key: '-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----\\n',
    }, null, 2));
    return credsPath;
}

function makeTempDbPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bridge-word-read-'));
    return path.join(dir, 'personal.sqlite');
}

const TOKYO_DAY_FORMAT = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

function tokyoIso(dayOffset = 0, hour = 12, minute = 0) {
    const now = new Date();
    const today = TOKYO_DAY_FORMAT.format(now);
    const base = new Date(`${today}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`);
    base.setUTCDate(base.getUTCDate() - dayOffset);
    return base.toISOString();
}

function seedWordLogs(dbPath) {
    storage.recordVocabLog({
        eventId: 'evt-alpha',
        word: 'alpha',
        deck: 'TOEIC_AI',
        saveStatus: 'saved',
        createdAt: tokyoIso(0, 12, 10),
        meta: { duplicate: false, correctedWord: '' },
    }, { dbPath });
    storage.recordVocabLog({
        eventId: 'evt-beta-dup',
        word: 'beta',
        deck: 'TOEIC_AI',
        saveStatus: 'saved',
        createdAt: tokyoIso(0, 12, 12),
        meta: { duplicate: true, correctedWord: '' },
    }, { dbPath });
    storage.recordVocabLog({
        eventId: 'evt-gamma-fail',
        word: 'gamma',
        deck: 'TOEIC_AI',
        saveStatus: 'failed',
        errorText: 'parse_failed',
        createdAt: tokyoIso(0, 12, 14),
        meta: { token: 'gamma' },
    }, { dbPath });
    storage.recordVocabLog({
        eventId: 'evt-fragile-save',
        word: 'fragile',
        deck: 'TOEIC_AI',
        saveStatus: 'saved',
        createdAt: tokyoIso(0, 12, 16),
        meta: { duplicate: false, correctedWord: 'fragile' },
    }, { dbPath });
    storage.recordVocabLog({
        eventId: 'evt-fragile-fail',
        word: 'fragile',
        deck: 'TOEIC_AI',
        saveStatus: 'failed',
        errorText: 'low_quality:missing_example_ko',
        createdAt: tokyoIso(3, 10, 0),
        meta: { token: 'fragile' },
    }, { dbPath });
    storage.recordVocabLog({
        eventId: 'evt-fragile-dup',
        word: 'fragile',
        deck: 'TOEIC_AI',
        saveStatus: 'saved',
        createdAt: tokyoIso(2, 10, 0),
        meta: { duplicate: true, correctedWord: '' },
    }, { dbPath });
    storage.recordVocabLog({
        eventId: 'evt-zeta-save',
        word: 'zeta',
        deck: 'TOEIC_AI',
        saveStatus: 'saved',
        createdAt: tokyoIso(12, 10, 0),
        meta: { duplicate: false, correctedWord: '' },
    }, { dbPath });
}

function runAuto(message, dbPath) {
    const createdStubCredsPath = ensureStubGoogleCreds();
    try {
        const res = spawnSync('node', ['scripts/bridge.js', 'auto', message], {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            env: {
                ...process.env,
                PERSONAL_DB_PATH: dbPath,
            },
        });
        assert.strictEqual(res.status, 0, res.stderr || res.stdout || 'bridge auto failed');
        return JSON.parse(String(res.stdout || '{}').trim());
    } finally {
        if (createdStubCredsPath) {
            try {
                fs.unlinkSync(createdStubCredsPath);
            } catch {}
        }
    }
}

function testTodayAddedQuery() {
    const dbPath = makeTempDbPath();
    seedWordLogs(dbPath);
    const out = runAuto('단어: 오늘 추가', dbPath);
    assert.strictEqual(out.route, 'word');
    assert.strictEqual(out.queryMode, 'today_added');
    assert.strictEqual(out.savedCount, 3);
    assert.strictEqual(out.failedCount, 1);
    assert.strictEqual(out.duplicateCount, 1);
    assert.strictEqual(out.autoCorrectedCount, 1);
    assert.ok(Array.isArray(out.recentWords));
    assert.ok(out.recentWords.includes('alpha'));
    assert.ok(out.recentWords.includes('fragile'));
    assert.ok(!out.recentWords.includes('beta'));
    assert.ok(String(out.telegramReply || '').includes('오늘 단어 활동'));
}

function testFailureListQuery() {
    const dbPath = makeTempDbPath();
    seedWordLogs(dbPath);
    const out = runAuto('단어: 실패 목록', dbPath);
    assert.strictEqual(out.route, 'word');
    assert.strictEqual(out.queryMode, 'failure_list');
    assert.ok(Array.isArray(out.failures));
    assert.strictEqual(out.failures.length, 2);
    assert.strictEqual(out.failures[0].word, 'gamma');
    assert.ok(String(out.telegramReply || '').includes('최근 단어 실패 목록'));
    assert.ok(String(out.telegramReply || '').includes('parse_failed'));
}

function testReviewRecommendationQuery() {
    const dbPath = makeTempDbPath();
    seedWordLogs(dbPath);
    const out = runAuto('단어: 복습 추천', dbPath);
    assert.strictEqual(out.route, 'word');
    assert.strictEqual(out.queryMode, 'review_recommendation');
    assert.ok(Array.isArray(out.recommendations));
    assert.ok(out.recommendations.length > 0);
    assert.strictEqual(out.recommendations[0].word, 'fragile');
    assert.ok(out.recommendations[0].score > 0);
    assert.ok(String(out.telegramReply || '').includes('단어 복습 추천'));
}

function run() {
    testTodayAddedQuery();
    testFailureListQuery();
    testReviewRecommendationQuery();
    console.log('test_bridge_word_read_commands: ok');
}

run();
