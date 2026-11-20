// 通过插件的开发桥（tools/bridge-server.mjs + 面板页）指挥 Chrome
import { spawn } from 'node:child_process';
import { config } from './feishu.mjs';
import { openInChrome } from './platform.mjs';
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function call(cmd, timeout = 30000) {
  const r = await fetch(`${config.bridge}/cmd`, { method: 'POST', body: JSON.stringify(cmd), signal: AbortSignal.timeout(timeout) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}
export async function evaluate(tabId, expression, timeout = 30000) {
  const r = await call({ op: 'cdp', tabId, method: 'Runtime.evaluate', timeout, params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }, timeout + 5000);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
export const panel = (name, args = [], timeout = 60000) => call({ op: 'panel', name, args }, timeout);
const ping = () => call({ op: 'ping' }, 8000).then(() => true, () => false);

// 确保桥接服务在跑、插件面板页开着
export async function ensureBridge() {
  let listening = true;
  try { await fetch(config.bridge, { signal: AbortSignal.timeout(2000) }); } catch { listening = false; }
  if (!listening) {
    spawn(process.execPath, ['tools/bridge-server.mjs'], { cwd: config.pluginDir, detached: true, stdio: 'ignore' }).unref();
    await sleep(1500);
  }
  if (await ping()) return;
  openInChrome(`chrome-extension://${config.extensionId}/sidepanel.html`, { background: true });
  for (let i = 0; i < 10; i++) { await sleep(2000); if (await ping()) return; }
  throw new Error('插件面板没有响应：Chrome 可能有弹窗卡住，或插件没加载');
}
// 打开一个后台页，等 ready 表达式为真，执行 fn，再关掉
export async function withTab(url, fn, { wait = 8000 } = {}) {
  const id = await call({ op: 'open', url });
  try { await sleep(wait); return await fn(id); }
  finally { await call({ op: 'close', tabIds: [id] }, 10000).catch(() => {}); }
}
