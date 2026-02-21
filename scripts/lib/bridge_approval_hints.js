const fs = require('fs');
const path = require('path');

function readLastApprovalHints(deps = {}) {
  const fsModule = deps.fsModule || fs;
  const hintsPath = String(deps.hintsPath || '').trim();
  if (!hintsPath) return {};
  try {
    if (!fsModule.existsSync(hintsPath)) return {};
    const raw = fsModule.readFileSync(hintsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeLastApprovalHints(hints = {}, deps = {}) {
  const fsModule = deps.fsModule || fs;
  const pathModule = deps.pathModule || path;
  const hintsPath = String(deps.hintsPath || '').trim();
  if (!hintsPath) return false;
  try {
    fsModule.mkdirSync(pathModule.dirname(hintsPath), { recursive: true });
    fsModule.writeFileSync(hintsPath, `${JSON.stringify(hints, null, 2)}\n`, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function buildApprovalOwnerKey(requestedBy = '', telegramContext = null) {
  const requester = String(requestedBy || '').trim();
  const telegramUserId = String((telegramContext && telegramContext.userId) || '').trim();
  if (requester && requester !== 'unknown') return requester;
  if (telegramUserId) return telegramUserId;
  return 'unknown';
}

function rememberLastApprovalHint({
  requestedBy = '',
  telegramContext = null,
  requestId = '',
  capability = '',
  action = '',
} = {}, deps = {}) {
  const ownerKey = buildApprovalOwnerKey(requestedBy, telegramContext);
  const reqId = String(requestId || '').trim();
  if (!ownerKey || !reqId) return false;
  const readFn = typeof deps.readLastApprovalHints === 'function'
    ? deps.readLastApprovalHints
    : () => readLastApprovalHints(deps);
  const writeFn = typeof deps.writeLastApprovalHints === 'function'
    ? deps.writeLastApprovalHints
    : (hints) => writeLastApprovalHints(hints, deps);
  const hints = readFn();
  hints[ownerKey] = {
    owner_key: ownerKey,
    request_id: reqId,
    capability: String(capability || '').trim(),
    action: String(action || '').trim(),
    updated_at: new Date().toISOString(),
  };
  return writeFn(hints);
}

function readLastApprovalHint(requestedBy = '', telegramContext = null, deps = {}) {
  const ownerKey = buildApprovalOwnerKey(requestedBy, telegramContext);
  if (!ownerKey) return null;
  const readFn = typeof deps.readLastApprovalHints === 'function'
    ? deps.readLastApprovalHints
    : () => readLastApprovalHints(deps);
  const hints = readFn();
  const row = hints && typeof hints === 'object' ? hints[ownerKey] : null;
  if (!row || typeof row !== 'object') return null;
  const reqId = String(row.request_id || '').trim();
  if (!reqId) return null;
  return {
    ownerKey,
    requestId: reqId,
    capability: String(row.capability || '').trim(),
    action: String(row.action || '').trim(),
    updatedAt: String(row.updated_at || '').trim(),
  };
}

function clearLastApprovalHint(requestedBy = '', telegramContext = null, deps = {}) {
  const ownerKey = buildApprovalOwnerKey(requestedBy, telegramContext);
  if (!ownerKey) return false;
  const readFn = typeof deps.readLastApprovalHints === 'function'
    ? deps.readLastApprovalHints
    : () => readLastApprovalHints(deps);
  const writeFn = typeof deps.writeLastApprovalHints === 'function'
    ? deps.writeLastApprovalHints
    : (hints) => writeLastApprovalHints(hints, deps);
  const hints = readFn();
  if (!Object.prototype.hasOwnProperty.call(hints, ownerKey)) return false;
  delete hints[ownerKey];
  return writeFn(hints);
}

function hasAnyApprovalHint(deps = {}) {
  const readFn = typeof deps.readLastApprovalHints === 'function'
    ? deps.readLastApprovalHints
    : () => readLastApprovalHints(deps);
  const hints = readFn();
  return Object.keys(hints).length > 0;
}

function findPendingApprovalByRequestId(requestId = '', rows = []) {
  const reqId = String(requestId || '').trim();
  if (!reqId) return null;
  const src = Array.isArray(rows) ? rows : [];
  return src.find((row) => String((row && row.request_id) || '').trim() === reqId) || null;
}

function resolveApprovalTokenFromHint(requestedBy = '', telegramContext = null, deps = {}) {
  const readHintFn = typeof deps.readLastApprovalHint === 'function'
    ? deps.readLastApprovalHint
    : (reqBy, tgCtx) => readLastApprovalHint(reqBy, tgCtx, deps);
  const readPendingApprovalsState = typeof deps.readPendingApprovalsState === 'function'
    ? deps.readPendingApprovalsState
    : () => [];
  const hint = readHintFn(requestedBy, telegramContext);
  if (!hint || !hint.requestId) {
    return { token: '', row: null, hint: null, found: false };
  }
  const rows = readPendingApprovalsState();
  const row = findPendingApprovalByRequestId(hint.requestId, rows);
  return {
    token: String((row && row.id) || '').trim(),
    row: row || null,
    hint,
    found: Boolean(row),
  };
}

function findApprovalTokenCandidates(query = '', deps = {}) {
  const readPendingApprovalsState = typeof deps.readPendingApprovalsState === 'function'
    ? deps.readPendingApprovalsState
    : () => [];
  const pending = readPendingApprovalsState();
  const needle = String(query || '').trim();
  if (!needle) return pending.slice(0, 5);

  const exact = pending.filter((row) => (
    String((row && row.request_id) || '').trim() === needle
      || String((row && row.id) || '').trim() === needle
  ));
  if (exact.length > 0) return exact;

  const partial = pending.filter((row) => (
    String((row && row.request_id) || '').includes(needle)
      || String((row && row.id) || '').includes(needle)
  ));
  return partial.slice(0, 5);
}

function sortPendingApprovalsNewestFirst(rows = []) {
  const src = Array.isArray(rows) ? rows.slice() : [];
  src.sort((a, b) => {
    const aMs = Date.parse(String((a && (a.created_at || a.updated_at)) || '')) || 0;
    const bMs = Date.parse(String((b && (b.created_at || b.updated_at)) || '')) || 0;
    return bMs - aMs;
  });
  return src;
}

function resolveApprovalTokenSelection({
  query = '',
  requestedBy = '',
  telegramContext = null,
} = {}, deps = {}) {
  const readPendingApprovalsState = typeof deps.readPendingApprovalsState === 'function'
    ? deps.readPendingApprovalsState
    : () => [];
  const findApprovalTokenCandidatesFn = typeof deps.findApprovalTokenCandidates === 'function'
    ? deps.findApprovalTokenCandidates
    : (value) => findApprovalTokenCandidates(value, deps);
  const sortPendingApprovalsNewestFirstFn = typeof deps.sortPendingApprovalsNewestFirst === 'function'
    ? deps.sortPendingApprovalsNewestFirst
    : sortPendingApprovalsNewestFirst;
  const allPending = readPendingApprovalsState();
  const queryText = String(query || '').trim();
  const ownerKey = buildApprovalOwnerKey(requestedBy, telegramContext);

  let candidates = queryText ? findApprovalTokenCandidatesFn(queryText) : allPending;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      token: '',
      row: null,
      candidates: [],
      matchedByRequester: false,
    };
  }

  candidates = sortPendingApprovalsNewestFirstFn(candidates);
  if (!ownerKey || ownerKey === 'unknown') {
    const row = candidates[0] || null;
    return {
      token: String((row && row.id) || '').trim(),
      row,
      candidates,
      matchedByRequester: false,
    };
  }

  const scoped = candidates.filter((row) => String((row && row.requested_by) || '').trim() === ownerKey);
  if (scoped.length > 0) {
    const row = scoped[0];
    return {
      token: String((row && row.id) || '').trim(),
      row,
      candidates: scoped,
      matchedByRequester: true,
    };
  }

  const row = candidates[0] || null;
  return {
    token: String((row && row.id) || '').trim(),
    row,
    candidates,
    matchedByRequester: false,
  };
}

function mergeUniqueLower(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of (Array.isArray(items) ? items : [])) {
    const key = String(item || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function resolveApprovalFlagsForToken(token = '', providedFlags = [], deps = {}) {
  const mergedProvided = mergeUniqueLower(providedFlags);
  const key = String(token || '').trim();
  if (!key) return mergedProvided;
  const readPendingToken = typeof deps.readPendingToken === 'function'
    ? deps.readPendingToken
    : () => null;
  let required = [];
  try {
    const pending = readPendingToken(key);
    required = mergeUniqueLower(pending && pending.required_flags ? pending.required_flags : []);
  } catch (_) {
    required = [];
  }
  return mergeUniqueLower([...required, ...mergedProvided]);
}

module.exports = {
  readLastApprovalHints,
  writeLastApprovalHints,
  buildApprovalOwnerKey,
  rememberLastApprovalHint,
  readLastApprovalHint,
  clearLastApprovalHint,
  hasAnyApprovalHint,
  findPendingApprovalByRequestId,
  resolveApprovalTokenFromHint,
  findApprovalTokenCandidates,
  sortPendingApprovalsNewestFirst,
  resolveApprovalTokenSelection,
  mergeUniqueLower,
  resolveApprovalFlagsForToken,
};
