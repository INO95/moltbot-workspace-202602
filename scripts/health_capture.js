const fs = require('fs');
const path = require('path');

const SNAPSHOT_PATH = path.join(__dirname, '../data/health_db.json');
const LOG_PATH = path.join(__dirname, '../data/health_captures.jsonl');

function ensureStore() {
    const dataDir = path.dirname(SNAPSHOT_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '', 'utf8');
    if (!fs.existsSync(SNAPSHOT_PATH)) {
        fs.writeFileSync(
            SNAPSHOT_PATH,
            JSON.stringify(
                {
                    schemaVersion: 2,
                    updatedAt: null,
                    running: [],
                    workouts: [],
                    sleep: [],
                    raw: [],
                },
                null,
                2,
            ),
            'utf8',
        );
    }
}

function normalizeDate(text) {
    const s = String(text || '');
    const m = s.match(/(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/);
    if (!m) return new Date().toISOString().split('T')[0];
    const y = m[1];
    const mo = String(parseInt(m[2], 10)).padStart(2, '0');
    const d = String(parseInt(m[3], 10)).padStart(2, '0');
    return `${y}-${mo}-${d}`;
}

function parseBodyArea(text) {
    const s = String(text || '');
    const areas = [
        { key: '가슴', re: /가슴|chest|bench/i },
        { key: '등', re: /등|back|pull/i },
        { key: '하체', re: /하체|legs|squat|deadlift/i },
        { key: '어깨', re: /어깨|shoulder/i },
        { key: '팔', re: /이두|삼두|arm|biceps|triceps/i },
        { key: '코어', re: /코어|복근|core/i },
        { key: '유산소', re: /러닝|런닝|run|cardio|트레드밀|indoor run/i },
    ];
    const matched = areas.filter(a => a.re.test(s)).map(a => a.key);
    return matched.length ? [...new Set(matched)] : ['기타'];
}

function parseNumber(text, pattern) {
    const m = String(text || '').match(pattern);
    if (!m) return null;
    const n = Number(String(m[1]).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

function detectCaptureType(text) {
    const s = String(text || '');
    if (/indoor run|run|distance|km|트레드밀|러닝|런닝/i.test(s)) return 'running';
    if (/workout|sets|reps|kg\/min|volume|max weight|1rm|운동|세트|반복/i.test(s)) return 'workout';
    if (/sleep|수면|deep sleep|rem/i.test(s)) return 'sleep';
    return 'unknown';
}

function parseRunning(text) {
    const date = normalizeDate(text);
    const distanceKm = parseNumber(text, /(\d+(?:\.\d+)?)\s*km/i);
    const calories = parseNumber(text, /(\d+(?:\.\d+)?)\s*kcal/i);
    const durationMin = parseNumber(text, /(\d+(?:\.\d+)?)\s*min/i);
    return {
        date,
        type: /트레드밀|indoor run/i.test(text) ? 'indoor' : 'running',
        distanceKm: distanceKm || 0,
        calories: calories || 0,
        durationMin: durationMin || 0,
    };
}

function parseWorkout(text) {
    const date = normalizeDate(text);
    const volumeKg = parseNumber(text, /(\d+(?:\.\d+)?)\s*kg\s*(?:$|\n|[^/])/i);
    const durationMin = parseNumber(text, /(\d+(?:\.\d+)?)\s*min/i);
    const calories = parseNumber(text, /(\d+(?:\.\d+)?)\s*kcal/i);
    const sets = parseNumber(text, /(\d+)\s*sets/i);
    const reps = parseNumber(text, /(\d+)\s*reps/i);
    const areas = parseBodyArea(text);
    return {
        date,
        areas,
        volumeKg: volumeKg || 0,
        durationMin: durationMin || 0,
        calories: calories || 0,
        sets: sets || 0,
        reps: reps || 0,
    };
}

function parseSleep(text) {
    const date = normalizeDate(text);
    const hours = parseNumber(text, /(\d+(?:\.\d+)?)\s*(?:h|hour|시간)/i);
    const deepPercent = parseNumber(text, /(\d+(?:\.\d+)?)\s*%/i);
    return {
        date,
        hours: hours || 0,
        deepPercent: deepPercent || 0,
    };
}

function appendEntry(entry) {
    ensureStore();
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}

function readEntries() {
    ensureStore();
    const lines = fs
        .readFileSync(LOG_PATH, 'utf8')
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean);
    const entries = [];
    for (const line of lines) {
        try {
            entries.push(JSON.parse(line));
        } catch {
            // Skip broken line.
        }
    }
    return entries;
}

function buildSnapshot(entries) {
    const out = {
        schemaVersion: 2,
        updatedAt: new Date().toISOString(),
        running: [],
        workouts: [],
        sleep: [],
        raw: [],
    };
    for (const e of entries) {
        out.raw.push({
            id: e.id,
            type: e.type,
            source: e.source,
            text: e.text,
            createdAt: e.createdAt,
        });
        if (e.type === 'running') out.running.push({ ...e.record, sourceText: e.text, createdAt: e.createdAt });
        if (e.type === 'workout') out.workouts.push({ ...e.record, sourceText: e.text, createdAt: e.createdAt });
        if (e.type === 'sleep') out.sleep.push({ ...e.record, sourceText: e.text, createdAt: e.createdAt });
    }
    return out;
}

function refreshSnapshot() {
    const snapshot = buildSnapshot(readEntries());
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
    return snapshot;
}

function ingestCapture(text, opts = {}) {
    const source = opts.source || 'unknown';
    const type = detectCaptureType(text);
    let record = null;
    if (type === 'running') record = parseRunning(text);
    if (type === 'workout') record = parseWorkout(text);
    if (type === 'sleep') record = parseSleep(text);

    const entry = {
        id: Date.now(),
        type,
        source,
        text: String(text || ''),
        record,
        createdAt: new Date().toISOString(),
    };
    appendEntry(entry);
    refreshSnapshot();

    return {
        success: type !== 'unknown',
        type,
        record,
    };
}

function filterByMonth(list, monthPrefix) {
    return list.filter(r => String(r.date || '').startsWith(monthPrefix));
}

function getMonthlySummary(ym = null) {
    const snapshot = refreshSnapshot();
    const now = new Date();
    const monthPrefix = ym || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const running = filterByMonth(snapshot.running, monthPrefix);
    const workouts = filterByMonth(snapshot.workouts, monthPrefix);
    const sleep = filterByMonth(snapshot.sleep, monthPrefix);

    const runningDistance = running.reduce((s, r) => s + Number(r.distanceKm || 0), 0);
    const runningCalories = running.reduce((s, r) => s + Number(r.calories || 0), 0);
    const workoutVolume = workouts.reduce((s, r) => s + Number(r.volumeKg || 0), 0);
    const workoutDuration = workouts.reduce((s, r) => s + Number(r.durationMin || 0), 0);
    const areaCount = {};
    for (const w of workouts) {
        for (const a of w.areas || []) {
            areaCount[a] = (areaCount[a] || 0) + 1;
        }
    }

    const expected = ['가슴', '등', '하체', '어깨', '유산소'];
    const missingAreas = expected.filter(area => !areaCount[area]);
    const restRules = { 가슴: 2, 등: 2, 하체: 3, 어깨: 2, 팔: 2, 코어: 1, 유산소: 1 };
    const recovery = {};
    for (const area of Object.keys(restRules)) {
        const recent = workouts
            .filter(w => (w.areas || []).includes(area))
            .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
        if (!recent) {
            recovery[area] = { lastDate: null, ready: true, needMoreDays: 0 };
            continue;
        }
        const daysSince = Math.floor((Date.now() - new Date(recent.date).getTime()) / 86400000);
        const need = Math.max(0, restRules[area] - daysSince);
        recovery[area] = { lastDate: recent.date, ready: need === 0, needMoreDays: need };
    }
    const avgSleep = sleep.length > 0 ? sleep.reduce((s, x) => s + Number(x.hours || 0), 0) / sleep.length : 0;

    return {
        month: monthPrefix,
        running: {
            sessions: running.length,
            distanceKm: Number(runningDistance.toFixed(2)),
            calories: Math.round(runningCalories),
        },
        workouts: {
            sessions: workouts.length,
            totalVolumeKg: Math.round(workoutVolume),
            totalDurationMin: Math.round(workoutDuration),
            byArea: areaCount,
            missingAreas,
        },
        sleep: {
            records: sleep.length,
            avgHours: Number(avgSleep.toFixed(2)),
        },
        recovery,
    };
}

function getRecentExerciseHistory(days = 30) {
    const snapshot = refreshSnapshot();
    const cutoff = Date.now() - days * 86400000;
    return snapshot.workouts
        .filter(w => new Date(w.date).getTime() >= cutoff)
        .map(w => ({
            date: w.date,
            type: (w.areas || [])[0] || 'other',
            name: (w.areas || []).join('/'),
            sets: w.sets,
            reps: w.reps,
            weight: w.volumeKg,
            duration: w.durationMin,
        }));
}

module.exports = {
    ingestCapture,
    getMonthlySummary,
    getRecentExerciseHistory,
};
