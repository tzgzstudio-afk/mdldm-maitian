#!/usr/bin/env node
// 发布中控：分批发布、状态落盘、防重、飞书通知、自动取链接
//   hub login                                   打开专用 Chrome 和各平台页面，供你登录
//   hub doctor                                  演练：检查 7 个平台登录态和上传页结构（不上传、不填写）
//   hub run <工程目录> [--only a,b] [--force]   发起（或续跑）一期
//   hub status [id] [--logs]                    看状态
//   hub sync <id> [--only a,b]                  取链接、更新状态，写回发布记录
//   hub mark <id> <平台> <状态> [备注] [--url 链接]   人工改状态
//   hub submit <id> <instagram|youtube|x>      中控卡住时，把已填好的发帖页单独提交一次（先查重）
//   hub adopt <工程目录>                         登记一期已发过的（不上传）
//   hub metrics [id]                            采集流量并发日报
//   hub daemon                                  常驻：到点自动取链接、提醒还没点发布的平台
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto'; import { execFileSync, spawn } from 'node:child_process';
import { APP_ROOT, STATE_ROOT, ensureState } from './paths.mjs';
import { ensureNasMounted, openInChrome, spawnAwake, listeningPid } from './platform.mjs';
import { db, NAMES, LOCKED, STATE_CN, upsertEpisode, getTask, getTasks, setTask, log, episodes, getEpisode, recentLogs, getMeta, setMeta, saveMetric, prevMetric, saveSnapshot } from './db.mjs';
import { collectors } from './metrics.mjs';
import { boardSync } from './board.mjs';
const board = (o) => boardSync(o).then((r) => { if (r) console.log('看板已同步：' + JSON.stringify(r)); return r; }).catch((e) => { console.error('看板同步出错：' + e.message); });
import { config, notify } from './feishu.mjs';
import { collectFollowers } from './followers.mjs';
import * as drv from './driver.mjs';
import { SITE } from './site.mjs';
import { xExisting, xSubmit, ytRows, ytSubmit, zszCourses, douyinTopics, igExisting, igSubmit } from './checks.mjs';

const args = process.argv.slice(2), cmd = args[0];
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const ZSZ_LEAD = 30;   // 知识站建课提前量（分钟）：上传 + 转码约 10 分钟
const strip = (s) => String(s || '').replace(/ *\d+%/, '');
const mapState = (s) => s === '待你发布' || s === '已填写' ? 'filled' : s === '异常' || s === '上传超时' ? 'failed' : s === '未登录' ? 'not_logged_in' : s === '已停止' ? 'stopped' : s === '跳过' ? 'skipped' : 'running';
const loadProject = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'publish.json'), 'utf8'));
const projectOf = (ep, pj) => ({ dir: path.relative(config.rootPath, ep.dir), data: pj });
const ALL = ['bilibili', 'xhs', 'douyin', 'channels', 'youtube', 'x', 'instagram', 'zsz'].filter(id => id !== 'zsz' || SITE);   // 没配自有站点就不管 zsz
const LOGIN_PAGES = { bilibili: 'https://member.bilibili.com/platform/upload/video/frame', xhs: 'https://creator.xiaohongshu.com/publish/publish?source=official&target=video', douyin: 'https://creator.douyin.com/creator-micro/content/upload', channels: 'https://channels.weixin.qq.com/platform/post/create', youtube: 'https://studio.youtube.com/', x: 'https://x.com/home', instagram: 'https://www.instagram.com/', zsz: SITE ? SITE.admin : '' };

function table(eid) {
  return getTasks(eid).map(t => `${NAMES[t.platform] || t.platform}：${STATE_CN[t.state] || t.state}${t.detail ? `（${t.detail.slice(0, 80)}）` : ''}${t.url ? ` ${t.url}` : ''}`).join('\n');
}

async function runBatch(ep, pj, batch) {
  log(ep.id, batch.join(','), 'start-batch', drv.mode);
  const last = {};
  const onState = (s) => {
    const state = mapState(s.status), tail = (s.logs || []).filter(l => l.kind === 'err').slice(-1)[0];
    const detail = state === 'running' ? strip(s.status) : (state === 'filled' ? '' : (tail ? tail.msg : s.status));
    last[s.id] = { state, tabId: s.tabId, logs: s.logs || [] };
    if (setTask(ep.id, s.id, state, detail, { tabId: s.tabId })) {
      log(ep.id, s.id, 'state', `${s.status} ${detail}`);
      if (state === 'failed' || state === 'not_logged_in') notify(`❌ ${ep.name}\n${NAMES[s.id]}：${STATE_CN[state]}，${detail}`);
    }
  };
  await drv.runBatch(projectOf(ep, pj), batch, onState, () => notify(`⚠️ ${ep.name}\n浏览器 2 分钟没响应，可能有弹窗卡住了，请看一眼`));
  return last;
}

