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
        return null;
    });

    const out = await client.addCard('TOEIC_AI', 'ledger', 'back', [], {
        sync: false,
        modelName: 'FrontBackModel',
    });
    assert.strictEqual(out.noteId, 99);
}

async function run() {
    await testSkipDuplicateMode();
    await testUpdateDuplicateMode();
    await testAllowModeAddCard();
    await testFieldAutoMappingFrontBack();
    console.log('test_anki_connect: ok');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
