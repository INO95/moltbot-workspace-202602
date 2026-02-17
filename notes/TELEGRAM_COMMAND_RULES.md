# Telegram Command Rules

Last updated: 2026-02-17

## Prefix commands
- 권장 단순 명령:
  - `학습:` (`단어:`와 동일)
  - `실행:` (`작업:`과 동일)
  - `검토:` (`점검:`와 동일)
  - `출시:` (`배포:`와 동일)
  - `프로젝트:` (신규 프로젝트 부트스트랩 템플릿)
  - `가계:` / `가계부:` (개인 가계 원장 기록/조회)
  - `투두:` / `할일:` (개인 할 일 기록/조회)
  - `루틴:` (루틴 등록/체크/조회)
  - `운동:` (운동 로그 기록/조회)
  - `콘텐츠:` (V1 태그 캡처)
  - `식당:` / `맛집:` (V1 태그 캡처)
  - `링크:` (외부 URL 즉시 반환)
  - `상태:` (`운영: 액션: 상태; 대상: all` 단축)
  - `운영:`
- 주요 명령:
  - `단어:` 영어 단어를 `TOEIC_AI` 덱에 추가
  - `리포트:` 요약/블로그/주간 리포트 실행
  - `작업:` 구현 작업 템플릿 (codex high reasoning)
  - `점검:` 리뷰/검증 템플릿 (codex medium reasoning)
  - `배포:` 배포 템플릿 (검증/롤백 필수)
  - `프로젝트:` 신규 프로젝트 부트스트랩 템플릿
  - `프롬프트:` 인터뷰형 프롬프트 세션 생성/보완/완성
  - `가계:` 지출/수입/환급/이체 기록 + 통계/목록
  - `투두:` 추가/완료/재개/삭제/목록
  - `루틴:` 등록/활성/비활성/체크/목록/요약
  - `운동:` 운동 로그 기록 + 목록/통계
  - `콘텐츠:` 영화/드라마 등 V1 태그 캡처
  - `식당:` 식당/맛집 V1 태그 캡처
  - `링크:` 외부 링크 즉시 조회 (`링크: 프롬프트`)
  - `상태:` 빠른 운영 상태 조회 (`상태:` 또는 `상태: tunnel`)
  - `운영:` Docker 상태조회/재시작 + 파일제어 PLAN/APPROVE

## Command allowlist policy
- Bridge layer allowlist is enforced for both:
  - direct command mode (`node scripts/bridge.js <command> ...`)
  - prefix auto mode (`node scripts/bridge.js auto "<message>"`)
- Default direct allowlist:
  - `auto`, `work`, `inspect`, `deploy`, `project`, `ops`, `word`, `news`, `prompt`, `finance`, `todo`, `routine`, `workout`, `media`, `place`
- Default auto route allowlist:
  - `word`, `memo`, `news`, `report`, `work`, `inspect`, `deploy`, `project`, `prompt`, `link`, `status`, `ops`, `finance`, `todo`, `routine`, `workout`, `media`, `place`
- Intentionally blocked by default (direct mode):
  - `checklist`, `summary`, `anki`
- `route=none` (무프리픽스 안내 응답)는 기존처럼 유지되어 차단하지 않습니다.
- On blocked commands, bridge returns structured JSON:
  - `route: "blocked"`, `blocked: true`, `errorCode: "COMMAND_NOT_ALLOWED"`
  - plus optional role hint (`BRIDGE_BLOCK_HINT`)

## 8-bot role split (live + backup)
- Live bots:
  - `dev` (개발): `work,inspect,deploy,project,ops,status,link`
  - `anki` (안키): `word`
  - `research` (리서쳐): `news,report,prompt`
  - `daily` (일상): 허브 단일 진입점 (`word/news/report/work/inspect/deploy/project/prompt`는 역할 봇으로 자동 위임, `ops/status/link/memo/finance/todo/routine/workout/media/place`는 로컬 처리)
- Backup bots (cold standby, default disabled):
  - `dev_bak`, `anki_bak`, `research_bak`, `daily_bak`
- Research bot receives scheduled tech trend reports by default:
  - `NEWS_TELEGRAM_TARGET=research`

## Daily transparent delegation
- daily에서 `auto` 라우트가 위임 대상일 경우 `capability: bot:dispatch` 큐로 전달됩니다.
- payload 표준 필드:
  - `payload.original_message`
  - `payload.route`
  - `payload.target_profile`
