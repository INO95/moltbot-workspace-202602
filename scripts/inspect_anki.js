const AnkiConnect = require('./anki_connect');
const anki = new AnkiConnect.constructor('host.docker.internal', 8765);

async function inspectAnki() {
    try {
        console.log("🔍 Finding target deck...");
        const targetDeckName = '단어::영단어::2603TOEIC';

        // 노트 ID 하나만 가져오기 (최신 순)
        const notes = await anki.invoke('findNotes', { query: `deck:"${targetDeckName}"` });

        if (notes && notes.length > 0) {
            console.log(`Found ${notes.length} notes. Analyzing the first one...`);
            // 노트 정보 조회
            const noteInfo = await anki.invoke('notesInfo', { notes: [notes[0]] });
            const modelName = noteInfo[0].modelName;
            console.log(`✅ Model Name: ${modelName}`);

            // 모델 필드 조회
            const fields = await anki.invoke('modelFieldNames', { modelName });
            console.log("✅ Fields:", fields);
        } else {
            console.log("⚠️ No notes found in target deck.");
        }

        console.log("\n🔍 Creating 'TOEIC_AI' deck...");
        await anki.invoke('createDeck', { deck: 'TOEIC_AI' });
        console.log("✅ 'TOEIC_AI' deck created/verified.");

    } catch (e) {
        console.error("❌ Error:", e.message);
    }
}

inspectAnki();
