// 安装向导：检查环境 → 问几个问题 → 生成 config.json → 可选装开机自启、打开登录页
//   node src/init.mjs
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { APP_ROOT, STATE_ROOT, ensureState } from './paths.mjs';
import { chromeBinary, cloudflaredBin } from './platform.mjs';

const CFG = process.env.MAITIAN_CONFIG || path.join(STATE_ROOT, 'config.json');
// 自己排队读行：管道输入时 readline 会在提问前把行读完，rl.question 会丢行
const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
const lines = [], waiters = []; let closed = false;
rl.on('line', (l) => { const w = waiters.shift(); w ? w(l) : lines.push(l); });
rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(''); });
const readLine = () => lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve('') : new Promise(r => waiters.push(r));
const prompt = async (q) => { process.stdout.write(q); const l = await readLine(); if (!process.stdin.isTTY) process.stdout.write(l + '\n'); return l; };
const ask = async (q, def = '') => (await prompt(`${q}${def ? `（回车用：${def}）` : ''}\n> `)).trim() || def;
// 非终端（管道或无输入）时默认一律「否」，免得误装开机自启
const yes = async (q, def = true) => { def = def && !!process.stdin.isTTY; const a = (await prompt(`${q} ${def ? '[Y/n]' : '[y/N]'} `)).trim() || (def ? 'y' : 'n'); return /^(y|yes|是|好)$/i.test(a); };
const ok = (t) => console.log(`  ✅ ${t}`), bad = (t) => console.log(`  ❌ ${t}`), tip = (t) => console.log(`  ·  ${t}`);
const home = (p) => p.replace(/^~(?=\/|$)/, os.homedir());

console.log('\n麦田 · 安装向导\n');
console.log('一、检查环境');
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj > 22 || (maj === 22 && min >= 5)) ok(`Node.js ${process.versions.node}`); else { bad(`Node.js ${process.versions.node}，需要 22.5 以上（用到内置 node:sqlite）`); process.exit(1); }
if (process.platform === 'linux') tip('当前是 Linux：开机自启用 systemd 用户服务，NAS 用 gio / CIFS，缩略图用 ffmpeg');
else if (process.platform !== 'darwin') tip('这个系统没有专门适配，开机自启和 NAS 挂载需要自己接');
let chrome = '';
try { chrome = chromeBinary(); ok('Chrome：' + chrome); } catch (e) { bad(e.message); }
const cf = cloudflaredBin();
if (cf) ok('cloudflared（可选，远程访问用）');
else tip(process.platform === 'linux' ? '没装 cloudflared：想在手机上远程看麦田，可安装官方 deb 或 snap，或在 config.json 的 tunnel.bin 写路径' : '没装 cloudflared：想在手机上远程看麦田，之后 brew install cloudflared');

if (fs.existsSync(CFG) && !(await yes('\n已经有 config.json，要重新生成吗？（旧的会备份成 config.json.bak）', false))) {
  console.log('\n保留现有配置。'); rl.close(); process.exit(0);
}

