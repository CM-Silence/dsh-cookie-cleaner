import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { appendLog } from './store.js';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 进程还在不在。EPERM 说明进程在、只是没权限给它发信号（Windows 上常见）。 */
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

/**
 * 解析 `tasklist /FO CSV /NH` 的输出，拿到 pid 列表。
 * 抽成纯函数是为了能单测 —— 这段逻辑第一版写错过（见 dshRunning 的注释）。
 */
export function parseTasklistPids(output) {
  const pids = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (match) pids.add(Number(match[2]));
  }
  return pids;
}

/**
 * 还有没有**别的** DSH 桌面端进程在跑。
 *
 * ⚠️ 这里有个很坑的自指问题：helper 自己就是拿 `DeepSeek Harness.exe` 起的
 *   （插件用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 拉起 helper），
 *   所以 `tasklist` 永远能列出它自己 —— 第一版就卡在这里，等退出等了一整天、
 *   一次都没清过。现在按 pid 判断，并且**永远排除自己和自己的父进程**。
 *
 * @param {string} imageName 可执行文件名
 * @param {{exclude?: number[], platform?: string, run?: Function}} [opts]
 */
export function dshRunning(imageName = 'DeepSeek Harness.exe', opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return false; // 其它平台靠 pid 判断就够
  if (!imageName || !imageName.toLowerCase().endsWith('.exe')) return false;

  const exclude = new Set([process.pid, process.ppid, ...(opts.exclude || [])].filter(Boolean));
  try {
    const run = opts.run || ((args) => execFileSync('tasklist', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    }));
    const out = run(['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH']);
    const pids = parseTasklistPids(out);
    for (const pid of pids) if (!exclude.has(pid)) return true;
    return false;
  } catch {
    return false; // tasklist 不可用就不拦，pid 判断仍然生效
  }
}

/* ───────────────────────── 单实例闸门 ───────────────────────── */

const LOCK_STALE_MS = 60 * 60 * 1000;

export function lockPath(stateDir) {
  return path.join(stateDir, 'helper.lock');
}

export function readLock(stateDir) {
  const file = lockPath(stateDir);
  if (!existsSync(file)) return null;
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    return lock && typeof lock === 'object' ? lock : null;
  } catch {
    return null;
  }
}

export function lockAlive(stateDir) {
  const lock = readLock(stateDir);
  if (!lock) return false;
  const age = Date.now() - Number(lock.at || 0);
  if (!Number.isFinite(age) || age > LOCK_STALE_MS) return false;
  return pidAlive(lock.pid);
}

/**
 * 锁还活着，但它盯的那批进程**早就没了**、也还没清成功 ——
 * 说明它已经错过一次性窗口（比如用户秒退秒开），只剩"等下一次退出"。
 * 这种 helper 对**新**实例没有帮助，而且它的锁会挡住新 helper ⇒ 应该被替换。
 *
 * 另外：哨兵/helper 换代（版本不同）也算过期 —— 老版本可能是那个 91MB 的
 * Electron 常驻进程，留着就是白白占内存，升级后第一次启动就该换掉。
 */
export function lockIsStale(stateDir, version = '') {
  const lock = readLock(stateDir);
  if (!lock || !lockAlive(stateDir)) return false;
  if (version && lock.version && lock.version !== version) return true;
  const watched = Array.isArray(lock.pids) ? lock.pids : [];
  if (watched.length === 0) return true;
  return watched.every((pid) => !pidAlive(pid));
}

export function acquireLock(stateDir, payload) {
  mkdirSync(stateDir, { recursive: true });
  const file = lockPath(stateDir);
  if (lockAlive(stateDir)) return false;
  try {
    writeFileSync(file, JSON.stringify({ ...payload, at: Date.now() }, null, 2) + '\n');
    return true;
  } catch (error) {
    appendLog(stateDir, 'lock write failed: ' + String(error && error.message));
    return false;
  }
}

export function releaseLock(stateDir) {
  try {
    const lock = readLock(stateDir);
    if (lock && Number(lock.pid) === process.pid) unlinkSync(lockPath(stateDir));
  } catch { /* 删不掉就等它过期 */ }
}

/** 杀掉一个卡住的 helper 并把锁清掉。只在确认它"过期"时调用。 */
export function replaceStaleHelper(stateDir, log = () => {}) {
  const lock = readLock(stateDir);
  if (!lock) return false;
  if (pidAlive(lock.pid)) {
    try {
      process.kill(Number(lock.pid), 'SIGTERM');
      log(`killed stale helper pid=${lock.pid} (它盯的进程早没了，留着只会挡新 helper)`);
    } catch (error) {
      log('failed to kill stale helper: ' + String(error && error.message));
    }
  }
  try { unlinkSync(lockPath(stateDir)); } catch { /* 忽略 */ }
  return true;
}
