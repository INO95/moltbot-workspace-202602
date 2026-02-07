const http = require('http');

class AnkiConnect {
    constructor(host = process.env.ANKI_CONNECT_HOST || 'host.docker.internal', port = Number(process.env.ANKI_CONNECT_PORT || 8765)) {
        this.host = host;
        this.port = port;
        this.fallbackHosts = this.buildFallbackHosts(host);
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
            for (const host of this.fallbackHosts) {
                try {
                    const result = await this.invokeWithHost(host, action, params);
                    if (this.host !== host) {
                        this.host = host;
                    }
                    return result;
                } catch (e) {
                    lastErr = e;
                }
            }
            throw new Error(`${lastErr ? lastErr.message : 'AnkiConnect failed'} (Is Anki running with AnkiConnect enabled?)`);
        })();
    }

    async syncWithDelay(delayMs = 1000) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return this.sync();
    }

    async addCard(deckName, front, back, tags = [], options = {}) {
        const shouldSync = options.sync !== false;
        console.log(`OpenClaw -> Anki: Adding card to [${deckName}]`);
        const result = await this.invoke('addNote', {
            note: {
                deckName: deckName,
                modelName: 'Basic',
                fields: {
                    Question: front,
                    Answer: back
                },
                options: {
                    allowDuplicate: true
                },
                tags: tags
            }
        });

        if (shouldSync) {
            try {
                console.log('OpenClaw -> Anki: Waiting 1s before sync...');
                console.log('OpenClaw -> Anki: Triggering sync...');
                await this.syncWithDelay();
            } catch (e) {
                console.log('Anki Sync failed (non-critical):', e.message);
            }
        }

        return result;
    }

    async getDeckNames() {
        return this.invoke('deckNames');
    }

    async sync() {
        return this.invoke('sync');
    }
}

module.exports = new AnkiConnect();
