#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE_ROOT="${MOLTBOT_PRIVATE_DIR:-$(cd "$ROOT/.." && pwd)/Moltbot_Private}"
BK_ROOT="$PRIVATE_ROOT/backups/openclaw"

if [[ ! -d "$BK_ROOT" ]]; then
  echo "backup root not found: $BK_ROOT" >&2
  exit 1
fi

LATEST="$(ls -1dt "$BK_ROOT"/dev_* "$BK_ROOT"/main_* 2>/dev/null | head -n1 || true)"
if [[ -z "$LATEST" ]]; then
  echo "no backup snapshots found in $BK_ROOT" >&2
  exit 1
fi

META="$LATEST/meta/backup.json"
for f in "$META" "$LATEST/meta/docker-compose.yml" "$LATEST/meta/package.json"; do
  [[ -f "$f" ]] || { echo "missing required file: $f" >&2; exit 1; }
done

node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log('json ok');" "$META" >/dev/null

declare -a backup_containers=(
  "moltbot-dev-bak"
  "moltbot-anki-bak"
  "moltbot-research-bak"
  "moltbot-daily-bak"
)

running=()
for c in "${backup_containers[@]}"; do
  if docker ps --format '{{.Names}}' | grep -qx "$c"; then
    running+=("$c")
  fi
done

if [[ ${#running[@]} -gt 0 ]]; then
  mode="warning"
  running_csv="$(IFS=,; echo "${running[*]}")"
else
  mode="ok"
  running_csv=""
fi

echo "latest_backup=$LATEST"
echo "backup_mode=$mode"
echo "backup_running_count=${#running[@]}"
echo "backup_running=${running_csv:-none}"
echo "verify=ok"