// 批次跑完后：自动平台回读核对并提交，手动平台交给你自己点
async function after(ep, pj, id, res) {
  const p = pj.platforms[id];
  if (res.state !== 'filled') return;
  // 存档：提交前把填好的页面截一张图
  try { if (id !== 'zsz') { const dir = path.join(ep.dir, '发布档案'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${id}.jpg`), await drv.screenshot(res.tabId)); } } catch (e) { log(ep.id, id, 'screenshot-error', e.message); }
  try {
    if (id === 'douyin') {
      const got = await douyinTopics(res.tabId).catch(() => []);
      if (got.length !== (p.topics || []).length) { setTask(ep.id, id, 'awaiting_user', `话题只识别了 ${got.length}/${p.topics.length} 个，发之前请补`); return; }
    }
    if (config.manual.includes(id)) { setTask(ep.id, id, 'awaiting_user', pj.schedule ? '已设定时，核对后点「定时发布」' : '核对后点发布'); return; }
    if (id === 'zsz') {
      const cs = await zszCourses(p.title);
      if (cs.length === 1) setTask(ep.id, id, cs[0].vis === 'published' ? 'published' : 'scheduled', cs[0].vis === 'published' ? '已上线' : '转码中，完成后自动上线', { url: SITE.courseUrl(cs[0]) });
      else { setTask(ep.id, id, 'failed', `后台同名课程有 ${cs.length} 节`); await notify(`❌ ${ep.name}\n知识站：同名课程 ${cs.length} 节，请检查`); }
      return;
    }
    const r = id === 'x' ? await xSubmit(res.tabId, p.text, pj.schedule) : id === 'instagram' ? await igSubmit(res.tabId, p.caption, pj.schedule) : await ytSubmit(res.tabId, p.title, pj.schedule);
    log(ep.id, id, 'submit', JSON.stringify(r));
    if (r.ok) setTask(ep.id, id, r.state, r.detail || '', { url: r.url });
    else { setTask(ep.id, id, 'awaiting_user', r.reason); await notify(`⚠️ ${ep.name}\n${NAMES[id]} 没能自动提交：${r.reason}`); }
  } catch (e) { setTask(ep.id, id, 'awaiting_user', `自动步骤出错：${e.message}`); await notify(`⚠️ ${ep.name}\n${NAMES[id]} 自动步骤出错：${e.message}`); }
}

// hub submit <id> <平台>：中控卡住时，把专用 Chrome 里已经填好的发帖页单独提交一次（只限 X / YouTube / Instagram）
// 先查重，页面必须恰好一个，然后走和自动流程一样的 after()：存档截图 → 核对 → 点一次 → 记状态
const SUBMIT_PAGES = {
  instagram: [/instagram\.com/, `!!document.querySelector('[role=dialog] [contenteditable=true]')`],
  youtube: [/studio\.youtube\.com/, `!!document.querySelector('ytcp-uploads-dialog')`],
  x: [/(x|twitter)\.com/, `!!document.querySelector('[data-testid=tweetTextarea_0]')`],
};
const refuse = (m) => Object.assign(new Error(m), { quiet: true });   // 拒绝提交是正常保护，不发飞书
async function submitOne() {
  const ep = getEpisode(args[1]), id = args[2];
  if (!ep) throw refuse('没有这一期，先 hub status 看 id');
  if (!SUBMIT_PAGES[id]) throw refuse(`hub submit 只支持 ${Object.keys(SUBMIT_PAGES).join(' / ')}；国内平台由你自己点发布`);
  const pj = loadProject(ep.dir), p = pj.platforms[id];
  if (!p || p.skip) throw refuse(`publish.json 里没有 ${id}，或已设 skip`);
  const t = getTask(ep.id, id);
  if (t && ['scheduled', 'published'].includes(t.state)) throw refuse(`${NAMES[id]} 已经是「${STATE_CN[t.state]}」，不再提交`);
  await drv.ensure();
  if (id === 'instagram' && await igExisting(p.caption, pj.schedule).catch(() => null)) throw refuse('Instagram 上已经有这一期（定时内容或主页），不再提交');
  if (id === 'x' && await xExisting(p.text).catch(() => null)) throw refuse('X 上已经有这条，不再提交');
  if (id === 'youtube') { const rows = await ytRows(p.title).catch(() => null); if (rows && (rows.length > 1 || rows.some(r => !/草稿|待处理|上传|处理中/.test(r)))) throw refuse(`YouTube Studio 里已有：${rows.join('；')}，不再提交`); }
  const [re, ready] = SUBMIT_PAGES[id], cands = [];
  for (const tab of await drv.adoptTabs(re)) if (await drv.evaluate(tab, ready).catch(() => false)) cands.push(tab);
  if (cands.length !== 1) throw refuse(`专用 Chrome 里填好的 ${NAMES[id]} 发帖页有 ${cands.length} 个，要恰好 1 个才提交`);
  log(ep.id, id, 'manual-submit', `tab ${cands[0]}`);
  await after(ep, pj, id, { state: 'filled', tabId: cands[0] });
  const now = getTask(ep.id, id);
  console.log(`${NAMES[id]}：${STATE_CN[now.state] || now.state}${now.detail ? `（${now.detail}）` : ''}`);
  if (['scheduled', 'published'].includes(now.state)) await notify(`✅ ${ep.name}\n${NAMES[id]}（hub submit）：${STATE_CN[now.state]}${now.detail ? `，${now.detail}` : ''}`);
  await board({ site: false }).catch(() => {});
}

async function run() {
  const dir = path.resolve(args[1] || '');
  if (!fs.existsSync(path.join(dir, 'publish.json'))) throw new Error(`${dir} 里没有 publish.json`);
  try { execFileSync(process.execPath, [path.join(config.pluginDir, 'tools/validate.mjs'), dir], { stdio: 'pipe' }); }
  catch (e) { throw new Error(`校验没通过：\n${(e.stdout || '').toString().slice(-800)}`); }
  const pj = loadProject(dir), ep = { id: pj.id, episode: pj.episode, name: pj.name, dir, schedule: pj.schedule || null };
  upsertEpisode(ep); saveSnapshot(ep.id, pj, true);
  const only = opt('--only') ? opt('--only').split(',') : null, force = args.includes('--force');
  let todo = Object.keys(pj.platforms).filter(id => !pj.platforms[id].skip && (!only || only.includes(id)));
  // X 长文模式（长文 + 视频帖引用长文）：不走插件填写，定时前 25 分钟由守护进程调长文脚本
  if (todo.includes('x') && pj.platforms.x.mode === 'article+quote') {
    todo = todo.filter(i => i !== 'x');
    if (!LOCKED.includes((getTask(ep.id, 'x') || {}).state)) setTask(ep.id, 'x', 'scheduled', '长文模式：定时前 25 分钟由麦田启动长文脚本（长文 + 视频帖引用长文）');
  }

  // 防重 1：库里已经到位的不再跑
  const locked = todo.filter(id => LOCKED.includes((getTask(ep.id, id) || {}).state));
  if (locked.length && !force) { console.log(`已到位、跳过：${locked.map(i => NAMES[i]).join('、')}（确实要重跑加 --force）`); todo = todo.filter(i => !locked.includes(i)); }
  if (!todo.length) { console.log('没有要跑的平台。\n' + table(ep.id)); return; }

  await drv.ensure();
  if (await drv.busy()) throw new Error('插件里还有一轮在跑，等它结束或先停掉');

  // 防重 2：平台上已经有了的不再跑
  if (todo.includes('x')) { const e = await xExisting(pj.platforms.x.text).catch(() => null); if (e) { setTask(ep.id, 'x', e.state, e.detail, { url: e.url }); todo = todo.filter(i => i !== 'x'); console.log('X 上已经有这条，跳过'); } }
  if (todo.includes('youtube')) { const rows = await ytRows(pj.platforms.youtube.title).catch(() => null); if (rows && rows.length) {
    todo = todo.filter(i => i !== 'youtube');
    const url = (rows[0].match(/https:\S+/) || [])[0];
    if (rows.length === 1 && /已安排|定时|首播|公开/.test(rows[0]) && !/草稿|待处理/.test(rows[0])) setTask(ep.id, 'youtube', /已安排|定时|首播/.test(rows[0]) ? 'scheduled' : 'published', rows[0].replace(/ https:\S+/, ''), { url });
    else { setTask(ep.id, 'youtube', 'awaiting_user', `Studio 里已有 ${rows.length} 条同标题视频：${rows.join('；')}`); await notify(`⚠️ ${ep.name}\nYouTube Studio 里已有同标题视频（${rows.join('；')}），没有再上传，请先处理`); }
  } }
  if (todo.includes('instagram')) { const e = await igExisting(pj.platforms.instagram.caption, pj.schedule).catch(() => null); if (e) { setTask(ep.id, 'instagram', e.count > 1 ? 'awaiting_user' : e.state, e.detail, { url: e.url }); todo = todo.filter(i => i !== 'instagram'); console.log('Instagram 上已经有这一期，跳过'); if (e.count > 1) await notify(`⚠️ ${ep.name}\nInstagram ${e.detail}，请去定时内容里删掉多余的`); } }
  if (todo.includes('zsz')) { const cs = await zszCourses(pj.platforms.zsz.title).catch(() => []); if (cs.length) { setTask(ep.id, 'zsz', cs[0].vis === 'published' ? 'published' : 'scheduled', '后台已有同名课程', { url: SITE.courseUrl(cs[0]) }); todo = todo.filter(i => i !== 'zsz'); } }
  // 知识站没有定时：建课转码完就直接上线、发 VIP 群通知。定时发布的期推迟到定时前 ZSZ_LEAD 分钟由守护进程建课
  //（2026-11-12 第 37 期提前将近一天上线）
  if (todo.includes('zsz') && !args.includes('--now') && pj.schedule && Date.parse(pj.schedule) - Date.now() > (ZSZ_LEAD + 10) * 60000) {
    setTask(ep.id, 'zsz', 'pending', `定时前 ${ZSZ_LEAD} 分钟自动建课（知识站没有定时，转码完即上线）`);
    todo = todo.filter(i => i !== 'zsz');
    console.log(`知识站推迟到定时前 ${ZSZ_LEAD} 分钟由守护进程上传`);
  }
  if (!todo.length) { await notify(`📋 ${ep.name}\n本轮没有需要现在上传的平台\n${table(ep.id)}`); return; }

  for (const id of todo) setTask(ep.id, id, 'pending', '');
  // 开跑前先查登录（2026-11-15 视频号到开跑才发现掉线，扫码耽误十几分钟）：掉线的立刻发飞书，其他平台照跑，扫完码本轮末尾自动补跑
  let loggedOut = [];
  try {
    await drv.ensure();
    const lr = await drv.checkLogin(todo.filter(i => i !== 'zsz'));
    loggedOut = todo.filter(i => i !== 'zsz' && lr[i] && !lr[i].ok);
    if (loggedOut.length) await notify(`🔑 ${ep.name}\n这些平台没登录：${loggedOut.map(i => NAMES[i]).join('、')}\n请现在在专用 Chrome 里扫码，其他平台先跑；扫完 20 分钟内会自动补跑\n${loggedOut.map(i => LOGIN_PAGES[i]).join('\n')}`);
  } catch (e) { console.error('开跑前登录检查出错：' + e.message); }
  await notify(`🚀 开始发布：${ep.name}\n定时：${pj.schedule ? pj.schedule.replace('T', ' ').slice(0, 16) : '立即'}\n本轮：${todo.map(i => NAMES[i]).join('、')}\n顺序：${config.batches.map(b => b.filter(i => todo.includes(i)).map(i => NAMES[i]).join('+')).filter(Boolean).join(' → ')}`);

  const pending = [];
  for (const b of config.batches) {
    const batch = b.filter(i => todo.includes(i));
    if (!batch.length) continue;
    let res;
    try { res = await runBatch(ep, pj, batch); }
    catch (e) { for (const id of batch) setTask(ep.id, id, 'failed', e.message); await notify(`❌ ${ep.name}\n${batch.map(i => NAMES[i]).join('、')} 这一批没跑起来：${e.message}`); continue; }
    for (const id of batch) if (res[id]) pending.push(after(ep, pj, id, res[id]).then(async () => {
      const t = getTask(ep.id, id);
      if (['awaiting_user', 'scheduled', 'published'].includes(t.state)) await notify(`${t.state === 'awaiting_user' ? '👉' : '✅'} ${ep.name}\n${NAMES[id]}：${STATE_CN[t.state]}${t.detail ? `，${t.detail}` : ''}${t.url ? `\n${t.url}` : ''}`);
    }));
  }
  await Promise.all(pending);
  // 补跑开跑时没登录的平台：每分钟查一次登录，最多 20 分钟
  let retry = loggedOut.filter(i => getTask(ep.id, i)?.state === 'not_logged_in');
  for (let k = 0; retry.length && k < 20; k++) {
    await drv.sleep(60000);
    const lr = await drv.checkLogin(retry).catch(() => ({}));
    const ok = retry.filter(i => lr[i] && lr[i].ok);
    if (!ok.length) continue;
    retry = retry.filter(i => !ok.includes(i));
    let res; try { res = await runBatch(ep, pj, ok); } catch (e) { for (const id of ok) setTask(ep.id, id, 'failed', e.message); continue; }
    await Promise.all(ok.filter(id => res[id]).map(id => after(ep, pj, id, res[id]).then(async () => {
      const t = getTask(ep.id, id);
      if (['awaiting_user', 'scheduled', 'published'].includes(t.state)) await notify(`${t.state === 'awaiting_user' ? '👉' : '✅'} ${ep.name}\n${NAMES[id]}（扫码后补跑）：${STATE_CN[t.state]}${t.detail ? `，${t.detail}` : ''}${t.url ? `\n${t.url}` : ''}`);
    })));
  }
  if (retry.length) await notify(`⚠️ ${ep.name}\n${retry.map(i => NAMES[i]).join('、')} 20 分钟内还没登录，没补跑；登录后运行 hub run <目录> --only ${retry.join(',')}`);
  await notify(`📋 ${ep.name} 本轮结束\n${table(ep.id)}`);
  await board({ site: false });
}

// 取链接、更新状态；写 NAS 的 发布记录.json，回填发布素材 md 头部的「已发布」行
async function sync(ep, ids, quiet = false) {
  const pj = loadProject(ep.dir); await drv.ensure();
  ids = (ids || Object.keys(pj.platforms)).filter(i => pj.platforms[i] && !pj.platforms[i].skip);
  const before = table(ep.id);
  const r = await drv.links(projectOf(ep, pj), ids);
  for (const [id, v] of Object.entries(r)) {
    const state = /定时|审核|转码/.test(v.status || '') ? 'scheduled' : v.url || /已发布|已上线/.test(v.status || '') ? 'published' : null;
    log(ep.id, id, 'links', JSON.stringify(v));
    if (state) setTask(ep.id, id, state, [v.status, v.note].filter(Boolean).join('，'), { url: v.url || undefined });
    // 平台实际记录的定时和计划不一致就报警（视频号第 36 期 15:00、第 37 期 22:00、第 4 期 20:00 都被改过）
    if (state === 'scheduled' && pj.schedule && v.time) {
      let t = typeof v.time === 'number' ? v.time : NaN;
      const m = typeof v.time === 'string' && v.time.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2}):(\d{2})/);
      if (m) t = Date.parse(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}:00+08:00`);
      if (t && Math.abs(t - Date.parse(pj.schedule)) > 60000 && Date.now() - (+getMeta(`timewarn:${ep.id}:${id}`) || 0) > 60 * 60000 && (setMeta(`timewarn:${ep.id}:${id}`, Date.now()), true)) {
        await notify(`⚠️ ${ep.name}\n${NAMES[id]}平台上记录的定时是 ${new Date(t + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')}，计划是 ${pj.schedule.slice(0, 16).replace('T', ' ')}，请去作品管理改`);
      }
    }
  }
  const tasks = getTasks(ep.id);
  try { fs.writeFileSync(path.join(ep.dir, '发布记录.json'), JSON.stringify({ updatedAt: new Date().toISOString(), platforms: Object.fromEntries(tasks.map(t => [t.platform, { name: NAMES[t.platform], state: STATE_CN[t.state] || t.state, url: t.url || '', detail: t.detail || '' }])) }, null, 2) + '\n'); } catch (e) { console.error('发布记录没写进 NAS：' + e.message); }
  try {
    const md = pj.source && path.join(os.homedir(), 'doc', pj.source);
    if (md && fs.existsSync(md)) {
      const line = '> 已发布：' + tasks.map(t => `${NAMES[t.platform]} ${STATE_CN[t.state] || t.state}${t.url ? ` ${t.url}` : ''}`).join('；') + `（发布中控 ${new Date().toLocaleString('zh-CN', { hour12: false })} 更新）  `;
      const s = fs.readFileSync(md, 'utf8');
      if (/^> 已发布：.*$/m.test(s)) fs.writeFileSync(md, s.replace(/^> 已发布：.*$/m, line));
    }
  } catch (e) { console.error('发布素材 md 没回填：' + e.message); }
  const now = table(ep.id);
  if (!quiet || now !== before) await notify(`🔗 ${ep.name} 链接和状态\n${now}`);
  if (now !== before) await board({ site: false });
  return now !== before;
}

