// 没有图形会话时必须直接失败，不能改用无头浏览器假装能登录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maitian-headless-'));
const port = 25000 + Math.floor(Math.random() * 10000);
process.env.MAITIAN_STATE = root;
process.env.MAITIAN_CONFIG = path.join(root, 'config.json');
process.env.MAITIAN_DB = path.join(root, 'data', 'hub.db');
fs.writeFileSync(process.env.MAITIAN_CONFIG, JSON.stringify({
  name: 'headless', chromePort: port, chromeProfile: path.join(root, 'profile'), rootPath: root, web: { port: 8790, key: 'h' }, keepAlive: [],
}));
const { launchChrome } = await import('../../src/chrome-shim.mjs');
try {
  await launchChrome();
  console.error('没有显示器时不应该把 Chrome 拉起来');
  process.exit(1);
} catch (e) {
  if (!/图形会话/.test(e.message)) { console.error(e); process.exit(1); }
  console.log('no-display refused');
}
