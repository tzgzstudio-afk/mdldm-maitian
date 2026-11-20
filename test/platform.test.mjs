import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromeBinary, cifsOptions, linuxMountPoint, makeThumbnail, parseSmbUrl, ensureNasMounted } from '../src/platform.mjs';

test('smb 地址解析不把密码写进挂载参数', () => {
  const parsed = parseSmbUrl('smb://demo:s3cret@192.168.1.10/%E8%A7%86%E9%A2%91');
  assert.equal(parsed.user, 'demo');
  assert.equal(parsed.password, 's3cret');
  assert.equal(parsed.host, '192.168.1.10');
  assert.equal(parsed.share, '视频');
  const opts = cifsOptions({ user: parsed.user, credentials: '/tmp/cred', version: '3.0' });
  assert.equal(opts.some((x) => x.startsWith('credentials=')), true);
  assert.equal(opts.join(',').includes('s3cret'), false);
  assert.throws(() => parseSmbUrl('https://example.com/share'), /smb:/);
});

test('Linux 挂载点跟着共享名走，也可以被 nasMount 覆盖', () => {
  const parsed = parseSmbUrl('smb://demo@nas.local/video');
  assert.equal(linuxMountPoint({ rootPath: '/mnt/video/导出' }, parsed), '/mnt/video');
  assert.equal(linuxMountPoint({ rootPath: '/data/projects', nasMount: '/mnt/nas' }, parsed), '/mnt/nas');
});

test('已经能读到发布目录时不再尝试挂载', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maitian-nas-'));
  assert.equal(await ensureNasMounted({ rootPath: dir }), true);
  const missing = path.join(dir, 'missing');
  assert.equal(await ensureNasMounted({ rootPath: missing }), false);
});

test('能找到本机 Chrome', () => {
  const bin = chromeBinary({});
  assert.equal(fs.existsSync(bin), true);
  assert.match(bin, /chrome|chromium/i);
  const prev = process.env.MAITIAN_CHROME;
  process.env.MAITIAN_CHROME = '/no/such/chrome';
  assert.throws(() => chromeBinary({}), /不存在/);
  if (prev === undefined) delete process.env.MAITIAN_CHROME; else process.env.MAITIAN_CHROME = prev;
});

test('ffmpeg 能把图缩成 jpeg', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maitian-thumb-'));
  const src = path.join(dir, 'in.png');
  const dest = path.join(dir, 'out.jpg');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x200', '-frames:v', '1', src], { stdio: 'ignore' });
  makeThumbnail(src, dest, 80);
  const buf = fs.readFileSync(dest);
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
  assert.ok(buf.length > 100);
});

test('源码语法检查', () => {
  const files = fs.readdirSync('src').filter((f) => f.endsWith('.mjs'));
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', path.join('src', f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, f + '\n' + r.stderr);
  }
  for (const sh of ['scripts/build-deb.sh', 'scripts/install-systemd.sh', 'scripts/install.sh', 'packaging/maitian-bin.sh']) {
    const r = spawnSync('bash', ['-n', sh], { encoding: 'utf8' });
    assert.equal(r.status, 0, sh + '\n' + r.stderr);
  }
});
