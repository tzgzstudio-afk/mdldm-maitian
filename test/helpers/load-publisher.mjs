// 只加载发布助手的适配器模块，确认 Linux 上的 Node 能把它和 chrome shim 接上。
// 不调用 preflight / run / collectLinks，因此不会打开平台页面，也不会发帖。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = '/tmp/mdldm-maitian-publisher';
if (!fs.existsSync(path.join(dir, 'lib/publish.js'))) {
  execFileSync('git', ['clone', '--depth', '1', 'https://github.com/CzzzzzzJ/mdldm-maitian-publisher.git', dir], { stdio: 'inherit', timeout: 180000 });
}
const rev = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maitian-pub-'));
process.env.MAITIAN_STATE = root;
process.env.MAITIAN_CONFIG = path.join(root, 'config.json');
process.env.MAITIAN_DB = path.join(root, 'data', 'hub.db');
fs.writeFileSync(process.env.MAITIAN_CONFIG, JSON.stringify({
  name: 'publisher-load', pluginDir: dir, rootPath: root, web: { port: 8792, key: 'p' }, keepAlive: [], driver: 'direct',
}));
const shim = await import('../../src/chrome-shim.mjs');
globalThis.chrome = shim.chrome;
const pub = await import(pathToFileURL(path.join(dir, 'lib/publish.js')).href);
const need = ['bilibili', 'xhs', 'douyin', 'channels', 'youtube', 'x', 'instagram'];
for (const id of need) {
  const ad = pub.ADAPTERS && pub.ADAPTERS[id];
  if (!ad || !ad.url || typeof ad.fill !== 'function') {
    console.error('适配器不完整', id);
    process.exit(1);
  }
}
if (typeof pub.preflight !== 'function' || typeof pub.run !== 'function' || typeof pub.collectLinks !== 'function') {
  console.error('publish.js 缺少 preflight/run/collectLinks');
  process.exit(1);
}
console.log(`publisher loaded rev=${rev} adapters=${need.join(',')}`);
