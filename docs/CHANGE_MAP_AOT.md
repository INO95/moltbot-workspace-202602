# CHANGE_MAP_AOT

## Purpose
- Define exact edit points for Task 1 and Task 2:
  - persona injection
  - bot config
  - Telegram send boundary
  - approval gating
  - browser automation path
- Provide a safe rollback runbook for 24/7 runtime.
- Keep all follow-up changes idempotent.

## System Model
- Input: Telegram command / `auto` -> `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge_cmd.sh:60`
- Core Loop: `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js` (routing, normalization, queue enqueue)
- Value Engine: `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_file_control.js` + `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_approval_store.js`
- Feedback Loop: `/Users/moltbot/Projects/Moltbot_Workspace/ops/commands/results.jsonl`, `/Users/moltbot/Projects/Moltbot_Workspace/data/bridge/inbox.jsonl`
- Scaling Lever: `hubDelegation` + bot dispatch + live/backup container split

## Change Map
| Topic | Confirmed file/line | Recommended edit point |
|---|---|---|
| Persona definition | `/Users/moltbot/Projects/Moltbot_Workspace/data/config.json:148` | Keep `dailyPersona.profiles` as single source of truth |
| Persona engine | `/Users/moltbot/Projects/Moltbot_Workspace/scripts/daily_persona.js:144`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/daily_persona.js:572` | Only change normalize/apply logic here |
| Bridge persona injection | `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js:328`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js:334`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js:1806` | Keep persona injection at final reply boundary |
| Ops worker persona injection | `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_host_worker.js:57`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_host_worker.js:408` | Keep common styling for PLAN/EXECUTE replies |
| Bot runtime config | `/Users/moltbot/Projects/Moltbot_Workspace/docker-compose.yml:117`, `/Users/moltbot/Projects/Moltbot_Workspace/docker-compose.yml:202`, `/Users/moltbot/Projects/Moltbot_Workspace/docker-compose.yml:288` | Keep profile-specific `MOLTBOT_BOT_ID`, allowlist, Telegram env |
| Bot config template/injection | `/Users/moltbot/Projects/Moltbot_Workspace/configs/dev/openclaw.json:106`, `/Users/moltbot/Projects/Moltbot_Workspace/configs/anki/openclaw.json:127`, `/Users/moltbot/Projects/Moltbot_Workspace/configs/daily/openclaw.json:104`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/openclaw_config_secrets.js:242` | Use single entry point for in-container `openclaw.json` patch |
| Telegram finalization (bridge) | `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js:1591`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js:1806` | Fix boundary at `appendExternalLinks` + `withApiMeta` |
| Telegram finalization (worker) | `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_host_worker.js:421`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_host_worker.js:449`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_host_worker.js:680`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_host_worker.js:722`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge_queue.js:26` | Treat pre-enqueue/enqueue as single send boundary |
| Approval gate entry | `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js:1016`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js:1047`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js:1457` | Keep `APPROVE <token>` parsing and outbox enqueue path |
| Approval policy/execute | `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_file_control.js:10`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_file_control.js:741`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_file_control.js:946`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_file_control.js:973` | Preserve strict plan/revalidate/execute split |
| Approval token lifecycle | `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_approval_store.js:169`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_approval_store.js:208`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_approval_store.js:269` | Keep create/validate/consume in single module |
| Exec approvals | `/Users/moltbot/Projects/Moltbot_Workspace/configs/dev/exec-approvals.json:1`, `/Users/moltbot/Projects/Moltbot_Workspace/configs/anki/exec-approvals.json:1`, `/Users/moltbot/Projects/Moltbot_Workspace/configs/daily/exec-approvals.json:1` | Reflect runtime command security policy |
| Browser current status | `/Users/moltbot/Projects/Moltbot_Workspace/configs/dev/openclaw.json:106`, `/Users/moltbot/Projects/Moltbot_Workspace/configs/daily/openclaw.json:104`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/project_bootstrap.js:197`, `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_host_worker.js:50` | Browser config exists, capability execution path does not yet exist |

## Task 1 Edit Points
- Scope: persona + Telegram boundary hardening.
- Priority files:
  - `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js`
  - `/Users/moltbot/Projects/Moltbot_Workspace/scripts/daily_persona.js`
  - `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_host_worker.js`
  - `/Users/moltbot/Projects/Moltbot_Workspace/data/config.json`
- Guardrails:
  - Preserve one-way finalization order: raw reply -> link rewrite -> persona style -> api metadata.
  - Do not duplicate persona logic in route-specific handlers.
  - Keep behavior idempotent for repeated queue replay.

## Task 2 Edit Points
- Scope: approval/browser capability extension on central hooks.
- Priority files:
  - `/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js` (ops action/policy/payload normalization)
  - `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_host_worker.js` (`CAPABILITY_HANDLERS`)
  - `/Users/moltbot/Projects/Moltbot_Workspace/scripts/ops_file_control.js` (risk policy extension for capability actions)
  - new file: `/Users/moltbot/Projects/Moltbot_Workspace/scripts/capabilities/browser_manager.js`
- Browser interface draft:
  - `capability=browser`
  - `action in [open, list, click, type, wait, screenshot, checkout, post, send]`
  - Mutating actions (`checkout`, `post`, `send`) must set `requires_approval=true`.

## Safe Rollback (24/7)
1. Pre-snapshot before release
```bash
git rev-parse HEAD
npm run -s backup:openclaw
npm run -s backup:openclaw:verify
npm run -s openclaw:approvals:status
```

2. Deploy strategy
- Do not restart all containers at once.
- Restart only impacted containers in sequence.

3. Fast rollback
```bash
git revert <commit_sha>
npm run -s openclaw:secrets:inject
npm run -s openclaw:up
```

4. Approval anomaly rule
- On `APPROVAL_FLAGS_REQUIRED` or `PLAN_MISMATCH`:
  - stop execution
  - re-run PLAN
  - issue a new token

5. Queue safety checks
- Check failure accumulation in:
  - `/Users/moltbot/Projects/Moltbot_Workspace/data/bridge/inbox.jsonl`
  - `/Users/moltbot/Projects/Moltbot_Workspace/ops/commands/results.jsonl`

## Idempotency Rules
- Branch create/checkout must be idempotent:
```bash
git show-ref --verify --quiet refs/heads/codex/feat/openclaw-aot-roi && git checkout codex/feat/openclaw-aot-roi || git checkout -b codex/feat/openclaw-aot-roi
```
- Directory create must be idempotent:
```bash
mkdir -p /Users/moltbot/Projects/Moltbot_Workspace/docs
```
- Task 0 writes exactly one file:
  - `/Users/moltbot/Projects/Moltbot_Workspace/docs/CHANGE_MAP_AOT.md`
- No public API/interface changes in Task 0.

## Test/Restart/Telemetry
```bash
npm run -s test:bridge-hub-delegation
npm run -s test:bridge-ops-capability
npm run -s test:ops-file-control
npm run -s test:ops-capability
npm run -s test:ops
npm run -s openclaw:approvals:apply
npm run -s openclaw:approvals:status
npm run -s openclaw:secrets:inject
npm run -s openclaw:up
npm run -s ops:daily:health
npm run -s health:system
```

