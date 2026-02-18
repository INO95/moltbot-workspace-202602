#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const anki = require('./anki_connect');

const DEFAULT_DECKS = ['TOEIC_AI', '단어::영단어::2603TOEIC', '단어::영단어::Eng_Voca'];

function parseArgs(argv) {
    const out = {
        backup: '',
        decks: [...DEFAULT_DECKS],
        apply: false,
        deleteNew: false,
        sync: true,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const token = String(argv[i] || '').trim();
        if (token === '--backup' && argv[i + 1]) {
            out.backup = String(argv[i + 1] || '').trim();
            i += 1;
        } else if (token === '--decks' && argv[i + 1]) {
            out.decks = String(argv[i + 1] || '')
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean);
            i += 1;
        } else if (token === '--deck' && argv[i + 1]) {
            const one = String(argv[i + 1] || '').trim();
            if (one) out.decks = [one];
            i += 1;
        } else if (token === '--apply') {
            out.apply = true;
        } else if (token === '--dry-run') {
            out.apply = false;
        } else if (token === '--delete-new') {
            out.deleteNew = true;
        } else if (token === '--no-sync') {
            out.sync = false;
        }
    }
    return out;
}

function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function timestamp14() {
    return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function decodeHexText(hex) {
    if (!hex) return '';
    try {
        return Buffer.from(String(hex), 'hex').toString('utf8');
    } catch (_) {
        return '';
    }
}

function runCmd(cmd, args, options = {}) {
    const out = spawnSync(cmd, args, {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 256,
        ...options,
    });
    if (out.status !== 0) {
        const stderr = String(out.stderr || '').trim();
        const stdout = String(out.stdout || '').trim();
        throw new Error(`${cmd} failed (${out.status}): ${stderr || stdout || 'unknown error'}`);
    }
    return out;
}

function runSqlite(dbPath, sql) {
    const out = runCmd('sqlite3', ['-separator', '\t', dbPath, sql]);
    const raw = String(out.stdout || '');
    if (!raw.trim()) return [];
    return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t'));
}

function normalizeDeckName(raw) {
    return String(raw || '')
        .replace(/\x1f/g, '::')
        .replace(/\^_/g, '::');
}

function stripFieldValue(value) {
    return String(value == null ? '' : value);
}

async function getLiveNotesByDeck(deckName) {
    const query = `deck:"${String(deckName || '').replace(/"/g, '\\"')}"`;
    const noteIds = await anki.invoke('findNotes', { query });
    const notes = [];
    for (const ids of chunk(noteIds, 200)) {
        if (!ids.length) continue;
        const batch = await anki.invoke('notesInfo', { notes: ids });
        for (const note of batch) notes.push(note);
    }
    return notes;
}

function simplifyLiveNote(note, deckName) {
    const fields = {};
    for (const [k, v] of Object.entries(note.fields || {})) {
        fields[k] = stripFieldValue(v && v.value);
    }
    return {
        noteId: Number(note.noteId),
        deck: deckName,
        model: String(note.modelName || ''),
        tags: Array.isArray(note.tags) ? note.tags : [],
        fields,
    };
}

function buildBackupState(backupColpkgPath, targetDecks) {
    const absBackup = path.resolve(backupColpkgPath);
    if (!fs.existsSync(absBackup)) {
        throw new Error(`backup file not found: ${absBackup}`);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-colpkg-'));
    const zstdBin = spawnSync('bash', ['-lc', 'command -v zstd'], { encoding: 'utf8' });
    const zstdPath = String(zstdBin.stdout || '').trim() || 'zstd';

    const c21b = path.join(tmpDir, 'collection.anki21b');
    const c21 = path.join(tmpDir, 'collection.anki21');

    runCmd('bash', ['-lc', `unzip -p ${JSON.stringify(absBackup)} collection.anki21b > ${JSON.stringify(c21b)}`]);
    runCmd(zstdPath, ['-d', '-q', '-o', c21, c21b]);

    const deckRows = runSqlite(c21, 'select id, name from decks;');
    const deckIdByName = new Map();
    for (const row of deckRows) {
        const did = Number(row[0]);
        const name = normalizeDeckName(row[1]);
        if (!Number.isFinite(did) || !name) continue;
        deckIdByName.set(name, did);
    }

    const fieldRows = runSqlite(c21, 'select ntid, ord, name from fields order by ntid, ord;');
    const fieldNamesByMid = new Map();
    for (const row of fieldRows) {
        const mid = Number(row[0]);
        const ord = Number(row[1]);
        const name = String(row[2] || '').trim();
        if (!Number.isFinite(mid) || !Number.isFinite(ord) || !name) continue;
        if (!fieldNamesByMid.has(mid)) fieldNamesByMid.set(mid, []);
        fieldNamesByMid.get(mid).push({ ord, name });
    }
    for (const [mid, rows] of fieldNamesByMid.entries()) {
        rows.sort((a, b) => a.ord - b.ord);
        fieldNamesByMid.set(mid, rows);
    }

    const notesByDeck = new Map();
    for (const deckName of targetDecks) {
        const did = deckIdByName.get(deckName);
        const noteMap = new Map();
        if (Number.isFinite(did)) {
            const rows = runSqlite(
                c21,
                `select distinct n.id, n.mid, hex(n.flds) from notes n join cards c on c.nid=n.id where c.did=${did};`,
            );
            for (const row of rows) {
                const noteId = Number(row[0]);
                const mid = Number(row[1]);
                const fieldsHex = String(row[2] || '').trim();
                const fieldValues = decodeHexText(fieldsHex).split('\x1f');
                const fieldDefs = fieldNamesByMid.get(mid) || [];
                const fields = {};
                for (let i = 0; i < fieldDefs.length; i += 1) {
                    fields[fieldDefs[i].name] = stripFieldValue(fieldValues[i]);
                }
                noteMap.set(noteId, { noteId, mid, fields });
            }
        }
        notesByDeck.set(deckName, noteMap);
    }

    return {
        tmpDir,
        backupFile: absBackup,
        notesByDeck,
        deckNamesFound: [...deckIdByName.keys()],
    };
}

function cleanupBackupState(state) {
    if (!state || !state.tmpDir) return;
    try {
        fs.rmSync(state.tmpDir, { recursive: true, force: true });
    } catch (_) {
        // ignore temp cleanup errors
    }
}

function compareFieldDiff(liveFields, backupFields) {
    const changed = {};
    for (const [name, liveValue] of Object.entries(liveFields || {})) {
        if (!Object.prototype.hasOwnProperty.call(backupFields || {}, name)) continue;
        const backupValue = stripFieldValue(backupFields[name]);
        if (stripFieldValue(liveValue) !== backupValue) {
            changed[name] = backupValue;
        }
    }
    return changed;
}

function writeJson(filePath, payload) {
    ensureDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.backup) {
        throw new Error('Usage: node scripts/anki_restore_from_colpkg.js --backup "<path.colpkg>" [--apply] [--delete-new] [--decks "A,B,C"]');
    }

    const startedAt = new Date().toISOString();
    const ts = timestamp14();
    const reportPath = path.join(__dirname, '..', 'logs', `anki_restore_report_${ts}.json`);
    const snapshotPath = path.join(__dirname, '..', 'logs', `anki_pre_restore_snapshot_${ts}.json`);

    const backupState = buildBackupState(args.backup, args.decks);

    const report = {
        startedAt,
        finishedAt: null,
        apply: Boolean(args.apply),
        deleteNew: Boolean(args.deleteNew),
        sync: Boolean(args.sync),
        backup: path.resolve(args.backup),
        decks: args.decks,
        snapshotPath: null,
        totals: {
            decks: args.decks.length,
            liveNotes: 0,
            backupNotes: 0,
            sharedNotes: 0,
            changedNotes: 0,
            updateOps: 0,
            deleteCandidates: 0,
            deleted: 0,
            updateFailed: 0,
            deleteFailed: 0,
        },
        deckResults: [],
        postVerify: null,
        warnings: [],
    };

    const snapshotRows = [];
    const updateOps = [];
    const deleteCandidates = [];

    for (const deckName of args.decks) {
        const liveNotes = await getLiveNotesByDeck(deckName);
        const backupMap = backupState.notesByDeck.get(deckName) || new Map();
        const liveSet = new Set();
        const changed = [];
        const unchanged = [];
        const onlyInLive = [];

        for (const note of liveNotes) {
            const simple = simplifyLiveNote(note, deckName);
            snapshotRows.push(simple);
            const noteId = simple.noteId;
            liveSet.add(noteId);
            const backupRow = backupMap.get(noteId);
            if (!backupRow) {
                onlyInLive.push(noteId);
                if (args.deleteNew) deleteCandidates.push(noteId);
                continue;
            }
            const diffFields = compareFieldDiff(simple.fields, backupRow.fields);
            const diffKeys = Object.keys(diffFields);
            if (!diffKeys.length) {
                unchanged.push(noteId);
                continue;
            }
            changed.push(noteId);
            updateOps.push({ noteId, fields: diffFields, deck: deckName });
        }

        const onlyInBackup = [];
        for (const noteId of backupMap.keys()) {
            if (!liveSet.has(noteId)) onlyInBackup.push(noteId);
        }

        report.totals.liveNotes += liveNotes.length;
        report.totals.backupNotes += backupMap.size;
        report.totals.sharedNotes += liveNotes.length - onlyInLive.length;
        report.totals.changedNotes += changed.length;
        report.totals.updateOps += changed.length;

        report.deckResults.push({
            deck: deckName,
            liveNotes: liveNotes.length,
            backupNotes: backupMap.size,
            changedNotes: changed.length,
            unchangedNotes: unchanged.length,
            onlyInLive: onlyInLive.length,
            onlyInBackup: onlyInBackup.length,
            sampleChanged: changed.slice(0, 12),
            sampleOnlyInLive: onlyInLive.slice(0, 12),
            sampleOnlyInBackup: onlyInBackup.slice(0, 12),
        });
    }

    report.totals.deleteCandidates = deleteCandidates.length;

    if (args.apply) {
        writeJson(snapshotPath, {
            createdAt: new Date().toISOString(),
            decks: args.decks,
            rows: snapshotRows,
        });
        report.snapshotPath = snapshotPath;

        for (const op of updateOps) {
            try {
                await anki.invoke('updateNoteFields', {
                    note: {
                        id: Number(op.noteId),
                        fields: op.fields,
                    },
                });
            } catch (error) {
                report.totals.updateFailed += 1;
                report.warnings.push(`update_failed noteId=${op.noteId} reason=${String(error.message || error)}`);
            }
        }

        for (const ids of chunk(deleteCandidates, 200)) {
            try {
                await anki.invoke('deleteNotes', { notes: ids.map((v) => Number(v)) });
                report.totals.deleted += ids.length;
            } catch (error) {
                report.totals.deleteFailed += ids.length;
                report.warnings.push(`delete_failed notes=${ids.join(',')} reason=${String(error.message || error)}`);
            }
        }

        if (args.sync) {
            try {
                await anki.syncWithDelay();
            } catch (error) {
                report.warnings.push(`sync_warning: ${String(error.message || error)}`);
            }
        }

        const postVerify = [];
        let totalDiff = 0;
        for (const deckName of args.decks) {
            const liveNotes = await getLiveNotesByDeck(deckName);
            const liveById = new Map(liveNotes.map((n) => [Number(n.noteId), simplifyLiveNote(n, deckName)]));
            const backupMap = backupState.notesByDeck.get(deckName) || new Map();
            let diffCount = 0;
            const diffSamples = [];

            for (const [noteId, backupRow] of backupMap.entries()) {
                const liveRow = liveById.get(noteId);
                if (!liveRow) continue;
                const diffFields = compareFieldDiff(liveRow.fields, backupRow.fields);
                const diffKeys = Object.keys(diffFields);
                if (!diffKeys.length) continue;
                diffCount += 1;
                if (diffSamples.length < 8) diffSamples.push({ noteId, diffKeys });
            }

            totalDiff += diffCount;
            postVerify.push({ deck: deckName, diffNotes: diffCount, sampleDiffs: diffSamples });
        }

        const deletedStillExists = [];
        if (deleteCandidates.length > 0) {
            const q = deleteCandidates.map((v) => `nid:${Number(v)}`).join(' OR ');
            const remains = await anki.invoke('findNotes', { query: q });
            for (const id of remains) deletedStillExists.push(Number(id));
        }

        report.postVerify = {
            totalDiffNotes: totalDiff,
            byDeck: postVerify,
            deletedCandidates: deleteCandidates.length,
            deletedStillExists,
        };
    }

    report.finishedAt = new Date().toISOString();
    writeJson(reportPath, report);
    cleanupBackupState(backupState);

    console.log(JSON.stringify({
        ok: true,
        apply: report.apply,
        reportPath,
        snapshotPath: report.snapshotPath,
        totals: report.totals,
        postVerify: report.postVerify,
    }, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(String(error.message || error));
        process.exit(1);
    });
}
