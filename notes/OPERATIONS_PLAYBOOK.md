# Moltbot Operations Playbook

Last updated: 2026-02-17

## Telegram input pattern
- `단어: <영단어 [뜻]>`
- `작업: <요청/대상/완료기준>`
- `점검: <대상/체크항목>`
- `배포: <대상/환경/검증>`
- `프로젝트: <프로젝트명/목표/스택/경로/완료기준>`
- `프롬프트: <요청>`
- `가계: <지출/수입/통계/목록>`
- `투두: <추가/완료/삭제/목록>`
- `루틴: <등록/체크/요약>`
- `운동: <기록/통계/목록>`
- `콘텐츠: <V1 태그 캡처>`
- `식당: <V1 태그 캡처>`

## Local bridge commands
- `node scripts/bridge.js auto "<message>"`
- `node scripts/openclaw_codex_sync.js [--restart]`
- `node scripts/ag_bridge_client.js --duel "<work command>"`
- `node scripts/ag_bridge_client.js --duel --allow-unstructured-critique "<work command>"` (legacy fallback)
- `node scripts/codex_oauth_translate.js --target "Japanese|English" --title "<title>" --content "<markdown>"`
- `node scripts/model_routing_report.js`
- `node scripts/model_cost_latency_dashboard.js`
- `node scripts/model_duel_report.js`
- `node scripts/oai_api_lane_toggle.js status|enable|disable`
- `node scripts/test_ag_bridge_duel_live_harness.js` (E2E dry-run harness)
- `node scripts/personal_migrate_legacy.js --apply` (legacy import)
- `node scripts/personal_retention.js --apply --days 90` (raw_text TTL purge)
- `node scripts/notion_personal_sync.js prepare`
- `node scripts/notion_personal_sync.js apply --batch <batchId> --approval <token>`
- `node scripts/notion_personal_sync_scheduler.js prepare` (prepare + Telegram notify)
- `npm run -s test:v1-release` (bridge + personal V1 full regression)
- Personal Notion env (separate integration):
  - `NOTION_PERSONAL_API_KEY`
  - `NOTION_PERSONAL_DB_ID` (or fallback `NOTION_LOG_DATABASE_ID`)
- Scheduled policy:
  - `prepare` runs twice daily (`09:05`, `21:05`, Asia/Tokyo) and sends approval token via bridge notify.
  - `apply` stays manual approval-only (`node scripts/notion_personal_sync.js apply --batch <id> --approval <token>`).

## Bridge command allowlist
- Enforced in `scripts/bridge.js` for both direct commands and `auto` routes.
- Config source: `data/config.json -> commandAllowlist`.
- Current safe-default direct allowlist:
  - `auto`, `work`, `inspect`, `deploy`, `project`, `ops`, `word`, `news`, `prompt`, `finance`, `todo`, `routine`, `workout`, `media`, `place`
- Current safe-default auto route allowlist:
  - `word`, `memo`, `news`, `report`, `work`, `inspect`, `deploy`, `project`, `prompt`, `link`, `status`, `ops`, `finance`, `todo`, `routine`, `workout`, `media`, `place`
- Default blocked direct commands:
  - `checklist`, `summary`, `anki`
- Runtime overrides (temporary ops use):
  - `BRIDGE_ALLOWLIST_ENABLED=true|false`
  - `BRIDGE_ALLOWLIST_DIRECT_COMMANDS=auto,work,...`
  - `BRIDGE_ALLOWLIST_AUTO_ROUTES=link,status,...`
- Invalid or empty allowlist config/ENV falls back to safe defaults and response includes `allowlistWarning`.

## OAI API lanes
- `oauth-codex`:
  - default for `work/inspect/deploy/prompt/report`
  - requires OpenClaw OAuth profile login (`openai-codex`)
- `api-key-openai`:
  - for API-key-only workflows (`responses/realtime/batch/webhook` style tasks)
  - currently disabled by policy (`enableApiKeyLane=false`)
  - later enable 시에도 `MOLTBOT_ALLOW_PAID_API=true` 없으면 차단
- `local-only`:
  - `word/news/status/link/ops/finance/todo/routine/workout/media/place` and non-model routine commands
- Activation checklist: `notes/API_KEY_LANE_ENABLE_CHECKLIST.md`

## Template override
- `작업/점검/배포` optional field: `API: auto|oauth|key`
- Examples:
  - `작업: 요청: ...; 대상: ...; 완료기준: ...; API: oauth`
  - `작업: 요청: realtime token endpoint 구성; 대상: ...; 완료기준: ...; API: key`

