const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storage = require('./personal_storage');

function makeTempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-storage-'));
    return {
        dir,
        dbPath: path.join(dir, 'personal.sqlite'),
    };
}

function main() {
    const { dir, dbPath } = makeTempDb();
    try {
        storage.ensureStorage({ dbPath });

        const event = storage.createEvent({
            route: 'finance',
            source: 'telegram',
            rawText: '점심 1200엔',
            normalizedText: '점심 1200엔',
            dedupeMaterial: 'finance:test',
        }, { dbPath });
        assert.ok(event.eventId);
        assert.strictEqual(event.duplicate, false);

        const eventDup = storage.createEvent({
            route: 'finance',
            source: 'telegram',
            rawText: '점심 1200엔',
            normalizedText: '점심 1200엔',
            dedupeMaterial: 'finance:test',
        }, { dbPath });
        assert.strictEqual(eventDup.duplicate, true);
        assert.strictEqual(eventDup.eventId, event.eventId);

        const ledger = storage.insertLedgerEntry({
            eventId: event.eventId,
            entryDate: '2026-02-17',
            entryType: 'expense',
            item: '점심',
            amount: -1200,
            currency: 'JPY',
            category: '식비',
            paymentMethod: '카드',
        }, { dbPath });
        assert.ok(ledger && ledger.id > 0);
        const ledgerSummary = storage.summarizeLedger({ dbPath, month: '2026-02' });
        assert.ok(Number(ledgerSummary.totals.count || 0) >= 1);

        const task = storage.createTask({
            eventId: event.eventId,
            title: '테스트 투두',
            status: 'open',
        }, { dbPath });
        assert.ok(task && task.id > 0);
        const taskDone = storage.updateTaskStatus(task.id, 'done', { dbPath });
        assert.strictEqual(taskDone.status, 'done');

        const routine = storage.upsertRoutineTemplate({
            eventId: event.eventId,
            name: '물 2L',
            active: 1,
        }, { dbPath });
        assert.ok(routine && routine.id > 0);
        const checkin = storage.logRoutineCheckin({
            eventId: event.eventId,
            templateId: routine.id,
            status: 'done',
        }, { dbPath });
        assert.strictEqual(checkin.template_name, '물 2L');

        const workout = storage.recordWorkout({
            eventId: event.eventId,
            workoutType: '러닝',
            durationMin: 30,
            distanceKm: 5,
        }, { dbPath });
        assert.strictEqual(workout.workout_type, '러닝');

        const vocab = storage.recordVocabLog({
            eventId: event.eventId,
            word: 'activate',
            deck: 'TOEIC_AI',
            noteId: 123,
            saveStatus: 'saved',
        }, { dbPath });
        assert.strictEqual(vocab.word, 'activate');
        const vocabSummary = storage.summarizeVocab({ dbPath });
        assert.ok(Number(vocabSummary.saved || 0) >= 1);

        const media = storage.recordMediaPlace({
            eventId: event.eventId,
            kind: 'media',
            title: 'Dune 2',
            status: 'watched',
            rating: 4.5,
            tags: ['sf'],
        }, { dbPath });
        assert.strictEqual(media.kind, 'media');
        const place = storage.recordMediaPlace({
            eventId: event.eventId,
            kind: 'place',
            title: 'Ichiran',
            status: 'wishlist',
        }, { dbPath });
        assert.strictEqual(place.kind, 'place');

        const mediaList = storage.listMediaPlace('media', { dbPath, limit: 5 });
        assert.ok(mediaList.length >= 1);
        const placeSummary = storage.summarizeMediaPlace('place', { dbPath });
        assert.ok(Number(placeSummary.totals.count || 0) >= 1);

        const oldCreatedAt = new Date(Date.now() - (100 * 24 * 60 * 60 * 1000)).toISOString();
        storage.createEvent({
            route: 'memo',
            source: 'telegram',
            rawText: 'old memo',
            normalizedText: 'old memo',
            dedupeMaterial: 'memo:old',
            createdAt: oldCreatedAt,
        }, { dbPath });

        const dry = storage.pruneRawEvents({ days: 90, apply: false }, { dbPath });
        assert.ok(Number(dry.candidates || 0) >= 1);
        const applied = storage.pruneRawEvents({ days: 90, apply: true }, { dbPath });
        assert.ok(Number(applied.purged || 0) >= 1);

        console.log('test_personal_storage: ok');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

main();
