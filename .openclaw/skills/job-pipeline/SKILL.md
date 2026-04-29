---
name: job-pipeline
description: Track job applications, recruiters, stages, notes, follow-ups, and weekly summaries through the existing Moltbot Telegram bridge.
version: 1.0.0
---

# Job Pipeline CRM

Use the existing bridge route for single-user job process tracking. This is local-first and stores data in the existing personal SQLite database.

## Command

```bash
node /home/node/.openclaw/workspace/scripts/bridge.js job "<message>"
```

## Telegram Examples

- `지원처 추가 회사명=Acme 포지션=Backend Engineer 링크=https://example.com/jobs/1`
- `Acme 현재 단계 interview_1로 변경`
- `리크루터 메모 저장 Acme 다음 주에 답장 필요`
- `Acme 다음액션=포트폴리오 보내기 마감=2026-05-03`
- `지원: 목록`
- `지원: 검색 react remote`
- `지원: 상세 Acme`
- `지원: 주간요약`

## Boundaries

- Do not auto-apply to jobs.
- Do not send outbound email.
- Do not widen Telegram permissions.
- Keep secrets and credentials out of the repository.
