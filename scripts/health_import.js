const fs = require('fs');
const path = require('path');
const healthCapture = require('./health_capture');

const STATE_PATH = path.join(__dirname, '../data/health_import_state.json');

function usage() {
    console.error('Usage: node scripts/health_import.js <apple|mifitness|auto> <file-path>');
}

function ensureState() {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(STATE_PATH)) {
        fs.writeFileSync(STATE_PATH, JSON.stringify({ importedKeys: {} }, null, 2), 'utf8');
    }
}

function loadState() {
    ensureState();
    try {
        const obj = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        if (!obj || typeof obj !== 'object') return { importedKeys: {} };
        if (!obj.importedKeys || typeof obj.importedKeys !== 'object') obj.importedKeys = {};
        return obj;
    } catch {
        return { importedKeys: {} };
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function attr(tag, name) {
    const m = String(tag || '').match(new RegExp(`${name}="([^"]*)"`, 'i'));
    return m ? m[1] : '';
}

function normalizeDate(text) {
    const s = String(text || '');
    const m = s.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (!m) return null;
    const y = m[1];
    const mo = String(parseInt(m[2], 10)).padStart(2, '0');
    const d = String(parseInt(m[3], 10)).padStart(2, '0');
    return `${y}-${mo}-${d}`;
}

function parseDateTime(text) {
    let s = String(text || '').trim();
    const explicitTz = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
    if (explicitTz) {
        s = `${explicitTz[1]}T${explicitTz[2]}${explicitTz[3]}:${explicitTz[4]}`;
    } else {
        s = s.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T');
    }
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d;
}

function toMinutes(value, unit) {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const u = String(unit || '').toLowerCase();
    if (u.includes('hour')) return n * 60;
    if (u.includes('sec')) return n / 60;
    return n;
}

function parseAppleHealthXml(xml) {
    const runningByDate = {};
    const sleepByDate = {};

    const runningRecordRe = /<Record\b[^>]*type="HKQuantityTypeIdentifierDistanceWalkingRunning"[^>]*>/gi;
    for (const match of String(xml).matchAll(runningRecordRe)) {
        const tag = match[0];
        const date = normalizeDate(attr(tag, 'startDate') || attr(tag, 'creationDate'));
        if (!date) continue;
        const unit = String(attr(tag, 'unit') || '').toLowerCase();
        const rawValue = Number(attr(tag, 'value') || 0);
        if (!Number.isFinite(rawValue) || rawValue <= 0) continue;
        let distanceKm = rawValue;
        if (unit === 'm') distanceKm = rawValue / 1000;
        if (unit === 'mi') distanceKm = rawValue * 1.60934;
        runningByDate[date] = runningByDate[date] || { distanceKm: 0, durationMin: 0 };
        runningByDate[date].distanceKm += distanceKm;
    }

    const runningWorkoutRe = /<Workout\b[^>]*workoutActivityType="HKWorkoutActivityTypeRunning"[^>]*>/gi;
    for (const match of String(xml).matchAll(runningWorkoutRe)) {
        const tag = match[0];
        const date = normalizeDate(attr(tag, 'startDate') || attr(tag, 'creationDate'));
        if (!date) continue;
        const durationMin = toMinutes(attr(tag, 'duration'), attr(tag, 'durationUnit'));
        runningByDate[date] = runningByDate[date] || { distanceKm: 0, durationMin: 0 };
        runningByDate[date].durationMin += durationMin;
    }

    const sleepRe = /<Record\b[^>]*type="HKCategoryTypeIdentifierSleepAnalysis"[^>]*>/gi;
    for (const match of String(xml).matchAll(sleepRe)) {
        const tag = match[0];
        const value = String(attr(tag, 'value') || '');
        const isAsleep =
            /Asleep/i.test(value) ||
            value === '2' ||
            value === '3' ||
            value === '4' ||
            value === '5';
        if (!isAsleep) continue;
        const start = parseDateTime(attr(tag, 'startDate'));
        const end = parseDateTime(attr(tag, 'endDate'));
        if (!start || !end || end <= start) continue;
        const date = normalizeDate(attr(tag, 'startDate'));
        if (!date) continue;
        const hours = (end.getTime() - start.getTime()) / 3600000;
        if (!Number.isFinite(hours) || hours <= 0) continue;
        sleepByDate[date] = (sleepByDate[date] || 0) + hours;
    }

    const running = Object.entries(runningByDate).map(([date, v]) => ({
        date,
        distanceKm: Number(v.distanceKm.toFixed(2)),
        durationMin: Math.round(v.durationMin || 0),
    }));
    const sleep = Object.entries(sleepByDate).map(([date, hours]) => ({
        date,
        hours: Number(hours.toFixed(2)),
    }));
    return { running, sleep };
}

function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (ch === ',' && !inQuotes) {
            out.push(cur.trim());
            cur = '';
            continue;
        }
        cur += ch;
    }
    out.push(cur.trim());
    return out;
}

