import { DatabaseSync } from 'node:sqlite';

/**
 * 测试用"假 DSH"：把 cookie 库按住 N 毫秒，模拟应用运行期独占。
 * 启动后往 stdout 打一行 ready，方便测试同步。
 */
const [, , dbPath, holdMs] = process.argv;
const db = new DatabaseSync(dbPath);
db.exec('BEGIN EXCLUSIVE');
process.stdout.write('ready\n');
await new Promise((resolve) => setTimeout(resolve, Number(holdMs) || 500));
db.exec('ROLLBACK');
db.close();
