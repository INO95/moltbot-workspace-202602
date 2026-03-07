# OpenClaw Runtime Runbook

This file keeps longer notes out of injected workspace prompts.

## What Moved Here
- Extended workspace conventions and examples
- Skill discovery notes beyond the minimal runtime rule
- Tool-specific local note examples for `TOOLS.md`
- Heartbeat/background-operating rationale

## Skill Discovery
- Search only when needed.
- Prefer `rg --files .agents/skills skills \"$CODEX_HOME/skills\" | rg 'SKILL\\.md$'`.
- Open only the matching `SKILL.md`, then load referenced files lazily.

## Local Notes Example
- Cameras: `living-room -> wide angle`
- SSH: `home-server -> admin@192.168.1.100`
- TTS: `Nova -> default storytelling voice`
