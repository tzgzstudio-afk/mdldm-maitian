#!/bin/bash
# 麦田一行安装：
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/CzzzzzzJ/mdldm-maitian/main/scripts/install.sh)"
# 做的事：检查 git 和 Node（≥22.5）→ 把麦田和麦田发布助手克隆到 ~/maitian/ → 运行安装向导
# 换目录：MAITIAN_HOME=~/somewhere bash -c "$(curl -fsSL …)"
set -e
DIR=${MAITIAN_HOME:-$HOME/maitian}
say() { echo; echo "== $1"; }
MAITIAN_REPO=${MAITIAN_REPO:-https://github.com/tzgzstudio-afk/mdldm-maitian.git}
PUBLISHER_REPO=${MAITIAN_PUBLISHER_REPO:-https://github.com/CzzzzzzJ/mdldm-maitian-publisher.git}

say "麦田 · 一行安装（装到 $DIR）"
if [ "$(uname -s)" = "Linux" ]; then
  echo "检测到 Linux。想要带 Node.js 22 的安装包，请按 docs/ubuntu.md 构建或安装 deb。下面仍会把源码克隆到 $DIR，开机自启用 systemd。"
fi
command -v git >/dev/null || { echo "需要 git。macOS：xcode-select --install；Ubuntu：sudo apt install git"; exit 1; }
if ! command -v node >/dev/null; then
  if [ "$(uname -s)" = "Linux" ]; then echo "需要 Node.js 22.5 以上。Ubuntu 建议安装 deb（docs/ubuntu.md，包内自带 Node）；或从 https://nodejs.org 安装 22.x。"; else echo "需要 Node.js 22.5 以上：brew install node，或去 https://nodejs.org 下载"; fi
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' || { echo "Node.js 版本是 $(node -v)，需要 22.5 以上"; exit 1; }

mkdir -p "$DIR"; cd "$DIR"
clone_one() { # $1 目录名  $2 仓库地址
  if [ -d "$1/.git" ]; then say "更新 $1"; git -C "$1" pull --ff-only -q; else
    say "下载 $1"; for i in 1 2 3; do git clone --depth 1 "$2" "$1" && break; echo "下载失败，第 $i 次重试"; rm -rf "$1"; sleep 3; done
    [ -d "$1/.git" ] || { echo "$1 下载失败，检查网络后重跑这条命令"; exit 1; }
  fi
}
clone_one mdldm-maitian "$MAITIAN_REPO"
clone_one mdldm-maitian-publisher "$PUBLISHER_REPO"

say "麦田发布助手（Chrome 插件）"
echo "Chrome 打开 chrome://extensions → 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选 $DIR/mdldm-maitian-publisher"
echo "（上架 Chrome 应用商店后也可以直接从商店安装）"

say "发布 skill"
L="$HOME/.claude/skills/maitian-publish"
if [ -e "$L" ] || [ -L "$L" ]; then echo "~/.claude/skills/maitian-publish 已经存在，没动它"
elif [ -d "$HOME/.claude/skills" ]; then ln -s "$DIR/mdldm-maitian/skills/maitian-publish" "$L"; echo "已链接到 ~/.claude/skills/maitian-publish（Claude Code 里说「整理发布」就会用上）"
else echo "没找到 ~/.claude/skills；用 Claude Code 的话，把 $DIR/mdldm-maitian/skills/maitian-publish 放进 ~/.claude/skills/"; fi

say "安装向导"
[ -t 0 ] || { echo "安装向导需要在终端里交互：cd $DIR/mdldm-maitian && node src/init.mjs"; exit 0; }
cd "$DIR/mdldm-maitian" && node src/init.mjs
