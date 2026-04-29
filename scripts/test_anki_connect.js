const assert = require('assert');
const { AnkiConnect } = require('./anki_connect');

function makeClient(handler) {
    const client = new AnkiConnect('127.0.0.1', 8765);
    client.invoke = handler;
    client.syncWithDelay = async () => null;
    return client;
}

async function testSkipDuplicateMode() {
    const calls = [];
    const client = makeClient(async (action, params) => {
        calls.push({ action, params });
        if (action === 'modelFieldNames') return ['Question', 'Answer'];
        if (action === 'findNotes') return [11];
        if (action === 'notesInfo') {
            return [{
                noteId: 11,
                fields: {
                    Question: { value: 'timely' },
                },
            }];
        }
        if (action === 'addNote') throw new Error('addNote should not be called in skip mode');
        return null;
    });

    const out = await client.addCard('TOEIC_AI', 'timely', 'back', ['toeic'], {
        sync: false,
        dedupeMode: 'skip',
    });
    assert.strictEqual(out.duplicate, true);
    assert.strictEqual(out.updated, false);
    assert.strictEqual(out.action, 'skip');
    assert.strictEqual(out.noteId, 11);
}

async function testUpdateDuplicateMode() {
    const calls = [];
    const client = makeClient(async (action, params) => {
        calls.push({ action, params });
        if (action === 'modelFieldNames') return ['Question', 'Answer'];
        if (action === 'findNotes') return [22];
        if (action === 'notesInfo') {
            return [{
                noteId: 22,
                fields: {
                    Question: { value: 'deviate' },
                },
            }];
        }
        if (action === 'updateNoteFields') return null;
        if (action === 'addTags') return null;
        if (action === 'addNote') throw new Error('addNote should not be called in update mode');
        return null;
    });

    const out = await client.addCard('TOEIC_AI', 'deviate', 'updated-back', ['toeic', 'v2'], {
        sync: false,
        dedupeMode: 'update',
    });
    assert.strictEqual(out.duplicate, true);
    assert.strictEqual(out.updated, true);
    assert.strictEqual(out.action, 'update');
    assert.strictEqual(out.noteId, 22);
    assert.ok(calls.some((c) => c.action === 'updateNoteFields'));
}

async function testAllowModeAddCard() {
    const calls = [];
    const client = makeClient(async (action, params) => {
        calls.push({ action, params });
        if (action === 'modelFieldNames') return ['Question', 'Answer'];
        if (action === 'addNote') return 77;
        if (action === 'notesInfo') return [{ noteId: 77, cards: [7701] }];
        if (action === 'cardsInfo') return [{ cardId: 7701, deckName: 'TOEIC_AI' }];
        return null;
    });

    const out = await client.addCard('TOEIC_AI', 'scheme', 'back', ['toeic'], {
        sync: false,
        dedupeMode: 'allow',
    });
    assert.strictEqual(out.action, 'add');
    assert.strictEqual(out.noteId, 77);
    assert.strictEqual(out.duplicate, false);
    assert.ok(calls.some((c) => c.action === 'addNote'));
}

async function testFieldAutoMappingFrontBack() {
    const client = makeClient(async (action, params) => {
        if (action === 'modelFieldNames') return ['Front', 'Back', 'Extra'];
        if (action === 'addNote') return 99;
        if (action === 'notesInfo') return [{ noteId: 99, cards: [9901] }];
        if (action === 'cardsInfo') return [{ cardId: 9901, deckName: 'TOEIC_AI' }];
        return null;
    });

    const out = await client.addCard('TOEIC_AI', 'ledger', 'back', [], {
        sync: false,
        modelName: 'FrontBackModel',
    });
    assert.strictEqual(out.noteId, 99);
}

async function testDeckAliasNormalizesBeforeAdd() {
    const calls = [];
    const client = makeClient(async (action, params) => {
        calls.push({ action, params });
        if (action === 'modelFieldNames') return ['Question', 'Answer'];
        if (action === 'addNote') return 88;
        if (action === 'notesInfo') return [{ noteId: 88, cards: [8801] }];
        if (action === 'cardsInfo') return [{ cardId: 8801, deckName: 'TOEIC_AI' }];
        return null;
    });

    const out = await client.addCard('toeic_ai', 'alias', 'back', [], {
        sync: false,
        dedupeMode: 'allow',
    });
    const addCall = calls.find((c) => c.action === 'addNote');
    assert.ok(addCall, 'addNote should be called');
    assert.strictEqual(addCall.params.note.deckName, 'TOEIC_AI');
    assert.strictEqual(out.requestedDeck, 'TOEIC_AI');
    assert.strictEqual(out.actualDeck, 'TOEIC_AI');
    assert.strictEqual(out.deckVerificationSkipped, false);
}

async function testDeckInfoDelayRetriesAndSucceeds() {
    let notesInfoCalls = 0;
    let cardsInfoCalls = 0;
    const client = makeClient(async (action, params) => {
        if (action === 'modelFieldNames') return ['Question', 'Answer'];
        if (action === 'addNote') return 101;
        if (action === 'notesInfo') {
            notesInfoCalls += 1;
            if (notesInfoCalls === 1) return [];
            return [{ noteId: 101, cards: [10101] }];
        }
        if (action === 'cardsInfo') {
            cardsInfoCalls += 1;
            if (cardsInfoCalls === 1) return [];
            return [{ cardId: 10101, deckName: 'TOEIC_AI' }];
        }
        return null;
    });

    const out = await client.addCard('TOEIC_AI', 'delay', 'back', [], {
        sync: false,
        dedupeMode: 'allow',
        deckVerificationDelayMs: 0,
    });
    assert.strictEqual(out.action, 'add');
    assert.strictEqual(out.deckVerificationSkipped, false);
    assert.strictEqual(out.actualDeck, 'TOEIC_AI');
    assert.ok(notesInfoCalls > 1, 'notesInfo should retry');
    assert.ok(cardsInfoCalls > 1, 'cardsInfo should retry');
}

