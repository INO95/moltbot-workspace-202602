# bot-research Runbook (MVP)

## Scope
- Profile: `research`
- Container: `moltbot-research`
- Log root: `logs/bot-research/`

## First Checks
1. Verify `latest.json` exists and reflects the latest run.
2. Confirm heartbeat is active during long jobs.
3. Compare recent `error.fingerprint` values for streak detection.

## Common Actions
1. For repeated upstream failures (503/429), apply temporary backoff.
2. For scheduler silence, verify cron invocation and bridge command intake.
3. For schema violations, patch producer fields and validate with `schema/log_schema_v1.json`.

## Escalation
- 3 consecutive errors on same fingerprint should trigger P2 alert path.
