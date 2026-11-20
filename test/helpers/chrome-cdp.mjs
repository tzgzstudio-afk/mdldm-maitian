// 启动专用 Chrome，连上调试端口，在 about:blank 里求值。不打开任何平台页面。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maitian-cdp-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const profile = path.join(root, 'profile');
process.env.MAITIAN_STATE = root;
process.env.MAITIAN_CONFIG = path.join(root, 'config.json');
process.env.MAITIAN_DB = path.join(root, 'data', 'hub.db');
fs.writeFileSync(process.env.MAITIAN_CONFIG, JSON.stringify({
  name: 'cdp-test',
  chromePort: port,
  chromeProfile: profile,
  rootPath: root,
  web: { port: port + 1, key: 'cdp' },
  keepAlive: [],
  driver: 'direct',
}));

let failed = 0;
try {
  const { chrome, launchChrome, closeConnection } = await import('../../src/chrome-shim.mjs');
  await launchChrome();
  const tab = await chrome.tabs.create({ url: 'about:blank' });
  await chrome.debugger.attach({ tabId: tab.id });
  const evaluated = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', { expression: '1+2', returnByValue: true });
  if (!evaluated.result || evaluated.result.value !== 3) {
    console.error('evaluate', JSON.stringify(evaluated));
    failed = 1;
  } else console.log(`cdp ok value=${evaluated.result.value} port=${port}`);
  await chrome.tabs.remove(tab.id).catch(() => {});
  closeConnection();
} catch (e) {
  console.error(e && e.stack || e);
  failed = 1;
} finally {
  try { execFileSync('pkill', ['-f', profile], { stdio: 'ignore' }); } catch { /* 进程已经退出 */ }
}
process.exit(failed);