// 采集一期的流量（只采已发布的平台），返回日报文字
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
async function collectMetrics(ep) {
  const pj = loadProject(ep.dir), day = today(), lines = []; let total = 0, totalDelta = 0, any = false;
  await drv.ensure();
  for (const t of getTasks(ep.id)) {
    const fn = collectors[t.platform], p = pj.platforms[t.platform];
    if (!fn || !p || t.state !== 'published') continue;
    let m = null; try { m = await fn({ url: t.url, p }); } catch (e) { log(ep.id, t.platform, 'metrics-error', e.message); }
    if (!m) { lines.push(`${NAMES[t.platform]}：没读到`); continue; }
    saveMetric(day, ep.id, t.platform, m); any = true;
    const prev = prevMetric(ep.id, t.platform, day), d = prev && m.views != null && prev.views != null ? m.views - prev.views : null;
    total += m.views || 0; totalDelta += d || 0;
    const f = (k, v) => v == null ? '' : `｜${k} ${v}`;
    lines.push(`${NAMES[t.platform]}：播放 ${m.views ?? '-'}${d != null ? `（${d >= 0 ? '+' : ''}${d}）` : ''}${f('赞', m.likes)}${f('评', m.comments)}${f('藏', m.favorites)}${f('转', m.shares)}${Object.entries(m.extra || {}).filter(([, v]) => v).map(([k, v]) => f(k, v)).join('')}`);
    await drv.sleep(3000);   // 一个一个来，放慢
  }
  if (!lines.length) return null;
  return `【${ep.episode ? ep.episode + ' 期 ' : ''}${ep.name.split(/[｜|]/)[0]}】${any ? `全平台播放 ${total}${totalDelta ? `（较上次 +${totalDelta}）` : ''}` : ''}\n${lines.join('\n')}`;
}
async function metricsReport(list) {
  const parts = [];
  for (const ep of list) { const r = await collectMetrics(ep).catch((e) => `【${ep.name}】采集出错：${e.message}`); if (r) parts.push(r); }
  // 粉丝：每天一次，和流量一起采
  const fl = await collectFollowers().catch((e) => ({ 出错: e.message }));
  const flLine = Object.entries(fl).map(([p, r]) => `${NAMES[p] || p} ${r && r.total != null ? r.total.toLocaleString('en-US') : r}`).join('｜');
  await board();
  if (parts.length) await notify(`📊 流量日报 ${today()}\n\n粉丝：${flLine}\n\n${parts.join('\n\n')}${config.board ? `\n\n看板：${config.board.url}` : ''}`);
  else console.log('没有已发布的平台可采集');
}