async function testDeckVerificationSkippedStillSucceeds() {
    const client = makeClient(async (action, params) => {
        if (action === 'modelFieldNames') return ['Question', 'Answer'];
        if (action === 'addNote') return 102;
        if (action === 'notesInfo') return [];
        return null;
    });

    const out = await client.addCard('TOEIC_AI', 'skip-verify', 'back', [], {
        sync: false,
        dedupeMode: 'allow',
        deckVerificationRetries: 1,
        deckVerificationDelayMs: 0,
    });
    assert.strictEqual(out.action, 'add');
    assert.strictEqual(out.noteId, 102);
    assert.strictEqual(out.deckVerificationSkipped, true);
    assert.strictEqual(out.deckVerificationSkipReason, 'notes_info_unavailable');
}

async function testDeckMismatchSelfHeals() {
    const calls = [];
    const client = makeClient(async (action, params) => {
        calls.push({ action, params });
        if (action === 'modelFieldNames') return ['Question', 'Answer'];
        if (action === 'addNote') return 103;
        if (action === 'notesInfo') return [{ noteId: 103, cards: [10301] }];
        if (action === 'cardsInfo') return [{ cardId: 10301, deckName: 'Default' }];
        if (action === 'changeDeck') return null;
        return null;
    });

    const out = await client.addCard('TOEIC_AI', 'recover', 'back', [], {
        sync: false,
        dedupeMode: 'allow',
        deckVerificationDelayMs: 0,
    });
    const changeDeckCall = calls.find((c) => c.action === 'changeDeck');
    assert.ok(changeDeckCall, 'changeDeck should be called');
    assert.deepStrictEqual(changeDeckCall.params.cards, [10301]);
    assert.strictEqual(changeDeckCall.params.deck, 'TOEIC_AI');
    assert.strictEqual(out.deckMismatchRecovered, true);
    assert.strictEqual(out.actualDeck, 'TOEIC_AI');
}

async function testAddCardsUsesBatchAddNotesAndSingleVerification() {
    const calls = [];
    let syncCalls = 0;
    const client = makeClient(async (action, params) => {
        calls.push({ action, params });
        if (action === 'modelFieldNames') return ['Question', 'Answer'];
        if (action === 'addNotes') return [201, 202];
        if (action === 'notesInfo') {
            assert.deepStrictEqual(params.notes, [201, 202]);
            return [
                { noteId: 201, cards: [20101] },
                { noteId: 202, cards: [20201] },
            ];
        }
        if (action === 'cardsInfo') {
            assert.deepStrictEqual(params.cards, [20101, 20201]);
            return [
                { cardId: 20101, deckName: 'TOEIC_AI' },
                { cardId: 20201, deckName: 'TOEIC_AI' },
            ];
        }
        return null;
    });
    client.syncWithDelay = async () => {
        syncCalls += 1;
        return null;
    };

    const out = await client.addCards('toeic_ai', [
        { front: 'batch-1', back: 'back-1' },
        { front: 'batch-2', back: 'back-2', tags: ['extra'] },
    ], ['toeic'], {
        deckVerificationDelayMs: 0,
    });
    const addNotesCall = calls.find((c) => c.action === 'addNotes');
    assert.ok(addNotesCall, 'addNotes should be called');
    assert.strictEqual(addNotesCall.params.notes.length, 2);
    assert.strictEqual(addNotesCall.params.notes[0].deckName, 'TOEIC_AI');
    assert.strictEqual(out.action, 'batch_add');
    assert.strictEqual(out.added, 2);
    assert.strictEqual(out.deckVerificationMode, 'batch');
    assert.strictEqual(out.results.every((row) => row.deckVerificationSkipped === false), true);
    assert.strictEqual(syncCalls, 1);
}

async function testAddCardsBatchDeckMismatchSelfHeals() {
    const calls = [];
    const client = makeClient(async (action, params) => {
        calls.push({ action, params });
        if (action === 'modelFieldNames') return ['Question', 'Answer'];
        if (action === 'addNotes') return [301];
        if (action === 'notesInfo') return [{ noteId: 301, cards: [30101] }];
        if (action === 'cardsInfo') return [{ cardId: 30101, deckName: 'Default' }];
        if (action === 'changeDeck') return null;
        return null;
    });

    const out = await client.addCards('TOEIC_AI', [
        { front: 'batch-recover', back: 'back' },
    ], [], {
        sync: false,
        deckVerificationDelayMs: 0,
    });
    const changeDeckCall = calls.find((c) => c.action === 'changeDeck');
    assert.ok(changeDeckCall, 'changeDeck should be called for batch mismatch');
    assert.deepStrictEqual(changeDeckCall.params.cards, [30101]);
    assert.strictEqual(changeDeckCall.params.deck, 'TOEIC_AI');
    assert.strictEqual(out.results[0].deckMismatchRecovered, true);
    assert.strictEqual(out.results[0].actualDeck, 'TOEIC_AI');
}

async function run() {
    await testSkipDuplicateMode();
    await testUpdateDuplicateMode();
    await testAllowModeAddCard();
    await testFieldAutoMappingFrontBack();
    await testDeckAliasNormalizesBeforeAdd();
    await testDeckInfoDelayRetriesAndSucceeds();
    await testDeckVerificationSkippedStillSucceeds();
    await testDeckMismatchSelfHeals();
    await testAddCardsUsesBatchAddNotesAndSingleVerification();
    await testAddCardsBatchDeckMismatchSelfHeals();
    console.log('test_anki_connect: ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
