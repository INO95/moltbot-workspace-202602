# OpenClaw Routing Guide (Moltbot)

## Current strategy

- Default: `openai-codex/gpt-5.1-codex-mini` (`fast`)
- Deep/complex route: `openai-codex/gpt-5.2-codex` (`deep`, `codex`)
- Fallback (failover): `openai-codex/gpt-5.2` -> `openai-codex/gpt-5.1`
- Budget policy default: monthly paid API budget is `0 JPY`; direct API-key spend stays disabled by default.
- Fallback runs only on provider/auth/rate-limit/timeout failures.
- Routing policy is OpenAI-only; Gemini fallback is disabled.

## Manual model switch (recommended for task complexity)

- Fast tasks (Anki, checklist, simple spend logs): `/model fast`
- High-accuracy design/review tasks: `/model deep`
- GPT usage: `/model gpt` or `/model codex`
- If using paid API models, explicitly approve first and enable `MOLTBOT_ALLOW_PAID_API=true`.
- `openai-codex` route requires OAuth login in OpenClaw auth profiles before first use.
- Check current model: `/model status`
- Show available models: `/model list`

## Why this setup

- `gpt-5.1-codex-mini` keeps routine interactions responsive.
- `gpt-5.2-codex` is reserved for complex reasoning/code accuracy.
- A single-provider policy removes cross-provider drift and simplifies ops.

## Security checklist

- Container isolation invariants:
  - OpenClaw services mount workspace only (`/home/node/.openclaw/workspace`).
  - OpenClaw runtime state is stored in named volumes (`openclaw_main_state`, `openclaw_sub1_state`).
  - `.env` in workspace is forbidden; use external runtime env file.
  - OpenClaw gateway ports bind to `127.0.0.1` only.
- Runtime env standard:
  - default path: `$HOME/.config/moltbot/runtime.env`
  - override: `MOLTBOT_ENV_FILE=/absolute/path/runtime.env`
  - root `.env` fallback is temporary compatibility mode only.
- Keep provider API keys in `auth-profiles.json` (ignored by git) or env vars.
- Prefer env vars for secrets: `OPENAI_API_KEY` (if direct API is enabled).
- Block Gemini/Google env injection in runtime compose config (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENCLAW_GEMINI_API_KEY`, `OPENCLAW_GOOGLE_API_KEY` = empty).
- For OpenAI/Codex subscription routing, login/paste token only if required by provider and avoid storing plain tokens in repo files.
- `openclaw.json` edits must be applied inside container (`docker exec`) rather than host `configs/...` direct edits.
- Keep `allowFrom` restricted to owner ID on Telegram.
- Do not commit session/auth files or `data/secure/*`.
