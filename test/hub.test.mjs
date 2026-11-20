import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function hub(dir, args) {
  const env = {
    ...process.env,
    MAITIAN_STATE: dir,
    MAITIAN_CONFIG: path.join(dir, 'config.json'),
    MAITIAN_DB: path.join(dir, 'data', 'hub.db'),
  };
  return spawnSync(process.execPath, [path.join(repo, 'src/hub.mjs'), ...args], { cwd: repo, env, encoding: 'utf8' });
}

test('分发计划、状态和人工标记不接触平台', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maitian-hub-'));
  const proj = path.join(dir, 'ep');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    name: '测试',
    rootPath: dir,
    web: { port: 8791, key: 'k' },
    keepAlive: [],
    driver: 'direct',
    manual: ['bilibili', 'douyin', 'xhs', 'channels'],
    auto: ['x', 'youtube', 'instagram'],
  }));
  fs.writeFileSync(path.join(proj, 'publish.json'), JSON.stringify({
    id: 'ep-test',
    episode: 1,
    name: '移植测试期',
    schedule: '2099-01-01T10:00:00.000Z',
    platforms: {
      bilibili: { title: '只登记不上传' },
      douyin: { title: '只登记不上传' },
      xhs: { title: '只登记不上传' },
      channels: { title: '只登记不上传' },
      youtube: { title: '只登记不上传' },
      instagram: { title: '只登记不上传' },
      x: { title: '只登记不上传', skip: '测试不发' },
    },
  }));
  const planned = hub(dir, ['plan', proj]);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  assert.match(planned.stdout, /已登记/);
  const again = hub(dir, ['plan', proj]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /已经登记/);
  const status = hub(dir, ['status', 'ep-test']);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.match(status.stdout, /移植测试期/);
  assert.match(status.stdout, /B站：计划中/);
  assert.match(status.stdout, /X：跳过/);
  const marked = hub(dir, ['mark', 'ep-test', 'bilibili', 'published', '本地标记', '--url', 'https://example.com/maitian-test']);
  assert.equal(marked.status, 0, marked.stdout + marked.stderr);
  assert.match(marked.stdout, /B站：已发布/);
  assert.match(marked.stdout, /example.com\/maitian-test/);
  const review = hub(dir, ['review', 'ep-test', '1']);
  assert.equal(review.status, 0, review.stdout + review.stderr);
  assert.match(review.stdout, /移植测试期|播放|B站/);
});

test('没有图形会话时拒绝启动专用 Chrome', () => {
  const r = spawnSync(process.execPath, [path.join(repo, 'test/helpers/no-display.mjs')], { encoding: 'utf8', env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no-display refused/);
});

test('专用 Chrome 调试端口可以在 about:blank 求值', { timeout: 60000 }, () => {
  const r = spawnSync(process.execPath, [path.join(repo, 'test/helpers/chrome-cdp.mjs')], { encoding: 'utf8', timeout: 50000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /cdp ok value=3/);
});

test('发布助手七个平台适配器能在 Linux 上加载', { timeout: 180000 }, () => {
  const r = spawnSync(process.execPath, [path.join(repo, 'test/helpers/load-publisher.mjs')], { encoding: 'utf8', timeout: 170000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /publisher loaded/);
  assert.match(r.stdout, /bilibili,xhs,douyin,channels,youtube,x,instagram/);
});
