# 麦田在 Ubuntu 上的安装和构建

本文说明怎么在 Ubuntu 上从源码构建 deb、安装、启动，以及哪些功能已经在构建环境里验证、哪些必须用你自己的账号和桌面再确认。

macOS 的 launchd 安装、`sips` 缩略图和钥匙串挂载都还在，没有删。

## 实际测试环境

| 项 | 值 |
|---|---|
| 构建和安装 | Ubuntu 24.04.5 LTS，x86_64（amd64） |
| 桌面 | 有 `DISPLAY=:1` 的图形会话 |
| 浏览器 | Google Chrome 157.0.8103.50（`/usr/bin/google-chrome-stable`） |
| 包内运行时 | 官方 Node.js 22.23.4 linux-x64，校验和见 `scripts/build-deb.sh` |
| 声明可安装的系统 | Ubuntu 22.04 和 24.04 的 amd64 |

22.04 没有在另一台机器上再装一遍。包不依赖 Ubuntu 源里的 `nodejs`（22.04 和 24.04 都低于 22.5，没有可用的 `node:sqlite`），所以 22.04 只要能安装这个 deb、systemd 和 Chrome，运行时版本是一样的。arm64 没有打过包。

没有生成 AppImage。deb 能安装并完成下面的冒烟，就不再做第二种包。

## 许可证和依赖

- 本仓库：MIT，版权归原作者。
- 麦田发布助手 `mdldm-maitian-publisher`：Apache-2.0。用户这边没有这个仓库的 fork，deb **不内置**它的代码。分发、体检、取链接仍然加载你本机克隆的那份 `lib/`。
- Node.js：官方 linux-x64 构建，随包放在 `/opt/maitian/node`，许可证在 `/opt/maitian/node/LICENSE`。
- Chrome / Chromium：不放进 deb。Google Chrome 不在 Ubuntu 官方源里，需要你自己安装。
- 建议同时安装：`ffmpeg`（封面缩略图）、`cifs-utils`（NAS）、`gvfs`（桌面 SMB）、`xdg-utils`、`xdotool`（把专用 Chrome 窗口带到前台）。

## 功能覆盖

| 功能 | Ubuntu 上的做法 | 本次验证 |
|---|---|---|
| 网页大屏、口令、演示数据 | 与原来相同，`maitian demo` / `maitian web` | 源码和安装后的包都打开过页面并读到演示 JSON |
| SQLite（`node:sqlite`） | 包内 Node 22.23.4 | 计划、状态、标记写入临时库 |
| 分发计划、人工标记、复盘文本 | 原命令 | 用假工程登记，不上传 |
| 守护进程 | systemd 用户服务，对应原来的 launchd | `systemd-analyze verify` 通过。这台构建机没有 `/run/user`，`systemctl --user` 连不上用户总线，所以没有 enable。直接运行单元里的 `maitian daemon`：网页无口令 401、带口令 200，日志里没有访问任何平台 |
| 专用 Chrome（CDP 9333） | 自动找 `google-chrome-stable` / `chromium`，调试端口允许本机 Node 连接 | 启动 Chrome，只打开 `about:blank`，算式结果为 3，然后关掉 |
| 无桌面 | 直接报错，不用无头模式冒充 | 已测到拒绝启动 |
| B站、抖音、小红书、视频号、YouTube、X、Instagram 的填写、提交、采数 | 仍调用发布助手里原来的适配器 | 在 Linux 上加载了 `cb231fad1060032e743714d72caf28ac8a1f06d7` 的 `lib/publish.js`，七个适配器都有 `url` 和 `fill`。没有打开平台、没有登录、没有上传、没有发帖。安装时克隆的是默认分支，不锁定这次提交 |
| 国内平台最后一下手点发布 | 保持原逻辑 | 未做 |
| 飞书通知、飞书验证码登录、多维表格 | 代码路径还在 | **没有发送任何消息**，也没有填写 webhook |
| NAS | macOS 仍用 `osascript` + `diskutil`；Linux 先 `gio mount`，不行再 `mount.cifs`（密码只进权限 600 的凭据文件） | 目录已经存在时直接返回成功。这台机器没有 NAS，没有做过真实挂载 |
| 缩略图 | macOS 用 `sips`；Linux 用 `ffmpeg`，没有再用 ImageMagick | 用 ffmpeg 生成过一张 JPEG |
| 远程隧道 | `cloudflared` 改为在常见路径和 `PATH` 里找 | 没有启动隧道，没有对外发布地址 |
| X 长文 + 引用视频帖 | 仍调用发布助手的 `tools/x-article-quote.mjs`；防休眠从 `caffeinate` 换成 `systemd-inhibit` | 没有运行这条会发帖的脚本 |
| iPhone 小组件 | 仍是 Scriptable，和桌面系统无关 | 未在手机上验证 |
| 自有站点转化 | 仍看 `config.site`，不配就关闭 | 未接真实站点 |

构建成功只说明包和上述自动测试通过。它不等于七个平台的发布和采集在你的账号里可用。

## 从源码构建 deb

在仓库根目录：

```bash
sudo apt update
sudo apt install -y curl xz-utils dpkg-dev ffmpeg cifs-utils gvfs xdg-utils xdotool
bash scripts/build-deb.sh
```

脚本会：

1. 下载 `https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz`
2. 用写在脚本里的 SHA256 核对压缩包
3. 把源码、systemd 单元、桌面入口和 Node 打进 `dist/maitian_0.3.0-1_amd64.deb`
4. 在同目录写下 `.sha256`

