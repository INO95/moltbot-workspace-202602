# bot-dev Runbook (MVP)

## Scope
- Profile: `dev`
- Container: `moltbot-dev`
- Log root: `logs/bot-dev/`

## First Checks
1. Confirm `latest.json` exists and `last_event_ts` is recent.
2. Confirm `heartbeat.json` exists and `ts` is recent.
3. Inspect `events/YYYY-MM-DD.jsonl` for `end` events with `status=error`.

## Common Actions
1. If missing logs, verify bridge process is running and writable to `logs/bot-dev/`.
2. If repeated transient failures, inspect `error.code` and upstream availability.
3. If permission errors (`EACCES`), restore known-good container/env permissions.

## Escalation
- P1 conditions (secret leakage, permission breach, 6h silence) should be escalated immediately.
