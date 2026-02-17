# Personal Agent V2 Handoff

Date: 2026-02-17  
Baseline: V1 released and operational

## V1 Baseline (done)
- Personal domains:
  - `finance`, `todo`, `routine`, `workout`, `word`, `news`
  - `media/place` tag-capture only
- Storage:
  - `data/personal/personal.sqlite`
- Bridge:
  - prefix + NL routing + local-only lane policy
- Notion:
  - approval-based `prepare/apply`
  - scheduled `prepare` notify (`09:05`, `21:05`)

## V2 Goal (from plan)
- Promote `media/place` to full domains:
  - rating/revisit/recommend/search
- Add SQLite FTS5 search UX:
  - `최근 본 것`, `가고 싶은 식당` query quality upgrade

## Suggested V2 Build Order
1. Schema extension
- Add richer fields for media/place:
  - genre/platform/watch_date/rewatch/revisit/region/budget/etc
- Add FTS5 virtual table + sync triggers.

2. Query routes
- New read-focused commands:
  - `콘텐츠: 최근 본 것`
  - `식당: 가고 싶은 곳`
  - `콘텐츠: 추천`
  - `식당: 재방문`

3. Ranking/recommendation
- Rule-first scoring:
  - rating, recency, revisit intent, tags overlap.
- Keep deterministic local scoring for V2.

4. Tests
- parser + storage + ranking + bridge E2E.
- add regression suite: `test:v2-media-place`.

## Guardrails
- Keep idempotent event ingestion (`dedupe_hash`) invariant.
- Keep Notion write approval policy unchanged.
- Keep `local-only` lane for personal routes by default.