async function doctor() {
  await drv.ensure();
  const r = await drv.checkLogin(ALL);
  const lines = ALL.map(id => `${NAMES[id]}：${r[id] && r[id].ok ? '✅ 已登录，上传页正常' : `❌ ${r[id] ? r[id].reason : '没有结果'}`}`);
  const bad = ALL.filter(id => !(r[id] && r[id].ok));
  console.log(lines.join('\n'));
  if (args.includes('--notify') || bad.length) await notify(`🩺 发布中控体检（${drv.mode === 'plugin' ? '插件方式' : '专用 Chrome'}）\n${lines.join('\n')}`);
  return bad;
}

// NAS 没挂上就试着挂一次，返回是否可读。
// macOS 仍用钥匙串和 diskutil；Linux 用 gio，不行再 mount.cifs。挂载细节在 platform.mjs。
async function ensureNas() { return ensureNasMounted(config); }

// X 长文模式：到点前启动插件仓库里的 tools/x-article-quote.mjs（走日常 Chrome 里插件的开发桥）
const extId = () => config.extensionId || [...crypto.createHash('sha256').update(path.resolve(config.pluginDir)).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
function startArticleJob(ep, pj) {
  const x = pj.platforms.x, dir = ep.dir;
  ensureState();
  const logf = path.join(STATE_ROOT, 'data', `x-article-${ep.id}.log`);
  const textf = path.join(STATE_ROOT, 'data', `x-article-${ep.id}.txt`); fs.writeFileSync(textf, x.text || '');
  if (!listeningPid(8765)) spawn(process.execPath, ['tools/bridge-server.mjs'], { cwd: config.pluginDir, detached: true, stdio: 'ignore' }).unref();
  try { openInChrome(`chrome-extension://${extId()}/sidepanel.html`, { background: true }); } catch (e) { console.error('打开发布助手面板失败：' + e.message); }
  const out = fs.openSync(logf, 'a');
  // PUBLISH_HUB 必须是源码目录：长文脚本从这里 import src/feishu.mjs，并在 state/ 写一次性锁。
  spawnAwake(process.execPath, [path.join(config.pluginDir, 'tools/x-article-quote.mjs'), '--draft', x.article, '--video', path.join(dir, pj.video || '成片.mp4'),
    '--text', textf, '--at', pj.schedule, '--prep', '20', '--hub-id', ep.id], { cwd: config.pluginDir, detached: true, stdio: ['ignore', out, out], env: { ...process.env, PUBLISH_HUB: APP_ROOT, MAITIAN_STATE: STATE_ROOT } }).unref();
  log(ep.id, 'x', 'article-job', `启动长文脚本，日志 ${logf}`);
}

// 分发计划：登记一期但不跑，平台状态都是「计划中」。hub run 时照常开跑
function planDir(dir) {
  const pj = loadProject(dir);
  if (getEpisode(pj.id)) return null;
  upsertEpisode({ id: pj.id, episode: pj.episode, name: pj.name, dir, schedule: pj.schedule || null }); saveSnapshot(pj.id, pj);
  for (const id of Object.keys(pj.platforms)) setTask(pj.id, id, pj.platforms[id].skip ? 'skipped' : 'planned', pj.platforms[id].skip ? String(pj.platforms[id].skip).slice(0, 80) : '');
  log(pj.id, '', 'plan', dir); return pj.name;
}
// 扫 rootPath 下三层以内的 publish.json：定时在未来、还没登记的，自动进计划
function scanPlans() {
  const out = [], walk = (d, depth) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (ents.some(e => e.name === 'publish.json')) {
      try { const pj = loadProject(d); if (pj.schedule && Date.parse(pj.schedule) > Date.now() && !getEpisode(pj.id)) { const n = planDir(d); if (n) out.push(n); } } catch {}
      return;
    }
    if (depth < 3) for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_')) walk(path.join(d, e.name), depth + 1);
  };
  walk(config.rootPath, 0); return out;
}