不需要根权限来构建。安装才需要。

只跑自动测试、不打包装：

```bash
# 需要本机已有 Node.js >= 22.5、ffmpeg，以及一台有图形会话的 Chrome
npm test
```

`npm test` 会克隆公开的发布助手仓库到 `/tmp/mdldm-maitian-publisher` 做模块加载。那次克隆只读，不推送、不改上游。

## 安装

```bash
sudo apt install -y ./dist/maitian_0.3.0-1_amd64.deb
# 如果 apt 不肯装本地文件：
sudo dpkg -i dist/maitian_0.3.0-1_amd64.deb
sudo apt-get install -f
```

安装结果：

- 命令：`maitian`
- 程序：`/opt/maitian`（root 所有，不要把配置写进去）
- 配置、数据库、专用 Chrome 档案：`~/.local/share/maitian/`
- 用户服务：`/usr/lib/systemd/user/maitian.service` 和 `maitian-tunnel.service`
- 桌面入口：应用程序菜单里的「麦田」

卸载不会删除 `~/.local/share/maitian`。那是你的配置和登录态。

## 第一次使用

发布助手仍要单独准备（Apache-2.0）：

```bash
git clone --depth 1 https://github.com/CzzzzzzJ/mdldm-maitian-publisher.git ~/mdldm-maitian-publisher
```

在 Chrome 打开 `chrome://extensions`，打开开发者模式，加载这个目录。插件方式（`driver: "plugin"`）还需要在日常 Chrome 里加载同一份扩展。

然后：

```bash
maitian init
```

向导会问发布助手路径、成片目录、NAS、飞书 webhook、网页端口。不知道就回车。它把 `config.json` 写到 `~/.local/share/maitian/config.json`，网页口令也打印在终端里。

Linux 上如果发布工程在 SMB 共享里：

- `nasUrl` 用 `smb://用户名@主机/共享名`。不要把密码放进这个 URL；密码写在 `nasCredentials` 指向的文件里（`username=`、`password=`、`domain=` 三行，权限 `600`）。
- `nasMount` 是挂载点，例如 `/mnt/nas`。`rootPath` 必须落在这个挂载点下面，例如 `/mnt/nas/视频导出`。
- 挂载点目录必须是空的，否则不会执行 `mount`，避免盖住已有文件。
- 桌面会话里会先试 `gio mount`。服务器上更稳妥的是在 `/etc/fstab` 里用 CIFS 挂好，让 `rootPath` 开机就存在。
- `nasVersion` 默认 `3.0`。旧 NAS 不通时再改成 `2.1`。

装守护进程（要在图形登录的同一个用户下）：

```bash
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS
systemctl --user enable --now maitian.service
sudo loginctl enable-linger "$USER"    # 只有希望重启后、尚未打开桌面时也启动服务才需要
journalctl --user -u maitian.service -f
```

没有 `DISPLAY` / `WAYLAND_DISPLAY` 时，服务仍然可以提供已经入库的网页，但登录、体检、填写发布页会失败。这是故意的：无头 Chrome 填不了这些上传页，也不能让你扫码。

打开网页：

```bash
maitian open          # 用配置里的端口和口令打开本机浏览器
maitian web           # 只开网页，不跑定时采集。不要和 daemon 同时占一个端口
maitian demo          # 假数据，端口 8788，口令 demo，不读你的 config.json
```

常用命令和原来一样，只是把 `node src/hub.mjs` 换成 `maitian`：

```bash
maitian doctor
maitian plan <工程目录>
maitian run <工程目录>
maitian status
maitian sync <id>
maitian adopt <工程目录>
maitian metrics
maitian followers
```

远程隧道可选。先安装 cloudflared，再：

```bash
systemctl --user enable --now maitian-tunnel.service
```

固定域名的配法和原来的 README 相同（`config.tunnel.name` / `hostname`）。不配就用每次变化的 trycloudflare 地址。本次构建没有启动它。

## 和 macOS 的差别

- 开机自启是 systemd 用户服务，不是 `~/Library/LaunchAgents`。
- 专用 Chrome 的可执行文件自动查找；也可以设 `chromeBin` 或环境变量 `MAITIAN_CHROME`。
- Chrome 111 之后，Node 连接调试端口需要 `--remote-allow-origins=*`。Linux 和 macOS 现在都会加这个参数。
- 缩略图在 Linux 上用 ffmpeg。
- NAS 不再调用 `osascript`。
- 长任务防休眠用 `systemd-inhibit`。没有这个命令时任务仍会跑，但拦不住休眠。
- 把窗口拉到前台依赖 `xdotool` 或 `wmctrl`。没有它们时窗口还是会打开，只是不一定到最前。
- 发布助手的一次性锁仍写在程序目录的 `state/`。deb 把 `/opt/maitian/state` 做成粘滞目录，给这个锁用。

## 不要在这次移植里做的事

- 不向 B站、抖音、小红书、视频号、YouTube、X、Instagram 发帖或上传。
- 不使用你的平台账号、Cookie 或密码。
- 不向飞书发消息。
- 不把这个 deb 发布成 GitHub Release，也不合并 PR。

登录、扫码、点「发布 / 定时发布」、核对真实播放数，都要你在自己的桌面和账号上做。建议顺序：`maitian demo` 看大屏，`maitian doctor` 看七个平台是否已登录，再用一个不会公开的测试工程跑 `maitian run`。
