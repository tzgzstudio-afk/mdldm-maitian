import fs from 'node:fs'; import path from 'node:path';
import { STATE_ROOT } from './paths.mjs';
const CFG = process.env.MAITIAN_CONFIG || path.join(STATE_ROOT, 'config.json');
if (!fs.existsSync(CFG)) { console.error(`还没有配置文件 ${CFG}：先运行 node src/init.mjs（安装向导），或者 node src/demo.mjs 用假数据看看效果`); process.exit(1); }
export const config = JSON.parse(fs.readFileSync(CFG, 'utf8'));

// ---------- 文字 → 飞书卡片（2026-11-14） ----------
// 调用方仍然传文字：第一行当标题，开头的表情决定卡片颜色；「平台：状态（说明） 链接」这种行排成带颜色的状态行。
const COLOR = [[/^(✅|🎉)/, 'green'], [/^(👉|⏰)/, 'orange'], [/^❌/, 'red'], [/^⚠️/, 'yellow'], [/^🚀/, 'blue'], [/^(📋|🔗)/, 'wathet'], [/^🩺/, 'turquoise'], [/^(📊|📈)/, 'purple'], [/^🌐/, 'indigo']];
const PLAT = /^(B站|小红书|抖音|视频号|YouTube|X|知识站)：([^（(\s]+)(?:[（(](.*)[)）])?\s*(https?:\/\/\S+)?\s*$/;
const STATE_COLOR = (s) => /已发布|已上线/.test(s) ? 'green' : /已定时|已填好/.test(s) ? 'blue' : /待你点发布/.test(s) ? 'orange' : /异常|未登录|失败/.test(s) ? 'red' : 'grey';
const esc = (s) => String(s).replace(/[<>]/g, (c) => ({ '<': '&lt;', '>': '&gt;' }[c]));
const link = (s) => esc(s).replace(/https?:\/\/[^\s；;，,）)]+/g, (u) => `[${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 42)}${u.length > 50 ? '…' : ''}](${u})`);

function webUrl() { try { return JSON.parse(fs.readFileSync(path.join(STATE_ROOT, 'data', 'tunnel.json'), 'utf8')).url; } catch { return ''; } }

export function toCard(text) {
  const lines = String(text).split('\n').map((l) => l.trim());
  const head = lines.shift() || '麦田';
  const template = (COLOR.find(([re]) => re.test(head)) || [null, 'blue'])[1];
  // 标题太长（比如「✅ 期名」）：期名放标题，后半句放副标题
  const [title, ...restHead] = head.split(/\s*[|｜]\s*(?=[^|｜]*$)/);
  const elements = [];
  let buf = [], rows = [];
  const flushText = () => { if (buf.length) { elements.push({ tag: 'markdown', content: buf.map(link).join('\n') }); buf = []; } };
  const flushRows = () => {
    if (!rows.length) return;
    elements.push({ tag: 'markdown', content: rows.map(([, p, st, detail, url]) => `**${p}**　<font color='${STATE_COLOR(st)}'>${esc(st)}</font>${detail ? `　<font color='grey'>${esc(detail.length > 46 ? detail.slice(0, 46) + '…' : detail)}</font>` : ''}${url ? `　[打开](${url})` : ''}`).join('\n') });
    rows = [];
  };
  for (const l of lines) {
    if (!l) { flushText(); flushRows(); continue; }
    const m = l.match(PLAT);
    if (m) { flushText(); rows.push(m); } else { flushRows(); buf.push(l); }
  }
  flushText(); flushRows();
  if (!elements.length) elements.push({ tag: 'markdown', content: link(head) });
  const url = webUrl();
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `麦田 · ${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }).slice(5, 16)}` }] });
  if (url) elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '打开麦田' }, type: 'primary', url }] });
  return { config: { wide_screen_mode: true }, header: { template, title: { tag: 'plain_text', content: title.slice(0, 80) }, ...(restHead.length ? { subtitle: { tag: 'plain_text', content: restHead.join(' ').slice(0, 80) } } : {}) }, elements };
}

async function post(body) {
  const r = await fetch(config.feishuWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return r.json().catch(() => ({}));
}

// 发飞书群消息；卡片发不出去就退回纯文字；失败只打印，不影响主流程
export async function notify(text, { quiet = false } = {}) {
  if (!quiet) console.log(`[飞书] ${text.replace(/\n/g, ' | ')}`);   // quiet：验证码之类的不写日志
  if (!config.feishuWebhook) return;
  try {
    let j = await post({ msg_type: 'interactive', card: toCard(text) });
    if (j.code && j.code !== 0) { console.error('飞书卡片被拒，改发文字：', JSON.stringify(j)); j = await post({ msg_type: 'text', content: { text } }); }
    if (j.code && j.code !== 0) console.error('飞书返回：', JSON.stringify(j));
  } catch (e) { console.error('飞书通知失败：', e.message); }
}
