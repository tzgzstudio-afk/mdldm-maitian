// 麦田公网隧道 → 拿到 https 地址 → 存 data/tunnel.json（飞书卡片里的「打开麦田」用它）+ 地址变了推飞书
// 两种模式：
//  - 固定域名（推荐）：config.tunnel = { name, hostname }，先 `cloudflared tunnel login`、`cloudflared tunnel create <name>`、
//    `cloudflared tunnel route dns <name> <hostname>`。地址永远不变。
//  - 快速隧道（默认）：没配 config.tunnel 时用 trycloudflare.com，不用账号，但每次重启地址都会变。
import { spawn } from 'child_process';
import fs from 'fs'; import path from 'path';
import { notify, config } from './feishu.mjs';
import { STATE_ROOT, ensureState } from './paths.mjs';
import { cloudflaredBin } from './platform.mjs';
ensureState();
const OUT = path.join(STATE_ROOT, 'data', 'tunnel.json');
const port = config.web?.port || 8787, key = config.web?.key;
const named = config.tunnel?.name && config.tunnel?.hostname;
const CF = cloudflaredBin(config.tunnel?.bin);
if (!CF) { console.error('没找到 cloudflared。macOS 可用 brew install cloudflared；Ubuntu 可安装官方 deb 或 snap，也可以在 config.json 的 tunnel.bin 写绝对路径。'); process.exit(1); }
// QUIC 在不少网络下被拦，统一走 http2
const args = named
  ? ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--url', `http://127.0.0.1:${port}`, config.tunnel.name]
  : ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', '--protocol', 'http2'];
const cf = spawn(CF, args, { stdio: ['ignore', 'pipe', 'pipe'] });

async function publish(base) {
  const url = named && (config.web?.access || config.web?.login === 'feishu') ? base : `${base}/?key=${key}`;   // 有登录页就不用带口令
  let prev = null; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')).url; } catch {}
  fs.writeFileSync(OUT, JSON.stringify({ url, base, at: new Date().toISOString(), mode: named ? 'named' : 'quick' }, null, 2));
  if (prev !== url) await notify(`🌐 麦田远程地址${named ? '（固定，不会再变）' : ''}：${url}`).catch(e => console.error(e.message));
}
let sent = false;
const onData = async (buf) => {
  const s = buf.toString(); process.stdout.write(s);
  if (sent) return;
  if (named && /Registered tunnel connection/.test(s)) { sent = true; await publish(`https://${config.tunnel.hostname}`); }
  const m = !named && s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m) { sent = true; await publish(m[0]); }
};
cf.stdout.on('data', onData); cf.stderr.on('data', onData);
cf.on('exit', (c) => { console.error('cloudflared 退出', c); process.exit(1); });
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { cf.kill(); process.exit(0); });