console.log('\n二、几个问题（不知道的直接回车，之后可以改 config.json）');
const ex = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config.example.json'), 'utf8'));
const cfg = { ...ex };
const guess = ['../mdldm-maitian-publisher', '../obsidian-x-publisher', '~/mdldm-maitian-publisher', '/opt/mdldm-maitian-publisher'].map(p => path.resolve(APP_ROOT, home(p))).find(p => fs.existsSync(path.join(p, 'lib/publish.js')));
let plugin = home(await ask('1. 麦田发布助手（插件仓库）在哪？没装的话先 git clone https://github.com/CzzzzzzJ/mdldm-maitian-publisher.git', guess || path.resolve(APP_ROOT, '../mdldm-maitian-publisher')));
fs.existsSync(path.join(plugin, 'lib/publish.js')) ? ok('找到插件') : bad('这个目录里没有 lib/publish.js；只看数据（L1）可以先不管，要分发时再改 pluginDir');
cfg.pluginDir = plugin;
cfg.rootPath = home(await ask('2. 发布工程放在哪个文件夹？（每期一个子目录，里面有成片、封面、publish.json；NAS 或本地都行）', path.join(os.homedir(), 'Movies/发布工程')));
fs.mkdirSync(cfg.rootPath, { recursive: true });
const nas = await ask('3. 如果发布工程在 NAS 上，填 SMB 地址，掉线时自动重挂（比如 smb://用户名@192.168.1.10/共享名；不用就回车）');
if (nas) { cfg.nasUrl = nas; if (process.platform === 'linux') tip('Ubuntu 会先试 gio mount，不行再 mount.cifs。要指定挂载点，在 config.json 写 nasMount，例如 /mnt/nas'); }
else delete cfg.nasUrl;
const hook = await ask('4. 飞书群机器人的 Webhook 地址（通知卡片发到这里；不用就回车）');
if (hook) cfg.feishuWebhook = hook; else delete cfg.feishuWebhook;
const xh = await ask('5. 你的 X 用户名（不带 @，用来采粉丝；不用就回车）');
if (xh) cfg.xHandle = xh.replace(/^@/, ''); else delete cfg.xHandle;
cfg.web = { port: +(await ask('6. 麦田网页用哪个端口？', '8787')), key: crypto.randomBytes(12).toString('base64url') };
if (await yes('7. 有自己的网站（课程站/会员站）要看转化吗？', false)) {
  cfg.site = { name: await ask('   站点叫什么？', '知识站'), base: await ask('   站点地址', 'https://example.com'), adminPath: await ask('   管理后台路径', '/admin'),
    coursesApi: await ask('   课程列表接口', '/api/courses?admin=1'), dashboardApi: await ask('   数据汇总接口', '/api/admin/dashboard'), coursePath: '/series/{seriesId}?courseId={id}' };
  tip('接口返回格式见 src/site.mjs 顶部注释；站点要记下访客第一次带来的 utm_campaign 才能按期看转化');
} else delete cfg.site;
delete cfg.board; delete cfg.extensionId;
if (!cfg.chromeBin) delete cfg.chromeBin;
if (!cfg.nasMount) delete cfg.nasMount;
if (!cfg.nasCredentials) delete cfg.nasCredentials;
cfg.chromeProfile = path.join(STATE_ROOT, 'chrome-profile');

ensureState();
if (fs.existsSync(CFG)) fs.copyFileSync(CFG, CFG + '.bak');
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n');
ok(`已写入 ${CFG}（网页口令：${cfg.web.key}）`);

console.log('\n三、收尾');
if ((process.platform === 'darwin' || process.platform === 'linux') && await yes('装成开机自启的守护进程？（推荐，之后自动采数据、发通知）')) {
  const script = process.platform === 'darwin' ? 'install-launchd.sh' : 'install-systemd.sh';
  spawnSync(path.join(APP_ROOT, 'scripts', script), cf && await yes('顺带装远程访问隧道（cloudflared）？', false) ? ['--tunnel'] : [], { stdio: 'inherit' });
}
if (chrome && await yes('现在打开专用 Chrome 和各平台页面去登录？（每个平台扫码或登录一次）')) {
  spawnSync(process.execPath, [path.join(APP_ROOT, 'src/hub.mjs'), 'login'], { stdio: 'inherit', env: { ...process.env, MAITIAN_STATE: STATE_ROOT, MAITIAN_CONFIG: CFG } });
}
const cli = fs.existsSync('/usr/bin/maitian') ? 'maitian' : `node ${path.join(APP_ROOT, 'src/hub.mjs')}`;
const demo = fs.existsSync('/usr/bin/maitian') ? 'maitian demo' : 'node src/demo.mjs';
console.log(`
完成。接下来：
  · 打开 http://localhost:${cfg.web.port}/?key=${cfg.web.key}
  · 登录完各平台后跑一次体检：${cli} doctor
  · 只看数据（L1）：已经发过的期用 ${cli} adopt <工程目录> 登记
  · 分发（L2）：按 skills/maitian-publish 准备发布工程，${cli} plan <工程目录>，到点前 ${cli} run <工程目录>
  · 想先看看效果：${demo}（假数据，不碰你的配置）
`);
rl.close();
