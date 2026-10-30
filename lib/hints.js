import { isLocalHost } from './config.js';

/**
 * 某个 host 超预算时，给人看的那句话。
 *
 * ⭐ 抽成纯函数的理由：这段文案连续被挑出过三次错（本机写成"不是本机"、
 *    safetyNet 关掉时分支错、mode=off 还说"会清"）。文案属于"规则"，
 *    就应该像规则一样被测试钉住，而不是每次靠人肉跑 CLI 复现。
 *
 * 口径（必须和实际删除路径一致）：
 *   · mode=off  → 只观测，什么都不删；
 *   · mode=all  → 整库删光；
 *   · 本机 origin → `deleteLocalCookies` 整组删，**不看预算、也不受 keepDays 约束**；
 *   · safetyNetHosts=any 的其它 host → `pruneOldestInHost` 按最老优先修剪；
 *   · 其余 → 不动（它不参与发往本机的请求）。
 *
 * @param {{host:string, count:number, bytes:number}} host
 * @param {object} config 已归一化的配置
 * @returns {{level:'warn'|'info', text:string}|null} 没超预算返回 null
 */
export function hostBudgetHint(host, config) {
  if (!host || host.bytes <= config.maxHeaderBytes) return null;
  const localish = isLocalHost(host.host, config.localHosts);
  const prefix = `${host.host} 自身 ${host.bytes} B > ${config.maxHeaderBytes} B — `;

  if (config.mode === 'off') {
    return { level: 'info', text: prefix + 'mode=off，只观测，不会删除' };
  }
  if (config.mode === 'all') {
    return { level: 'warn', text: prefix + 'mode=all，退出后整库都会清掉' };
  }
  if (localish) {
    return { level: 'warn', text: prefix + '本机 origin，退出后**整组清掉**（不看预算，也不受 keepDays 限制）' };
  }
  if (config.safetyNet && config.safetyNetHosts === 'any') {
    return { level: 'warn', text: prefix + `退出后按最老优先修剪（保留最新一条、${config.safetyNetKeepDays} 天内的不动）` };
  }
  return {
    level: 'info',
    text: prefix + '不是本机 origin，默认不动（它不参与发往本机的请求）；要处理请设 safetyNetHosts=any',
  };
}
