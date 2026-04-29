# Moltbot Workspace

[한국어](README.md) | [English](README.en.md) | [日本語](README.ja.md)

Moltbot Workspace is a personal operations workspace that routes Telegram requests to role-specific bots and local automation.

This repository contains code, configuration templates, tests, and operations documents. Sensitive material such as tokens, auth files, logs, and personal records must not be committed here. Keep them in local or private storage instead.

## Main Roles

- Telegram bridge: routes inputs such as `단어:`, `작업:`, `점검:`, and `운영:` to the right workflow.
- OpenClaw runtime: manages role bots such as `dev`, `anki`, `research`, `daily`, and `codex`.
- Operations queue: handles careful actions such as file work, restarts, and external tool runs through an approval flow.
- Personal automation: handles finance, todo, routine, workout, media, and place records.
- Learning and reports: supports Anki vocabulary processing, news collection, report generation, and model routing checks.
- Safety checks: runs secret scans, container isolation checks, runtime artifact tracking guards, and operations regression tests.

## Folder Structure

- `scripts/`: bridge, bot operations, tests, and automation scripts.
- `scripts/lib/`: shared logic for bridge and operations workflows.
- `packages/`: shared policy, routing, and operations modules.
- `contracts/`: contract files such as OpenClaw profile templates.
- `data/config.json`: default routing and feature policy settings.
- `ops/`: operations queue, alerts, and runtime state.
- `notes/`: decisions, operating procedures, and security policy documents.
- `docs/`: longer runbooks and change map documents.
- `.github/workflows/`: GitHub check workflows.

## Quick Start

Install dependencies.

```bash
npm ci
```

Run the basic regression tests.

```bash
npm run -s test:v1-release
npm run -s test:ops
```

Start and stop the OpenClaw live containers.

```bash
npm run -s openclaw:up
npm run -s openclaw:down
```

Check operations status.

```bash
npm run -s ops:daily:health
node scripts/bridge.js auto "운영: 액션: 상태; 대상: daily"
```

Note: `npm test` is not the real test bundle for this project. Use the named test commands above.

## Common Commands

Bridge auto routing:

```bash
node scripts/bridge.js auto "단어: absorb"
node scripts/bridge.js auto "작업: 요청: 브릿지 라우팅 점검; 대상: scripts/bridge.js; 완료기준: 테스트 통과"
```

OpenClaw auth and config:

```bash
npm run -s openclaw:auth:sync
npm run -s openclaw:config:sync:check
npm run -s openclaw:approvals:status
```

Safety checks:

```bash
npm run -s check:container-isolation-refs
npm run -s check:runtime-artifact-tracking
npm run -s check:openclaw-profile-templates
npm run -s check:secrets-scan-workflow
```

OpenClaw backup:

```bash
npm run -s backup:openclaw
npm run -s backup:openclaw:verify
```

## Safety Rules

- Do not create a `.env` file at the repository root.
- Keep runtime environment values in `$HOME/.config/moltbot/runtime.env`.
- Do not commit `configs/**/auth-profiles.json`, `data/secure/*`, `logs/`, `memory/`, or `reports/`.
- Do not commit API keys, Telegram tokens, OAuth sessions, or personal data.
- High-risk operations must go through the approval token flow.
- OpenClaw containers must keep local binding and isolation settings.

## GitHub Checks

PRs and `main` use these checks.

- `core-regression`: core routing, personal automation, and operations workflow tests.
- `gitleaks`: secret pattern scan.
- `trufflehog`: secret history scan.
- `guard`: container isolation guard.

## More Documents

- Operations playbook: `notes/OPERATIONS_PLAYBOOK.md`
- OpenClaw routing: `notes/OPENCLAW_ROUTING.md`
- Runtime runbook: `docs/openclaw_runtime_runbook.md`
- Public/private split policy: `notes/PRIVACY_SPLIT_PLAYBOOK.md`
- OpenClaw lockdown policy: `notes/OPENCLAW_LOCKDOWN_RUNBOOK.md`
- Recent OpenClaw update record: `notes/OPENCLAW_UPDATE_2026-04-29.md`
