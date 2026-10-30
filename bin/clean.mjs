#!/usr/bin/env node
import '../lib/silence.js';
import { existsSync } from 'node:fs';

import { runClean, describeReport } from '../lib/cleaner.js';
import { DEFAULTS, isLocalHost, normalizeConfig } from '../lib/config.js';
import { hostBudgetHint } from '../lib/hints.js';
import { cookieDbPath, stateDir as stateDirOf } from '../lib/paths.js';
import { CookieStoreLocked, openStore, readReport, readStats } from '../lib/store.js';

/**
 * 手动入口。DSH 正在跑也能用（只读统计会报 locked，不会去抢文件）。
 *
 *   node bin/clean.mjs status            # 上次跑完的结论 + 当前库大小
 *   node bin/clean.mjs clean --dry-run   # 只算不改
 *   node bin/clean.mjs clean             # 真清（DSH 必须已退出）
 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { out._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'status';

const overrides = {};
if (typeof args.mode === 'string') overrides.mode = args.mode;
if (typeof args['user-data-dir'] === 'string') overrides.userDataDir = args['user-data-dir'];
if (typeof args['max-header-bytes'] === 'string') overrides.maxHeaderBytes = Number(args['max-header-bytes']);
if (typeof args['safety-net-hosts'] === 'string') overrides.safetyNetHosts = args['safety-net-hosts'];
if (typeof args['safety-net'] === 'string') overrides.safetyNet = args['safety-net'] !== 'false';
const config = normalizeConfig(overrides);
const stateDir = typeof args['state-dir'] === 'string' ? args['state-dir'] : stateDirOf();
const dbPath = cookieDbPath(config.userDataDir);

function liveStats() {
  if (!existsSync(dbPath)) return { missing: true };
  try {
    const db = openStore(dbPath, { readOnly: true });
    const stats = readStats(db);
    db.close();
    return stats;
  } catch (error) {
    if (error instanceof CookieStoreLocked) return { locked: true };
    return { error: String(error.message || error) };
  }
}

function printLive(stats) {
  if (stats.missing) return console.log(`cookie store: not found — ${dbPath}`);
  if (stats.locked) return console.log(`cookie store: in use (DSH is running) — ${dbPath}`);
  if (stats.error) return console.log(`cookie store: unreadable — ${stats.error}`);
  const local = stats.hosts.filter((host) => isLocalHost(host.host, config.localHosts));
  const localBytes = local.reduce((sum, host) => sum + host.bytes, 0);
  const localCount = local.reduce((sum, host) => sum + host.count, 0);
  console.log(`cookie store : ${dbPath}`);
  console.log(`total        : ${stats.cookies} cookie(s), ≈ ${stats.bytes} B`);
  console.log(`local origin : ${localCount} cookie(s), ≈ ${localBytes} B` + (
    local.length ? `  [${local.map((host) => host.host).join(', ')}]` : ''
  ) + (localCount > 0 && config.mode !== 'off' ? ' — 每次退出都会整组清掉' : ''));
  console.log(`budget       : ${config.maxHeaderBytes} B/host (mode=${config.mode}, safetyNetHosts=${config.safetyNetHosts})`);
  // ⚠️ 预算按 host 判，不按全库：发往 127.0.0.1 的请求带不上账号 cookie。
  //    文案规则在 lib/hints.js 里（纯函数，有单测钉住），这里只负责打印。
  for (const host of stats.hosts) {
    const hint = hostBudgetHint(host, config);
    if (hint) console.log(`${hint.level === 'warn' ? '⚠️' : 'ℹ️'}  ${hint.text}`);
  }
  const top = stats.hosts.slice(0, 8);
  if (top.length) {
    console.log('top hosts    :');
    for (const host of top) console.log(`  ${host.host.padEnd(40)} ${String(host.count).padStart(4)} / ${host.bytes} B`);
  }
}

if (command === 'status') {
  console.log(describeReport(readReport(stateDir)));
  console.log('');
  printLive(liveStats());
  process.exit(0);
}

if (command === 'clean') {
  const dryRun = args['dry-run'] === true;
  const report = runClean({ config, dbPath, stateDir, trigger: 'cli', dryRun });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(describeReport(report));
  if (!report.ok && String(report.note || '').startsWith('locked')) {
    console.log('\n提示：cookie 库正被 DSH 独占，先完全退出 DSH 再跑（或让它随退出自动清）。');
    process.exit(2);
  }
  process.exit(report.ok ? 0 : 1);
}

console.log('usage: node bin/clean.mjs [status|clean] [options]');
console.log('  --dry-run                 只算不改');
console.log('  --mode local|all|off      local=只清本机 origin（默认）；all=全库删光（会掉登录）；off=只观测');
console.log('  --safety-net-hosts local|any  兜底范围：local 只处理本机 origin（默认）；any 也修剪账号域名');
console.log('  --safety-net true|false   关掉兜底（本机 origin 照样每次整组清，它不走兜底）');
console.log('  --max-header-bytes <n>    单个 host 的 Cookie 头预算（默认 14336）');
console.log('  --user-data-dir <dir>     显式指定 Electron userData 目录');
console.log('  --state-dir <dir>         状态/报告/备份目录（默认 ~/.dsh/cookie-cleaner）');
console.log(`  --json                    输出原始报告 JSON`);
console.log(`defaults: mode=${DEFAULTS.mode} safetyNetHosts=${DEFAULTS.safetyNetHosts} maxHeaderBytes=${DEFAULTS.maxHeaderBytes}`);
process.exit(1);
