import { existsSync } from 'node:fs';
import path from 'node:path';

import { isLocalHost } from './config.js';
import { NEVER_TOUCH } from './paths.js';
import {
  CookieStoreLocked, backupStore, deleteAllCookies, deleteLocalCookies, isLockError, openStore,
  pruneOldestInHost, readStats, writeReport, appendLog, fromChromiumTime,
} from './store.js';

const TOP_HOSTS = 10;

function slimStats(stats) {
  return {
    cookies: stats.cookies,
    bytes: stats.bytes,
    hosts: (stats.hosts || []).slice(0, TOP_HOSTS),
  };
}

function localPart(stats, localHosts) {
  const hosts = (stats.hosts || []).filter((entry) => isLocalHost(entry.host, localHosts));
  return {
    cookies: hosts.reduce((sum, entry) => sum + entry.count, 0),
    bytes: hosts.reduce((sum, entry) => sum + entry.bytes, 0),
    hosts: hosts.slice(0, TOP_HOSTS),
  };
}

/**
 * 跑一次清理。
 *
 * ⭐ 只做三件事：删本机 origin 的 cookie → 预算兜底 → 可选 VACUUM。
 * ⚠️ 不碰 localStorage / IndexedDB / Preferences / cordis.patch.yml（见 NEVER_TOUCH）。
 *
 * @param {object} options
 * @param {object} options.config 已经 normalize 过的配置
 * @param {string} options.dbPath cookie 库路径
 * @param {string} options.stateDir 状态目录（报告、备份、日志）
 * @param {'exit'|'startup'|'cli'} [options.trigger]
 * @param {boolean} [options.dryRun] 只算不删
 */
export function runClean({ config, dbPath, stateDir, trigger = 'cli', dryRun = false }) {
  const started = Date.now();
  const base = {
    at: new Date().toISOString(),
    trigger,
    mode: config.mode,
    db: dbPath,
    dryRun,
    untouched: [...NEVER_TOUCH],
  };

  const finish = (report) => {
    const full = { ...base, durationMs: Date.now() - started, ...report };
    if (!dryRun) {
      try { writeReport(stateDir, full); } catch { /* 报告写不了不影响结果 */ }
      const tail = full.ok
        ? `cleaned trigger=${trigger} deleted=${full.deleted} bytes ${full.before?.bytes ?? '?'}→${full.after?.bytes ?? '?'}`
        : `skipped trigger=${trigger} reason=${full.note}`;
      appendLog(stateDir, tail);
    }
    return full;
  };

  if (!config.enabled) return finish({ ok: true, skipped: true, deleted: 0, note: 'plugin disabled' });
  if (config.mode === 'off') {
    try {
      const db = openStore(dbPath, { readOnly: true });
      const stats = readStats(db);
      db.close();
      return finish({ ok: true, skipped: true, deleted: 0, before: slimStats(stats), note: 'mode=off (observe only)' });
    } catch (error) {
      return finish({ ok: false, deleted: 0, note: error.code === 'LOCKED' ? 'locked' : String(error.message || error) });
    }
  }
  if (!existsSync(dbPath)) return finish({ ok: true, skipped: true, deleted: 0, note: 'cookie store not found' });

  let db;
  try {
    db = openStore(dbPath, { readOnly: dryRun });
  } catch (error) {
    if (error instanceof CookieStoreLocked || isLockError(error)) return finish({ ok: false, deleted: 0, note: 'locked (DSH still running)' });
    return finish({ ok: false, deleted: 0, note: String(error.message || error) });
  }

  try {
    const before = readStats(db);
    const localBefore = localPart(before, config.localHosts);
    const allMode = config.mode === 'all';
    // 兜底范围：默认只处理"本机"这个 host（其实清完就没了）；'any' 才会碰账号域名。
    const scopeAny = config.safetyNetHosts === 'any';
    const overBudget = config.safetyNet
      ? before.hosts.filter((host) => host.bytes > config.maxHeaderBytes
        && (scopeAny || isLocalHost(host.host, config.localHosts)))
      : [];
    const skippedOverBudget = config.safetyNet
      ? before.hosts.filter((host) => host.bytes > config.maxHeaderBytes
        && !(scopeAny || isLocalHost(host.host, config.localHosts)))
      : [];

    const report = {
      ok: true,
      before: slimStats(before),
      localBefore,
      deleted: 0,
      deletedBytes: 0,
      safetyNetUsed: false,
      /** 兜底到底修了哪几个 host —— 报告文案要按它说，不能笼统说"本机清完还超"。 */
      safetyNetHosts: [],
      vacuumed: false,
      backup: null,
      // ⚠️ 这些 host 自己就超了预算，但**没删**：它们不是发往本机的那条请求，
      //    默认绝不动（删了就是掉登录）。报告里留一条，免得"看着没问题"其实另有 431 源。
      //    `mode: all` 下全库都删了，再留这条提示就是自相矛盾。
      warnings: allMode ? [] : skippedOverBudget.map((host) => `${host.host} 自身 ${host.bytes}B > ${config.maxHeaderBytes}B`
        + '（不是本机 origin，默认不动；要处理把 safetyNetHosts 设成 "any"）'),
    };

    if (dryRun) {
      // ⚠️ 这里必须按"实际会不会删"来数：
      //    · 本机 host 已经在 localBefore 里整组算过一次，不能再把 overBudget 里的同一条加一遍；
      //    · 兜底要删几条，得走一遍 keepDays 预演，不能拿 host 的总条数充数。
      const plannedSafety = allMode
        ? 0
        : overBudget
          .filter((host) => !isLocalHost(host.host, config.localHosts))
          .reduce((sum, host) => sum + pruneOldestInHost(
            db, host.host, config.maxHeaderBytes, config.safetyNetKeepDays, Date.now(), { apply: false },
          ).deleted, 0);
      const planned = allMode ? before.cookies : localBefore.cookies + plannedSafety;
      db.close();
      return finish({
        ...report,
        note: `dry-run: would delete ${planned} cookie(s)${allMode ? ' (mode=all)' : ''}`,
      });
    }

    // ⭐ 只要有删除就备份 —— 包括"只清本机"和"只有安全网要删"两种情况。
    //    兜底先做一次"只算不做"的预演：keepDays 挡住的、本来就不用删的，不该白留一份备份。
    const safetyPlans = allMode
      ? []
      : overBudget.map((host) => ({
        host: host.host,
        planned: pruneOldestInHost(db, host.host, config.maxHeaderBytes, config.safetyNetKeepDays, Date.now(), { apply: false }),
      }));
    const plannedSafetyDeletes = safetyPlans.reduce((sum, item) => sum + item.planned.deleted, 0);

    const willDelete = allMode
      ? before.cookies > 0
      : (localBefore.cookies > 0 || plannedSafetyDeletes > 0);
    if (willDelete) report.backup = backupStore(dbPath, path.join(stateDir, 'backups'), config.backups);

    if (allMode) {
      report.deleted += deleteAllCookies(db);
    } else {
      report.deleted += deleteLocalCookies(db, config.localHosts);
    }

    for (const item of safetyPlans) {
      if (item.planned.deleted === 0) continue;
      const squeezed = pruneOldestInHost(db, item.host, config.maxHeaderBytes, config.safetyNetKeepDays);
      if (squeezed.deleted > 0) {
        report.safetyNetUsed = true;
        report.safetyNetHosts.push(item.host);
        report.deleted += squeezed.deleted;
      }
    }

    const after = readStats(db);

    if (config.vacuum && report.deleted > 0) report.vacuumed = vacuumSafely(db);

    report.after = slimStats(after);
    report.deletedBytes = Math.max(0, before.bytes - after.bytes);
    if (report.deleted === 0) report.note = 'nothing to delete';

    db.close();
    return finish(report);
  } catch (error) {
    try { db.close(); } catch { /* 已关 */ }
    if (error instanceof CookieStoreLocked || isLockError(error)) return finish({ ok: false, deleted: 0, note: 'locked (DSH still running)' });
    return finish({ ok: false, deleted: 0, note: String(error.message || error) });
  }
}

