// 专用 Chrome 的直连驱动：用调试端口实现插件代码依赖的那几个 chrome.* 接口，
// 这样 麦田发布助手（插件）lib 下的适配器不用改就能在中控进程里跑。
import { spawn } from 'node:child_process';
import os from 'node:os'; import fs from 'node:fs';
import { config } from './feishu.mjs';
import { chromeBinary, bringToFront, listeningPid } from './platform.mjs';

const PORT = config.chromePort || 9333;
const PROFILE = (config.chromeProfile || '~/publish-hub/chrome-profile').replace(/^~/, os.homedir());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let ws = null, seq = 0;
const waiting = new Map();            // id -> {resolve, reject}
const tabs = new Map();               // tabId -> {targetId, sessionId}
const byTarget = new Map();           // targetId -> tabId
let nextTab = 1000;

const version = () => fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());

// 启动专用 Chrome（已经在跑就直接用）。foreground=true 时把窗口带到前台（登录用）
export async function launchChrome({ foreground = false } = {}) {
  const bin = chromeBinary(config);
  try { await version(); } catch {
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error('没有图形会话（DISPLAY 和 WAYLAND_DISPLAY 都为空）。登录和填写发布页需要桌面；已经采到库里的大屏不依赖 Chrome。');
    }
    fs.mkdirSync(PROFILE, { recursive: true });
    const args = [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-dev-shm-usage', '--window-size=1500,1000'];
    if (process.platform === 'linux') args.push('--class=maitian-chrome');
    spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 30; i++) { await sleep(500); try { await version(); break; } catch { if (i === 29) throw new Error(`专用 Chrome 没启动起来（${bin}，端口 ${PORT}）`); } }
  }
  if (foreground) bringToFront(await pid());
}
async function pid() { return listeningPid(PORT); }

let connecting = null;
function connect() {
  if (ws && ws.readyState === 1) return Promise.resolve();
  return (connecting ||= doConnect().finally(() => { connecting = null; }));
}
async function doConnect() {
  await launchChrome();
  const v = await version();
  const sock = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('连不上专用 Chrome 的调试端口')); });
  ws = sock;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
      return;
    }
    // 「离开此网站？」等弹窗：自动点离开，不让它卡住浏览器
    if (m.method === 'Page.javascriptDialogOpening' && m.sessionId) raw('Page.handleJavaScriptDialog', { accept: true }, m.sessionId).catch(() => {});
    if (m.method === 'Target.targetDestroyed') { const t = byTarget.get(m.params.targetId); if (t) { tabs.delete(t); byTarget.delete(m.params.targetId); } }
  };
  ws.onclose = () => { ws = null; for (const w of waiting.values()) w.reject(new Error('专用 Chrome 断开了')); waiting.clear(); tabs.clear(); byTarget.clear(); };
  await raw('Target.setDiscoverTargets', { discover: true });
}
function raw(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++seq; waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(`${method} 超时`)); } }, 180000).unref();
  });
}
function tabOf(id) { const t = tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}.`); return t; }
async function session(id) {
  const t = tabOf(id);
  if (!t.sessionId) {
    t.sessionId = (await raw('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
    await raw('Page.enable', {}, t.sessionId).catch(() => {});
  }
  return t.sessionId;
}

export const chrome = {
  runtime: { id: 'publish-hub' },
  scripting: { executeScript: async () => { throw new Error('专用 Chrome 里不支持 scripting'); } },
  tabs: {
    async create({ url, active = false }) {
      await connect();
      const { targetId } = await raw('Target.createTarget', { url: url || 'about:blank', background: !active });
      const id = nextTab++; tabs.set(id, { targetId }); byTarget.set(targetId, id);
      return { id, url, windowId: 1 };
    },
    async get(id) {
      await connect();
      const { targetInfo } = await raw('Target.getTargetInfo', { targetId: tabOf(id).targetId });
      return { id, url: targetInfo.url, title: targetInfo.title, windowId: 1 };
    },
    async query() { return []; },
    async update(id, { active } = {}) { await connect(); if (active) await raw('Target.activateTarget', { targetId: tabOf(id).targetId }); return { id }; },
    async remove(ids) {
      await connect();
      for (const id of [].concat(ids)) { const t = tabs.get(id); if (!t) continue; await session(id).catch(() => {}); await raw('Target.closeTarget', { targetId: t.targetId }).catch(() => {}); }
    },
  },
  debugger: {
    onDetach: { addListener() {} },
    async attach({ tabId }) { await connect(); await session(tabId); },
    async detach() { /* 会话留着，后面的回读和提交还要用 */ },
    async sendCommand({ tabId }, method, params = {}) { await connect(); return raw(method, params, await session(tabId)); },
  },
};
// 认领专用 Chrome 里已经开着的页面（别的进程填好的发帖页），返回本进程可用的 tabId
export async function adoptTargets(re) {
  await connect();
  const { targetInfos } = await raw('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && re.test(t.url)).map(t => {
    let id = byTarget.get(t.targetId);
    if (id == null) { id = nextTab++; tabs.set(id, { targetId: t.targetId }); byTarget.set(t.targetId, id); }
    return id;
  });
}
export function closeConnection() { if (ws) { ws.onclose = null; ws.close(); ws = null; } }
