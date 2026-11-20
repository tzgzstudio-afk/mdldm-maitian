#!/bin/bash
# 把麦田装成 systemd 用户服务，对应 macOS 的 scripts/install-launchd.sh。
#   scripts/install-systemd.sh            安装守护进程
#   scripts/install-systemd.sh --tunnel   顺带安装 cloudflared 隧道
#   scripts/install-systemd.sh --uninstall
# 服务名默认 maitian，可用环境变量 MAITIAN_LABEL 改（只影响写到用户目录里的单元）。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
PREFIX=${MAITIAN_LABEL:-maitian}
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
STATE=${MAITIAN_STATE:-$ROOT}

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now "${PREFIX}.service" "${PREFIX}-tunnel.service" 2>/dev/null || true
  rm -f "$UNIT_DIR/${PREFIX}.service" "$UNIT_DIR/${PREFIX}-tunnel.service"
  systemctl --user daemon-reload || true
  echo "已卸载用户服务。/usr/lib/systemd/user 里的安装包单元还在，需要的话再执行：systemctl --user disable --now maitian.service maitian-tunnel.service"
  exit 0
fi

if ! command -v systemctl >/dev/null; then echo "没有 systemctl，装不了开机自启"; exit 1; fi
[[ -f "$ROOT/config.json" || -f "$STATE/config.json" ]] || { echo "先准备 config.json（node src/init.mjs，或 maitian init）"; exit 1; }
mkdir -p "$UNIT_DIR" "$STATE/data"

# deb 把自己的单元装在 /usr/lib，这里只负责启用，避免再写一份指向源码目录的单元。
if [[ -f /usr/lib/systemd/user/maitian.service && "$ROOT" == /opt/maitian ]]; then
  systemctl --user daemon-reload
  systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS 2>/dev/null || true
  systemctl --user enable --now maitian.service
  if [[ "${1:-}" == "--tunnel" ]]; then systemctl --user enable --now maitian-tunnel.service; fi
  echo "已启用安装包里的用户服务。日志：journalctl --user -u maitian.service -f"
  echo "如果重启后要在登录前就跑，执行：sudo loginctl enable-linger \"$USER\""
  exit 0
fi

cat > "$UNIT_DIR/${PREFIX}.service" <<EOF
[Unit]
Description=麦田发布中控
After=network-online.target graphical-session.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/src/hub.mjs daemon
Restart=always
RestartSec=60
Environment=MAITIAN_STATE=$STATE
Environment=PATH=$(dirname "$NODE"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=default.target
EOF

if [[ "${1:-}" == "--tunnel" ]]; then
  cat > "$UNIT_DIR/${PREFIX}-tunnel.service" <<EOF
[Unit]
Description=麦田远程隧道
After=network-online.target ${PREFIX}.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/src/tunnel.mjs
Restart=always
RestartSec=60
Environment=MAITIAN_STATE=$STATE
Environment=PATH=$(dirname "$NODE"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=default.target
EOF
fi

systemctl --user daemon-reload
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS 2>/dev/null || true
systemctl --user enable --now "${PREFIX}.service"
[[ "${1:-}" == "--tunnel" ]] && systemctl --user enable --now "${PREFIX}-tunnel.service"
echo "已安装 ${PREFIX}.service（状态目录 $STATE）"
echo "看日志：journalctl --user -u ${PREFIX}.service -f"
echo "图形会话里的 DISPLAY 会被 import 进用户服务。没有桌面时，守护进程可以看已有数据，但不能新开专用 Chrome。"
echo "重启后仍要在登录前运行：sudo loginctl enable-linger \"$USER\""
