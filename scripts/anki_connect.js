const http = require('http');

class AnkiConnect {
    constructor(host = 'host.docker.internal', port = 8765) {
        this.host = host;
        this.port = port;
    }

    invoke(action, params = {}) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({ action, version: 6, params });

            const options = {
                hostname: this.host,
                port: this.port,
                path: '/',
                method: 'POST',
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
                        }
                        if (!result.hasOwnProperty('error')) {
                            reject(new Error('response is missing required error field'));
                        }
                        if (!result.hasOwnProperty('result')) {
                            reject(new Error('response is missing required result field'));
                        }
                        if (result.error) {
                            reject(new Error(result.error));
                        }
                        resolve(result.result);
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', (e) => {
                reject(new Error(`AnkiConnect Error: ${e.message} (Is Anki running?)`));
            });

            req.write(postData);
            req.end();
        });
    }

    async addCard(deckName, front, back, tags = []) {
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

        // Automatically sync after adding card
        try {
            console.log('OpenClaw -> Anki: Waiting 1s before sync...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            console.log('OpenClaw -> Anki: Triggering sync...');
            await this.sync();
        } catch (e) {
            console.log('Anki Sync failed (non-critical):', e.message);
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