## OpenClaw container isolation (strict)
- Invariants:
  - OpenClaw runs only in containers (live: `moltbot-dev`, `moltbot-anki`, `moltbot-research`, `moltbot-daily`; backup: `moltbot-*-bak`).
  - Only workspace bind mount is allowed for OpenClaw services.
  - `.env` inside workspace is forbidden (container startup guard blocks it).
  - OpenClaw ports are bound to `127.0.0.1` only.
  - OpenClaw containers run with hardened runtime flags:
    - `cap_drop: [ALL]`
    - `security_opt: ["no-new-privileges:true"]`
    - `read_only: true` + `tmpfs: /tmp`
- Runtime env file:
  - Preferred: `$HOME/.config/moltbot/runtime.env`
  - Override: `MOLTBOT_ENV_FILE=/abs/path/to/runtime.env`
  - Legacy root `.env` is temporary fallback only and logs a warning.
- One-time migration:
  - `npm run -s env:migrate-runtime`
- Container lifecycle:
  - `npm run -s openclaw:up`
  - `npm run -s openclaw:down`
  - `npm run -s openclaw:up:backup` (failover/manual test only)
  - `npm run -s openclaw:down:backup`
- Node execution policy (exec approvals):
  - `node` binary execution is allowlisted.
  - `npm`/`npx` are intentionally not allowlisted.
  - Result: dependency install or package manager commands are handled via `ask=on-miss` approval prompt, and denied if approval cannot be obtained (`askFallback=deny`).

## Role routing
- Live role mapping:
  - `dev`(개발): `work,inspect,deploy,project,ops,status,link`
  - `anki`(안키): `word`
  - `research`(리서쳐): `news,report,prompt`
  - `daily`(일상): 허브 단일 진입점 (`word/news/report/work/inspect/deploy/project/prompt` 투명 위임, `ops/status/link/memo/finance/todo/routine/workout/media/place` 로컬 처리)
- Tech trend report cron is pinned to researcher bot target:
  - `NEWS_TELEGRAM_TARGET=research`

## Daily hub delegation
- `data/config.json -> hubDelegation` 기준으로 daily가 역할 봇으로 자동 위임합니다.
- 기본 위임 맵:
  - `work/inspect/deploy/project/prompt -> dev`
  - `word -> anki`
  - `news/report -> research`
  - `ops/status/link/memo/finance/todo/routine/workout/media/place -> daily(local)`
- 위임 경로는 `capability: bot:dispatch`로 큐잉되며, 결과는 역할 봇 `telegramReply`를 그대로 회신합니다.
- 고위험 액션(파일 제어, mail:send, photo:cleanup, schedule:delete)은 기존 approval token 흐름을 유지합니다.

## Daily health policy (v2)
- `ops/config/daily_ops_mvp.json -> health_policy` 적용:
  - `bot_down`은 heartbeat 단독이 아니라 `container state + telemetry + telegram channel` 합성 판정.
  - `idle/stale`는 `WARN/UNKNOWN`, 실제 정지/통신불능만 `DOWN(P1)`.
  - `no_signal`은 telegram fallback이 건강하면 suppress되고 `UNKNOWN` 강제 덮어쓰기 금지.
- `ops/config/remediation_policy.json`의 `defaults.rearm_on_recovery=true`로 복구 후 자동복구 시도 횟수 재무장전.

## Cron noise policy
- `private-sync*` 같은 비핵심 잡은 `scripts/cron_guard.js` dedupe/cooldown 집계로 동일 실패 반복 노이즈를 줄입니다.
- `noise`로 분류된 잡은 기본값으로 브리지/텔레그램 전송을 막고 로컬 로그만 남깁니다.
  - 필요할 때만 `CRON_GUARD_DELIVER_NOISE_ALERTS=1`로 재활성화합니다.
- 운영 우선순위는 `bot_down`, `telegram_auth_invalid`, `telegram_channel_exited`를 우선 확인합니다.

## Redaction check
- 토큰/민감값 로그 점검 순서:
  1. `npm run -s test:ops` (redaction 테스트 포함)
  2. `rg -n "(OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|OPENCLAW_GATEWAY_TOKEN|Bearer\\s+)" logs ops --hidden`
  3. 필요 시 `npm run -s openclaw:secrets:redact` 재적용

## Secret incident response
- Rotate gateway tokens:
  - `npm run -s openclaw:rotate:apply`
- Re-apply container config secrets:
  - `npm run -s openclaw:secrets:inject`
- Verify isolation guard:
  - `npm run -s check:container-isolation-refs`
- Check GitHub secret scanning alerts:
  - `gh api -H 'Accept: application/vnd.github+json' 'repos/INO95/moltbot-workspace-202602/secret-scanning/alerts?state=open'`
