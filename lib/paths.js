import os from 'node:os';
import path from 'node:path';

/** Harness 家目录：与 DSH 自己解析路径的方式保持一致。 */
export function dshHome(env = process.env) {
  return env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 插件自己的状态目录（日志、报告、备份都放这儿，不碰 DSH 的业务数据）。 */
export function stateDir(env = process.env) {
  return path.join(dshHome(env), 'cookie-cleaner');
}

/**
 * Electron 桌面版的 userData 目录。
 *
 * ⭐ 为什么不用 `app.getPath('userData')`：这插件跑在 **Host 子进程**里（Electron 以
 * `ELECTRON_RUN_AS_NODE` 起的 node 进程），那里拿不到 Electron 的 app 对象。
 * 所以按平台约定算出来；算错了也只是"找不到库、跳过"，不会误删别的东西。
 */
export function defaultUserDataDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, '@deepseek-ai', 'dsh-desktop');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), '@deepseek-ai', 'dsh-desktop');
}

/** Chromium 的 cookie 库。所有清理只针对这一个文件。 */
export function cookieDbPath(userDataDir) {
  return path.join(userDataDir, 'Network', 'Cookies');
}

/** ⚠️ 白名单式的"绝不触碰"清单 —— 写在这里是为了让人一眼查得到，也方便测试断言。 */
export const NEVER_TOUCH = [
  'Local Storage',
  'IndexedDB',
  'Session Storage',
  'Preferences',
  'Local State',
  'Network/Cookies-journal',
  'profiles/desktop/cordis.patch.yml',
  'settings.yaml',
];
