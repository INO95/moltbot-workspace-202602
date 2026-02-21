# OAI API Lane Decision Table

Last updated: 2026-02-15 (JST)

## Default Policy
- Baseline: OAuth-only.
- `api-key-openai` lane is disabled by default in `data/oai_api_routing_policy.json`.
- Enabling API-key lane always requires explicit paid API approval (`MOLTBOT_ALLOW_PAID_API=true`).

## Route-to-Lane Defaults
| Route | Default Lane | Rationale |
|---|---|---|
| `work`, `inspect`, `deploy`, `prompt`, `report` | `oauth-codex` | High reasoning / coding reliability path |
| `word`, `news`, `status`, `link`, `ops`, `anki`, `none` | `local-only` | Low-cost automation / local tasks |

## When to Temporarily Use API-key Lane
- Use only for tasks that need capabilities unavailable on OAuth lane:
- Realtime API
- Webhook handlers
- Batch jobs
- Responses API integration testing

## Activation Checklist
1. Confirm current status: `npm run -s oai:lane:status`
2. Set runtime approvals:
   - `export MOLTBOT_ENABLE_API_KEY_LANE=true`
   - `export MOLTBOT_ALLOW_PAID_API=true`
   - `export OPENAI_API_KEY='<key>'`
3. Validate route behavior with a targeted bridge command.
4. Roll back after task completion:
   - `unset MOLTBOT_ENABLE_API_KEY_LANE MOLTBOT_ALLOW_PAID_API OPENAI_API_KEY`
   - `npm run -s oai:lane:disable`

## Cost/Safety Guardrails
- If `RATE_LIMIT_SAFE_MODE=true`, API-key lane remains blocked.
- Keep `monthlyApiBudgetYen=0` unless explicit budget change is approved.
- Never store API keys in repository files. Use runtime env file only.