- If `telegram_bot_token` leak is detected, rotate token in BotFather first, then update `$HOME/.config/moltbot/runtime.env`.

## Bridge queue
- Primary queue log: `data/bridge/inbox.jsonl` (append-only)
- Compatibility snapshot: `data/bridge/inbox.json` (latest task only)
- Every enqueued payload includes compact `ackId` for traceability.
- `ag_bridge_client`, `daily_telegram_digest`, and `morning_briefing` enqueue to both.

## File control queue (host runner)
- New command outbox:
  - `ops/commands/outbox/*.json` (Daily/bridge writes)
  - Schema fields:
    - `schema_version`, `request_id`, `phase(plan|execute)`, `intent_action`, `requested_by`, `telegram_context`, `payload`, `created_at`
- Worker state:
  - `ops/commands/state/pending/*.json` (approval tokens)
  - `ops/commands/state/consumed/*.json` (consumed tokens / replay guard)
  - `ops/commands/state/processing/*.processing` (claim lock)
  - `ops/commands/state/completed/*` (processed artifacts)
- Append-only audit:
  - `ops/commands/results.jsonl`
  - Result fields:
    - `request_id`, `token_id`, `requested_by`, `phase`, `plan_summary`, `executed_steps`, `file_counts`, `hashes`, `rollback_instructions`, `ok`, `error_code`, `finished_at`

## File control safety gates
- Flow:
  - `PLAN`: dry-run plan + risk classification + token issuance (TTL 120~300s, default 180s)
  - `EXECUTE`: only after `APPROVE <token>` + required flags
- Risk tiers:
  - `MEDIUM`: `~/Downloads`, `~/Desktop` (single approval)
  - `HIGH`: `~/Documents`, `~/Library/Mobile Documents/com~apple~CloudDocs` (`--force`)
  - `HIGH_PRECHECK`: `/Volumes/**` (`--force` + mounted/writable/free-space preflight)
  - `GIT_AWARE`: git-aware actions only (`--force`, and `git_push` adds `--push`)
- Hard blocks:
  - `.git/**` path target 금지
  - allowed root 바깥 경로 금지
  - symlink/realpath escape 금지
  - direct delete 금지 (`trash`만 허용)

## Rollback procedure
- move/rename/archive:
  - result의 inverse mapping(`rollback_instructions`) 실행
- trash:
  - `~/.assistant_trash/<timestamp>/manifest.json` 기준 복구
- git:
  - not pushed: `git reset --soft HEAD~1`
  - pushed/shared: `git revert <commit>` (권장)

## Model duel log
- Protocol doc: `notes/MODEL_DUEL_PROTOCOL.md`
- Primary log: `data/bridge/model_duel.jsonl` (append-only JSONL)
- Writer lock: `data/locks/model_duel.lock`
- Default mode: 2-pass (`draft -> critique -> revision -> final`, maxRounds=1, timeout=120s)
- Critique exchange: Antigravity is requested with `[DUEL_CRITIQUE_REQUEST:v1]` and should return strict JSON (`content/rubric/issues`)

## GitHub and blog
- Prerequisite: GitHub CLI (`gh`) installed and authenticated.
- Repo planning: `node scripts/github_repo_manager.js plan <project-name>`
- Safe local commit: `node scripts/github_repo_manager.js commit "<message>"`
- Public auto-commit policy file: `policies/public_publish_policy.json`
- Private repo bootstrap: `node scripts/private_repo_split.js bootstrap`
- Private repo sync: `node scripts/private_repo_split.js sync`
- Blog draft from reports: `node scripts/blog_publish_from_reports.js`
- Blog dry-run only (no deploy): `node scripts/blog_publish_from_reports.js --dry-run`
- Blog skip-window test: `node scripts/blog_publish_from_reports.js --hours 1 --no-deploy`
- Blog translation path uses OpenClaw Codex OAuth (`openai-codex`) with high thinking.
- Translator acquires a lock and restores the previous default model after each translation run.
- `main` branch protection is configured to require `gitleaks` and `trufflehog` checks.

## Budget guard
- Default paid API budget: `0 JPY`.
- API-key lane stays blocked unless user explicitly approves and sets:
- First, enable lane in `data/oai_api_routing_policy.json` (`guards.enableApiKeyLane=true`)
- Then approve paid API:
  - `MOLTBOT_ALLOW_PAID_API=true`
- For ChatGPT Plus path (`openai-codex`), complete OAuth once in OpenClaw:
  - `docker exec -it moltbot-dev node dist/index.js configure --section model`
  - After login, sync auth to live bots:
  - `npm run -s openclaw:auth:sync`
  - Include backup profiles too (optional):
  - `npm run -s openclaw:auth:sync:all`
