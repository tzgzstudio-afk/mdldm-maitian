// 代码目录和可写状态目录分开。
// 从 git 检出目录直接跑时，两者都是仓库根目录，和原来的 macOS 用法一样。
// 装到 /opt/maitian 这种不可写目录时，配置、数据库、登录档案放到用户目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function chooseState() {
  if (process.env.MAITIAN_STATE) return path.resolve(process.env.MAITIAN_STATE);
  if (process.platform === 'linux') {
    try { fs.accessSync(APP_ROOT, fs.constants.W_OK); }
    catch { return path.join(os.homedir(), '.local', 'share', 'maitian'); }
  }
  return APP_ROOT;
}

export const STATE_ROOT = chooseState();
if (!process.env.MAITIAN_STATE && STATE_ROOT !== APP_ROOT) process.env.MAITIAN_STATE = STATE_ROOT;

export function ensureState() {
  fs.mkdirSync(path.join(STATE_ROOT, 'data'), { recursive: true });
  return STATE_ROOT;
}