- 허브 응답은 역할 봇의 `telegramReply`를 그대로 사용합니다.
- 위임 경로에서도 approval 정책은 우회되지 않습니다.

## Word (`단어:`) rules
- 형식: `단어: Word 뜻`
- 여러 개: `단어: Activated 활성화된, Formulate 체계화하다`
- 저장 덱: `TOEIC_AI`
- 저장 성공/실패는 `data/personal/personal.sqlite`의 `vocab_logs`에도 기록됩니다.

## Personal (`가계/투두/루틴/운동/콘텐츠/식당`) rules
- `가계:` 예시
  - `가계: 점심 1200엔`
  - `가계: 통계 2026-02`
  - `가계: 목록`
- `투두:` 예시
  - `투두: 추가 운동 가기`
  - `투두: 완료 12`
  - `투두: 목록`
- `루틴:` 예시
  - `루틴: 등록 물 2L`
  - `루틴: 체크 물 2L`
  - `루틴: 요약`
- `운동:` 예시
  - `운동: 러닝 30분 5km`
  - `운동: 통계`
- `콘텐츠:`/`식당:` 예시
  - `콘텐츠: 듄2 봤음 4.5점 #SF`
  - `식당: 라멘집 가고싶음 #도쿄`

## Prompt (`프롬프트:`) rules
- 시작: `프롬프트: <자유 설명>`
- 보완: `프롬프트: 답변 <sessionId> | 제약: ...; 출력형식: ...; 금지사항: ...; 성공기준: ...`
- 완성: `프롬프트: 완성 <sessionId>`

## 작업/점검/배포 템플릿
- `작업:` 필수
  - `요청: ...`
  - `대상: ...`
  - `완료기준: ...`
- `점검:` 필수
  - `대상: ...`
  - `체크항목: ...`
- `배포:` 필수
  - `대상: ...`
  - `환경: ...`
  - `검증: ...`
- `운영:` 필수
  - `액션: 재시작|상태|파일|승인`
  - `대상: dev|anki|research|daily|dev_bak|anki_bak|research_bak|daily_bak|proxy|webproxy|tunnel|prompt|web|all` (`상태/재시작`에서만 사용)

## File control approval protocol (A+B+C+D)
- 기본 원칙:
  - 모든 파일 제어는 PLAN(dry-run)부터 시작
  - 실제 실행은 `APPROVE` 토큰 승인 후에만 가능
  - 삭제류 동작은 `~/.assistant_trash/<timestamp>/`로 이동 (직접 삭제 금지)
  - `.git/**` 직접 수정 금지, Git 동작은 git-aware 명령만 허용
- PLAN 요청:
  - `운영: 액션: 파일; 작업: <action>; 경로: <path>; 대상경로: <path>; 패턴: <glob>; 저장소: <repo>; 커밋메시지: <msg>`
  - 지원 action:
    - `list_files`, `compute_plan`, `move`, `rename`, `archive`, `trash`, `restore`
    - `drive_preflight_check`
    - `git_status`, `git_diff`, `git_mv`, `git_add`, `git_commit`, `git_push`
- APPROVE 요청:
  - `APPROVE <token>`
  - `APPROVE <token> --force` (HIGH/GIT)
  - `APPROVE <token> --force --push` (push)
- Telegram 정책:
  - 파일 제어(`액션: 파일|승인`)는 Telegram envelope metadata가 반드시 포함되어야 함
  - user/group allowlist 미일치 시 즉시 차단
- 결과 전달:
  - PLAN 결과: risk tier, exact paths, required flags, rollback preview, token/expiry
  - EXECUTE 결과: 실행 단계, 파일 카운트/해시, rollback 안내

## Report (`리포트:`) rules
- `리포트: 블로그` -> 최근 로그 기반 포스트 생성
- `리포트: 주간` -> 주간 보고서
- `리포트:` (기본) -> 일일 요약

## Tips
- 무프리픽스 일반 문장은 실행하지 않고 가이드를 반환합니다.
- 링크 응답은 로컬 URL 대신 외부 URL(`/prompt/`)을 사용합니다.
- `상태:`에는 외부 링크 점검 결과(DNS/HTTPS)가 포함될 수 있습니다.
