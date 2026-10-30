import { runClean } from './cleaner.js';
import { NEVER_TOUCH } from './paths.js';
import { appendLog, writeReport } from './store.js';
import { acquireLock, pidAlive, releaseLock, sleep } from './processes.js';

/** 阶段一轮询间隔：只看 pid、不发外部命令，所以可以很密。 */
const POLL_MS = 250;
/** 阶段二：进程没了之后，用这串退避去抢"库刚被释放"的窗口。 */
const DRAIN_DELAYS_MS = [0, 200, 400, 800, 1200, 2000, 3000];

/**
 * 等 DSH 退出，然后清一次。
 *
 * ⭐ 为什么不"启动时清"：cookie 库在应用运行期间被 Chromium 独占 —— 读、改名、删除
 *    都是 EBUSY（实测 Copy-Item / FileShare.ReadWrite / esentutl / unlink 全部失败）。
 *    真正能动手的窗口只有"上一次退出之后、下一次启动之前"。
 *
 * 两阶段：
 *   ① 只轮询自己盯的那几个 pid（便宜、密）；
 *   ② 它们消失后**真去开库**：开得动就是我们的窗口；开不动说明新实例已经把库拿走，
 *      退避再试几次；还不行就记一条"错过窗口"，不再傻等。
 *
 * ⚠️ 第一版在阶段二用 `tasklist` 找 `DeepSeek Harness.exe` 当闸门 —— 可 helper 自己
 *    就是拿这个名字起的，于是永远"还有 DSH 在跑"，一次都没清成。现在不再拿进程名做主判据。
 */
export async function waitAndClean({ pids, config, dbPath, stateDir, timeoutMs, drainDelays = DRAIN_DELAYS_MS }) {
  const deadline = Date.now() + timeoutMs;
  const watched = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  let polls = 0;

  // 阶段一：等自己盯的那批进程消失
  while (Date.now() < deadline) {
    polls += 1;
    if (!watched.some((pid) => pidAlive(pid))) break;
    await sleep(POLL_MS);
  }

  if (Date.now() >= deadline) {
    const report = {
      at: new Date().toISOString(),
      trigger: 'exit',
      ok: false,
      deleted: 0,
      note: `gave up after ${Math.round(timeoutMs / 1000)}s (${polls} polls) — DSH never exited`,
    };
    appendLog(stateDir, `helper timeout after ${polls} polls`);
    return report;
  }

  // 阶段二：抢窗口
  for (const delay of drainDelays) {
    if (delay > 0) await sleep(delay);
    if (Date.now() >= deadline) break;
    const report = runClean({ config, dbPath, stateDir, trigger: 'exit' });
    if (report.ok || report.skipped) return report;
    if (!String(report.note || '').startsWith('locked')) return report; // 别的错误：直接收工
  }

  // 全是 locked ⇒ 秒退秒开把窗口吃掉了
  const missed = {
    at: new Date().toISOString(),
    trigger: 'exit',
    ok: false,
    deleted: 0,
    untouched: [...NEVER_TOUCH],
    note: 'missed the exit window: a new DSH instance took the store before we could clean',
  };
  try { writeReport(stateDir, missed); } catch { /* 报告写不了也不影响 */ }
  appendLog(stateDir, 'missed the exit window (store re-locked by a new instance)');
  return missed;
}

/** helper 进程的完整生命周期：抢锁 → 等退出 → 清理 → 放锁。 */
export async function runHelper({ pids, config, dbPath, stateDir, timeoutMs }) {
  if (!acquireLock(stateDir, { pid: process.pid, pids })) return null;
  try {
    appendLog(stateDir, `helper armed pids=${pids.join(',')} timeout=${timeoutMs}ms`);
    return await waitAndClean({ pids, config, dbPath, stateDir, timeoutMs });
  } finally {
    releaseLock(stateDir);
  }
}
