import './silence.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from './config.js';
import { cookieDbPath, stateDir as stateDirOf } from './paths.js';
import { runClean } from './cleaner.js';
import { appendLog, readReport } from './store.js';
import { lockAlive, lockIsStale, replaceStaleHelper, dshRunning, acquireLock } from './processes.js';

export const name = 'dsh-cookie-cleaner';
/** 只依赖 Node 内置能力；不注入任何 DSH 服务，挂不上也不会拖垮启动。 */
export const inject = [];

/** 拿自己的版本号写进锁里 —— 升级后第一次启动就能把老版本的哨兵换掉。 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '';
  } catch {
    return '';
  }
})();

const HELPER = fileURLToPath(new URL('../bin/helper.mjs', import.meta.url));
const WATCH_VBS = fileURLToPath(new URL('../bin/watch.vbs', import.meta.url));
/** wscript.exe 是 GUI 子系统，天生没有控制台 —— 见 spawn 处的说明。 */
const WSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');

function summarize(report) {
  if (!report) return 'no previous run';
  const before = report.before ? `${report.before.cookies}/${report.before.bytes}B` : '?';
  const after = report.after ? `${report.after.cookies}/${report.after.bytes}B` : '?';
  return `${report.ok ? 'ok' : 'failed'} ${report.trigger} ${before}→${after} ${report.note ? '(' + report.note + ')' : ''}`.trim();
}

/**
 * 挂上就跑三件事：
 *   ① 打一行"上次清成什么样"的日志；
 *   ② 立刻试一次（99% 会被锁住 —— 这时只记录，不动手）；
 *   ③ 起一个脱离进程的 helper，等这次 DSH 退出后把库清干净。
 *
 * ⭐ 为什么是"退出后清"而不是"启动时清"：cookie 库在运行期被 Chromium 独占，
 *    读/改/删/改名全是 EBUSY。退出后清 → 等价于每次启动都拿到干净的库，
 *    而且永远不和正在跑的应用抢文件。
 */
export function apply(ctx, rawConfig) {
  let config;
  let state;
  let dbPath;
  try {
    config = normalizeConfig(rawConfig);
    state = stateDirOf();
    dbPath = cookieDbPath(config.userDataDir);
    mkdirSync(state, { recursive: true });
  } catch (error) {
    // 这里出错绝不能影响 DSH 启动
    try { console.error('[cookie-cleaner] init failed: ' + String(error && error.message)); } catch { /* 忽略 */ }
    return;
  }

  appendLog(state, `boot: ${summarize(readReport(state))}`);

  if (!config.enabled) {
    appendLog(state, 'disabled by config — idle');
    return;
  }
  if (!existsSync(dbPath)) {
    appendLog(state, `no cookie store at ${dbPath} — idle`);
    return;
  }

  // 桌面端里 process.execPath 就是 DeepSeek Harness.exe；CLI/headless 里是 node.exe，
  // 那种情况下不拿进程名当第二道闸（否则会把所有 node 都当成"DSH 还在跑"）。
  const exeName = path.basename(process.execPath);
  const imageName = /deepseek/i.test(exeName) ? exeName : '';

  // ② 只有在"应用没在跑"时才有机会立刻清一次（正常桌面启动里几乎永远为假）。
  //    这里顺带避开 sqlite 的懒加载：不必为了确认"锁着"去碰库。
  if (!dshRunning(imageName)) {
    try {
      const immediate = runClean({ config, dbPath, stateDir: state, trigger: 'startup' });
      if (!immediate.ok && !String(immediate.note || '').startsWith('locked')) {
        appendLog(state, 'startup pass: ' + (immediate.note || 'unknown failure'));
      }
    } catch (error) {
      appendLog(state, 'startup pass threw: ' + String(error && error.message));
    }
  } else {
    appendLog(state, 'app is running — cleanup deferred to the exit helper');
  }

  // ③ 交给 helper：等退出再动手。
  // ⚠️ 锁还在、但它盯的进程早就没了 ⇒ 它已经错过窗口，留着只会挡住新 helper，
  //    直接换掉（第一版就是这样：旧 helper 一直等，新实例反而以为"已经有人值守"）。
  if (lockAlive(state)) {
    if (lockIsStale(state, VERSION)) {
      replaceStaleHelper(state, (message) => appendLog(state, message));
      appendLog(state, 'stale helper replaced');
    } else {
      appendLog(state, 'helper already armed — skip spawning another');
      return;
    }
  }

  try {
    const watched = `${process.pid},${process.ppid}`;
    const payload = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_COOKIE_CLEANER_CONFIG: payload,
      DSH_COOKIE_CLEANER_STATE: state,
    };

    // ⭐ Windows 上让 **wscript** 当哨兵，而不是让一个 node 进程整晚挂着：
    //    · Electron 的 node 常驻 ≈ 91MB；
    //    · cmd 只有 8MB，但它是控制台程序 —— 从 GUI 父进程起来时，
    //      detached 就没有控制台，它每 2 秒 spawn 的 timeout/tasklist 会**各开一个窗口**（闪屏）；
    //      attached 又能继承隐藏控制台、但父进程一退就被带走。
    //    · wscript.exe 是 GUI 子系统：天生没有控制台，Run(...,0,...) 让 node 也隐藏，
    //      而且 detached 之后能活到应用退出。内存 ≈ 5MB，不闪窗。
    //    其它平台仍然用 node 直接等。
    const useWatcher = process.platform === 'win32' && existsSync(WSCRIPT) && existsSync(WATCH_VBS);
    let child;
    let kind;
    if (useWatcher) {
      env.DSH_COOKIE_CLEANER_LOCK_HELD = '1'; // 锁由插件代写（pid 是哨兵的）
      child = spawn(WSCRIPT, ['//nologo', '//B', WATCH_VBS, watched, process.execPath, HELPER], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env,
      });
      kind = 'watcher';
    } else {
      child = spawn(process.execPath, ['--no-warnings', HELPER, '--pids', watched], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env,
      });
      kind = 'helper';
    }
    child.unref();

    if (kind === 'watcher') {
      acquireLock(state, { pid: child.pid, pids: [process.pid, process.ppid], kind, version: VERSION });
    }

    try {
      writeFileSync(path.join(state, 'armed.json'), JSON.stringify({
        at: new Date().toISOString(),
        kind,
        helperPid: child.pid,
        watched: [process.pid, process.ppid],
        dbPath,
        mode: config.mode,
        maxHeaderBytes: config.maxHeaderBytes,
      }, null, 2) + '\n');
    } catch { /* 记账失败不影响清理 */ }
    appendLog(state, `${kind} spawned pid=${child.pid} watching=${process.pid},${process.ppid}`);
  } catch (error) {
    appendLog(state, 'helper spawn failed: ' + String(error && error.message));
  }
}
