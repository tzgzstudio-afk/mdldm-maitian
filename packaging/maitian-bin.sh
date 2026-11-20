#!/bin/bash
# deb 安装后的 /usr/bin/maitian。源码在 /opt/maitian，可写数据在用户目录。
set -euo pipefail
APP=/opt/maitian
NODE="$APP/node/bin/node"
STATE="${MAITIAN_STATE:-$HOME/.local/share/maitian}"
export MAITIAN_STATE="$STATE"
export PATH="$APP/node/bin:${PATH:-/usr/bin:/bin}"
mkdir -p "$STATE/data"
cd "$APP"
cmd="${1:-}"
case "$cmd" in
  init|demo|tunnel)
    shift
    exec "$NODE" "$APP/src/${cmd}.mjs" "$@"
    ;;
  desktop)
    systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS 2>/dev/null || true
    systemctl --user start maitian.service 2>/dev/null || true
    exec "$NODE" "$APP/src/hub.mjs" open
    ;;
  *)
    exec "$NODE" "$APP/src/hub.mjs" "$@"
    ;;
esac
