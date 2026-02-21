# OpenClaw Routing Guide (Moltbot)

Last updated: 2026-02-15

## Current strategy

- Model provider baseline: OpenAI only.
- OAuth lane (default): `openai-codex/*` via OpenClaw auth profile.
- API-key lane (conditional): official OpenAI API (`responses`, `realtime`, `batch/webhook` use-cases).
- Local-only lane: no external model call (`word/news/status/link/ops` route class).
- Telegram runtime split: live 4 (`dev/anki/research/daily`) + backup 4 (`*_bak`, cold standby).
- Budget policy default: monthly paid API budget is `0 JPY`.
- API-key lane is currently disabled by policy (`enableApiKeyLane=false`) and remains blocked unless explicitly enabled later.
- Even after enabling lane, paid API approval is still required (`MOLTBOT_ALLOW_PAID_API=true`).

## Route-to-lane defaults

- `work`: `oauth-codex`
- `inspect`: `oauth-codex`
- `deploy`: `oauth-codex`
- `project`: `oauth-codex`
- `prompt`: `oauth-codex`
- `report`: `oauth-codex` (simple aggregate report can downgrade to `local-only`)
- `word/news/status/link/ops/none`: `local-only`
- Tech trend report delivery (`news_digest send`) defaults to researcher target:
  - `NEWS_TELEGRAM_TARGET=research`
  - queue fallback default off (`NEWS_QUEUE_FALLBACK=0`)

## Override rules

- Manual override (template field): `API: auto|oauth|key`
- `API:key` forces `api-key-openai` lane.
- Invalid override value fails template validation.
- Feature override: realtime/webhook/batch-oriented requests can auto-switch to `api-key-openai`.
- Lane toggle helper: `node scripts/oai_api_lane_toggle.js status|enable|disable`

## Manual model switch

- Fast tasks: `/model fast`
- High-accuracy design/review tasks: `/model deep`
- GPT usage: `/model gpt` or `/model codex`
- Check current model: `/model status`
- Show available models: `/model list`

## Why this setup

- OAuth lane keeps complex work quality high without direct API-key spend by default.
- API-key lane is available for OpenAI APIs not covered by OAuth execution flow.
- Local-only lane keeps routine automation cheap and stable.

## Security checklist

- Container isolation invariants:
  - OpenClaw services mount workspace only (`/home/node/.openclaw/workspace`).
  - OpenClaw runtime state is stored in named volumes (live + backup profiles).
  - `.env` in workspace is forbidden; use external runtime env file.
  - OpenClaw gateway ports bind to `127.0.0.1` only.
  - OpenClaw containers must run with dropped Linux capabilities and no-new-privileges.
- Runtime env standard:
  - default path: `$HOME/.config/moltbot/runtime.env`
  - override: `MOLTBOT_ENV_FILE=/absolute/path/runtime.env`
  - root `.env` fallback is temporary compatibility mode only.
- Keep provider API keys in `auth-profiles.json` (ignored by git) or env vars.
- For OpenAI/Codex subscription routing, complete OAuth login once:
  - `docker exec moltbot-dev node dist/index.js models auth login --provider openai-codex`
- For API-key lane, export secrets via runtime env only (`OPENAI_API_KEY`); never commit to repo files.
- Block Gemini/Google env injection in runtime compose config (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENCLAW_GEMINI_API_KEY`, `OPENCLAW_GOOGLE_API_KEY` = empty).
- `openclaw.json` edits must be applied inside container (`docker exec`) rather than host `configs/...` direct edits.
- Keep `allowFrom` restricted to owner ID on Telegram.
- Do not commit session/auth files or `data/secure/*`.
- If a Telegram token is leaked, rotate in BotFather immediately and treat old token as compromised.
