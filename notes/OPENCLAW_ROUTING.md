# OpenClaw Routing Guide (Moltbot)

## Current strategy

- Default: `google/gemini-3-flash-preview` (`fast`)
- Fallback (failover): `google/gemini-3-pro-preview` (`deep`) -> `openai-codex/gpt-5.2` (`codex`)
- Additional models enabled: `openai/gpt-5-mini` (`gptmini`), `openai/gpt-5.2` (`gpt`), `openai-codex/gpt-5.2` (`codex`)
- Budget policy default: monthly paid API budget is `0 JPY`, so OpenAI API fallback is disabled by default.
- Fallback runs only on provider/auth/rate-limit/timeout failures.
- Setting a ChatGPT web session token alone does not switch default routing unless the OpenClaw model/auth path is explicitly configured.

## Manual model switch (recommended for task complexity)

- Fast tasks (Anki, checklist, simple spend logs): `/model fast`
- High-accuracy design/review tasks: `/model deep`
- GPT usage: `/model gpt` or `/model codex`
- If using paid API models, explicitly approve first and enable `MOLTBOT_ALLOW_PAID_API=true`.
- `openai-codex` route requires OAuth login in OpenClaw auth profiles before first use.
- Check current model: `/model status`
- Show available models: `/model list`

## Why this setup

- Flash keeps routine interactions cheap and responsive.
- Pro is reserved for complex reasoning or when fallback is needed.
- This avoids running expensive models for every short message.

## Security checklist

- Keep provider API keys in `auth-profiles.json` (ignored by git) or env vars.
- Prefer env vars for secrets: `GEMINI_API_KEY`, `OPENAI_API_KEY`.
- For OpenAI/Codex subscription routing, login/paste token only if required by provider and avoid storing plain tokens in repo files.
- `openclaw.json` env substitution is strict; verify required vars are injected before switching to `${VAR}`.
- Keep `allowFrom` restricted to owner ID on Telegram.
- Do not commit session/auth files or `data/secure/*`.
