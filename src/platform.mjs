// 把原来写死在 macOS 上的启动、挂载、缩略图和防休眠换成当前系统真正能做的事。
// Linux 分支会实际调用 Chrome、ffmpeg、gio/mount.cifs、systemd-inhibit；缺了工具就报错，不用空函数假装成功。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_ROOT, ensureState } from './paths.mjs';

export function which(cmd) {
  if (!cmd) return '';
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : '';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* 继续找 */ }
  }
  return '';
}

const LINUX_CHROME = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

export function chromeBinary(config = {}) {
  const explicit = process.env.MAITIAN_CHROME || config.chromeBin;
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    throw new Error(`配置的 Chrome 不存在：${explicit}`);
  }
  if (process.platform === 'darwin') {
    const mac = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ].find((p) => fs.existsSync(p));
    if (mac) return mac;
  }
  if (process.platform === 'linux') {
    const hit = LINUX_CHROME.find((p) => fs.existsSync(p));
    if (hit) return hit;
    for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
      const w = which(name);
      if (w) return w;
    }
  }
  throw new Error('没找到 Google Chrome 或 Chromium。Ubuntu 请安装 google-chrome-stable，或在 config.json 里设置 chromeBin。');
}

export function cloudflaredBin(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const c of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/snap/bin/cloudflared']) {
    if (fs.existsSync(c)) return c;
  }
  return which('cloudflared');
}

