# Extensible Roadmap

Last updated: 2026-02-08

## Phase 1 (done)
- Prefix-based intake (`단어:`, `작업:`, `점검:`, `배포:`, `리포트:`)
- Prompt/session workflow and codex-first complex task routing

## Phase 2 (next)
- Add append-only bridge queue (`jsonl`) to avoid race conditions on `inbox.json` ✅
- Add command template guardrails and ops queue handling ✅

## Phase 3
- GitHub repo bootstrap + safe autopush with secret scanning gate ✅
- Blog publishing pipeline from operation logs (KO -> JA -> EN) ✅
- Telegram command acknowledgements with compact IDs for traceability ✅

## Phase 4
- Monthly model routing optimizer:
  - quality-sensitive tasks -> codex/deep
  - routine logs -> fast/rule-based
- Cost/latency dashboard and alerting ✅
