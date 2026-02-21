const fs = require('fs');
const path = require('path');
const anki = require('./anki_connect');

const DEFAULT_DECKS = ['단어::영단어::Eng_Voca'];

function parseArgs(argv) {
    const out = {
        apply: false,
        decks: [...DEFAULT_DECKS],
        batchSize: 100,
        writeBackup: true,
    };
    const customDecks = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = String(argv[i] || '').trim();
        if (a === '--apply') out.apply = true;
        else if (a === '--dry-run') out.apply = false;
        else if (a === '--deck' && argv[i + 1]) {
            customDecks.push(String(argv[i + 1] || '').trim());
            i += 1;
        } else if (a === '--decks' && argv[i + 1]) {
            customDecks.push(
                ...String(argv[i + 1] || '')
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
            );
            i += 1;
        } else if (a === '--batch-size' && argv[i + 1]) {
            out.batchSize = Math.max(20, Number(argv[i + 1] || out.batchSize));
            i += 1;
        } else if (a === '--no-backup') {
            out.writeBackup = false;
        }
    }
    if (customDecks.length > 0) out.decks = customDecks;
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

function normalizeText(value) {
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

function chunk(array, size) {
    const out = [];
    for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
    return out;
}

function extractBodyAndTip(text) {
    const raw = normalizeText(text);
    const m = raw.match(/^(.*?)(?:\n)?\s*💡?\s*TOEIC TIP[:：]\s*([\s\S]*)$/i);
    if (!m) return { body: raw, tip: '' };
    return {
        body: String(m[1] || '').trim(),
        tip: String(m[2] || '').trim(),
    };
}

function isSentenceLike(text) {
    const t = normalizeText(text);
    if (!t) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length >= 6) return true;
    if (/[.?!]$/.test(t)) return true;
    if (/,|;|:/.test(t)) return true;
    return false;
}

function alreadyStructured(text) {
    const t = normalizeText(text);
    if (!t) return false;
    return (/^(예문|표현)\s*[:：]/.test(t) && /(해석|의미)\s*[:：]/.test(t));
}

function buildStructuredAnswer(question, answer) {
    const q = normalizeText(question);
    const { body, tip } = extractBodyAndTip(answer);
    if (!q && !body) return '';
    if (alreadyStructured(answer)) return normalizeText(answer);

    const lines = [];
    if (isSentenceLike(q)) {
        lines.push(`예문: ${q}`);
        lines.push('');
        lines.push(`해석: ${body}`);
    } else {
        lines.push(`표현: ${q}`);
        lines.push('');
        lines.push(`의미: ${body}`);
    }
    if (tip) {
        lines.push('');
        lines.push('💡 TOEIC TIP:');
        lines.push(tip);
    }
    return lines.join('\n').trim();
}

async function migrateDeck(deck, options, backupRows) {
    const ids = await anki.invoke('findNotes', { query: `deck:"${String(deck || '').replace(/"/g, '\\"')}" note:Basic` });
    const batches = chunk(ids, options.batchSize);
    const report = {
        deck,
        scannedBasic: ids.length,
        updated: 0,
        unchanged: 0,
        failed: 0,
        failures: [],
        sample: [],
    };

    for (const batch of batches) {
        const notes = batch.length ? await anki.invoke('notesInfo', { notes: batch }) : [];
        for (const n of notes) {
            const rawQ = String(n.fields?.Question?.value || '');
            const rawA = String(n.fields?.Answer?.value || '');
            const nextA = buildStructuredAnswer(rawQ, rawA);
            const curA = normalizeText(rawA);
            if (!nextA || nextA === curA) {
                report.unchanged += 1;
                continue;
            }

            if (report.sample.length < 8) {
                report.sample.push({
                    noteId: Number(n.noteId),
                    question: normalizeText(rawQ),
                    before: curA,
                    after: nextA,
                });
            }

            if (!options.apply) continue;
            try {
                await anki.invoke('updateNoteFields', {
                    note: {
                        id: Number(n.noteId),
                        fields: {
                            Answer: nextA,
                        },
                    },
                });
                await anki.invoke('addTags', {
                    notes: [Number(n.noteId)],
                    tags: 'layout:basic-a',
                });
                backupRows.push({
                    deck,
                    noteId: Number(n.noteId),
                    question: rawQ,
                    answerBefore: rawA,
                    answerAfter: nextA,
                });
                report.updated += 1;
            } catch (error) {
                report.failed += 1;
                report.failures.push({
                    noteId: Number(n.noteId),
                    reason: String(error.message || error),
                });
            }
        }
    }
    return report;
}

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeBackup(backupRows) {
    const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const backupPath = path.join(__dirname, '..', 'logs', `anki_basic_layout_backup_${ts}.json`);
    ensureDir(backupPath);
    fs.writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows: backupRows }, null, 2), 'utf8');
    return backupPath;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const backupRows = [];
    const results = [];
    for (const deck of args.decks) {
        const row = await migrateDeck(deck, args, backupRows);
        results.push(row);
    }

    let backupPath = null;
    if (args.apply && args.writeBackup && backupRows.length > 0) {
        backupPath = writeBackup(backupRows);
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
        decks: args.decks,
        backupPath,
        totals: {
            scannedBasic: results.reduce((acc, cur) => acc + Number(cur.scannedBasic || 0), 0),
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
