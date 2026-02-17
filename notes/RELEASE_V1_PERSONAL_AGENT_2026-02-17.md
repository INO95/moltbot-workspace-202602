# Personal Agent V1 Release Snapshot

Date: 2026-02-17 (Asia/Tokyo)  
Workspace: `/Users/moltbot/Projects/Moltbot_Workspace`

## Scope
- V1 domains implemented:
  - `finance`, `todo`, `routine`, `workout`, `word`, `news`
  - `media/place` V1 tag capture
- Bridge routing integrated for prefix + natural-language inference.
- Personal ledger DB integrated:
  - `data/personal/personal.sqlite`
- Notion sync integrated with approval governance:
  - `prepare` + `apply --approval <token>`

## Runtime State
- Cron installed from:
  - `/Users/moltbot/Projects/Moltbot_Workspace/crontab_moltbot.txt`
- OpenClaw live services recreated and running:
  - `moltbot-dev`, `moltbot-anki`, `moltbot-research`, `moltbot-daily`

## Scheduled Jobs (V1-related)
- Personal briefing:
  - `07:10`, `21:30`
- Notion personal sync prepare notify:
  - `09:05`, `21:05`
- News digest:
  - `07:00`, `19:00`
- News event checks:
  - hourly `09:00-21:00`
- Personal retention:
  - daily `02:15`
- Backup:
  - sync daily `02:40`
  - verify weekly `Sun 02:45`

## Migration
- `personal_migrate_legacy.js` executed:
  - initial apply succeeded
  - re-run confirmed idempotent duplicate handling

## Verification
- Full V1 regression suite passed:
  - `npm run -s test:v1-release`
- Bridge domain smoke checks passed:
  - finance duplicate prevention confirmed
  - todo/routine/workout/media/place/news command responses confirmed
- Notion live apply verified:
  - recent applied page id: `30accdc5-2b91-8133-9e3a-dbb973dfd4ab`

## Operational Notes
- Personal Notion env keys:
  - `NOTION_PERSONAL_API_KEY`
  - `NOTION_PERSONAL_DB_ID`
- `apply` remains manual approval-only by policy.
