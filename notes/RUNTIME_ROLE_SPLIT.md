# Runtime Role Split (Antigravity/OpenClaw vs Codex)

## Antigravity / OpenClaw (always-on)
- Telegram channel receiving
- Prefix routing (`단어:`, `작업:`, `점검:`, `배포:`, `리포트:`, `프롬프트:`)
- Scheduled jobs (briefing/digest/report/blog draft)
- Low-cost routine logging and notifications

## Codex (deep work / coding)
- Script and workflow implementation
- Refactor, audit, and review tasks
- Git-safe automation scaffolding
- System hardening and extensible architecture changes

## Escalation rule
- Routine low-risk operations stay on OpenClaw.
- Complex design/coding/debugging escalates to Codex.
- Paid API path requires explicit user approval (budget guard default 0 JPY).
