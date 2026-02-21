const anki = require('./anki_connect');

const DEFAULT_DECKS = [
    '단어::영단어::2603TOEIC',
    '단어::영단어::Eng_Voca',
];

function parseArgs(argv) {
    const out = {
        apply: false,
        mode: 'a',
        decks: [],
        batchSize: 100,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = String(argv[i] || '').trim();
        if (a === '--apply') out.apply = true;
        else if (a === '--dry-run') out.apply = false;
        else if (a === '--mode' && argv[i + 1]) {
            out.mode = String(argv[i + 1] || 'a').trim().toLowerCase();
            i += 1;
        } else if (a === '--deck' && argv[i + 1]) {
            out.decks.push(String(argv[i + 1] || '').trim());
            i += 1;
        } else if (a === '--decks' && argv[i + 1]) {
            out.decks.push(
                ...String(argv[i + 1] || '')
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
            );
            i += 1;
        } else if (a === '--batch-size' && argv[i + 1]) {
            out.batchSize = Math.max(20, Number(argv[i + 1] || 100));
            i += 1;
        }
    }
    if (!['a', 'b'].includes(out.mode)) out.mode = 'a';
    if (!out.decks.length) out.decks = [...DEFAULT_DECKS];
    return out;
}

function decodeHtmlEntities(text) {
    return String(text || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#39;/gi, '\'')
        .replace(/&quot;/gi, '"');
}

function normalizeFieldText(value) {
    return decodeHtmlEntities(String(value || ''))
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<hr\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function hasEngVocaFields(note) {
    const fields = note && note.fields ? note.fields : {};
    return Object.prototype.hasOwnProperty.call(fields, 'Clean_Word')
        && Object.prototype.hasOwnProperty.call(fields, 'Example_Sentence')
        && Object.prototype.hasOwnProperty.call(fields, 'Cleam_Word_Mean')
        && Object.prototype.hasOwnProperty.call(fields, 'Sentence_Mean');
}

function parseSentenceMean(rawText) {
    const text = normalizeFieldText(rawText);
    let body = text;
    let tip = '';
    const tipMatch = text.match(/^(.*?)(?:\n)?\s*💡?\s*TOEIC TIP[:：]\s*([\s\S]*)$/i);
    if (tipMatch) {
        body = String(tipMatch[1] || '').trim();
        tip = String(tipMatch[2] || '').trim();
    }
    const exMatch = body.match(/(?:^|\n)\s*예문[:：]\s*([^\n]+)/i);
    const trMatch = body.match(/(?:^|\n)\s*해석[:：]\s*([\s\S]*)$/i);
    const example = exMatch ? String(exMatch[1] || '').trim() : '';
    let translation = '';
    if (trMatch) {
        translation = String(trMatch[1] || '').trim();
    } else {
        translation = body
            .replace(/(?:^|\n)\s*예문[:：]\s*[^\n]+/ig, '')
            .replace(/(?:^|\n)\s*해석[:：]\s*/ig, '')
            .trim();
    }
    return {
        text,
        example,
        translation,
        tip,
    };
}

function buildSentenceMeanModeA(example, translation, tip) {
    const lines = [];
    lines.push(`예문: ${String(example || '').trim()}`);
    lines.push('');
    lines.push(`해석: ${String(translation || '').trim()}`);
    if (tip) {
        lines.push('');
        lines.push('💡 TOEIC TIP:');
        lines.push(String(tip).trim());
    }
    return lines.join('\n').trim();
}

function buildSentenceMeanModeB(translation, tip) {
    const lines = [];
    lines.push(`해석: ${String(translation || '').trim()}`);
    if (tip) {
        lines.push('');
        lines.push('💡 TOEIC TIP:');
        lines.push(String(tip).trim());
    }
    return lines.join('\n').trim();
}

function chunk(array, size) {
    const out = [];
    for (let i = 0; i < array.length; i += size) {
        out.push(array.slice(i, i + size));
    }
    return out;
}

async function migrateDeck(deck, options) {
    const query = `deck:"${String(deck || '').replace(/"/g, '\\"')}"`;
    const noteIds = await anki.invoke('findNotes', { query });
    const batches = chunk(noteIds, options.batchSize);
    const report = {
        deck,
        mode: options.mode,
        scanned: noteIds.length,
        engVocaNotes: 0,
        skippedNonEngVoca: 0,
        updated: 0,
        unchanged: 0,
        failed: 0,
        failures: [],
        sample: [],
    };

    for (const ids of batches) {
        const notes = ids.length ? await anki.invoke('notesInfo', { notes: ids }) : [];
        for (const note of notes) {
            if (!hasEngVocaFields(note)) {
                report.skippedNonEngVoca += 1;
                continue;
            }
            report.engVocaNotes += 1;
            const exampleField = normalizeFieldText(note.fields?.Example_Sentence?.value || '');
            const parsed = parseSentenceMean(note.fields?.Sentence_Mean?.value || '');
            const example = exampleField || parsed.example;
            const translation = parsed.translation || parsed.text;
            const tip = parsed.tip;

            const nextExample = options.mode === 'a' ? '' : example;
            const nextSentence = options.mode === 'a'
                ? buildSentenceMeanModeA(example, translation, tip)
                : buildSentenceMeanModeB(translation, tip);

            const curExample = normalizeFieldText(note.fields?.Example_Sentence?.value || '');
            const curSentence = normalizeFieldText(note.fields?.Sentence_Mean?.value || '');
            if (curExample === nextExample && curSentence === nextSentence) {
                report.unchanged += 1;
                continue;
            }

            if (report.sample.length < 8) {
                report.sample.push({
                    noteId: Number(note.noteId),
                    word: normalizeFieldText(note.fields?.Clean_Word?.value || ''),
                    before: {
                        Example_Sentence: curExample,
                        Sentence_Mean: curSentence,
                    },
                    after: {
                        Example_Sentence: nextExample,
                        Sentence_Mean: nextSentence,
                    },
                });
            }

            if (!options.apply) continue;
            try {
                await anki.invoke('updateNoteFields', {
                    note: {
                        id: Number(note.noteId),
                        fields: {
                            Example_Sentence: nextExample,
                            Sentence_Mean: nextSentence,
                        },
                    },
                });
                await anki.invoke('addTags', {
                    notes: [Number(note.noteId)],
                    tags: `layout:engvoca-${options.mode}`,
                });
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

    return report;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const results = [];
    for (const deck of args.decks) {
        const row = await migrateDeck(deck, args);
        results.push(row);
    }

    if (args.apply) {
        try {
            await anki.syncWithDelay();
        } catch (error) {
            results.push({ syncWarning: String(error.message || error) });
        }
    }

    const summary = {
        apply: args.apply,
        mode: args.mode,
        decks: args.decks,
        totals: {
            scanned: results.reduce((acc, cur) => acc + Number(cur.scanned || 0), 0),
            engVocaNotes: results.reduce((acc, cur) => acc + Number(cur.engVocaNotes || 0), 0),
            updated: results.reduce((acc, cur) => acc + Number(cur.updated || 0), 0),
            unchanged: results.reduce((acc, cur) => acc + Number(cur.unchanged || 0), 0),
            failed: results.reduce((acc, cur) => acc + Number(cur.failed || 0), 0),
        },
        results,
    };
    console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error.message || error));
        process.exit(1);
    });
}
