#!/bin/sh
# Bridge launcher with resilient Node resolution across host/container runtimes.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

resolve_node_bin() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

resolve_bridge_js() {
  sandbox_base=""
  case "$ROOT_DIR" in
    *"/.openclaw-sandboxes/"*)
      sandbox_base=${ROOT_DIR%%/.openclaw-sandboxes/*}
      ;;
  esac

  for candidate in \
    "$ROOT_DIR/scripts/bridge.js" \
    "$sandbox_base/scripts/bridge.js" \
    "/Users/moltbot/Projects/Moltbot_Workspace/scripts/bridge.js" \
    "/home/node/.openclaw/workspace/scripts/bridge.js" \
    "/workspace/scripts/bridge.js"
  do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

BRIDGE_JS="$(resolve_bridge_js || true)"
if [ -z "$BRIDGE_JS" ]; then
  echo '{"route":"none","success":false,"errorCode":"BRIDGE_SCRIPT_MISSING","telegramReply":"브릿지 스크립트를 찾지 못했습니다."}'
  exit 127
fi

NODE_BIN="$(resolve_node_bin || true)"
if [ -z "$NODE_BIN" ]; then
  echo '{"route":"none","success":false,"errorCode":"NODE_BIN_NOT_FOUND","telegramReply":"node 실행 파일을 찾지 못해 브릿지 실행을 완료하지 못했습니다."}'
  exit 127
fi

BRIDGE_ROOT=$(CDPATH= cd -- "$(dirname "$BRIDGE_JS")/.." && pwd)
cd "$BRIDGE_ROOT"
exec "$NODE_BIN" "$BRIDGE_JS" "$@"
