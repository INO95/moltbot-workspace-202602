# Moltbot Operations Playbook

## Telegram input pattern
- `단어: <영단어 [뜻]>`  
  Example: `단어: Activated 활성화된, Formulate 공식화하다`
- `작업: <요청/대상/완료기준>`
- `점검: <대상/체크항목>`
- `배포: <대상/환경/검증>`
- `프롬프트: <요청>`

## Local bridge commands
- `node scripts/bridge.js auto "<message>"`
- `node scripts/openclaw_codex_sync.js [--restart]`
- `node scripts/codex_oauth_translate.js --target "Japanese|English" --title "<title>" --content "<markdown>"`
- `node scripts/model_routing_report.js`
- `node scripts/model_cost_latency_dashboard.js`

## Bridge queue
- Primary queue log: `data/bridge/inbox.jsonl` (append-only)
- Compatibility snapshot: `data/bridge/inbox.json` (latest task only)
- Every enqueued payload includes compact `ackId` for traceability.
- `ag_bridge_client`, `daily_telegram_digest`, and `morning_briefing` now enqueue to both.

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
- Default paid API budget: 0 JPY.
- Paid API should stay blocked unless user explicitly approves and sets:
  - `MOLTBOT_ALLOW_PAID_API=true`
- For ChatGPT Plus path (`openai-codex`), complete OAuth once in OpenClaw:
  - `docker exec moltbot-main node dist/index.js models auth login --provider openai-codex`
