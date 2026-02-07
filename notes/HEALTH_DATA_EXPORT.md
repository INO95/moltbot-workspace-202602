# Health Data Export Guide (Free Path)

Last updated: 2026-02-06

## 1) Mi Fitness export (free)
1. Open Xiaomi account privacy portal:
   - `account.xiaomi.com` -> Privacy -> Manage your data -> MI Fitness
2. Request data download package.
3. Save exported archive into local workspace (recommended: `data/health-imports/mi-fitness/`).

## 2) Apple Health export (free)
1. iPhone Health app -> profile icon -> Export All Health Data.
2. Save exported file (`export.zip` / `export.xml`) into local workspace
   (recommended: `data/health-imports/apple-health/`).

## 3) Moltbot ingestion pattern
- Screenshot/OCR text:
  - `node scripts/bridge.js health ingest "<ocr text>"`
- Monthly summary:
  - `node scripts/bridge.js health summary 2026-02`

## 4) Current constraints
- Mi Fitness -> Zepp Life reverse sync is unreliable in-app.
- Keep no paid third-party requirement by using manual export + local parser flow.

## References
- Xiaomi support guide:
  - https://www.mi.com/global/support/article/KA-11566/
- Apple Health data management:
  - https://support.apple.com/en-us/108779
