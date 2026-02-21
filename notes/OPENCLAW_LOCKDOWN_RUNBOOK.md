# OpenClaw Lockdown Runbook

Last updated: 2026-02-15 (JST)

## Scope
- Persona consistency (`민식이`/`인호`)
- Sandbox hardening (`mode=all`, `scope=session`)
- Exec approvals allowlist deployment
- Notion conversation staging automation
- OAI lane governance (OAuth-first)

## Apply Steps
1. Deploy exec approvals allowlist to running gateways:
   - `npm run -s openclaw:approvals:apply`
2. Verify approvals snapshot:
   - `npm run -s openclaw:approvals:status`
3. Reload crontab after edits:
   - `crontab /Users/moltbot/Projects/Moltbot_Workspace/crontab_moltbot.txt`
4. Verify security posture:
   - `docker exec moltbot-dev node dist/index.js security audit --json`

## Command Guard Layers
- Layer 1: Telegram channel allowlist (`channels.telegram.groupPolicy=allowlist`)
- Layer 2: Bridge command allowlist (`data/config.json` + `scripts/bridge.js`)
- Layer 3: OpenClaw exec approvals (`configs/*/exec-approvals.json`)

## Docker Proxy Hardening
- `docker-proxy` now exposes a Unix socket over shared volume (`docker_proxy_sock`) instead of TCP listener.
- `DOCKER_HOST` in OpenClaw containers points to:
  - `unix:///var/run/docker-proxy/docker.sock`

## Notion Conversation Policy
- `prepare`: scheduled by cron at 09:00 / 21:00 JST.
- `apply`: approval token required (`--approval <nonce>`).
- failure alerts are normalized into:
  - `logs/notion_conversation_alerts.jsonl`
  - `logs/notion_conversation_alert_latest.json`

## Skill Feedback Loop
- Collector/queue: `npm run -s skill:feedback-loop`
- Pending list: `npm run -s skill:feedback:list`
- Single-command apply: `npm run -s skill:feedback:apply -- --id <feedback_id>`
