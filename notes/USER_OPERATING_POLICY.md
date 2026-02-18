# User Operating Policy (BAEK INHO)

Last updated: 2026-02-14

## Core principles
- Always ask for required missing information before irreversible decisions.
- Maximize efficiency and maintain security defaults.
- Prefer latest verified information for provider/platform behavior.
- Keep plans extensible and continuously suggest system improvements.

## Anki policy
- English vocabulary cards go to `TOEIC_AI` deck only.
- Non-vocabulary Anki workflows are untouched.

## API budget policy
- Default monthly paid API budget: `0 JPY`.
- Paid API usage requires explicit user approval first.

## GitHub / blog policy
- GitHub account: `INO95`
- Prefer public repositories by default.
- Blog post language priority: `Korean -> Japanese -> English`
- Publish when meaningful work/logs exist.
- Blog translation path: use `openai-codex` OAuth route first (no paid API key spend).

## Prefix recommendation
- `단어:` TOEIC vocabulary save
- `리포트:` report/blog trigger messages
- `작업:` complex/accuracy-critical requests (prefer `openai-codex/gpt-5.2` + high reasoning)
- `점검:` inspection/check requests
- `배포:` deploy/release requests
- `프롬프트:` prompt drafting/finalizing

## Model/API routing policy
- Provider baseline: OpenAI-only.
- Default complex-work lane: `oauth-codex` (`work/inspect/deploy/prompt/report`).
- API-key lane (`api-key-openai`) is currently disabled and reserved for future activation.
- When enabled later, use it only for API-key-specific workflows (`responses/realtime/batch/webhook`) and explicit `API:key` overrides.
- Local-only lane is preferred for routine routes (`word/news/status/link/ops`).
- If OAuth lane fails, suggest API-key lane as fallback option only; do not auto-switch without policy approval.
