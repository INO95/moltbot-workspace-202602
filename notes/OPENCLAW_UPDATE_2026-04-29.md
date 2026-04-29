# OpenClaw Update - 2026-04-29

## Summary

OpenClaw was updated on the local Moltbot runtime from `2026.4.15` to `2026.4.26`.

## Scope

- Updated the live Docker base image to `ghcr.io/openclaw/openclaw:2026.4.26`.
- Retagged the image as `openclaw:local`.
- Rebuilt the local `openclaw:local-dockercli` image.
- Restarted the live OpenClaw containers.
- Updated the user-path OpenClaw CLI to `2026.4.26`.

## Verification

- `moltbot-dev`: `OpenClaw 2026.4.26`, healthy.
- `moltbot-anki`: `OpenClaw 2026.4.26`, healthy.
- `moltbot-research`: `OpenClaw 2026.4.26`, healthy.
- `moltbot-daily`: `OpenClaw 2026.4.26`, healthy.
- `moltbot-codex`: `OpenClaw 2026.4.26`, healthy.
- Backup verification completed successfully before the update.

## Model Notes

- The `2026.4.26` runtime includes `openai-codex/gpt-5.5` support and fallback catalog entries.
- The active bot default model was left unchanged at `openai-codex/gpt-5.4`.
- OAuth for `openai-codex` remained healthy after the update.

## Follow-Up

- Consider a separate, deliberate model migration PR if switching the default from `openai-codex/gpt-5.4` to `openai-codex/gpt-5.5`.
- The Homebrew global OpenClaw copy may still be older, but the active `openclaw` command resolves to the updated user-path CLI.