// 常驻：每 5 分钟看一眼。到了定时时间自动取链接；你还没点的平台定时提醒并检查
async function daemon() {
  if (!process.env.HUB_NO_WEB && config.web) { const { startWeb } = await import('./web.mjs'); startWeb(); }
  console.log(`发布中控守护进程启动（${drv.mode}）`);
  // 开机后 NAS 往往比守护进程晚挂上：等一等，自己挂一次（密码在钥匙串里），5 分钟还不行再报警
  { let ok = false; for (let i = 0; i < 10 && !(ok = await ensureNas()); i++) await drv.sleep(30000);
    if (ok) console.log('NAS 可读'); else await notify('⚠️ 麦田守护进程启动 5 分钟后仍读不到 NAS（已尝试自动挂载），取链接和封面会失败，请检查 NAS 是否开机'); }
  const MIN = 60000, every = (key, ms) => { const last = +getMeta(key) || 0; if (Date.now() - last < ms) return false; setMeta(key, Date.now()); return true; };
  for (;;) {
    try {
      if (!(await ensureNas()) && every('nasAlert', 60 * MIN)) await notify('⚠️ 麦田读不到 NAS，已尝试自动挂载但没成功');
      else if (every('scanPlans', 30 * MIN)) { const n = scanPlans(); if (n.length) await notify(`🗓 分发计划新增 ${n.length} 期\n${n.join('\n')}`); }
      for (const ep of episodes()) {
        if (Date.now() - Date.parse(ep.created_at) > 14 * 86400e3) continue;
        const tasks = getTasks(ep.id); if (!tasks.length) continue;
        const sched = ep.schedule ? Date.parse(ep.schedule) : 0;
        // 知识站：到了定时前 ZSZ_LEAD 分钟自动建课；已建的课复查是否真正上线
        const zt = tasks.find(t => t.platform === 'zsz');
        if (zt && zt.state === 'pending' && sched && Date.now() >= sched - ZSZ_LEAD * MIN && Date.now() < sched + 6 * 60 * MIN && every(`zszrun:${ep.id}`, 20 * MIN)) {
          log(ep.id, 'zsz', 'deferred-run', '定时前自动建课');
          execFileSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), 'hub.mjs'), 'run', ep.dir, '--only', 'zsz'], { stdio: 'inherit', timeout: 40 * MIN });
        }
        if (zt && zt.state === 'scheduled' && every(`zszcheck:${ep.id}`, 10 * MIN)) {
          const pj0 = loadProject(ep.dir); const cs = await zszCourses(pj0.platforms.zsz.title).catch(() => []);
          if (cs.length === 1 && cs[0].vis === 'published') { setTask(ep.id, 'zsz', 'published', '已上线', { url: SITE.courseUrl(cs[0]) }); await notify(`✅ ${ep.name}\n知识站：已上线`); }
        }
        const waiting = tasks.filter(t => t.state === 'awaiting_user');
        const unsettled = tasks.filter(t => t.state === 'scheduled' || (t.state === 'published' && !t.url && t.platform !== 'channels'));
        if (waiting.length && every(`remind:${ep.id}`, 20 * MIN)) {
          const changed = await sync(ep, waiting.map(t => t.platform), true).catch(() => false);
          const still = getTasks(ep.id).filter(t => t.state === 'awaiting_user');
          if (still.length && !changed) await notify(`⏰ ${ep.name}\n还在等你点发布：${still.map(t => NAMES[t.platform]).join('、')}${sched ? `\n定时时间 ${ep.schedule.replace('T', ' ').slice(0, 16)}` : ''}`);
        }
        if (unsettled.length && (!sched || Date.now() > sched + 5 * MIN) && Date.now() < (sched || Date.parse(ep.created_at)) + 24 * 3600e3 && every(`sync:${ep.id}`, 30 * MIN)) {
          await sync(ep, unsettled.map(t => t.platform), true).catch((e) => console.error('sync 出错：' + e.message));
          const left = getTasks(ep.id).filter(t => t.state === 'scheduled');
          if (!left.length && !getMeta(`done:${ep.id}`)) { setMeta(`done:${ep.id}`, 1); await notify(`🎉 ${ep.name}\n全部平台已发布\n${table(ep.id)}`); }
        }
      }
      // 新发的一期头三天加密采样（每 6 小时一次），之后回到每天一次
      for (const ep of episodes()) {
        const pub = Date.parse(ep.schedule || ep.created_at); if (!(Date.now() > pub + 30 * MIN && Date.now() < pub + 72 * 3600e3)) continue;
        if (!getTasks(ep.id).some(t => t.state === 'published') || !every(`sample:${ep.id}`, (config.sampleHours || 6) * 60 * MIN)) continue;
        await collectMetrics(ep).catch((e) => console.error('加密采样出错：' + e.message));
      }
      // 登录保活：定期打开一下后台首页（视频号的扫码登录过期快），掉线就提醒，并记下每次保持了多久
      for (const id of config.keepAlive || []) {
        if (!every(`keep:${id}`, (config.keepAliveMinutes || 60) * MIN)) continue;
        const ok = await drv.withTab(LOGIN_PAGES[id], async (t) => !/login|passport|signin/i.test((await chrome.tabs.get(t)).url) && !(await drv.evaluate(t, `/扫码登录/.test(document.body.innerText) && /验证码登录|密码登录/.test(document.body.innerText)`).catch(() => false)), { wait: 12000 }).catch(() => null);
        if (ok === null) continue;
        const was = getMeta(`login:${id}`);
        if (ok && was !== 'ok') { setMeta(`login:${id}`, 'ok'); setMeta(`loginSince:${id}`, Date.now()); }
        if (!ok && was !== 'out') {
          const since = +getMeta(`loginSince:${id}`) || 0; setMeta(`login:${id}`, 'out');
          log('', id, 'login-expired', since ? `保持了 ${((Date.now() - since) / 3600e3).toFixed(1)} 小时` : '');
          await notify(`🔑 ${NAMES[id]}登录过期了${since ? `（这次保持了 ${((Date.now() - since) / 3600e3).toFixed(1)} 小时）` : ''}\n发布前请在专用 Chrome 里重新扫码：${LOGIN_PAGES[id]}`);
        }
      }
      // X 长文模式：定时前 25 分钟启动长文脚本（每期只启动一次）
      for (const ep of episodes()) {
        const sched = ep.schedule ? Date.parse(ep.schedule) : 0, xt = getTask(ep.id, 'x');
        if (!sched || !xt || xt.state !== 'scheduled' || Date.now() < sched - 25 * MIN || Date.now() > sched + 20 * MIN || getMeta(`xart:${ep.id}`)) continue;
        let pj; try { pj = loadProject(ep.dir); } catch { continue; }
        if (pj.platforms.x && pj.platforms.x.mode === 'article+quote') { setMeta(`xart:${ep.id}`, Date.now()); startArticleJob(ep, pj); await notify(`🕕 ${ep.name}\nX：启动长文脚本，${new Date(sched).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)} 发长文，再发引用长文的视频帖`); }
      }
      // 每天上午 10 点后采一次流量（最近 30 天的期数）
      if (new Date().getHours() >= 10 && getMeta('metricsDay') !== new Date().toLocaleDateString('zh-CN')) {
        setMeta('metricsDay', new Date().toLocaleDateString('zh-CN'));
        await metricsReport(episodes().filter(e => Date.now() - Date.parse(e.created_at) < 30 * 86400e3)).catch((e) => console.error('流量采集出错：' + e.message));
        // 采完流量：到第 1/3/7 天的期出复盘卡片，周一出周报（每条只发一次）
        try { const R = await import('./review.mjs'); for (const t of R.due((k) => { if (getMeta(k)) return false; setMeta(k, Date.now()); return true; })) await notify(t); }
        catch (e) { console.error('复盘出错：' + e.message); }
      }
      // 发布前一晚 20 点后：第二天要发、还没开跑的期，先查一遍登录，掉线的今晚就扫码
      for (const ep of episodes()) {
        const sched = ep.schedule ? Date.parse(ep.schedule) : 0;
        if (!sched || new Date().getHours() < 20 || sched - Date.now() < 6 * 3600e3 || sched - Date.now() > 30 * 3600e3) continue;
        if (!getTasks(ep.id).some(t => t.state === 'planned') || getMeta(`eve:${ep.id}`)) continue;
        setMeta(`eve:${ep.id}`, Date.now());
        const bad = await doctor().catch(() => null);
        if (bad && !bad.length) await notify(`🌙 ${ep.name}\n明天 ${ep.schedule.slice(11, 16)} 发布，${ALL.length} 个平台登录都正常`);
        else if (bad) await notify(`🌙 ${ep.name}\n明天 ${ep.schedule.slice(11, 16)} 发布，今晚先把这些平台登录好：${bad.map(i => NAMES[i]).join('、')}`);
      }
      // 每天上午体检一次，有平台掉线才通知
      const day = new Date().toLocaleDateString('zh-CN');
      if (new Date().getHours() >= 9 && getMeta('doctorDay') !== day) { setMeta('doctorDay', day); await doctor().catch((e) => console.error('体检出错：' + e.message)); }
    } catch (e) { console.error('守护循环出错：' + e.message); }
    await drv.sleep(5 * MIN);
  }
}

