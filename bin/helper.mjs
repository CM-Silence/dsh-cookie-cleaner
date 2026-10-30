#!/usr/bin/env node
import '../lib/silence.js';
import { runHelper, waitAndClean } from '../lib/helper.js';
import { normalizeConfig } from '../lib/config.js';
import { cookieDbPath, stateDir as stateDirOf } from '../lib/paths.js';

/**
 * 脱离父进程运行的清理器：等 DSH 退出 → 清一次 → 退出。
 *
 * 参数由插件通过环境变量下发（避免 Windows 命令行转义/长度问题）：
 *   DSH_COOKIE_CLEANER_CONFIG  base64(JSON) 的已归一化配置
 *   DSH_COOKIE_CLEANER_STATE   状态目录（报告/备份/日志）
 * 命令行只带 pids。
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[key.slice(2)] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const raw = process.env.DSH_COOKIE_CLEANER_CONFIG || '';
let parsed = {};
try {
  parsed = raw ? JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) : {};
} catch {
  parsed = {};
}

const config = normalizeConfig(parsed);
if (!config.enabled) process.exit(0);

const stateDir = process.env.DSH_COOKIE_CLEANER_STATE || stateDirOf();
const dbPath = args.db && args.db !== 'true' ? args.db : cookieDbPath(config.userDataDir);
const pids = String(args.pids && args.pids !== 'true' ? args.pids : '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

// 锁有两种持法：
//   · 被哨兵（watch.cmd）叫起来时，锁已经由插件代写（pid 是哨兵的），这里不能再抢；
//   · 自己直接被 spawn 时（非 Windows，或手工跑），自己抢、自己放。
const lockHeld = process.env.DSH_COOKIE_CLEANER_LOCK_HELD === '1';

try {
  if (lockHeld) {
    await waitAndClean({ pids, config, dbPath, stateDir, timeoutMs: config.waitTimeoutMs });
  } else {
    await runHelper({
      pids,
      config,
      dbPath,
      stateDir,
      timeoutMs: config.waitTimeoutMs,
    });
  }
} finally {
  // ⭐ 清完（或抢不到窗口）必须立刻退出 —— 绝不常驻。
  //    正常情况下上面已经结束了；这里兜一层，保证任何分支都不会把进程留在后台。
  process.exit(0);
}
