#!/bin/bash
# 在 Ubuntu amd64 上打出 maitian deb。需要 curl、xz、dpkg-deb。
# 运行时自带官方 Node.js 22，不使用发行版里过旧的 nodejs 包。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG_VERSION=0.3.0-1
NODE_VER=22.23.4
NODE_SUM=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
WORKDIR=$(mktemp -d /tmp/maitian-deb.XXXX)
STAGE="$WORKDIR/stage"
OUT_DIR=${1:-$ROOT/dist}
LOG=${2:-$WORKDIR/build.log}
mkdir -p "$OUT_DIR"
exec > >(tee -a "$LOG") 2>&1

echo "== 麦田 deb 构建 $(date -Is)"
echo "源码 $ROOT"
echo "工作目录 $WORKDIR"
. /etc/os-release
echo "构建机 $PRETTY_NAME $(uname -m)"

echo "== 下载并校验 Node.js $NODE_VER"
curl -fsSL -o "$WORKDIR/node.tar.xz" "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz"
echo "$NODE_SUM  $WORKDIR/node.tar.xz" | sha256sum -c -
tar -xJf "$WORKDIR/node.tar.xz" -C "$WORKDIR"

echo "== 组装文件"
APP="$STAGE/opt/maitian"
mkdir -p "$APP/state" "$STAGE/usr/bin" "$STAGE/usr/lib/systemd/user" \
  "$STAGE/usr/share/applications" "$STAGE/usr/share/icons/hicolor/512x512/apps" \
  "$STAGE/usr/share/doc/maitian"
cp -a "$WORKDIR/node-v${NODE_VER}-linux-x64" "$APP/node"
cp -a "$ROOT/src" "$ROOT/scripts" "$ROOT/skills" "$ROOT/docs" "$APP/"
cp -a "$ROOT/config.example.json" "$ROOT/package.json" "$ROOT/LICENSE" "$ROOT/README.md" "$APP/"
cp "$ROOT/packaging/maitian.service" "$ROOT/packaging/maitian-tunnel.service" "$STAGE/usr/lib/systemd/user/"
cp "$ROOT/packaging/maitian.desktop" "$STAGE/usr/share/applications/"
cp "$ROOT/src/web/icon-512.png" "$STAGE/usr/share/icons/hicolor/512x512/apps/maitian.png"
cp "$ROOT/packaging/debian/copyright" "$ROOT/packaging/debian/changelog" "$STAGE/usr/share/doc/maitian/"
gzip -n -9 -c "$ROOT/packaging/debian/changelog" > "$STAGE/usr/share/doc/maitian/changelog.gz"
install -m 0755 "$ROOT/packaging/maitian-bin.sh" "$STAGE/usr/bin/maitian"
chmod 0755 "$ROOT/scripts/install-systemd.sh" "$ROOT/scripts/install.sh" "$ROOT/scripts/build-deb.sh"
find "$APP/scripts" -name '*.sh' -exec chmod 0755 {} +
chmod 1777 "$APP/state"

# 安装包里不要带开发机的配置、数据库或登录态
rm -rf "$APP/data" "$APP/demo" "$APP/chrome-profile" "$APP/node_modules" "$APP/config.json"

mkdir -p "$STAGE/DEBIAN"
cp "$ROOT/packaging/debian/control" "$STAGE/DEBIAN/control"
install -m 0755 "$ROOT/packaging/debian/postinst" "$STAGE/DEBIAN/postinst"
install -m 0755 "$ROOT/packaging/debian/prerm" "$STAGE/DEBIAN/prerm"
cp "$ROOT/packaging/debian/copyright" "$STAGE/DEBIAN/copyright"

DEB="$OUT_DIR/maitian_${PKG_VERSION}_amd64.deb"
dpkg-deb --root-owner-group -Zxz --build "$STAGE" "$DEB"
sha256sum "$DEB" | tee "$DEB.sha256"
dpkg-deb -I "$DEB"
echo "== 完成 $DEB"
echo "日志 $LOG"
if [[ "$LOG" != "$WORKDIR/build.log" ]]; then cp -f "$LOG" "$WORKDIR/build.log"; fi
echo "$DEB"
