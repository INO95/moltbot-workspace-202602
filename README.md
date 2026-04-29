# Moltbot Workspace

Moltbot Workspace는 텔레그램으로 들어온 요청을 여러 역할 봇과 로컬 자동화로 나눠 처리하는 개인 운영 작업공간입니다.

이 저장소에는 코드, 설정 템플릿, 테스트, 운영 문서를 둡니다. 토큰, 인증 파일, 로그, 개인 기록 같은 민감한 자료는 저장소에 올리지 않고 로컬 또는 비공개 공간에 따로 둡니다.

## 주요 역할

- 텔레그램 브릿지: `단어:`, `작업:`, `점검:`, `운영:` 같은 입력을 알맞은 처리 흐름으로 보냅니다.
- OpenClaw 런타임: `dev`, `anki`, `research`, `daily`, `codex` 역할 봇을 관리합니다.
- 운영 큐: 파일 작업, 재시작, 외부 도구 실행처럼 조심해야 하는 일을 승인 흐름으로 처리합니다.
- 개인 자동화: 가계, 투두, 루틴, 운동, 콘텐츠, 장소 기록을 다룹니다.
- 학습/리포트: Anki 단어 처리, 뉴스 수집, 리포트 생성, 모델 라우팅 점검을 지원합니다.
- 안전 점검: 비밀값 검사, 컨테이너 격리, 런타임 파일 추적 방지, 운영 회귀 테스트를 실행합니다.

## 폴더 구조

- `scripts/`: 브릿지, 봇 운영, 테스트, 자동화 스크립트가 모여 있습니다.
- `scripts/lib/`: 브릿지와 운영 흐름의 공통 로직입니다.
- `packages/`: 공통 정책, 라우팅, 운영 모듈입니다.
- `contracts/`: OpenClaw 프로필 템플릿 같은 계약 파일입니다.
- `data/config.json`: 라우팅과 기능 정책의 기본 설정입니다.
- `ops/`: 운영 큐, 경보, 실행 상태를 다루는 영역입니다.
- `notes/`: 의사결정, 운영 절차, 보안 정책 문서입니다.
- `docs/`: 긴 실행 가이드와 변경 지도 문서입니다.
- `.github/workflows/`: GitHub 검사 흐름입니다.

## 빠른 시작

필요한 패키지를 설치합니다.

```bash
npm ci
```

기본 회귀 테스트를 실행합니다.

```bash
npm run -s test:v1-release
npm run -s test:ops
```

OpenClaw 라이브 컨테이너를 켜고 끕니다.

```bash
npm run -s openclaw:up
npm run -s openclaw:down
```

운영 상태를 확인합니다.

```bash
npm run -s ops:daily:health
node scripts/bridge.js auto "운영: 액션: 상태; 대상: daily"
```

주의: 이 프로젝트의 `npm test`는 실제 테스트 묶음이 아닙니다. 위처럼 이름이 붙은 테스트 명령을 사용합니다.

## 자주 쓰는 명령

브릿지 자동 라우팅:

```bash
node scripts/bridge.js auto "단어: absorb"
node scripts/bridge.js auto "작업: 요청: 브릿지 라우팅 점검; 대상: scripts/bridge.js; 완료기준: 테스트 통과"
```

OpenClaw 인증과 설정:

```bash
npm run -s openclaw:auth:sync
npm run -s openclaw:config:sync:check
npm run -s openclaw:approvals:status
```

안전 점검:

```bash
npm run -s check:container-isolation-refs
npm run -s check:runtime-artifact-tracking
npm run -s check:openclaw-profile-templates
npm run -s check:secrets-scan-workflow
```

OpenClaw 백업:

```bash
npm run -s backup:openclaw
npm run -s backup:openclaw:verify
```

## 안전 원칙

- 저장소 루트에 `.env`를 만들지 않습니다.
- 런타임 환경값은 `$HOME/.config/moltbot/runtime.env`에 둡니다.
- `configs/**/auth-profiles.json`, `data/secure/*`, `logs/`, `memory/`, `reports/`는 Git에 올리지 않습니다.
- API 키, 텔레그램 토큰, OAuth 세션, 개인 데이터는 커밋하지 않습니다.
- 고위험 운영 작업은 승인 토큰 흐름을 거칩니다.
- OpenClaw 컨테이너는 로컬 바인딩과 격리 설정을 유지합니다.

## GitHub 검사

PR과 `main`에는 다음 검사가 붙어 있습니다.

- `core-regression`: 핵심 라우팅, 개인 자동화, 운영 흐름 테스트
- `gitleaks`: 비밀값 패턴 검사
- `trufflehog`: 비밀값 히스토리 검사
- `guard`: 컨테이너 격리 기준 검사

## 더 자세한 문서

- 운영 절차: `notes/OPERATIONS_PLAYBOOK.md`
- OpenClaw 라우팅: `notes/OPENCLAW_ROUTING.md`
- 런타임 실행 가이드: `docs/openclaw_runtime_runbook.md`
- 공개/비공개 분리 정책: `notes/PRIVACY_SPLIT_PLAYBOOK.md`
- OpenClaw 잠금 정책: `notes/OPENCLAW_LOCKDOWN_RUNBOOK.md`
- 최근 OpenClaw 업데이트 기록: `notes/OPENCLAW_UPDATE_2026-04-29.md`
