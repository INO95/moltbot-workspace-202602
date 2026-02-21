const { readJsonFile, writeJsonFile } = require('./news_storage');

function nowIso() {
    return new Date().toISOString();
}

function createEmptyState() {
    return {
        version: 1,
        updatedAt: nowIso(),
        sources: {},
    };
}

function readFetchState(statePath) {
    const state = readJsonFile(statePath, createEmptyState());
    if (!state || typeof state !== 'object') return createEmptyState();
    if (!state.sources || typeof state.sources !== 'object') state.sources = {};
    if (!state.version) state.version = 1;
    return state;
}

function writeFetchState(statePath, state) {
    const next = state && typeof state === 'object' ? state : createEmptyState();
    if (!next.sources || typeof next.sources !== 'object') next.sources = {};
    next.version = 1;
    next.updatedAt = nowIso();
    writeJsonFile(statePath, next);
}

function getSourceState(state, sourceId) {
    if (!state.sources[sourceId]) {
        state.sources[sourceId] = {
            lastRunAt: null,
            lastSeenId: null,
            etagByUrl: {},
            lastModifiedByUrl: {},
        };
    }
    const sourceState = state.sources[sourceId];
    if (!sourceState.etagByUrl || typeof sourceState.etagByUrl !== 'object') sourceState.etagByUrl = {};
    if (!sourceState.lastModifiedByUrl || typeof sourceState.lastModifiedByUrl !== 'object') sourceState.lastModifiedByUrl = {};
    return sourceState;
}

function shouldPoll(sourceState, pollMinutes, nowMs = Date.now()) {
    const minutes = Number(pollMinutes || 0);
    if (!minutes || minutes <= 0) return true;
    if (!sourceState || !sourceState.lastRunAt) return true;
    const lastMs = Date.parse(sourceState.lastRunAt);
    if (!Number.isFinite(lastMs)) return true;
    return nowMs - lastMs >= minutes * 60 * 1000;
}

module.exports = {
    readFetchState,
    writeFetchState,
    getSourceState,
    shouldPoll,
};
