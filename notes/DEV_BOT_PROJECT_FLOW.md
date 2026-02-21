# DEV Bot Project Flow

## 목적

dev 봇 대화만으로 신규 프로젝트를 안정적으로 생성/개발/검증/배포하기 위한 표준 흐름.

## 표준 루프

1. `프로젝트:` 템플릿으로 스캐폴드 계획 고정
2. `작업:`으로 실제 생성/구현 수행
3. `점검:`으로 회귀/품질 확인
4. `배포:`로 스테이징/프로덕션 배포

## 입력 규칙

- `프로젝트명`: slug 권장 (`my-app`)
- `스택`: 템플릿 + 패키지매니저 포함 (`next.js typescript pnpm`)
- `경로`: 절대경로 권장 (`/Users/moltbot/Projects`)
- `완료기준`: 테스트 명령 포함 (`lint/typecheck/test`)
- `초기화`: `plan` 또는 `실행`

## 품질 게이트

- Node/Frontend 기본: `lint`, `typecheck`, `test`
- Frontend(E2E 포함): `npx playwright test --project=chromium`
- Python/FastAPI 기본: `python -m pytest -q`

## 예시

`프로젝트: 프로젝트명: sample-web; 목표: MVP; 스택: vite react pnpm; 경로: /Users/moltbot/Projects; 완료기준: lint/typecheck/test 통과; 초기화: 실행`

`작업: 요청: bootstrap.commands 실행 후 앱 기동; 대상: /Users/moltbot/Projects/sample-web; 완료기준: pnpm dev 실행 로그`

`점검: 대상: /Users/moltbot/Projects/sample-web; 체크항목: 회귀,예외처리,보안,테스트누락`

`배포: 대상: sample-web; 환경: staging; 검증: health check + rollback`