function parseDurationMinutes(raw) {
    const s = String(raw || '').trim();
    if (!s) return 0;
    if (/^\d+:\d+(:\d+)?$/.test(s)) {
        const p = s.split(':').map(v => parseInt(v, 10) || 0);
        if (p.length === 2) return p[0] * 60 + p[1];
        if (p.length === 3) return p[0] * 60 + p[1] + Math.round(p[2] / 60);
    }
    const n = Number(s.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? Math.round(n) : 0;
}

function parseMiFitnessCsv(csvText) {
    const lines = String(csvText || '')
        .split(/\r?\n/)
        .map(x => x.trim())
        .filter(Boolean);
    if (lines.length < 2) return { running: [], sleep: [] };

    const headers = splitCsvLine(lines[0]).map(h => h.toLowerCase());
    const idx = {
        date: headers.findIndex(h => /date|day|날짜/.test(h)),
        distance: headers.findIndex(h => /distance|거리|km/.test(h)),
        duration: headers.findIndex(h => /duration|시간|min/.test(h)),
        calories: headers.findIndex(h => /kcal|calorie|칼로리/.test(h)),
        sleep: headers.findIndex(h => /sleep|수면/.test(h)),
    };

    const runningByDate = {};
    const sleepByDate = {};
    for (const line of lines.slice(1)) {
        const cols = splitCsvLine(line);
        const date = normalizeDate(cols[idx.date]);
        if (!date) continue;

        const distRaw = idx.distance >= 0 ? cols[idx.distance] : '';
        const dist = Number(String(distRaw || '').replace(/[^0-9.]/g, '')) || 0;
        if (dist > 0) {
            const durationMin = idx.duration >= 0 ? parseDurationMinutes(cols[idx.duration]) : 0;
            runningByDate[date] = runningByDate[date] || { distanceKm: 0, durationMin: 0 };
            runningByDate[date].distanceKm += dist;
            runningByDate[date].durationMin += durationMin;
        }

        const sleepRaw = idx.sleep >= 0 ? cols[idx.sleep] : '';
        const sleepHours = Number(String(sleepRaw || '').replace(/[^0-9.]/g, '')) || 0;
        if (sleepHours > 0) {
            sleepByDate[date] = (sleepByDate[date] || 0) + sleepHours;
        }
    }

    return {
        running: Object.entries(runningByDate).map(([date, v]) => ({
            date,
            distanceKm: Number(v.distanceKm.toFixed(2)),
            durationMin: Math.round(v.durationMin || 0),
        })),
        sleep: Object.entries(sleepByDate).map(([date, hours]) => ({
            date,
            hours: Number(hours.toFixed(2)),
        })),
    };
}

function importRecords(records, sourceName) {
    const state = loadState();
    let imported = 0;
    let skipped = 0;

    for (const run of records.running || []) {
        const key = `${sourceName}:running:${run.date}:${run.distanceKm}:${run.durationMin}`;
        if (state.importedKeys[key]) {
            skipped += 1;
            continue;
        }
        const text = `Indoor Run ${run.date} Distance ${run.distanceKm}km Duration ${run.durationMin}min`;
        healthCapture.ingestCapture(text, { source: `${sourceName}-import` });
        state.importedKeys[key] = new Date().toISOString();
        imported += 1;
    }

    for (const sl of records.sleep || []) {
        const key = `${sourceName}:sleep:${sl.date}:${sl.hours}`;
        if (state.importedKeys[key]) {
            skipped += 1;
            continue;
        }
        const text = `Sleep ${sl.date} ${sl.hours}h`;
        healthCapture.ingestCapture(text, { source: `${sourceName}-import` });
        state.importedKeys[key] = new Date().toISOString();
        imported += 1;
    }

    saveState(state);
    return { imported, skipped };
}

function detectMode(mode, filePath) {
    if (mode !== 'auto') return mode;
    const lower = String(filePath || '').toLowerCase();
    if (lower.endsWith('.xml')) return 'apple';
    if (lower.endsWith('.csv')) return 'mifitness';
    return 'mifitness';
}

function main() {
    const modeArg = process.argv[2];
    const filePath = process.argv[3];
    if (!modeArg || !filePath) {
        usage();
        process.exit(1);
    }
    const mode = detectMode(String(modeArg).toLowerCase(), filePath);
    if (!['apple', 'mifitness'].includes(mode)) {
        usage();
        process.exit(1);
    }
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const records = mode === 'apple' ? parseAppleHealthXml(raw) : parseMiFitnessCsv(raw);
    const result = importRecords(records, mode);
    const monthly = healthCapture.getMonthlySummary();

    console.log(
        JSON.stringify(
            {
                mode,
                filePath,
                parsed: {
                    running: (records.running || []).length,
                    sleep: (records.sleep || []).length,
                },
                imported: result.imported,
                skipped: result.skipped,
                monthly,
            },
            null,
            2,
        ),
    );
}

if (require.main === module) {
    main();
}

module.exports = {
    parseAppleHealthXml,
    parseMiFitnessCsv,
    importRecords,
};
