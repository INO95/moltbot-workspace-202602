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

    async findDuplicateByFront(deckName, front, options = {}) {
        const modelName = String(options.modelName || 'Basic').trim();
        const mapped = await this.buildNoteFields(front, '', { modelName });
        const query = `deck:"${this.escapeQueryValue(deckName)}" ${mapped.frontField}:"${this.escapeQueryValue(front)}"`;
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
                duplicate = await this.findDuplicateByFront(deckName, front, { modelName });
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

        debugLog(`OpenClaw -> Anki: Adding card to [${deckName}]`);
        let result;
        try {
            result = await this.invoke('addNote', {
                note: {
                    deckName: deckName,
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
                    resolved = await this.findDuplicateByFront(deckName, front, { modelName });
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

        return {
            noteId: result,
            duplicate: false,
            updated: false,
            action: 'add',
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
