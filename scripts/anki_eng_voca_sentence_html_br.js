const anki = require('./anki_connect');

function parseArgs(argv) {
    const out = {
        apply: false,
        deck: '단어::영단어::2603TOEIC',
        batchSize: 100,
        addTag: true,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = String(argv[i] || '').trim();
        if (a === '--apply') out.apply = true;
        else if (a === '--dry-run') out.apply = false;
        else if (a === '--deck' && argv[i + 1]) {
            out.deck = String(argv[i + 1] || out.deck).trim();
            i += 1;
        } else if (a === '--batch-size' && argv[i + 1]) {
            out.batchSize = Math.max(20, Number(argv[i + 1] || out.batchSize));
            i += 1;
        } else if (a === '--no-tag') {
            out.addTag = false;
        }
    }
    return out;
}

function chunk(array, size) {
    const out = [];
    for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
    return out;
}

function toHtmlBr(raw) {
    const normalized = String(raw || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (!normalized) return '';
    return normalized
        .replace(/\n\n/g, '[[DOUBLE_BREAK]]')
        .replace(/\n/g, '<br>')
        .replace(/\[\[DOUBLE_BREAK\]\]/g, '<br><br>');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const query = `deck:"${String(args.deck).replace(/"/g, '\\"')}" note:eng_voca`;
    const noteIds = await anki.invoke('findNotes', { query });
    const batches = chunk(noteIds, args.batchSize);
    const report = {
        apply: args.apply,
        deck: args.deck,
        scanned: noteIds.length,
        updated: 0,
        unchanged: 0,
        failed: 0,
        failures: [],
        sample: [],
    };

    for (const ids of batches) {
        const notes = ids.length ? await anki.invoke('notesInfo', { notes: ids }) : [];
        for (const note of notes) {
            const raw = String(note.fields?.Sentence_Mean?.value || '');
            const next = toHtmlBr(raw);
            if (raw === next) {
                report.unchanged += 1;
                continue;
            }
            if (report.sample.length < 12) {
                report.sample.push({
                    noteId: Number(note.noteId),
                    word: String(note.fields?.Clean_Word?.value || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(),
                    before: raw.slice(0, 200),
                    after: next.slice(0, 200),
                });
            }

            if (!args.apply) continue;
            try {
                await anki.invoke('updateNoteFields', {
                    note: {
                        id: Number(note.noteId),
                        fields: {
                            Sentence_Mean: next,
                        },
                    },
                });
                if (args.addTag) {
                    await anki.invoke('addTags', {
                        notes: [Number(note.noteId)],
                        tags: 'layout:html-br',
                    });
                }
                report.updated += 1;
            } catch (error) {
                report.failed += 1;
                report.failures.push({
                    noteId: Number(note.noteId),
                    reason: String(error.message || error),
                });
            }
        }
    }

    if (args.apply) {
        try {
            await anki.syncWithDelay();
        } catch (error) {
            report.syncWarning = String(error.message || error);
        }
    }

    console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error.message || error));
        process.exit(1);
    });
}