export function listeningPid(port) {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (out) return out.split('\n').find(Boolean) || '';
  } catch { /* 没有 lsof，或这个端口没人听 */ }
  const ss = which('ss');
  if (ss) {
    try {
      const out = execFileSync(ss, ['-ltnp', `sport = :${port}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const m = out.match(/pid=(\d+)/);
      if (m) return m[1];
    } catch { /* ss 失败就当没找到 */ }
  }
  return '';
}

export function bringToFront(pid) {
  if (!pid) return;
  if (process.platform === 'darwin') {
    try { execFileSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`], { stdio: 'ignore' }); } catch { /* 不影响登录 */ }
    return;
  }
  if (process.platform !== 'linux' || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) return;
  const xdo = which('xdotool');
  if (xdo) {
    try {
      execFileSync(xdo, ['search', '--class', 'maitian-chrome', 'windowactivate'], { stdio: 'ignore' });
      return;
    } catch { /* 窗口类名还没出现时再按 pid 找 */ }
    try {
      const ids = execFileSync(xdo, ['search', '--pid', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').filter(Boolean);
      if (ids.length) { execFileSync(xdo, ['windowactivate', ids[ids.length - 1]], { stdio: 'ignore' }); return; }
    } catch { /* 下面再试 wmctrl */ }
  }
  const wm = which('wmctrl');
  if (wm) { try { execFileSync(wm, ['-a', 'maitian-chrome'], { stdio: 'ignore' }); } catch { /* 窗口已经在，只是没置前 */ } }
}

// 打开日常 Chrome（不带专用 profile），给插件侧边栏用。macOS 的 open -g 仍走系统 Chrome。
export function openInChrome(url, { background = false } = {}) {
  if (process.platform === 'darwin') {
    execFileSync('open', [...(background ? ['-g'] : []), '-a', 'Google Chrome', url], { stdio: 'pipe' });
    return;
  }
  const bin = chromeBinary();
  const child = spawn(bin, [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

export function openLocal(url) {
  if (process.platform === 'darwin') {
    execFileSync('open', [url], { stdio: 'ignore' });
    return true;
  }
  const xdg = which('xdg-open');
  if (xdg && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    const child = spawn(xdg, [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  }
  return false;
}

// 长文脚本在 macOS 上用 caffeinate 防止休眠。Linux 用 systemd-inhibit；没有时照常跑，并说明没拦住休眠。
export function spawnAwake(command, args, opts) {
  if (process.platform === 'darwin') return spawn('caffeinate', ['-dims', command, ...args], opts);
  const inh = which('systemd-inhibit');
  if (inh) return spawn(inh, ['--what=idle:sleep', '--who=maitian', '--why=麦田发布任务', '--mode=block', command, ...args], opts);
  console.error('没找到 systemd-inhibit，这次任务不会阻止系统休眠');
  return spawn(command, args, opts);
}

export function makeThumbnail(src, dest, width) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const w = String(Math.max(1, Math.round(Number(width) || 720)));
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sips')) {
    execFileSync('/usr/bin/sips', ['-Z', w, '-s', 'format', 'jpeg', '-s', 'formatOptions', '78', src, '--out', dest], { stdio: 'ignore', timeout: 20000 });
    return dest;
  }
  const ff = which('ffmpeg');
  if (ff) {
    // 长边不超过 w，和 sips -Z 一样；宽高取偶数，避免 yuv420 编码器拒绝。
    const scale = `scale=trunc(iw*min(1\\,${w}/max(iw\\,ih))/2)*2:trunc(ih*min(1\\,${w}/max(iw\\,ih))/2)*2`;
    execFileSync(ff, ['-y', '-i', src, '-vf', scale, '-q:v', '5', dest], { stdio: 'ignore', timeout: 20000 });
    return dest;
  }
  const magick = which('magick') || which('convert');
  if (magick) {
    execFileSync(magick, [src, '-resize', `${w}x${w}>`, '-quality', '78', dest], { stdio: 'ignore', timeout: 20000 });
    return dest;
  }
  throw new Error('没有可用的缩略图工具。macOS 用 sips；Ubuntu 请安装 ffmpeg 或 imagemagick。');
}

export function parseSmbUrl(nasUrl) {
  let u;
  try { u = new URL(nasUrl); } catch { throw new Error('nasUrl 不是合法地址'); }
  if (u.protocol !== 'smb:') throw new Error('nasUrl 需要 smb:// 开头');
  const segs = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  if (!u.hostname || !segs[0]) throw new Error('nasUrl 需要包含主机和共享名，例如 smb://用户名@192.168.1.10/共享名');
  return { user: u.username || '', password: u.password || '', host: u.hostname, share: segs[0], subpath: segs.slice(1).join('/') };
}

export function linuxMountPoint(config, parsed) {
  if (config.nasMount) return config.nasMount;
  const parts = String(config.rootPath || '').split('/').filter(Boolean);
  const idx = parts.findIndex((p) => p === parsed.share);
  if (idx >= 0) return `/${parts.slice(0, idx + 1).join('/')}`;
  return path.join('/mnt', parsed.share);
}

export function cifsOptions({ user = '', credentials = '', uid = process.getuid?.() || 0, gid = process.getgid?.() || 0, version = '3.0' } = {}) {
  const opts = [`uid=${uid}`, `gid=${gid}`, 'iocharset=utf8', 'file_mode=0644', 'dir_mode=0755', `vers=${version || '3.0'}`];
  if (credentials) opts.push(`credentials=${credentials}`);
  else if (user) opts.push(`username=${user}`);
  else opts.push('guest');
  return opts;
}

function isMount(p) {
  let target;
  try { target = fs.realpathSync(p); } catch { target = path.resolve(p); }
  try {
    return fs.readFileSync('/proc/mounts', 'utf8').split('\n').some((line) => {
      const mnt = (line.split(' ')[1] || '').replace(/\\040/g, ' ');
      return mnt === target || mnt === path.resolve(p);
    });
  } catch { return false; }
}

function umount(p) {
  try { execFileSync('umount', [p], { stdio: 'pipe', timeout: 20000 }); return; } catch { /* 再试免密 sudo */ }
  try { execFileSync('sudo', ['-n', 'umount', p], { stdio: 'pipe', timeout: 20000 }); }
  catch (e) { console.error(`卸载 ${p} 失败：${(e.stderr || e.message || '').toString().slice(0, 200)}`); }
}

function mountCifs(parsed, mountPoint, credFile, version) {
  const remote = `//${parsed.host}/${parsed.share}`;
  const opts = cifsOptions({ user: parsed.user, credentials: credFile, version });
  const args = ['-t', 'cifs', remote, mountPoint, '-o', opts.join(',')];
  try { execFileSync('mount', args, { stdio: 'pipe', timeout: 25000 }); return; } catch { /* 普通用户通常没有 mount 权限 */ }
  execFileSync('sudo', ['-n', 'mount', ...args], { stdio: 'pipe', timeout: 25000 });
}

function credentialFile(parsed, config) {
  if (config.nasCredentials && fs.existsSync(config.nasCredentials)) return { file: config.nasCredentials, temp: false };
  const saved = path.join(STATE_ROOT, 'smb-credentials');
  if (!parsed.password && fs.existsSync(saved)) return { file: saved, temp: false };
  if (!parsed.password && !parsed.user) return { file: '', temp: false };
  if (/[\r\n]/.test(parsed.user) || /[\r\n]/.test(parsed.password)) throw new Error('NAS 用户名或密码不能包含换行');
  ensureState();
  const file = path.join(STATE_ROOT, 'data', `.smb-${process.pid}.cred`);
  const lines = [`username=${parsed.user || 'guest'}`, `password=${parsed.password || ''}`, 'domain='];
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return { file, temp: true };
}

function unmountSiblings(mountPoint, rootPath) {
  const parent = path.dirname(mountPoint);
  const base = path.basename(mountPoint);
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(`${base}-`)) continue;
    const alt = path.join(parent, name);
    const rel = path.relative(mountPoint, rootPath);
    if (rel.startsWith('..')) continue;
    if (!fs.existsSync(path.join(alt, rel))) continue;
    console.log(`NAS 挂到了 ${alt}，卸掉重挂`);
    umount(alt);
  }
}

function ensureNasLinux(config, ok) {
  let parsed = null;
  if (config.nasUrl) {
    try { parsed = parseSmbUrl(config.nasUrl); }
    catch (e) { console.error(e.message); return false; }
  }
  if (!parsed && !config.nasMount) {
    console.error(`读不到 ${config.rootPath}，也没有 nasUrl。可以先在系统里挂好，或在 config.json 填写 nasUrl。`);
    return false;
  }
  const mountPoint = config.nasMount || linuxMountPoint(config, parsed);
  try { unmountSiblings(mountPoint, config.rootPath); } catch (e) { console.error('处理 NAS 挂载点出错：' + e.message); }
  if (ok()) return true;
  if (config.nasUrl && which('gio')) {
    const gioUrl = parsed && parsed.password
      ? `smb://${encodeURIComponent(parsed.user)}@${parsed.host}/${encodeURIComponent(parsed.share)}`
      : config.nasUrl;
    try { execFileSync('gio', ['mount', gioUrl], { stdio: 'pipe', timeout: 25000 }); }
    catch (e) { console.error(`gio mount 没挂上：${(e.stderr || e.message || '').toString().slice(0, 240)}`); }
    if (ok()) return true;
    const gvfs = `/run/user/${process.getuid?.() || ''}/gvfs`;
    if (fs.existsSync(gvfs)) console.error(`gio 可能挂在 ${gvfs}，但 ${config.rootPath} 仍不可读。把 rootPath 指到这个目录下，或设置 nasMount 后走 CIFS。`);
  }
  if (!parsed) return ok();
  try { fs.mkdirSync(mountPoint, { recursive: true }); }
  catch (e) { console.error('创建挂载点失败：' + e.message); return false; }
  if (!isMount(mountPoint)) {
    let entries = [];
    try { entries = fs.readdirSync(mountPoint); } catch { /* 挂载点刚创建 */ }
    if (entries.length) {
      console.error(`挂载点 ${mountPoint} 里已经有文件，没有执行 mount，避免把原目录盖住。`);
      return false;
    }
    const cred = credentialFile(parsed, config);
    try { mountCifs(parsed, mountPoint, cred.file, config.nasVersion || '3.0'); }
    catch (e) { console.error(`CIFS 挂载失败：${(e.stderr || e.message || '').toString().slice(0, 300)}`); }
    finally { if (cred.temp) fs.rmSync(cred.file, { force: true }); }
  }
  if (!ok()) console.error(`NAS 仍不可读：${config.rootPath}（尝试的挂载点 ${mountPoint}）`);
  return ok();
}

export function ensureNasMounted(config = {}) {
  const rootPath = config.rootPath;
  const ok = () => { try { fs.accessSync(rootPath); return true; } catch { return false; } };
  if (!rootPath) return false;
  if (ok()) return true;
  if (process.platform === 'darwin') {
    try {
      const vol = rootPath.split('/').slice(0, 3).join('/');
      for (const alt of fs.readdirSync('/Volumes').filter((n) => n.startsWith(path.basename(vol) + '-')).map((n) => '/Volumes/' + n)) {
        if (fs.existsSync(path.join(alt, path.relative(vol, rootPath)))) {
          console.log(`NAS 挂到了 ${alt}，卸掉重挂`);
          execFileSync('diskutil', ['unmount', alt], { stdio: 'pipe', timeout: 20000 });
        }
      }
    } catch (e) { console.error('处理 NAS 挂载点出错：' + e.message); }
    if (config.nasUrl) {
      try { execFileSync('osascript', ['-e', `with timeout of 20 seconds\nmount volume "${config.nasUrl}"\nend timeout`], { stdio: 'pipe', timeout: 25000 }); } catch { /* 挂不上就让调用方报警 */ }
    }
    return ok();
  }
  if (process.platform === 'linux') return ensureNasLinux(config, ok);
  console.error(`读不到 ${rootPath}，当前系统没有自动挂载实现`);
  return false;
}