let code = 0;
try {
  if (cmd === 'run') await run();
  else if (cmd === 'submit') await submitOne();
  else if (cmd === 'sync') { const ep = getEpisode(args[1]); if (!ep) throw new Error('没有这一期，先 hub status 看 id'); await sync(ep, opt('--only') ? opt('--only').split(',') : null); }
  else if (cmd === 'doctor') await doctor();
  else if (cmd === 'board') { await drv.ensure(); const r = await boardSync(); console.log(JSON.stringify(r)); }
  else if (cmd === 'review') {   // hub review <id> [天数]：看某一期发布 N 天的复盘（加 --notify 发飞书）
    const R = await import('./review.mjs'); const ep = getEpisode(args[1]); if (!ep) throw new Error('没有这一期，先 hub status 看 id');
    const t = R.reviewText(R.review(ep, +(args[2] && !args[2].startsWith('--') ? args[2] : 1))); console.log(t); if (args.includes('--notify')) await notify(t);
  }
  else if (cmd === 'weekly') { const R = await import('./review.mjs'); const w = R.weekly(); console.log(w.text); if (args.includes('--notify')) await notify(w.text); }
  else if (cmd === 'metrics') { const list = args[1] ? [getEpisode(args[1])].filter(Boolean) : episodes().filter(e => Date.now() - Date.parse(e.created_at) < 30 * 86400e3); await metricsReport(list); }
  else if (cmd === 'plan') {   // 只登记、不上传：大屏「分发计划」里先看到这一期
    if (args[1] && !args[1].startsWith('--')) { const r = planDir(path.resolve(args[1])); console.log(r ? `已登记计划：${r}` : '这一期已经登记过了'); }
    else { const n = scanPlans(); console.log(`扫描完成，新登记 ${n.length} 期${n.length ? '：' + n.join('、') : ''}`); }
  }
  else if (cmd === 'adopt') {   // 把已经发过的一期登记进来（不上传），按标题去各平台取链接
    const dir = path.resolve(args[1] || ''), pj = loadProject(dir), ep = { id: pj.id, episode: pj.episode, name: pj.name, dir, schedule: pj.schedule || null };
    upsertEpisode(ep); saveSnapshot(ep.id, pj); for (const id of Object.keys(pj.platforms)) if (!getTask(ep.id, id)) setTask(ep.id, id, 'pending', '登记的往期');
    await sync(getEpisode(ep.id)); console.log(table(ep.id));
  }
  else if (cmd === 'login') { await drv.openForLogin(ALL.map(i => LOGIN_PAGES[i])); console.log(`专用 Chrome 已打开 ${ALL.length} 个平台页面，登录完运行 hub doctor 检查`); }
  else if (cmd === 'followers') { await drv.ensure(); console.log(JSON.stringify(await collectFollowers(opt('--only') ? opt('--only').split(',') : null), null, 1)); }
  else if (cmd === 'daemon') await daemon();
  else if (cmd === 'web') { const { startWeb } = await import('./web.mjs'); startWeb(); await new Promise(() => {}); }
  else if (cmd === 'open') {
    const { openLocal } = await import('./platform.mjs');
    const port = config.web?.port || 8787, key = config.web?.key || '';
    const url = `http://127.0.0.1:${port}/${key ? '?key=' + encodeURIComponent(key) : ''}`;
    if (!openLocal(url)) console.error('没有打开浏览器，请手动访问下面的地址');
    console.log(url);
  }
  else if (cmd === 'status') {
    const list = args[1] && !args[1].startsWith('--') ? [getEpisode(args[1])].filter(Boolean) : episodes().slice(0, 5);
    if (!list.length) console.log('还没有记录');
    for (const e of list) { console.log(`\n【${e.id}】${e.name}  定时 ${e.schedule || '立即'}\n${table(e.id)}`); if (args.includes('--logs')) console.log(recentLogs(e.id).map(l => `  ${l.ts.slice(11, 19)} ${l.platform} ${l.action} ${l.result}`).join('\n')); }
  } else if (cmd === 'mark') { setTask(args[1], args[2], args[3], (args[4] && !args[4].startsWith('--') ? args[4] : '人工标记'), { url: opt('--url') || undefined }); log(args[1], args[2], 'mark', args[3]); console.log(table(args[1])); }
  else if (cmd === 'notify-test') await notify('发布中控已接通 ✅');
  else console.log('用法：hub login | doctor | run <工程目录> [--only a,b] [--force] | status [id] [--logs] | sync <id> | mark <id> <平台> <状态> | submit <id> <instagram|youtube|x> | daemon | web | open');
} catch (e) { console.error('出错：' + e.message); if (!e.quiet) await notify(`❌ 发布中控出错：${e.message.slice(0, 300)}`); code = 1; }
await drv.close(); db.close(); process.exit(code);
