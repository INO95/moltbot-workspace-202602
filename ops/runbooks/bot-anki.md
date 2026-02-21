# bot-anki Runbook (MVP)

## Scope
- Profile: `anki`
- Container: `moltbot-anki`
- Log root: `logs/bot-anki/`

## First Checks
1. Validate `latest.json` and `heartbeat.json` freshness.
2. Inspect latest `retry` and `end` events for recurring fingerprints.
3. Check if failures are transient (`429/503/timeout`) or permanent input/data issues.

## Common Actions
1. Confirm dependencies (Anki/API endpoints) are reachable.
2. If retries exhausted, reduce concurrency and rerun once.
3. Validate no secrets/PII are included in message/error fields.

## Escalation
- Any secret leakage or permission breach is P1.
