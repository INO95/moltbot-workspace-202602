const ALLOWED_REASONING = new Set(['low', 'medium', 'high']);
const HIGH_REASONING_MARKERS = [
  /\bdeploy(?:ment)?\b/i,
  /\brelease\b/i,
  /\bdelete\b/i,
  /\bdestructive\b/i,
  /\bmigration\b/i,
  /\bschema\b/i,
  /\bauth(?:entication|orization)?\b/i,
  /\bsecurity\b/i,
  /\bpayment\b/i,
  /\barchitecture\b/i,
  /\brefactor\b/i,
  /\bcomplex\b/i,
  /\brm\s+-rf\b/i,
  /배포/,
  /출시/,
  /삭제/,
  /파기/,
  /마이그레이션/,
  /스키마/,
  /인증/,
  /보안/,
  /결제/,
  /아키텍처/,
  /리팩터/,
  /대규모/,
  /복잡/,
  /심층/,
  /깊게/,
];

const OAUTH_ROUTE_MODEL_POLICY = Object.freeze({
  work: Object.freeze({
    preferredModelAlias: 'codex',
    preferredReasoning: 'medium',
  }),
  inspect: Object.freeze({
    preferredModelAlias: 'codex',
    preferredReasoning: 'medium',
  }),
  deploy: Object.freeze({
    preferredModelAlias: 'codex',
    preferredReasoning: 'high',
  }),
  project: Object.freeze({
    preferredModelAlias: 'gpt',
    preferredReasoning: 'low',
  }),
});

function normalizeReasoningForPlatform(value, fallback = 'high') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'xhigh') return 'high';
  if (ALLOWED_REASONING.has(raw)) return raw;

  const fallbackRaw = String(fallback || '').trim().toLowerCase();
  if (fallbackRaw === 'xhigh') return 'high';
  if (ALLOWED_REASONING.has(fallbackRaw)) return fallbackRaw;
  return 'high';
}

function resolveOauthRouteModelPolicy(route, options = {}) {
  const key = String(route || '').trim().toLowerCase();
  const seeded = OAUTH_ROUTE_MODEL_POLICY[key] || OAUTH_ROUTE_MODEL_POLICY.work;
  const degraded = Boolean(options.degraded && options.degraded.enabled);
  const commandText = String(options.commandText || options.payload || '').trim();
  const shouldEscalate = (key === 'work' || key === 'inspect')
    && HIGH_REASONING_MARKERS.some((pattern) => pattern.test(commandText));
  const targetReasoning = shouldEscalate
    ? 'high'
    : (options.preferredReasoning || seeded.preferredReasoning);

  return {
    preferredModelAlias: degraded ? 'gpt' : seeded.preferredModelAlias,
    preferredReasoning: normalizeReasoningForPlatform(
      targetReasoning,
      seeded.preferredReasoning,
    ),
  };
}

module.exports = {
  OAUTH_ROUTE_MODEL_POLICY,
  normalizeReasoningForPlatform,
  resolveOauthRouteModelPolicy,
};
