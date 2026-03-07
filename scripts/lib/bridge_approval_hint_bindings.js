function createApprovalHintBindings(core = {}, deps = {}) {
  const readLastApprovalHintsCore = core.readLastApprovalHintsCore;
  const writeLastApprovalHintsCore = core.writeLastApprovalHintsCore;
  const buildApprovalOwnerKeyCore = core.buildApprovalOwnerKeyCore;
  const rememberLastApprovalHintCore = core.rememberLastApprovalHintCore;
  const readLastApprovalHintCore = core.readLastApprovalHintCore;
  const clearLastApprovalHintCore = core.clearLastApprovalHintCore;
  const hasAnyApprovalHintCore = core.hasAnyApprovalHintCore;
  const findPendingApprovalByRequestIdCore = core.findPendingApprovalByRequestIdCore;
  const resolveApprovalTokenFromHintCore = core.resolveApprovalTokenFromHintCore;
  const findApprovalTokenCandidatesCore = core.findApprovalTokenCandidatesCore;
  const sortPendingApprovalsNewestFirstCore = core.sortPendingApprovalsNewestFirstCore;
  const resolveApprovalTokenSelectionCore = core.resolveApprovalTokenSelectionCore;
  const mergeUniqueLowerCore = core.mergeUniqueLowerCore;
  const resolveApprovalFlagsForTokenCore = core.resolveApprovalFlagsForTokenCore;

  const fsModule = deps.fsModule;
  const pathModule = deps.pathModule;
  const hintsPath = String(deps.hintsPath || '').trim();
  const readPendingApprovalsState = deps.readPendingApprovalsState;
  const readPendingToken = deps.readPendingToken;

  if (typeof readLastApprovalHintsCore !== 'function'
      || typeof writeLastApprovalHintsCore !== 'function'
      || typeof buildApprovalOwnerKeyCore !== 'function'
      || typeof rememberLastApprovalHintCore !== 'function'
      || typeof readLastApprovalHintCore !== 'function'
      || typeof clearLastApprovalHintCore !== 'function'
      || typeof hasAnyApprovalHintCore !== 'function'
      || typeof findPendingApprovalByRequestIdCore !== 'function'
      || typeof resolveApprovalTokenFromHintCore !== 'function'
      || typeof findApprovalTokenCandidatesCore !== 'function'
      || typeof sortPendingApprovalsNewestFirstCore !== 'function'
      || typeof resolveApprovalTokenSelectionCore !== 'function'
      || typeof mergeUniqueLowerCore !== 'function'
      || typeof resolveApprovalFlagsForTokenCore !== 'function') {
    throw new Error('createApprovalHintBindings requires complete core function set');
  }
  if (!fsModule || !pathModule || !hintsPath) {
    throw new Error('createApprovalHintBindings requires fsModule/pathModule/hintsPath');
  }
  if (typeof readPendingApprovalsState !== 'function' || typeof readPendingToken !== 'function') {
    throw new Error('createApprovalHintBindings requires readPendingApprovalsState/readPendingToken');
  }

  function readLastApprovalHints() {
    return readLastApprovalHintsCore({
      fsModule,
      hintsPath,
    });
  }

  function writeLastApprovalHints(hints = {}) {
    return writeLastApprovalHintsCore(hints, {
      fsModule,
      pathModule,
      hintsPath,
    });
  }

  function buildApprovalOwnerKey(requestedBy = '', telegramContext = null) {
    return buildApprovalOwnerKeyCore(requestedBy, telegramContext);
  }

  function rememberLastApprovalHint(payload = {}) {
    return rememberLastApprovalHintCore(payload, {
      readLastApprovalHints,
      writeLastApprovalHints,
    });
  }

  function readLastApprovalHint(requestedBy = '', telegramContext = null) {
    return readLastApprovalHintCore(requestedBy, telegramContext, {
      readLastApprovalHints,
    });
  }

  function clearLastApprovalHint(requestedBy = '', telegramContext = null) {
    return clearLastApprovalHintCore(requestedBy, telegramContext, {
      readLastApprovalHints,
      writeLastApprovalHints,
    });
  }

  function hasAnyApprovalHint() {
    return hasAnyApprovalHintCore({
      readLastApprovalHints,
    });
  }

  function findPendingApprovalByRequestId(requestId = '', rows = []) {
    return findPendingApprovalByRequestIdCore(requestId, rows);
  }

  function resolveApprovalTokenFromHint(requestedBy = '', telegramContext = null) {
    return resolveApprovalTokenFromHintCore(requestedBy, telegramContext, {
      readLastApprovalHint,
      readPendingApprovalsState,
    });
  }

  function findApprovalTokenCandidates(query = '') {
    return findApprovalTokenCandidatesCore(query, {
      readPendingApprovalsState,
    });
  }

  function sortPendingApprovalsNewestFirst(rows = []) {
    return sortPendingApprovalsNewestFirstCore(rows);
  }

  function resolveApprovalTokenSelection({
    query = '',
    requestedBy = '',
    telegramContext = null,
  } = {}) {
    return resolveApprovalTokenSelectionCore({
      query,
      requestedBy,
      telegramContext,
    }, {
      readPendingApprovalsState,
      findApprovalTokenCandidates,
      sortPendingApprovalsNewestFirst,
    });
  }

  function mergeUniqueLower(items = []) {
    return mergeUniqueLowerCore(items);
  }

  function resolveApprovalFlagsForToken(token = '', providedFlags = []) {
    return resolveApprovalFlagsForTokenCore(token, providedFlags, {
      readPendingToken,
    });
  }

  return {
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
}

module.exports = {
  createApprovalHintBindings,
};
