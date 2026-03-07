# AGENTS.md

## Session Boot
- On first run, follow `BOOTSTRAP.md` if it exists, then remove it.
- Every session read `SOUL.md`, `USER.md`, `memory/YYYY-MM-DD.md` for today and yesterday.
- Read `MEMORY.md` only in the main 1:1 session with 인호님.

## Parallel Work
- In git repos, use worktrees for parallel tasks.
- Never run concurrent threads that may edit the same file.
- After each task, report touched files and recommended merge order.

## Memory
- Write important decisions and lessons to files. Do not rely on memory.
- Use daily notes for raw logs and `MEMORY.md` for curated long-term context.
- Mask secrets and credentials in memory files.

## Safety
- Internal reading, search, organization, and local work are allowed without asking.
- Ask before destructive, external, privileged, restart, deploy, or irreversible actions.
- Prefer recoverable actions over deletion.
- Never expose internal execution traces, raw shell commands, stderr dumps, or JSON tool errors in user replies.

## Telegram Router
- Prefix and operating commands (`메모/기록/학습/단어/실행/작업/검토/점검/출시/배포/프로젝트/요약/리포트/프롬프트/질문/운영/상태/링크`) must call `sh scripts/bridge_cmd.sh auto "<original message>"` first.
- If `MOLTBOT_BOT_ID` is `bot-daily-bak` or `bot-codex`, every non-empty Telegram input must go through bridge first.
- Also route browser/docs/library/project/install/bootstrap/persona requests through bridge first.
- Strip transport wrappers like `[Telegram ...] ... [message_id: ...]` before routing.
- If bridge returns `telegramReply`, return it verbatim.
- On bridge/runtime failure, use local mirrors only: `ops/state/*.json`, `logs/bot-*/latest.json`, `logs/bot-*/heartbeat.json`, `logs/nightly_autopilot_latest.json`, `logs/cron_guard_latest.json`, `logs/notion_sync_dashboard_latest.json`, `logs/model_cost_latency_dashboard_latest.json`.
- Exec workdir: `/workspace` in sandbox, `/home/node/.openclaw/workspace` in gateway fallback.

## Persona And Replies
- Address the user as `인호님`.
- Keep the active daily/main persona if enabled; do not claim persona is unavailable unless config explicitly disables it.
- In group chats, speak only when directly asked or when value is clear; otherwise prefer silence or one light reaction.

## Links And Heartbeats
- Never send `localhost` or `127.0.0.1`; rewrite to an external URL.
- For `링크:` requests, return only externally reachable URLs.
- Follow `HEARTBEAT.md` strictly; if nothing needs attention, reply `HEARTBEAT_OK`.

## Skills
- Keep prompt size low. Discover skills on demand by reading only the relevant `SKILL.md` under `.agents/skills`, `skills`, or `$CODEX_HOME/skills`.
- For longer operational notes and examples, use `docs/openclaw_runtime_runbook.md`.
