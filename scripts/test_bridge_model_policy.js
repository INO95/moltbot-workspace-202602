const assert = require('assert');
const { handleAutoRoutedCommand } = require('./lib/bridge_auto_routes');
const { handleDirectBridgeCommand } = require('./lib/bridge_direct_commands');

function pickPreferredModelMeta(source, fallbackAlias, fallbackReasoning) {
  return {
    preferredModelAlias: String((source && source.preferredModelAlias) || fallbackAlias),
    preferredReasoning: String((source && source.preferredReasoning) || fallbackReasoning),
  };
}

function buildDeps() {
  return {
    parseStructuredCommand: (route, payload) => ({
      ok: true,
      route,
      payload,
      telegramReply: `${route}:${payload}`,
      fields: { payload },
    }),
    appendExternalLinks: (text) => text,
    buildCodexDegradedMeta: () => ({ enabled: false }),
    buildDuelModeMeta: () => ({ enabled: true }),
    withApiMeta: (output) => output,
    buildProjectRoutePayload: (parsed) => ({ success: true, project: parsed.payload }),
    parseTransportEnvelopeContext: () => ({}),
    runOpsCommand: () => ({ success: true }),
    handlePersonalRoute: async (route) => ({ route, success: true }),
    processWordTokens: async (text) => ({ success: true, word: text }),
    normalizeNewsCommandPayload: (text) => text,
    pickPreferredModelMeta,
    handlePromptPayload: (text) => ({ success: true, prompt: text }),
    handleMemoCommand: async (text) => ({ success: true, telegramReply: text }),
    handleNewsCommand: async () => ({ success: true, preferredModelAlias: 'fast', preferredReasoning: 'low' }),
    normalizeReportNewsPayload: (text) => text,
    publishFromReports: async () => ({ success: true }),
    buildWeeklyReport: async () => ({ success: true }),
    buildDailySummary: async () => ({ success: true }),
    isResearchRuntime: () => false,
    buildQuickStatusReply: () => 'ok',
    buildLinkOnlyReply: () => 'https://example.com',
    inferPathListReply: () => '',
    buildGogNoPrefixGuide: () => '',
    buildNoPrefixReply: () => 'skip',
    engine: {
      recordActivity: async () => ({ ok: true }),
      getTodaySummary: async () => ({ ok: true }),
    },
    anki: {
      addCard: async () => ({ noteId: 1 }),
      getDeckNames: async () => ['TOEIC_AI'],
    },
    config: {},
  };
}

async function main() {
  const deps = buildDeps();

  const autoWork = await handleAutoRoutedCommand({
    routed: { route: 'work', payload: '요청: 코드 정리' },
    fullText: '작업: 요청: 코드 정리',
  }, deps);
  assert.strictEqual(autoWork.preferredModelAlias, 'codex');
  assert.strictEqual(autoWork.preferredReasoning, 'medium');

  const autoEscalated = await handleAutoRoutedCommand({
    routed: { route: 'inspect', payload: '배포 release 전 auth migration schema 점검' },
    fullText: '검토: 배포 release 전 auth migration schema 점검',
  }, deps);
  assert.strictEqual(autoEscalated.preferredModelAlias, 'codex');
  assert.strictEqual(autoEscalated.preferredReasoning, 'high');

  const autoProject = await handleAutoRoutedCommand({
    routed: { route: 'project', payload: '새 프로젝트' },
    fullText: '프로젝트: 새 프로젝트',
  }, deps);
  assert.strictEqual(autoProject.preferredModelAlias, 'gpt');
  assert.strictEqual(autoProject.preferredReasoning, 'low');

  const autoPrompt = await handleAutoRoutedCommand({
    routed: { route: 'prompt', payload: '문구 다듬기' },
    fullText: '프롬프트: 문구 다듬기',
  }, deps);
  assert.strictEqual(autoPrompt.preferredModelAlias, 'gpt');
  assert.strictEqual(autoPrompt.preferredReasoning, 'low');

  const autoWord = await handleAutoRoutedCommand({
    routed: { route: 'word', payload: 'apple' },
    fullText: '단어: apple',
  }, deps);
  assert.strictEqual(autoWord.preferredModelAlias, 'fast');
  assert.strictEqual(autoWord.preferredReasoning, 'low');

  const directWork = await handleDirectBridgeCommand({
    normalizedCommand: 'work',
    fullText: '요청: 로그 정리 검토',
    toeicDeck: 'TOEIC_AI',
    toeicTags: [],
  }, deps);
  assert.strictEqual(directWork.handled, true);
  assert.strictEqual(directWork.output.preferredModelAlias, 'codex');
  assert.strictEqual(directWork.output.preferredReasoning, 'medium');

  const directEscalated = await handleDirectBridgeCommand({
    normalizedCommand: 'work',
    fullText: '결제 payment auth security migration 작업',
    toeicDeck: 'TOEIC_AI',
    toeicTags: [],
  }, deps);
  assert.strictEqual(directEscalated.output.preferredReasoning, 'high');

  const directProject = await handleDirectBridgeCommand({
    normalizedCommand: 'project',
    fullText: '새 프로젝트 만들기',
    toeicDeck: 'TOEIC_AI',
    toeicTags: [],
  }, deps);
  assert.strictEqual(directProject.output.preferredModelAlias, 'gpt');
  assert.strictEqual(directProject.output.preferredReasoning, 'low');

  const directPrompt = await handleDirectBridgeCommand({
    normalizedCommand: 'prompt',
    fullText: '문장 다듬기',
    toeicDeck: 'TOEIC_AI',
    toeicTags: [],
  }, deps);
  assert.strictEqual(directPrompt.output.preferredModelAlias, 'gpt');
  assert.strictEqual(directPrompt.output.preferredReasoning, 'low');

  const directWord = await handleDirectBridgeCommand({
    normalizedCommand: 'word',
    fullText: 'banana',
    toeicDeck: 'TOEIC_AI',
    toeicTags: [],
  }, deps);
  assert.strictEqual(directWord.output.preferredModelAlias, 'fast');
  assert.strictEqual(directWord.output.preferredReasoning, 'low');

  console.log('test_bridge_model_policy: ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
