// 演示模式：不接任何平台，用一份假数据把麦田网页跑起来。
//   node src/demo.mjs            生成 demo/ 目录（假配置、假数据库、假工程和封面），在 http://localhost:8788/?key=demo 打开
//   node src/demo.mjs --reset    重新生成假数据
// 演示数据只在 demo/ 里，不碰你的 data/hub.db 和 config.json。
import fs from 'node:fs'; import path from 'node:path';
import { STATE_ROOT } from './paths.mjs';

const D = path.join(STATE_ROOT, 'demo'), PROJ = path.join(D, 'projects');
if (process.argv.includes('--reset')) fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(PROJ, { recursive: true });
const cfg = { name: '麦田 · 演示', web: { port: 8788, key: 'demo' }, rootPath: PROJ, driver: 'direct', keepAlive: [],
  site: { name: '课程站', base: 'https://example.com' }, xHandle: 'demo' };
fs.writeFileSync(path.join(D, 'config.json'), JSON.stringify(cfg, null, 2));
process.env.MAITIAN_CONFIG = path.join(D, 'config.json');
process.env.MAITIAN_DB = path.join(D, 'hub.db');
const fresh = !fs.existsSync(process.env.MAITIAN_DB);

const { db, upsertEpisode, setTask, saveSnapshot, log, setMeta } = await import('./db.mjs');
await import('./followers.mjs');   // 建 followers 表

