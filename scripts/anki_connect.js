const http = require('http');
const ANKI_CONNECT_DEBUG = String(process.env.ANKI_CONNECT_DEBUG || '').trim().toLowerCase();
const ANKI_CONNECT_DEBUG_ENABLED = ['1', 'true', 'yes', 'on'].includes(ANKI_CONNECT_DEBUG);

function debugLog(...args) {
    if (!ANKI_CONNECT_DEBUG_ENABLED) return;
    console.error(...args);
}

class AnkiConnect {
    constructor(host = process.env.ANKI_CONNECT_HOST || 'host.docker.internal', port = Number(process.env.ANKI_CONNECT_PORT || 8765)) {
        this.host = host;
        this.port = port;
        this.fallbackHosts = this.buildFallbackHosts(host);
        this.modelFieldCache = new Map();
        this.deckAliasMap = new Map([
            ['toeic_ai', 'TOEIC_AI'],
            ['toeic-ai', 'TOEIC_AI'],
        ]);
    }

    buildFallbackHosts(primaryHost) {
        const envHosts = String(process.env.ANKI_CONNECT_HOSTS || '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
        const defaults = ['host.docker.internal', '127.0.0.1', 'localhost'];
        return [...new Set([primaryHost, ...envHosts, ...defaults])];
    }

    invokeWithHost(hostname, action, params = {}) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({ action, version: 6, params });

            const options = {
                hostname,
                port: this.port,
                path: '/',
                method: 'POST',
                timeout: 2500,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'Connection': 'close'
                }
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (Object.keys(result).length != 2) {
                            reject(new Error('response has an unexpected number of fields'));
                            return;
                        }
                        if (!result.hasOwnProperty('error')) {
                            reject(new Error('response is missing required error field'));
                            return;
                        }
                        if (!result.hasOwnProperty('result')) {
                            reject(new Error('response is missing required result field'));
                            return;
                        }
                        if (result.error) {
                            reject(new Error(result.error));
                            return;
                        }
                        resolve(result.result);
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy(new Error('timeout'));
            });
            req.on('error', (e) => {
                reject(new Error(`AnkiConnect Error@${hostname}:${this.port}: ${e.message}`));
            });

            req.write(postData);
            req.end();
        });
    }

    invoke(action, params = {}) {
        return (async () => {
            let lastErr = null;
            let firstErr = null;
            for (const host of this.fallbackHosts) {
                try {
                    const result = await this.invokeWithHost(host, action, params);
                    if (this.host !== host) {
                        this.host = host;
                    }
                    return result;
                } catch (e) {
                    if (!firstErr) firstErr = e;
                    lastErr = e;
                }
            }
            const rootErr = firstErr || lastErr;
            throw new Error(`${rootErr ? rootErr.message : 'AnkiConnect failed'} (Is Anki running with AnkiConnect enabled?)`);
        })();
    }

    async syncWithDelay(delayMs = 1000) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return this.sync();
    }

    escapeQueryValue(value) {
        return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    async getModelFieldNamesCached(modelName) {
        const key = String(modelName || '').trim();
        if (!key) throw new Error('modelName is required');
        if (this.modelFieldCache.has(key)) return this.modelFieldCache.get(key);
        const fields = await this.invoke('modelFieldNames', { modelName: key });
        const normalized = Array.isArray(fields) ? fields.map((v) => String(v || '').trim()).filter(Boolean) : [];
        this.modelFieldCache.set(key, normalized);
        return normalized;
    }

    async buildNoteFields(front, back, options = {}) {
        const modelName = String(options.modelName || 'Basic').trim();
        const fields = await this.getModelFieldNamesCached(modelName);
        if (fields.length < 2) {
            throw new Error(`model fields are insufficient: model=${modelName}, actual=${JSON.stringify(fields)}`);
        }
        const preferredPairs = [
            ['Front', 'Back'],
            ['Question', 'Answer'],
            [fields[0], fields[1]],
        ];
        for (const [frontKey, backKey] of preferredPairs) {
            if (!fields.includes(frontKey) || !fields.includes(backKey)) continue;
            return {
                modelName,
                fields: {
                    [frontKey]: front,
                    [backKey]: back,
                },
                frontField: frontKey,
                backField: backKey,
            };
        }
        throw new Error(
            `failed to map note fields: model=${modelName}, expected one of Front/Back or Question/Answer, actual=${JSON.stringify(fields)}`,
        );
    }

    normalizeDeckName(deckName) {
        const raw = String(deckName || '').trim();
        if (!raw) return raw;
        return this.deckAliasMap.get(raw.toLowerCase()) || raw;
    }

    async invokeRetry(action, params = {}, options = {}) {
        const retries = Number.isFinite(Number(options.retries))
            ? Math.max(0, Number(options.retries))
            : 3;
        const delayMs = Number.isFinite(Number(options.delayMs))
            ? Math.max(0, Number(options.delayMs))
            : 250;
        const accept = typeof options.accept === 'function'
            ? options.accept
            : () => true;
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                const result = await this.invoke(action, params);
                if (accept(result)) {
                    return {
                        ok: true,
                        result,
                        attempts: attempt + 1,
                    };
                }
                lastError = new Error(`${action} response is not ready`);
            } catch (error) {
                lastError = error;
            }
            if (attempt < retries && delayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
        return {
            ok: false,
            result: null,
            error: lastError,
            attempts: retries + 1,
        };
    }

    async verifyAddedDeck(noteId, deckName, options = {}) {
        const requestedDeck = this.normalizeDeckName(deckName);
        const skipped = (reason) => ({
            requestedDeck,
            actualDeck: null,
            deckMismatchRecovered: false,
            deckVerificationSkipped: true,
            deckVerificationSkipReason: reason,
        });
        const numericNoteId = Number(noteId);
        if (!Number.isFinite(numericNoteId) || numericNoteId <= 0) {
            return skipped('invalid_note_id');
        }

        const retryOptions = {
            retries: Number.isFinite(Number(options.deckVerificationRetries))
                ? Number(options.deckVerificationRetries)
                : 3,
            delayMs: Number.isFinite(Number(options.deckVerificationDelayMs))
                ? Number(options.deckVerificationDelayMs)
                : 250,
        };
        const noteRead = await this.invokeRetry('notesInfo', { notes: [numericNoteId] }, {
            ...retryOptions,
            accept: (result) => Array.isArray(result) && result.length > 0 && result[0],
        });
        if (!noteRead.ok) {
            debugLog('Anki deck verification skipped (notesInfo not ready):', noteRead.error && noteRead.error.message);
            return skipped('notes_info_unavailable');
        }

        const noteInfo = Array.isArray(noteRead.result) ? noteRead.result[0] : null;
        const cardIds = noteInfo && Array.isArray(noteInfo.cards)
            ? noteInfo.cards.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
            : [];
        let actualDeck = String((noteInfo && (noteInfo.deckName || noteInfo.deck)) || '').trim();

        if (cardIds.length > 0) {
            const cardsRead = await this.invokeRetry('cardsInfo', { cards: cardIds }, {
                ...retryOptions,
                accept: (result) => Array.isArray(result) && result.length > 0,
            });
            if (cardsRead.ok) {
                const cardInfo = cardsRead.result.find((card) => card && (card.deckName || card.deck)) || null;
                actualDeck = String((cardInfo && (cardInfo.deckName || cardInfo.deck)) || actualDeck || '').trim();
            }
        }

        if (!actualDeck) {
            return skipped('deck_info_unavailable');
        }

        if (actualDeck === requestedDeck) {
            return {
                requestedDeck,
                actualDeck,
                deckMismatchRecovered: false,
                deckVerificationSkipped: false,
            };
        }

        let deckMismatchRecovered = false;
        if (cardIds.length > 0) {
            try {
                await this.invoke('changeDeck', {
                    cards: cardIds,
                    deck: requestedDeck,
                });
                deckMismatchRecovered = true;
                actualDeck = requestedDeck;
            } catch (error) {
                debugLog('Anki deck mismatch recovery failed (non-critical):', error.message);
            }
        }

        return {
            requestedDeck,
            actualDeck,
            deckMismatchRecovered,
            deckVerificationSkipped: false,
        };
    }

    async verifyAddedDecks(noteDeckPairs = [], options = {}) {
        const pairs = Array.isArray(noteDeckPairs)
            ? noteDeckPairs
                .map((pair) => ({
                    noteId: Number(pair && pair.noteId),
                    requestedDeck: this.normalizeDeckName(pair && pair.deckName),
                }))
                .filter((pair) => Number.isFinite(pair.noteId) && pair.noteId > 0 && pair.requestedDeck)
            : [];
        const skipped = (pair, reason) => ({
            noteId: pair.noteId,
            requestedDeck: pair.requestedDeck,
            actualDeck: null,
            deckMismatchRecovered: false,
            deckVerificationSkipped: true,
            deckVerificationSkipReason: reason,
        });
        if (pairs.length === 0) return [];

        const retryOptions = {
            retries: Number.isFinite(Number(options.deckVerificationRetries))
                ? Number(options.deckVerificationRetries)
                : 3,
            delayMs: Number.isFinite(Number(options.deckVerificationDelayMs))
                ? Number(options.deckVerificationDelayMs)
                : 250,
        };
        const noteIds = pairs.map((pair) => pair.noteId);
        const noteRead = await this.invokeRetry('notesInfo', { notes: noteIds }, {
            ...retryOptions,
            accept: (result) => Array.isArray(result) && result.length > 0,
        });
        if (!noteRead.ok) {
            return pairs.map((pair) => skipped(pair, 'notes_info_unavailable'));
        }

        const notesById = new Map();
        const allCardIds = [];
        for (const note of Array.isArray(noteRead.result) ? noteRead.result : []) {
            const noteId = Number(note && note.noteId);
            if (!Number.isFinite(noteId)) continue;
            const cards = Array.isArray(note.cards)
                ? note.cards.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
                : [];
            for (const cardId of cards) allCardIds.push(cardId);
            notesById.set(noteId, {
                note,
                cards,
                deckName: String((note && (note.deckName || note.deck)) || '').trim(),
            });
        }

        const cardDeckById = new Map();
        if (allCardIds.length > 0) {
            const cardsRead = await this.invokeRetry('cardsInfo', { cards: allCardIds }, {
                ...retryOptions,
                accept: (result) => Array.isArray(result) && result.length > 0,
            });
            if (cardsRead.ok) {
                for (const card of cardsRead.result) {
                    const cardId = Number(card && (card.cardId || card.card_id));
                    const deck = String((card && (card.deckName || card.deck)) || '').trim();
                    if (Number.isFinite(cardId) && deck) cardDeckById.set(cardId, deck);
                }
            }
        }

        const results = [];
        const recoveryByDeck = new Map();
        const recoveryResultsByDeck = new Map();
        for (const pair of pairs) {
            const noteInfo = notesById.get(pair.noteId);
            if (!noteInfo) {
                results.push(skipped(pair, 'note_info_unavailable'));
                continue;
            }
            const deckFromCards = noteInfo.cards
                .map((cardId) => cardDeckById.get(cardId))
                .find(Boolean);
            const actualDeck = deckFromCards || noteInfo.deckName;
            if (!actualDeck) {
                results.push(skipped(pair, 'deck_info_unavailable'));
                continue;
            }
            const result = {
                noteId: pair.noteId,
                requestedDeck: pair.requestedDeck,
                actualDeck,
                deckMismatchRecovered: false,
                deckVerificationSkipped: false,
            };
            if (actualDeck !== pair.requestedDeck && noteInfo.cards.length > 0) {
                if (!recoveryByDeck.has(pair.requestedDeck)) recoveryByDeck.set(pair.requestedDeck, []);
                if (!recoveryResultsByDeck.has(pair.requestedDeck)) recoveryResultsByDeck.set(pair.requestedDeck, []);
                recoveryByDeck.get(pair.requestedDeck).push(...noteInfo.cards);
                recoveryResultsByDeck.get(pair.requestedDeck).push(result);
            }
            results.push(result);
        }

        for (const [deck, cards] of recoveryByDeck.entries()) {
            try {
                await this.invoke('changeDeck', { cards, deck });
                for (const result of recoveryResultsByDeck.get(deck) || []) {
                    result.actualDeck = deck;
                    result.deckMismatchRecovered = true;
                }
            } catch (error) {
                debugLog('Anki batch deck mismatch recovery failed (non-critical):', error.message);
                for (const result of recoveryResultsByDeck.get(deck) || []) {
                    result.deckRecoveryFailed = true;
                }
            }
        }

        return results;
    }

    async findDuplicateByFront(deckName, front, options = {}) {
        const normalizedDeckName = this.normalizeDeckName(deckName);
        const modelName = String(options.modelName || 'Basic').trim();
        const mapped = await this.buildNoteFields(front, '', { modelName });
        const query = `deck:"${this.escapeQueryValue(normalizedDeckName)}" ${mapped.frontField}:"${this.escapeQueryValue(front)}"`;
        const notes = await this.invoke('findNotes', { query });
        if (!Array.isArray(notes) || notes.length === 0) {
            return null;
        }
        const inspected = await this.invoke('notesInfo', { notes: notes.slice(0, 10) });
        const normalizedFront = String(front || '').trim().toLowerCase();
        for (const note of inspected) {
            const value = String((note.fields && note.fields[mapped.frontField] && note.fields[mapped.frontField].value) || '')
                .trim()
                .toLowerCase();
            if (value === normalizedFront) {
                return {
                    noteId: Number(note.noteId),
                    field: mapped.frontField,
                };
            }
        }
        return null;
    }

    async addCard(deckName, front, back, tags = [], options = {}) {
        const shouldSync = options.sync !== false;
        const normalizedDeckName = this.normalizeDeckName(deckName);
        const modelName = String(options.modelName || 'Basic');
        const dedupeMode = String(options.dedupeMode || 'allow').toLowerCase();
        let effectiveDedupeMode = dedupeMode;
        const cleanTags = Array.isArray(tags)
            ? tags.map((v) => String(v || '').trim()).filter(Boolean)
            : [];
        const mapped = await this.buildNoteFields(front, back, { modelName });
        let duplicate = null;
        if (dedupeMode !== 'allow') {
            try {
                duplicate = await this.findDuplicateByFront(normalizedDeckName, front, { modelName });
            } catch (error) {
                debugLog('Anki duplicate scan failed (fallback safe-add):', error.message);
                // Keep duplicate protection on even when scan fails.
                // This may return duplicate errors on add, which is safer than silently creating duplicates.
                effectiveDedupeMode = 'safe_add';
            }
        }

        if (duplicate && effectiveDedupeMode === 'skip') {
            return {
                noteId: duplicate.noteId,
                duplicate: true,
                updated: false,
                action: 'skip',
            };
        }

        if (duplicate && effectiveDedupeMode === 'update') {
            await this.invoke('updateNoteFields', {
                note: {
                    id: duplicate.noteId,
                    fields: mapped.fields,
                },
            });
            if (cleanTags.length > 0) {
                await this.invoke('addTags', {
                    notes: [duplicate.noteId],
                    tags: cleanTags.join(' '),
                });
            }
            if (shouldSync) {
                try {
                    await this.syncWithDelay();
                } catch (e) {
                    debugLog('Anki Sync failed (non-critical):', e.message);
                }
            }
            return {
                noteId: duplicate.noteId,
                duplicate: true,
                updated: true,
                action: 'update',
            };
        }

        debugLog(`OpenClaw -> Anki: Adding card to [${normalizedDeckName}]`);
        let result;
        try {
            result = await this.invoke('addNote', {
                note: {
                    deckName: normalizedDeckName,
                    modelName: mapped.modelName,
                    fields: mapped.fields,
                    options: {
                        allowDuplicate: effectiveDedupeMode === 'allow'
                    },
                    tags: cleanTags
                }
            });
        } catch (error) {
            const message = String(error && error.message ? error.message : error).toLowerCase();
            const duplicateLike = /duplicate|cannot create note because it is a duplicate/.test(message);
            if (duplicateLike && effectiveDedupeMode !== 'allow') {
                let resolved = null;
                try {
                    resolved = await this.findDuplicateByFront(normalizedDeckName, front, { modelName });
                } catch (_) {
                    resolved = null;
                }
                if (resolved && effectiveDedupeMode === 'update') {
                    await this.invoke('updateNoteFields', {
                        note: {
                            id: resolved.noteId,
                            fields: mapped.fields,
                        },
                    });
                    if (cleanTags.length > 0) {
                        await this.invoke('addTags', {
                            notes: [resolved.noteId],
                            tags: cleanTags.join(' '),
                        });
                    }
                    return {
                        noteId: resolved.noteId,
                        duplicate: true,
                        updated: true,
                        action: 'update',
                    };
                }
                if (resolved) {
                    return {
                        noteId: resolved.noteId,
                        duplicate: true,
                        updated: false,
                        action: 'skip',
                    };
                }
            }
            throw error;
        }

        if (shouldSync) {
            try {
                debugLog('OpenClaw -> Anki: Waiting 1s before sync...');
                debugLog('OpenClaw -> Anki: Triggering sync...');
                await this.syncWithDelay();
            } catch (e) {
                debugLog('Anki Sync failed (non-critical):', e.message);
            }
        }

        const deckVerification = await this.verifyAddedDeck(result, normalizedDeckName, options);

        return {
            noteId: result,
            duplicate: false,
            updated: false,
            action: 'add',
            ...deckVerification,
        };
    }

    async addCards(deckName, cards = [], tags = [], options = {}) {
        const entries = Array.isArray(cards) ? cards : [];
        const shouldSync = options.sync !== false;
        const modelName = String(options.modelName || 'Basic');
        const dedupeMode = String(options.dedupeMode || 'allow').toLowerCase();
        const baseTags = Array.isArray(tags)
            ? tags.map((v) => String(v || '').trim()).filter(Boolean)
            : [];
        if (entries.length === 0) {
            return {
                action: 'batch_add',
                count: 0,
                added: 0,
                results: [],
            };
        }

        if (dedupeMode !== 'allow') {
            const results = [];
            for (const entry of entries) {
                const card = entry && typeof entry === 'object' ? entry : {};
                const result = await this.addCard(
                    card.deckName || deckName,
                    card.front,
                    card.back,
                    [...baseTags, ...(Array.isArray(card.tags) ? card.tags : [])],
                    {
                        ...options,
                        sync: false,
                    },
                );
                results.push(result);
            }
            if (shouldSync) {
                try {
                    await this.syncWithDelay();
                } catch (error) {
                    debugLog('Anki batch sync failed (non-critical):', error.message);
                }
            }
            return {
                action: 'batch_add',
                count: entries.length,
                added: results.filter((row) => row && row.action === 'add').length,
                results,
                fallbackSequential: true,
            };
        }

        const noteDeckPairs = [];
        const notes = [];
        for (const entry of entries) {
            const card = entry && typeof entry === 'object' ? entry : {};
            const normalizedDeckName = this.normalizeDeckName(card.deckName || deckName);
            const mapped = await this.buildNoteFields(card.front, card.back, {
                modelName: String(card.modelName || modelName),
            });
            const cardTags = Array.isArray(card.tags)
                ? card.tags.map((value) => String(value || '').trim()).filter(Boolean)
                : [];
            const cleanTags = [...new Set([...baseTags, ...cardTags])];
            notes.push({
                deckName: normalizedDeckName,
                modelName: mapped.modelName,
                fields: mapped.fields,
                options: {
                    allowDuplicate: true,
                },
                tags: cleanTags,
            });
            noteDeckPairs.push({ deckName: normalizedDeckName });
        }

        const noteIds = await this.invoke('addNotes', { notes });
        if (!Array.isArray(noteIds)) {
            throw new Error('addNotes response must be an array');
        }
        const resultRows = noteIds.map((noteId, index) => {
            const numericNoteId = Number(noteId);
            const ok = Number.isFinite(numericNoteId) && numericNoteId > 0;
            if (ok) noteDeckPairs[index].noteId = numericNoteId;
            return {
                noteId: ok ? numericNoteId : null,
                duplicate: false,
                updated: false,
                action: ok ? 'add' : 'error',
                requestedDeck: noteDeckPairs[index].deckName,
                deckVerificationSkipped: true,
                deckVerificationSkipReason: ok ? 'pending_batch_verification' : 'add_failed',
            };
        });

        if (shouldSync) {
            try {
                await this.syncWithDelay();
            } catch (error) {
                debugLog('Anki batch sync failed (non-critical):', error.message);
            }
        }

        const verificationRows = await this.verifyAddedDecks(
            noteDeckPairs.filter((pair) => pair.noteId),
            options,
        );
        const verificationByNoteId = new Map(verificationRows.map((row) => [Number(row.noteId), row]));
        const results = resultRows.map((row) => {
            const verification = row.noteId ? verificationByNoteId.get(Number(row.noteId)) : null;
            return verification ? { ...row, ...verification } : row;
        });

        return {
            action: 'batch_add',
            count: entries.length,
            added: results.filter((row) => row.action === 'add').length,
            deckVerificationMode: 'batch',
            results,
        };
    }

    async getDeckNames() {
        return this.invoke('deckNames');
    }

    async sync() {
        return this.invoke('sync');
    }
}

const client = new AnkiConnect();

module.exports = client;
module.exports.AnkiConnect = AnkiConnect;
