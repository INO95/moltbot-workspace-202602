const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const config = require('../data/config.json');
const { sendCommand } = require('./ag_bridge_client');

function loadGoogleCreds() {
    const candidates = [
        process.env.MOLTBOT_GOOGLE_CREDS_PATH,
        path.join(__dirname, '../data/secure/google_creds.json'),
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate)) continue;
            const raw = fs.readFileSync(candidate, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            if (parsed && parsed.client_email && parsed.private_key) {
                return parsed;
            }
        } catch (_) {
            // try next candidate
        }
    }

    return null;
}

const creds = loadGoogleCreds();

class MoltEngine {
    constructor() {
        this.config = config;
        this.initialized = false;
        this.doc = null;
        this.remoteReady = false;

        if (creds && creds.client_email && creds.private_key && this.config.spreadsheetId) {
            const auth = new JWT({
                email: creds.client_email,
                key: creds.private_key,
                scopes: [
                    'https://www.googleapis.com/auth/spreadsheets',
                    'https://www.googleapis.com/auth/drive',
                ],
            });
            this.doc = new GoogleSpreadsheet(config.spreadsheetId, auth);
            this.remoteReady = true;
        }
    }

    async init() {
        if (this.initialized) return;
        if (!this.remoteReady || !this.doc) {
            throw new Error('Google credentials are unavailable. Set MOLTBOT_GOOGLE_CREDS_PATH or provide data/secure/google_creds.json');
        }
        await this.doc.loadInfo();
        console.log(`✅ Connected to: ${this.doc.title}`);
        this.initialized = true;
    }

    getFormattedDate(date = new Date()) {
        const days = ['일', '월', '화', '수', '목', '금', '토'];
        const yy = String(date.getFullYear()).slice(-2);
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const day = days[date.getDay()];
        return `${yy} ${mm} ${dd} ${day}`;
    }

    getIsoDate(date = new Date()) {
        return date.toISOString().split('T')[0];
    }

    csvEscape(value) {
        const s = String(value ?? '');
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
    }

    appendCsvRow(filePath, header, rowValues) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, `${header.join(',')}\n`, 'utf8');
        }
        const line = rowValues.map(v => this.csvEscape(v)).join(',');
        fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    }

    hasActivityShortcut(text) {
        const lowerText = String(text || '').toLowerCase();
        return Object.keys(this.config.activityShortcuts || {}).some(shortcut =>
            lowerText.includes(shortcut.toLowerCase()),
        );
    }

    stripKnownPrefix(text) {
        const prefixes = Object.values(this.config.commandPrefixes || {})
            .map(v => String(v || '').trim())
            .filter(Boolean);
        for (const prefix of prefixes) {
            if (String(text).startsWith(prefix)) {
                return String(text).slice(prefix.length).trim();
            }
        }
        return String(text || '').trim();
    }

    splitIngestSegments(text) {
        const normalized = this.stripKnownPrefix(String(text || ''));
        return normalized
            .replace(/그리고/gi, ',')
            .replace(/[|/]/g, ',')
            .split(/\n|[,;]|(?:\s{2,})/)
            .map(s => s.trim())
            .filter(Boolean);
    }

    async getOrCreateTodayRow() {
        await this.init();

        const sheet = this.doc.sheetsByTitle[this.config.sheets.checklist];
        const rows = await sheet.getRows();
        const today = this.getFormattedDate();

        let row = rows.find(r => r.get('날짜') === today);
        if (!row) {
            row = await sheet.addRow({ '날짜': today });
            console.log(`✨ 새로운 체크리스트 행 생성: ${today}`);
        }
        return row;
    }

    async recordActivity(text) {
        const lowerText = String(text || '').toLowerCase();
        const recorded = [];

        for (const [shortcut, info] of Object.entries(this.config.activityShortcuts || {})) {
            if (!lowerText.includes(shortcut.toLowerCase())) continue;
            const column = info.column;
            let value = info.value;

            if (value === null) {
                const match = String(text).match(new RegExp(`${shortcut}\\s*(\\d+|\\S+)`, 'i'));
                if (match && match[1]) {
                    value =
                        shortcut === '알고' || shortcut === '알고리즘'
                            ? `${match[1]}문제`
                            : match[1];
                } else {
                    value = 'O';
                }
            }

            recorded.push({ column, value });
        }

        if (recorded.length === 0) {
            recorded.push({ column: '기타', value: String(text || '').trim() || '-' });
        }

        let remoteSynced = false;
        let remoteError = null;
        try {
            const row = await this.getOrCreateTodayRow();
            for (const rec of recorded) {
                if (rec.column === '기타') {
                    const existing = row.get('기타') || '';
                    const newValue = existing ? `${existing}, ${rec.value}` : rec.value;
                    row.set('기타', newValue);
                } else {
                    row.set(rec.column, rec.value);
                }
            }
            await row.save();
            remoteSynced = true;
        } catch (error) {
            remoteError = error.message;
            this.logError(`Checklist sheet sync skipped: ${error.message}`);
        }

        try {
            for (const rec of recorded) {
                this.appendCsvRow(
                    path.join(__dirname, '../data/todos.csv'),
                    ['date', 'task', 'status', 'completed_at'],
                    [this.getIsoDate(), rec.column, rec.value, new Date().toISOString()],
                );
            }
        } catch (error) {
            this.logError(`Checklist CSV write failed: ${error.message}`);
        }

        return {
            success: true,
            recorded,
            remoteSynced,
            ...(remoteError ? { remoteError } : {}),
        };
    }

    async getTodaySummary() {
        try {
            const row = await this.getOrCreateTodayRow();
            const sheet = this.doc.sheetsByTitle[this.config.sheets.checklist];

            const summary = {};
            for (const header of sheet.headerValues) {
                const value = row.get(header);
                if (value) summary[header] = value;
            }
            return summary;
        } catch (error) {
            const csvPath = path.join(__dirname, '../data/todos.csv');
            const today = this.getIsoDate();
            if (!fs.existsSync(csvPath)) {
                return { error: `체크리스트 조회 실패: ${error.message}` };
            }

            const lines = fs.readFileSync(csvPath, 'utf8').split('\n').slice(1).filter(Boolean);
            const summary = {};
            for (const line of lines) {
                const [date, task, status] = line.split(',');
                if (date !== today) continue;
                summary[task] = status;
            }
            if (Object.keys(summary).length === 0) {
                summary.error = `체크리스트 조회 실패(원격), 로컬 데이터 없음: ${error.message}`;
            }
            return summary;
        }
    }

    async ingestNaturalText(text) {
        const segments = this.splitIngestSegments(text);
        const result = {
            input: text,
            segments: segments.length,
            checklist: [],
            skipped: [],
        };

        for (const segment of segments) {
            if (!this.hasActivityShortcut(segment)) {
                result.skipped.push(segment);
                continue;
            }
            const check = await this.recordActivity(segment);
            result.checklist.push(check);
        }

        return result;
    }

    async handleRemoteCommand(command) {
        try {
            const response = await sendCommand(command);
            return {
                success: true,
                message: response.result,
                actions: response.actions,
            };
        } catch (error) {
            this.logError(`Remote command failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    logError(message) {
        const errorLogPath = path.join(__dirname, '../logs/error.log');
        const logDir = path.dirname(errorLogPath);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const timestamp = new Date().toISOString();
        fs.appendFileSync(errorLogPath, `[${timestamp}] Error: ${message}\n`);
        console.error(`❌ Error logged: ${message}`);
    }
}

module.exports = new MoltEngine();