if (fresh) {
  const DAY = 864e5, now = Date.now(), PL = ['bilibili', 'douyin', 'xhs', 'channels', 'youtube', 'x', 'zsz'];
  const bj = (t) => new Date(t + 8 * 3600e3).toISOString();
  const day = (t) => bj(t).slice(0, 10);
  let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const at18 = (offsetDays) => Date.parse(day(now + offsetDays * DAY) + 'T18:00:00+08:00');
  const COLORS = ['#d4ff3a', '#ffcf3d', '#7ee0ff', '#ffb3c7', '#b9f5c9', '#d9c8ff', '#ffd6a5', '#c7d2fe'];
  const EPS = [
    ['用 AI 做一支产品宣传片', '从脚本到成片 1 小时', -19], ['一个人的内容工作流', '选题、拍摄、剪辑、分发全公开', -15],
    ['AI 帮我读完 50 份财报', '提问模板直接抄', -12], ['给爸妈做一个防诈骗助手', '30 分钟搭好', -8],
    ['我的 Agent 记忆管理法', '用久了不变笨', -5], ['10 个 Bot 组成的编辑部', '口播稿从 2 小时到 20 分钟', -1],
    ['把微信群聊交给 AI 整理', '不用登录不用解密', 1], ['AI 剪辑实测：哪家最省事', '六款工具横评', 4],
  ];
  const cover = (title, i) => `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1152" viewBox="0 0 1536 1152"><rect width="1536" height="1152" fill="#f1eee6"/><rect x="0" y="0" width="1536" height="1152" fill="url(#g)" opacity=".5"/><defs><pattern id="g" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#141414" stroke-opacity=".06"/></pattern></defs><rect x="80" y="80" width="300" height="88" rx="12" fill="${COLORS[i % 8]}" stroke="#141414" stroke-width="6"/><text x="230" y="140" font-family="PingFang SC,sans-serif" font-size="46" font-weight="900" text-anchor="middle" fill="#141414">第 ${i + 1} 期</text>${title.match(/.{1,7}/g).slice(0, 3).map((l, k) => `<text x="80" y="${380 + k * 190}" font-family="PingFang SC,sans-serif" font-size="150" font-weight="900" fill="#141414">${l}</text>`).join('')}<rect x="80" y="${330 + Math.min(3, Math.ceil(title.length / 7)) * 190}" width="560" height="22" fill="${COLORS[i % 8]}"/></svg>`;
  const cover3 = (title, sub, i) => `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="2048" viewBox="0 0 1536 2048"><defs><pattern id="g" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#141414" stroke-opacity=".06"/></pattern></defs><rect width="1536" height="2048" fill="#f1eee6"/><rect width="1536" height="2048" fill="url(#g)"/><rect x="110" y="140" width="330" height="100" rx="14" fill="${COLORS[i % 8]}" stroke="#141414" stroke-width="7"/><text x="275" y="212" font-family="PingFang SC,sans-serif" font-size="54" font-weight="900" text-anchor="middle" fill="#141414">第 ${i + 1} 期</text>${title.match(/.{1,5}/g).slice(0, 4).map((l, k) => `<text x="110" y="${560 + k * 250}" font-family="PingFang SC,sans-serif" font-size="230" font-weight="900" fill="#141414">${l}</text>`).join('')}<rect x="110" y="${560 + Math.min(4, Math.ceil(title.length / 5)) * 250 - 150}" width="700" height="30" fill="${COLORS[i % 8]}"/><text x="110" y="1880" font-family="PingFang SC,sans-serif" font-size="80" font-weight="700" fill="#3a3a3a">${sub}</text></svg>`;
  const ins = db.prepare(`INSERT OR REPLACE INTO metrics (day, episode_id, platform, views, likes, comments, favorites, shares, extra, collected_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insS = db.prepare(`INSERT OR REPLACE INTO samples (ts, episode_id, platform, views, likes, comments, favorites, shares) VALUES (?,?,?,?,?,?,?,?)`);
  const W = { bilibili: 0.09, douyin: 0.33, xhs: 0.16, channels: 0.06, youtube: 0.02, x: 0.33, zsz: 0.01 };
  const IR = { bilibili: 0.035, douyin: 0.03, xhs: 0.12, channels: 0.03, youtube: 0.02, x: 0.025, zsz: 0 };
  EPS.forEach(([t1, t2, off], i) => {
    const id = `demo-${i + 1}`, dir = path.join(PROJ, id), at = at18(off), name = `${t1}｜${t2}`;
    fs.mkdirSync(path.join(dir, '封面'), { recursive: true });
    fs.writeFileSync(path.join(dir, '封面', 'cover-4x3.svg'), cover(t1, i));
    fs.writeFileSync(path.join(dir, '封面', 'cover-3x4.svg'), cover3(t1, t2, i));
    const camp = `demo-${i + 1}`;
    const pj = { version: 1, id, episode: i + 1, name, nick: t1.slice(0, 10), schedule: new Date(at).toISOString(), covers: { '3x4': '封面/cover-3x4.svg', '4x3': '封面/cover-4x3.svg' },
      platforms: Object.fromEntries(PL.map(p => [p, { title: t1, desc: `${t2}。📚 课程站：https://example.com/?utm_source=${p}&utm_medium=video&utm_campaign=${camp}`, tags: ['演示账号', 'AI'] }])) };
    fs.writeFileSync(path.join(dir, 'publish.json'), JSON.stringify(pj, null, 2));
    upsertEpisode({ id, episode: i + 1, name, dir, schedule: pj.schedule }); saveSnapshot(id, pj, true);
    const planned = off > 2, future = off > 0;
    for (const p of PL) setTask(id, p, planned ? 'planned' : future ? (p === 'xhs' ? 'awaiting_user' : 'scheduled') : 'published', planned ? '' : future ? '定时' : '已发布', future ? {} : { url: 'https://example.com/' });
    log(id, '', 'plan', '演示数据');
    if (future) return;
    const total = 6000 + rnd() * 26000;                      // 这一期最终播放
    for (let d = 0; d <= Math.min(-off, 30); d++) {
      const t = at + d * DAY + 16 * 3600e3, k = 1 - Math.exp(-(d + 0.6) / 2.2);
      for (const p of PL) { const v = Math.round(total * W[p] * k * (0.8 + rnd() * 0.4)), I = v * IR[p]; ins.run(day(t), id, p, v, Math.round(I * .5), Math.round(I * .1), Math.round(I * .3), Math.round(I * .1), '{}', new Date(t).toISOString()); }
    }
    for (let h = 6; h <= 72 && at + h * 3600e3 < now; h += 6) for (const p of PL) { const v = Math.round(total * W[p] * (1 - Math.exp(-(h / 24 + .1) / 2.2))); insS.run(new Date(at + h * 3600e3).toISOString().slice(0, 16), id, p, v, Math.round(v * IR[p] * .5), 0, 0, 0); }
    db.prepare('INSERT OR REPLACE INTO site_campaigns (campaign, sources, reg, vip, orders, revenue, updated_at) VALUES (?,?,?,?,?,?,?)').run(camp, 'bilibili,x,youtube', Math.round(total / 900), Math.round(total / 6000), Math.round(total / 6000), Math.round(total / 6000) * 499, new Date().toISOString());
  });
  const base = { bilibili: 15000, douyin: 12000, xhs: 18000, channels: 4300, youtube: 300, x: 5600, zsz: 3200 };
  const insF = db.prepare('INSERT OR REPLACE INTO followers (day, platform, total, gain, loss, source, collected_at) VALUES (?,?,?,?,?,?,?)');
  for (const p of Object.keys(base)) { let v = base[p]; for (let d = 40; d >= 0; d--) { const g = Math.round(base[p] * 0.0015 * (0.5 + rnd() * 1.5)); v += g; insF.run(day(now - d * DAY), p, v, g, 0, 'demo', new Date().toISOString()); } }
  const insD = db.prepare('INSERT OR REPLACE INTO site_daily (day, reg, vip, orders, revenue) VALUES (?,?,?,?,?)');
  for (let d = 30; d >= 0; d--) { const r = Math.round(20 + rnd() * 60), v = Math.round(r * (0.05 + rnd() * 0.1)); insD.run(day(now - d * DAY), r, v, v, v * 499); }
  const insC = db.prepare('INSERT OR REPLACE INTO site_channels (source, label, reg, vip, orders, revenue, updated_at) VALUES (?,?,?,?,?,?,?)');
  [['bilibili', 'B站', 820, 70], ['douyin', '抖音', 610, 31], ['xiaohongshu', '小红书', 540, 46], ['twitter', 'X', 380, 9], ['youtube', 'YouTube', 90, 4], ['other', '其他渠道', 160, 8]].forEach(([s, l, r, v]) => insC.run(s, l, r, v, v, v * 499, new Date().toISOString()));
  setMeta('siteCampaigns', 'on'); setMeta('metricsDay', new Date().toLocaleDateString('zh-CN')); setMeta('doctorDay', new Date().toLocaleDateString('zh-CN'));
  console.log('演示数据已生成：demo/');
}
const { startWeb } = await import('./web.mjs');
startWeb();
console.log('打开 http://localhost:8788/?key=demo （Ctrl+C 退出）');
