# Job Pipeline CRM

Telegram에서 `지원:`, `지원처:`, `채용:`, `job:` prefix로 채용 진행 상황을 기록한다.

## Examples

- `지원처 추가 회사명=Acme 포지션=Backend Engineer 링크=https://example.com/jobs/1`
- `Acme 현재 단계 interview_1로 변경`
- `리크루터 메모 저장 Acme 다음 주에 답장 필요`
- `Acme 다음액션=포트폴리오 보내기 마감=2026-05-03`
- `지원: 목록`
- `지원: 검색 react remote`
- `지원: 상세 Acme`
- `지원: 주간요약`

## Storage

- Uses the existing local SQLite file: `data/personal/personal.sqlite`
- Adds `job_*` tables on first use through the existing personal schema path.
- No secrets are stored in the repository.

## Rollout

1. Run local checks for the new route.
2. Inject OpenClaw runtime config if needed.
3. Restart only the daily runtime first.
4. Smoke test `지원: 도움말`, `지원: 목록`, `가계: 점심 1200엔`, and `상태:`.
