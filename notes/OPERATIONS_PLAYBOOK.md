# Moltbot Operations Playbook

## Telegram input pattern
- `기록: <내용>`  
  Example: `기록: 점심 외식 카레 식비 1000엔 현금`
- `단어: <영단어 [뜻]>`  
  Example: `단어: Activated 활성화된, Formulate 공식화하다`
- `운동: <캡처 OCR 텍스트>`  
  Example: `운동: Indoor Run 5.66km 338kcal 2026/01/30`

## Local bridge commands
- `node scripts/bridge.js auto "<message>"`
- `node scripts/bridge.js preview "<finance text>"`
- `node scripts/bridge.js finance-status`
- `node scripts/bridge.js health ingest "<ocr text>"`
- `node scripts/bridge.js health summary [YYYY-MM]`
- `node scripts/health_import.js apple "<Apple Health export.xml>"`
- `node scripts/health_import.js mifitness "<Mi Fitness export.csv>"`
- `node scripts/health_import_watch.js --scan`
- `node scripts/health_import_watch.js --watch --interval 60`
- `node scripts/openclaw_codex_sync.js [--restart]`
- `node scripts/codex_oauth_translate.js --target "Japanese|English" --title "<title>" --content "<markdown>"`
- `node scripts/model_routing_report.js`
- `node scripts/model_cost_latency_dashboard.js`

## Bridge queue
- Primary queue log: `data/bridge/inbox.jsonl` (append-only)
- Compatibility snapshot: `data/bridge/inbox.json` (latest task only)
- Every enqueued payload includes compact `ackId` for traceability.
- `ag_bridge_client`, `daily_telegram_digest`, and `morning_briefing` now enqueue to both.

## Finance rules
- Credit card charge: expense is recorded, but bank balance is not immediately reduced.
- Credit settlement: bank balance is reduced when settlement payment is recorded.
- Reimbursement received: record as positive `정산환급`.

## Health pipeline
- Source of truth: `data/health_captures.jsonl` (append-only)
- Snapshot: `data/health_db.json` (derived)
- Monthly summary uses captured running/workout/sleep records.
- Drop-folder ingestion:
  - inbox: `data/health_import_inbox/`
  - success archive: `data/health_import_archive/`
  - parse/import failed: `data/health_import_failed/`
  - latest run log: `logs/health_import_watch_latest.json`

## GitHub and blog
- Prerequisite: GitHub CLI (`gh`) installed and authenticated.
- Repo planning: `node scripts/github_repo_manager.js plan <project-name>`
- Safe local commit: `node scripts/github_repo_manager.js commit "<message>"`
- Blog draft from reports: `node scripts/blog_publish_from_reports.js`
- Blog dry-run only (no deploy): `node scripts/blog_publish_from_reports.js --dry-run`
- Blog skip-window test: `node scripts/blog_publish_from_reports.js --hours 1 --no-deploy`
- Blog translation path uses OpenClaw Codex OAuth (`openai-codex`) with high thinking.
- Translator acquires a lock and restores the previous default model after each translation run.

## Budget guard
- Default paid API budget: 0 JPY.
- Paid API should stay blocked unless user explicitly approves and sets:
  - `MOLTBOT_ALLOW_PAID_API=true`
- For ChatGPT Plus path (`openai-codex`), complete OAuth once in OpenClaw:
  - `docker exec moltbot-main node dist/index.js models auth login --provider openai-codex`
