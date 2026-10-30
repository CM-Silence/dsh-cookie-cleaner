import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { isLocalHost, normalizeHost } from './config.js';

/**
 * `node:sqlite` 是**懒加载**的。
 *
 * ⭐ 为什么：它一 import 就会打一句 ExperimentalWarning。插件在 Host 里挂载时
 *    99% 的情况只是"看一眼、发现库被锁、交给 helper"，根本用不上 sqlite；
 *    把这个 import 推迟到真正要读库那一刻，就不会往启动日志里撒无关的警告。
 */
const require = createRequire(import.meta.url);
let DatabaseSyncCtor;

function sqlite() {
  if (DatabaseSyncCtor === undefined) {
    DatabaseSyncCtor = require('node:sqlite').DatabaseSync;
  }
  return DatabaseSyncCtor;
}

/** Chromium 把时间存成"1601-01-01 起的微秒数"，不是 Unix 时间。 */
const WINDOWS_EPOCH_OFFSET_MS = 11644473600000;

export function toChromiumTime(ms) {
  return BigInt(Math.round(ms + WINDOWS_EPOCH_OFFSET_MS)) * 1000n;
}

export function fromChromiumTime(micros) {
  return Number(BigInt(micros) / 1000n) - WINDOWS_EPOCH_OFFSET_MS;
}

/**
 * 一条 cookie 在 Cookie 头里占的大致字节。
 * 值可能落在 `value`（明文）或 `encrypted_value`（密文）里，取大的那个，
 * 再加上 `name=`、`; ` 这些固定开销 —— 用来做预算判断，不追求精确到字节。
 */
const COOKIE_BYTES_SQL = "MAX(LENGTH(COALESCE(value,'')), LENGTH(COALESCE(encrypted_value,''))) + LENGTH(name) + 2";

export class CookieStoreLocked extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'CookieStoreLocked';
    this.code = 'LOCKED';
    this.cause = cause;
  }
}

/**
 * 这个错误是不是"库被占着"。
 *
 * ⚠️ 两个时机都要认：打开时就 EBUSY（Chromium 独占，OS 层直接拒绝），
 *    或者打开了但 `BEGIN IMMEDIATE` 抢不到锁（另一个 SQLite 连接占着）。
 *    只认前者的话，后者会冒成 'database is locked' 的原始文案，
 *    传到报告里就变成"出错了"，而不是"锁着、等下一轮"。
 */
export function isLockError(error) {
  const text = [error && error.code, error && error.message, error && error.cause && error.cause.message]
    .filter(Boolean)
    .join(' ');
  return /EBUSY|EPERM|SQLITE_BUSY|database is locked|unable to open/i.test(text);
}

function asLocked(error) {
  if (isLockError(error)) return new CookieStoreLocked('cookie store is in use (DSH is running)', error);
  return null;
}

/** 只读打开，拿统计。DSH 在跑的时候这一步就会抛 CookieStoreLocked。 */
export function openStore(dbPath, { readOnly = false } = {}) {
  if (!existsSync(dbPath)) {
    const error = new Error('cookie store not found: ' + dbPath);
    error.code = 'MISSING';
    throw error;
  }
  try {
    const DatabaseSync = sqlite();
    return new DatabaseSync(dbPath, { readOnly });
  } catch (error) {
    const locked = asLocked(error);
    if (locked) throw locked;
    throw error;
  }
}

export function hasCookiesTable(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(name)='cookies'").get();
  return Boolean(row);
}

/** 按 host 汇总：条数 + 估算字节。报告和策略都吃这个。 */
export function readStats(db) {
  if (!hasCookiesTable(db)) return { cookies: 0, bytes: 0, hosts: [], tableMissing: true };
  const rows = db.prepare(`
    SELECT host_key AS host,
           COUNT(*) AS count,
           SUM(${COOKIE_BYTES_SQL}) AS bytes
    FROM cookies
    GROUP BY host_key
    ORDER BY bytes DESC
  `).all();
  const hosts = rows.map((row) => ({
    host: String(row.host ?? ''),
    count: Number(row.count ?? 0),
    bytes: Number(row.bytes ?? 0),
  }));
  return {
    cookies: hosts.reduce((sum, host) => sum + host.count, 0),
    bytes: hosts.reduce((sum, host) => sum + host.bytes, 0),
    hosts,
  };
}

/** 本机 origin 的 cookie 全部删掉（这是 431 的来源）。 */
export function deleteLocalCookies(db, localHosts) {
  if (!hasCookiesTable(db)) return 0;
  const hosts = db.prepare('SELECT DISTINCT host_key AS host FROM cookies').all();
  const targets = hosts
    .map((row) => String(row.host ?? ''))
    .filter((host) => isLocalHost(host, localHosts));
  if (targets.length === 0) return 0;
  let deleted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const stmt = db.prepare('DELETE FROM cookies WHERE host_key = ?');
    for (const host of targets) deleted += Number(stmt.run(host).changes ?? 0);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 已经回了 */ }
    throw error;
  }
  return deleted;
}

/** 全库删光（`mode: 'all'`，等于老办法：会掉登录，所以一定会先备份）。 */
export function deleteAllCookies(db) {
  if (!hasCookiesTable(db)) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = Number(db.prepare('SELECT COUNT(*) AS n FROM cookies').get()?.n ?? 0);
    db.exec('DELETE FROM cookies');
    db.exec('COMMIT');
    return before;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 已经回了 */ }
    throw error;
  }
}