function vacuumSafely(db) {
  try {
    db.exec('VACUUM');
    return true;
  } catch {
    return false;
  }
}

/** 给人看的摘要（CLI 和日志共用）。 */
export function describeReport(report) {
  if (!report) return 'no report yet — DSH has not finished a run with the cleaner installed';
  const before = report.before ? `${report.before.cookies} cookie(s) / ${report.before.bytes} B` : 'unknown';
  const after = report.after ? `${report.after.cookies} cookie(s) / ${report.after.bytes} B` : 'unknown';
  const lines = [
    `last run : ${report.at} (trigger=${report.trigger}, mode=${report.mode})`,
    `result   : ${report.ok ? 'ok' : 'FAILED'}${report.note ? ' — ' + report.note : ''}`,
    `before   : ${before}`,
    `after    : ${after}`,
    `deleted  : ${report.deleted ?? 0} cookie(s), freed ≈ ${report.deletedBytes ?? 0} B`,
  ];
  if (report.localBefore?.hosts?.length) {
    lines.push('local hosts:');
    for (const host of report.localBefore.hosts) lines.push(`  ${host.host} — ${host.count} cookie(s), ${host.bytes} B`);
  }
  if (report.safetyNetUsed) {
    // ⚠️ 别写"本机清完还超"了：兜底现在是**按 host**修剪某个自己就超预算的 host，
    //    本机 origin 那条走的是整组删除，根本不经过这里。
    const hosts = Array.isArray(report.safetyNetHosts) && report.safetyNetHosts.length > 0
      ? report.safetyNetHosts.join(', ')
      : 'over-budget host';
    lines.push(`safety net: trimmed ${hosts} (oldest first, newest per name kept)`);
  }
  // ⚠️ warnings 必须打出来：README 让用户看 status，之前它只写进 last-report.json，
  //    用户在终端里根本看不到"某个账号 host 自己超预算了"这条提示。
  if (Array.isArray(report.warnings) && report.warnings.length > 0) {
    lines.push('warnings :');
    for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  }
  if (report.backup) lines.push(`backup   : ${report.backup}`);
  return lines.join('\n');
}

export { fromChromiumTime };
