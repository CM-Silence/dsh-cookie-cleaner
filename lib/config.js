import { defaultUserDataDir } from './paths.js';

/**
 * 默认策略。
 *
 * ⭐ `mode: 'local'` 是刻意的默认值 —— 只删**本机 origin**（127.0.0.1 / localhost / ::1）
 * 的 cookie。理由：
 *   · 431 是**发往本机 Host 的那一条请求**的 Cookie 头超了 Node 的默认 16KB 上限，
 *     而 HTTP 只会带上"域名匹配"的 cookie ⇒ 撑爆头的必然是本机 origin 的 cookie；
 *   · 平台账号（deepseek 域名）的 cookie 不参与这条请求，删了只会让人掉登录态、
 *     顺带把右上角的账号态清成"未登录"，这才是"设置看着丢了"的常见来源。
 * 所以默认只动本机 origin，账号与设置都不碰。
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  /** 'local' 只清本机 origin；'all' 清全部（等于老办法，会掉登录）；'off' 只观测不动手 */
  mode: 'local',
  /** 视为"本机 origin"的 host；比较时会去掉前导点、转小写 */
  localHosts: ['127.0.0.1', 'localhost', '::1', 'dsh-app'],
  /** 给 Cookie 头留的预算（字节）。Node 的 http 默认 maxHeaderSize 是 16384，留 2KB 余量 */
  maxHeaderBytes: 14336,
  /** 预算超了还清不掉时，是否按"最老优先"继续删 */
  safetyNet: true,
  /**
   * 兜底作用范围：'local' 只处理本机 origin（清完其实就没了，等于不碰账号）；
   * 'any' 才会修剪"自己就超预算"的账号域名 —— 会动登录 cookie，默认关。
   */
  safetyNetHosts: 'local',
  /** 兜底删除时，这个天数内新建的 cookie 一律不删 */
  safetyNetKeepDays: 30,
  /** 清完是否 VACUUM。431 只看请求头、不看文件大小 ⇒ 默认关，缩短抢窗口的时间 */
  vacuum: false,
  /** 保留几份改动前的库备份 */
  backups: 5,
  /** 等应用退出的上限；超时就放弃，下一轮再说 */
  waitTimeoutMs: 30 * 60 * 1000,
  /** 显式指定 userData 目录（一般不用填，按平台约定算） */
  userDataDir: '',
});

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

function toHostList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  return [...DEFAULTS.localHosts];
}

/** 把用户配置收敛成一份"永远能用"的配置；坏值一律回落到默认，绝不因为配置写错而崩掉启动。 */
export function normalizeConfig(raw, env = process.env, platform = process.platform) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = ['local', 'all', 'off'].includes(src.mode) ? src.mode : DEFAULTS.mode;
  return {
    enabled: src.enabled === undefined ? DEFAULTS.enabled : Boolean(src.enabled),
    mode,
    localHosts: toHostList(src.localHosts),
    maxHeaderBytes: toInt(src.maxHeaderBytes, DEFAULTS.maxHeaderBytes),
    safetyNet: src.safetyNet === undefined ? DEFAULTS.safetyNet : Boolean(src.safetyNet),
    safetyNetHosts: ['local', 'any'].includes(src.safetyNetHosts) ? src.safetyNetHosts : DEFAULTS.safetyNetHosts,
    safetyNetKeepDays: toInt(src.safetyNetKeepDays, DEFAULTS.safetyNetKeepDays),
    vacuum: src.vacuum === undefined ? DEFAULTS.vacuum : Boolean(src.vacuum),
    backups: Math.min(20, toInt(src.backups, DEFAULTS.backups)),
    waitTimeoutMs: toInt(src.waitTimeoutMs, DEFAULTS.waitTimeoutMs),
    userDataDir: typeof src.userDataDir === 'string' && src.userDataDir.trim()
      ? src.userDataDir.trim()
      : (env.DSH_COOKIE_CLEANER_USER_DATA || defaultUserDataDir(env, platform)),
  };
}

/** host 归一化：Chromium 里本机 cookie 可能存成 `.127.0.0.1`、大小写也可能不一致。 */
export function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/^\.+/, '');
}

/** 这个 host 算不算"本机 origin"。 */
export function isLocalHost(host, localHosts = DEFAULTS.localHosts) {
  const h = normalizeHost(host);
  if (!h) return false;
  return localHosts.some((candidate) => {
    const c = normalizeHost(candidate);
    if (!c) return false;
    return h === c || h.endsWith('.' + c);
  });
}
