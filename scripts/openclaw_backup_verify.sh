#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE_ROOT="${MOLTBOT_PRIVATE_DIR:-$(cd "$ROOT/.." && pwd)/Moltbot_Private}"
BK_ROOT="$PRIVATE_ROOT/backups/openclaw"

if [[ ! -d "$BK_ROOT" ]]; then
  echo "backup root not found: $BK_ROOT" >&2
  exit 1
fi

LATEST="$(ls -1dt "$BK_ROOT"/main_* 2>/dev/null | head -n1 || true)"
if [[ -z "$LATEST" ]]; then
  echo "no backup snapshots found in $BK_ROOT" >&2
  exit 1
fi

CFG="$LATEST/configs/main/openclaw.json"
META="$LATEST/meta/backup.json"
INSPECT="$LATEST/meta/moltbot-main.inspect.json"

for f in "$CFG" "$META" "$INSPECT"; do
  [[ -f "$f" ]] || { echo "missing required file: $f" >&2; exit 1; }
done

node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));console.log('json ok');" "$CFG" "$META" >/dev/null

if docker ps --format '{{.Names}}' | grep -qx 'moltbot-sub1'; then
  SUB_STATUS='running'
else
  SUB_STATUS='not-running'
fi

echo "latest_backup=$LATEST"
echo "sub1_status=$SUB_STATUS"
echo "verify=ok"
