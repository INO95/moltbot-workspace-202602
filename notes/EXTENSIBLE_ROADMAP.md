# Extensible Roadmap

Last updated: 2026-02-07

## Phase 1 (done)
- Prefix-based intake (`기록:`, `단어:`, `운동:`)
- Credit card settlement-aware finance recording
- Reimbursement-aware effective expense tracking
- Health capture ingestion from screenshot-style text

## Phase 2 (next)
- Add append-only bridge queue (`jsonl`) to avoid race conditions on `inbox.json` ✅
- Add OCR parser plugin path (Apple Health XML + Mi Fitness export parsing) ✅
- Add test fixtures for finance intent classification ✅

## Phase 3
- GitHub repo bootstrap + safe autopush with secret scanning gate ✅
- Blog publishing pipeline from operation logs (KO -> JA -> EN) ✅
- Telegram command acknowledgements with compact IDs for traceability ✅

## Phase 4
- Monthly model routing optimizer:
  - quality-sensitive tasks -> codex/deep
  - routine logs -> fast/rule-based
- Cost/latency dashboard and alerting ✅
- Health drop-folder auto import pipeline ✅