/**
 * 预算兜底：**只针对单个 host**。
 *
 * ⚠️ 这里是第二版修掉的错误：第一版拿"全库总字节"和 maxHeaderBytes 比。
 *    Cookie 头是按 origin 组织的 —— 发往 127.0.0.1 的请求根本带不上 .deepseek.com 的 cookie，
 *    所以用全库总量当预算，会在"跟 431 毫无关系"的情况下把账号 cookie 删掉。
 *    现在只按 host 判：某个 host 自己的 cookie 超过预算，才动它。
 *
 * ⚠️ 每个 (host,name) 至少留最新的一条 —— 不留等于把登录态按字母顺序拆散，比"掉登录"更难查。
 */
export function pruneOldestInHost(db, host, budgetBytes, keepDays, now = Date.now(), { apply = true } = {}) {
  if (!hasCookiesTable(db)) return { deleted: 0, freedBytes: 0 };
  // ⚠️ creation_utc 是"1601 起的微秒"，≈1.3e16，超过 Number.MAX_SAFE_INTEGER。
  //    直接 SELECT 出来 node:sqlite 会抛 ERR_OUT_OF_RANGE，所以一律 CAST 成文本再用 BigInt 比。
  const rows = db.prepare(`
    SELECT host_key AS host, name, path, CAST(creation_utc AS TEXT) AS createdAt, ${COOKIE_BYTES_SQL} AS bytes
    FROM cookies
    WHERE host_key = ?
    ORDER BY creation_utc ASC
  `).all(host);
  if (rows.length === 0) return { deleted: 0, freedBytes: 0 };

  const cutoff = toChromiumTime(now - keepDays * 24 * 60 * 60 * 1000);
  const newestByGroup = new Map();
  for (const row of rows) {
    const key = normalizeHost(row.host) + '\u0000' + row.name;
    const seen = newestByGroup.get(key);
    if (seen === undefined || BigInt(row.createdAt) > BigInt(seen)) newestByGroup.set(key, row.createdAt);
  }

  // ⚠️ 这里算的必须是**这个 host 自己**的字节数，不是全库（第二版修的就是这个）。
  let bytes = rows.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0);
  let freed = 0;
  const victims = [];
  const picked = new Set();
  const keyOf = (row) => [row.host, row.name, row.path, row.createdAt].join('\u0000');

  const pick = (row) => {
    const k = keyOf(row);
    if (picked.has(k)) return false;
    picked.add(k);
    victims.push(row);
    bytes -= Number(row.bytes ?? 0);
    freed += Number(row.bytes ?? 0);
    return true;
  };

  // 第一轮：同一个 (host,name) 只留最新的一条 —— 按字母序删会把登录态拆散，更难查。
  for (const row of rows) {
    if (bytes <= budgetBytes) break;
    if (BigInt(row.createdAt) >= BigInt(cutoff)) continue; // 太新，不动
    const key = normalizeHost(row.host) + '\u0000' + row.name;
    if (BigInt(newestByGroup.get(key)) === BigInt(row.createdAt)) continue; // 这组里最新的一条，留着
    pick(row);
  }

  // 第二轮（最后手段）：还超标就按最老优先继续删，不再管"每组留最新"。
  // ⚠️ 这一轮会连登录 cookie 一起动，所以只在预算真的压不下来时才会走到。
  if (bytes > budgetBytes) {
    for (const row of rows) {
      if (bytes <= budgetBytes) break;
      if (BigInt(row.createdAt) >= BigInt(cutoff)) continue;
      pick(row);
    }
  }

  if (victims.length === 0) return { deleted: 0, freedBytes: 0 };
  // 只算不做：调用方要拿"到底会不会删"来决定是否先备份（免得每次兜底都留一份空备份）。
  if (!apply) return { deleted: victims.length, freedBytes: freed };

  db.exec('BEGIN IMMEDIATE');
  try {
    const stmt = db.prepare('DELETE FROM cookies WHERE host_key = ? AND name = ? AND path = ? AND creation_utc = ?');
    let deleted = 0;
    for (const row of victims) {
      deleted += Number(stmt.run(row.host, row.name, row.path, row.createdAt).changes ?? 0);
    }
    db.exec('COMMIT');
    return { deleted, freedBytes: freed };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 已经回了 */ }
    throw error;
  }
}

/** 改库之前先备份 —— 万一策略不对，用户手里还有原件。 */
export function backupStore(dbPath, dir, keep = 5) {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `Cookies-${stamp}.db`);
  copyFileSync(dbPath, target);
  const files = readdirSync(dir)
    .filter((name) => name.startsWith('Cookies-') && name.endsWith('.db'))
    .map((name) => ({ name, at: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const extra of files.slice(keep)) {
    try { unlinkSync(path.join(dir, extra.name)); } catch { /* 删不掉就留着 */ }
  }
  return target;
}

function vacuum(db) {
  try {
    db.exec('VACUUM');
    return true;
  } catch {
    return false;
  }
}

export function appendLog(dir, line) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'host.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch { /* 日志写不了也不能影响主流程 */ }
}

export function writeReport(dir, report) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'last-report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    at: report.at,
    ok: report.ok,
    mode: report.mode,
    before: report.before && { cookies: report.before.cookies, bytes: report.before.bytes },
    after: report.after && { cookies: report.after.cookies, bytes: report.after.bytes },
    deleted: report.deleted,
    note: report.note,
  }, null, 2) + '\n');
}

export function readReport(dir) {
  const file = path.join(dir, 'last-report.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
