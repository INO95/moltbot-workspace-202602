# User Operating Policy (BAEK INHO)

Last updated: 2026-02-08

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

## Model routing policy
- Default low-cost path: `google/gemini-3-flash-preview` (daily chat, routine updates).
- Complex work path: `openai-codex/gpt-5.2` via `작업:` prefix when deeper reasoning/precision is needed.
- If codex OAuth is unavailable, fall back to Gemini and mark result as degraded confidence.
