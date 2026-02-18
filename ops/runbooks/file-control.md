# File Control Runbook

Last updated: 2026-02-16

## Scope
Host-executed Telegram file control (A+B+C+D):
- Personal files (`~`)
- iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs`)
- External drives (`/Volumes/**`)
- Git-aware repo actions

## Command flow
1. PLAN enqueue (dry-run):
   - `ops/commands/outbox/*.json` with `phase=plan`
2. Worker computes risk/paths + emits token:
   - Token record: `ops/commands/state/pending/<token>.json`
3. APPROVE enqueue:
   - `APPROVE <token> [--force] [--push]`
   - Bridge writes `phase=execute`
4. Worker validates token/requester/flags and executes
5. Audit append:
   - `ops/commands/results.jsonl`

## Safety gates
- No direct delete: delete-like actions go to `~/.assistant_trash/<timestamp>/`
- `.git/**` direct path targeting is blocked
- Symlink escape blocked by realpath checks
- `/Volumes/**` requires preflight (`mounted`, `writable`, `free space >= minFreeBytes`)
- `git_push` requires both `--force --push`

## Common failures
- `TOKEN_EXPIRED`:
  - Token TTL elapsed (default 180 seconds)
  - Action: run PLAN again and use fresh token
- `TOKEN_CONSUMED`:
  - Token replay attempt
  - Action: run PLAN again
- `REQUESTER_MISMATCH`:
  - APPROVE requester differs from PLAN requester
  - Action: approve from same Telegram user ID
- `PLAN_MISMATCH`:
  - Path/state drift between PLAN and EXECUTE
  - Action: re-run PLAN and approve new token
- `TELEGRAM_USER_NOT_ALLOWED` / `TELEGRAM_GROUP_NOT_ALLOWED`:
  - Bridge allowlist violation
  - Action: update `data/config.json` policy or use allowed channel/user
- `DRIVE_PREFLIGHT_FAILED`:
  - External drive missing/read-only/space low
  - Action: mount drive, ensure writable, free up space

## Recovery
- move/rename/archive: use `rollback_instructions` from results row
- trash: restore from `manifest.json` under trash session directory
- git:
  - not pushed: `git -C <repo> reset --soft HEAD~1`
  - pushed/shared: `git -C <repo> revert <commit>`

## Audit checklist
- Confirm `requested_by` and `token_id` exist in `ops/commands/results.jsonl`
- Verify `phase` sequence (`plan` -> `execute`)
- Verify `file_counts` and `hashes` entries for mutating actions
- Verify rollback instructions are present for reversible actions
