# Privacy Split Playbook

## Goal
- Keep code/config templates in public repository.
- Keep operational logs, personal notes, and runtime data in private repository.

## Private repository
- Default remote: `INO95/moltbot-private` (private)
- Default local path: `../Moltbot_Private`

## Included in private sync
- `configs/`
- `data/`
- `logs/`
- `memory/`
- `reports/`
- `USER.md`
- `HEARTBEAT.md`
- `crontab_moltbot.txt`
- `notes/USER_OPERATING_POLICY.md`
- `blog/_posts/`
- `blog/CNAME`

## Commands
- Bootstrap private repository:
  - `npm run private:bootstrap`
- Regular sync to private repository:
  - `npm run private:sync`

## Security policy
- Public auto-commit is allowlist-based in `scripts/github_repo_manager.js`.
- CI blocks known secret patterns via:
  - `.github/workflows/secrets-scan.yml`
