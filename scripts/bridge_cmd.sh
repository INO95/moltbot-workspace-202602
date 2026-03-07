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
    "/Users/inho-baek/Projects/Moltbot_Workspace/scripts/bridge.js" \
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

resolve_app_entry() {
  bot_id=$(printf '%s' "${MOLTBOT_BOT_ID:-}" | tr '[:upper:]' '[:lower:]')
  app_rel=""
  case "$bot_id" in
    bot-daily|bot-daily-bak)
      app_rel="apps/bot-daily/src/main.js"
      ;;
    bot-dev|bot-dev-bak)
      app_rel="apps/bot-dev/src/main.js"
      ;;
    bot-anki|bot-anki-bak)
      app_rel="apps/bot-anki/src/main.js"
      ;;
    bot-research|bot-research-bak)
      app_rel="apps/bot-research/src/main.js"
      ;;
    bot-codex)
      app_rel="apps/bot-codex/src/main.js"
      ;;
    *)
      return 1
      ;;
  esac

  sandbox_base=""
  case "$ROOT_DIR" in
    *"/.openclaw-sandboxes/"*)
      sandbox_base=${ROOT_DIR%%/.openclaw-sandboxes/*}
      ;;
  esac

  for candidate in \
    "$ROOT_DIR/$app_rel" \
    "$sandbox_base/$app_rel" \
    "/Users/inho-baek/Projects/Moltbot_Workspace/$app_rel" \
    "/home/node/.openclaw/workspace/$app_rel" \
    "/workspace/$app_rel"
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

APP_ENTRY="$(resolve_app_entry || true)"
if [ -n "$APP_ENTRY" ]; then
  APP_ROOT=$(CDPATH= cd -- "$(dirname "$APP_ENTRY")/../../.." && pwd)
  cd "$APP_ROOT"
  exec "$NODE_BIN" "$APP_ENTRY" "$@"
fi

BRIDGE_ROOT=$(CDPATH= cd -- "$(dirname "$BRIDGE_JS")/.." && pwd)
cd "$BRIDGE_ROOT"

# AnkiConnect stability defaults (can be overridden by env)
: "${ANKI_CONNECT_HOSTS:=127.0.0.1,localhost,host.docker.internal}"
: "${ANKI_CONNECT_TIMEOUT_MS:=8000}"
: "${ANKI_CONNECT_SYNC_TIMEOUT_MS:=12000}"
: "${ANKI_SYNC_WARNING_COOLDOWN_MS:=600000}"
export ANKI_CONNECT_HOSTS ANKI_CONNECT_TIMEOUT_MS ANKI_CONNECT_SYNC_TIMEOUT_MS ANKI_SYNC_WARNING_COOLDOWN_MS

exec "$NODE_BIN" "$BRIDGE_JS" "$@"
