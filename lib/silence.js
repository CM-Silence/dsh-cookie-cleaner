/**
 * `node:sqlite` 在 Node 22/24 上还会打一句 ExperimentalWarning，
 * 而这条警告会混进 Host 的 stderr（也就是用户看到的启动日志）。
 * 只把它过滤掉，别的 warning 一个字都不动。
 *
 * ⚠️ 必须作为**第一个 import** 引入：ESM 的求值顺序决定了它得先于 `node:sqlite` 加载。
 *
 * 两道保险：
 *  ① 拦 `process.emitWarning`（多数路径走这里）；
 *  ② 挂一个 `warning` 监听器 —— Node 的规则是"没有监听器才自动打印"，
 *     所以我们挂了之后必须自己把**非 sqlite** 的警告打回去，不能吞掉别人的。
 */
const FILTER = /SQLite is an experimental feature/i;

const original = process.emitWarning;
process.emitWarning = function emitWarning(warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (FILTER.test(text)) return;
  return original.call(process, warning, ...rest);
};

process.on('warning', (warning) => {
  const text = (warning && warning.message) || '';
  if (FILTER.test(text)) return;
  const name = (warning && warning.name) || 'Warning';
  console.warn(`${name}: ${text}`);
});
