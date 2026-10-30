import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import '../lib/silence.js';
import { makeFixture, readRows, tempDir } from '../test-support/fixture.mjs';
import { runClean } from '../lib/cleaner.js';
import { normalizeConfig, isLocalHost, normalizeHost, DEFAULTS } from '../lib/config.js';
import { openStore, readStats, deleteLocalCookies } from '../lib/store.js';

const day = 24 * 60 * 60 * 1000;

function configFor(dir, overrides = {}) {
  return normalizeConfig({
    userDataDir: dir,
    maxHeaderBytes: 10 * 1024 * 1024,
    vacuum: true,
    ...overrides,
  });
}

test('normalizeConfig 收敛坏值并且不抛', () => {
  const cfg = normalizeConfig({ mode: 'nonsense', maxHeaderBytes: 'abc', localHosts: 'A.com, .b.com', backups: 999 });
  assert.equal(cfg.mode, 'local');
  assert.equal(cfg.maxHeaderBytes, DEFAULTS.maxHeaderBytes);
  assert.deepEqual(cfg.localHosts, ['a.com', '.b.com']);
  assert.equal(cfg.backups, 20);
});

test('isLocalHost 认本机各种写法，不误伤外部域名', () => {
  assert.equal(isLocalHost('127.0.0.1'), true);
  assert.equal(isLocalHost('.127.0.0.1'), true);
  assert.equal(isLocalHost('LOCALHOST'), true);
  assert.equal(isLocalHost('dsh-app'), true);
  assert.equal(isLocalHost('www.127.0.0.1'), true);
  assert.equal(isLocalHost('deepseek.com'), false);
  assert.equal(isLocalHost('127.0.0.1.evil.com'), false);
  assert.equal(normalizeHost('.127.0.0.1'), '127.0.0.1');
});

test('只清本机 origin，平台 cookie 一条不动', () => {
  const dir = tempDir('local-only');
  const dbPath = makeFixture({
    dir,
    cookies: [
      { host: '127.0.0.1', name: 'dsh_token_1', bytes: 4000 },
      { host: '127.0.0.1', name: 'dsh_token_2', bytes: 4000 },
      { host: 'localhost', name: 'dsh_token_3', bytes: 2000 },
      { host: '.deepseek.com', name: 'session', bytes: 500 },
      { host: 'accounts.google.com', name: 'SID', bytes: 500 },
    ],
  });

  const report = runClean({ config: configFor(dir), dbPath, stateDir: path.join(dir, 'state'), trigger: 'cli' });
  assert.equal(report.ok, true);
  assert.equal(report.deleted, 3);
  assert.equal(report.after.cookies, 2);
  assert.ok(report.after.bytes < 1200);

  const hosts = readRows(dbPath).map((row) => row.host).sort();
  assert.deepEqual(hosts, ['.deepseek.com', 'accounts.google.com']);
});

test('dry-run 只算不删、不留报告', () => {
  const dir = tempDir('dry-run');
  const dbPath = makeFixture({ dir, cookies: [{ host: '127.0.0.1', name: 'a', bytes: 100 }] });
  const stateDir = path.join(dir, 'state');

  const report = runClean({ config: configFor(dir), dbPath, stateDir, trigger: 'cli', dryRun: true });
  assert.equal(report.deleted, 0);
  assert.equal(report.localBefore.cookies, 1);
  assert.equal(readRows(dbPath).length, 1);
  assert.equal(existsSync(path.join(stateDir, 'last-report.json')), false);
});

test('备份只留配置的份数', () => {
  const stateDir = path.join(tempDir('backup-state'), 'state');
  const cookies = [{ host: '127.0.0.1', name: 'x', bytes: 10 }];
  for (let i = 0; i < 4; i += 1) {
    const dir = tempDir('backup-' + i);
    const dbPath = makeFixture({ dir, cookies });
    runClean({ config: configFor(dir, { backups: 2 }), dbPath, stateDir, trigger: 'cli' });
    const backups = listBackups(stateDir);
    assert.ok(backups.length <= 2, `expected <= 2 backups, saw ${backups.length}`);
  }
});

function listBackups(stateDir) {
  try {
    return readdirSync(path.join(stateDir, 'backups')).filter((name) => name.endsWith('.db'));
  } catch {
    return [];
  }
}

test('预算兜底（safetyNetHosts=any）：按 host 自己的量判断，最老优先、每组留最新', () => {
  const dir = tempDir('safety-net');
  const now = Date.now();
  const dbPath = makeFixture({
    dir,
    cookies: [
      { host: '.deepseek.com', name: 'session', path: '/a', bytes: 200, createdAt: now - 90 * day },
      { host: '.deepseek.com', name: 'session', path: '/b', bytes: 200, createdAt: now - 2 * day },
      { host: '.deepseek.com', name: 'tracking', bytes: 200, createdAt: now - 90 * day },
      { host: '127.0.0.1', name: 'local', bytes: 200, createdAt: now - day },
    ],
  });

  const report = runClean({
    config: configFor(dir, { maxHeaderBytes: 260, safetyNet: true, safetyNetHosts: 'any', safetyNetKeepDays: 30 }),
    dbPath,
    stateDir: path.join(dir, 'state'),
    trigger: 'cli',
  });

  assert.equal(report.ok, true);
  assert.equal(report.safetyNetUsed, true);
  assert.deepEqual(report.safetyNetHosts, ['.deepseek.com'], '要记下兜底到底修了哪个 host');
  const rows = readRows(dbPath);
  // 本机那条被删；老的 session 被删；30 天内的新 session 保留；老的 tracking 被删
  assert.equal(rows.some((row) => row.host === '127.0.0.1'), false);
  assert.equal(rows.filter((row) => row.name === 'session').length, 1);
  assert.equal(rows.some((row) => row.name === 'tracking'), false);
});

test('默认 safetyNetHosts=local：账号域名就算超预算也不动，只记一条 warning', () => {
  const dir = tempDir('account-untouched');
  const now = Date.now();
  const dbPath = makeFixture({
    dir,
    cookies: [
      { host: '.deepseek.com', name: 'session', bytes: 500, createdAt: now - 90 * day },
      { host: '.deepseek.com', name: 'other', bytes: 500, createdAt: now - 90 * day },
      { host: '.deepseek.com', name: 'third', bytes: 500, createdAt: now - 90 * day },
    ],
  });

  const report = runClean({
    config: configFor(dir, { maxHeaderBytes: 600 }), // 默认 local
    dbPath,
    stateDir: path.join(dir, 'state'),
    trigger: 'cli',
  });

  assert.equal(report.ok, true);
  assert.equal(report.deleted, 0, '本机没有 cookie 时，默认不碰任何账号 cookie');
  assert.equal(readRows(dbPath).length, 3);
  assert.equal(report.safetyNetUsed, false);
  assert.equal(report.backup, null, '没删东西就不该留备份');
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /deepseek\.com/);
});

test('安全网单独删除时也必须先备份', () => {
  const dir = tempDir('safety-net-backup');
  const now = Date.now();
  const dbPath = makeFixture({
    dir,
    cookies: [
      { host: '.deepseek.com', name: 'a', path: '/x', bytes: 500, createdAt: now - 90 * day },
      { host: '.deepseek.com', name: 'a', path: '/y', bytes: 500, createdAt: now - 90 * day },
    ],
  });
  const stateDir = path.join(dir, 'state');

  const report = runClean({
    config: configFor(dir, { maxHeaderBytes: 200, safetyNetHosts: 'any', safetyNetKeepDays: 30 }),
    dbPath,
    stateDir,
    trigger: 'cli',
  });

  assert.ok(report.deleted > 0);
  assert.ok(report.backup, '安全网删了东西也得有备份');
  assert.equal(existsSync(report.backup), true);
});

test("mode=all：全库删光，且一定留备份", () => {
  const dir = tempDir('mode-all');
  const dbPath = makeFixture({
    dir,
    cookies: [
      { host: '127.0.0.1', name: 'token', bytes: 300 },
      { host: '.deepseek.com', name: 'session', bytes: 100 },
      { host: 'accounts.google.com', name: 'SID', bytes: 100 },
    ],
  });

  const report = runClean({
    config: configFor(dir, { mode: 'all' }),
    dbPath,
    stateDir: path.join(dir, 'state'),
    trigger: 'cli',
  });

  assert.equal(report.ok, true);
  assert.equal(report.deleted, 3, 'mode=all 必须真的全删（第一版这里是空操作）');
  assert.equal(readRows(dbPath).length, 0);
  assert.ok(report.backup, '全删之前必须有备份');
});

test('安全网不删 keepDays 内的新 cookie', () => {
  const dir = tempDir('keep-days');
  const now = Date.now();
  const dbPath = makeFixture({
    dir,
    cookies: [
      { host: '.deepseek.com', name: 'a', bytes: 4000, createdAt: now - 5 * day },
      { host: '.deepseek.com', name: 'b', bytes: 4000, createdAt: now - 10 * day },
    ],
  });

  const report = runClean({
    config: configFor(dir, { maxHeaderBytes: 100, safetyNet: true, safetyNetHosts: 'any', safetyNetKeepDays: 30 }),
    dbPath,
    stateDir: path.join(dir, 'state'),
    trigger: 'cli',
  });
  assert.equal(report.deleted, 0);
  assert.equal(readRows(dbPath).length, 2);
  assert.equal(report.backup, null, '一条都没删，就不该留备份');
});

test('库被占用时给出 locked，而不是抛异常', () => {
  const dir = tempDir('locked');
  const dbPath = makeFixture({ dir, cookies: [{ host: '127.0.0.1', name: 'a', bytes: 10 }] });
  const holder = openStore(dbPath, { readOnly: false });
  holder.exec('BEGIN EXCLUSIVE');
  try {
    const report = runClean({ config: configFor(dir), dbPath, stateDir: path.join(dir, 'state'), trigger: 'cli' });
    // 同进程双句柄在部分平台允许，这里只要求"要么成功、要么干净地失败"
    assert.ok(report.ok === true || String(report.note || '').length > 0);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
});

test('mode=off 只观测不动手', () => {
  const dir = tempDir('off');
  const dbPath = makeFixture({ dir, cookies: [{ host: '127.0.0.1', name: 'a', bytes: 100 }] });
  const report = runClean({ config: configFor(dir, { mode: 'off' }), dbPath, stateDir: path.join(dir, 'state'), trigger: 'cli' });
  assert.equal(report.deleted, 0);
  assert.equal(readRows(dbPath).length, 1);
  assert.match(report.note, /observe only/);
});

test('库不存在时安静跳过', () => {
  const dir = tempDir('missing');
  const report = runClean({
    config: configFor(dir),
    dbPath: path.join(dir, 'Network', 'Cookies'),
    stateDir: path.join(dir, 'state'),
    trigger: 'cli',
  });
  assert.equal(report.ok, true);
  assert.equal(report.deleted, 0);
  assert.match(report.note, /not found/);
});

/* ───────────── 输出层：dry-run 计数 / warnings / describeReport ───────────── */

test('dry-run 不会把"本机 host 超预算"重复计数', () => {
  const dir = tempDir('dryrun-count');
  const dbPath = makeFixture({
    dir,
    cookies: [{ host: '127.0.0.1', name: 'only_one', bytes: 5000 }],
  });

  const report = runClean({
    config: configFor(dir, { maxHeaderBytes: 100 }),
    dbPath,
    stateDir: path.join(dir, 'state'),
    trigger: 'cli',
    dryRun: true,
  });

  // 本机只有 1 条：整组清掉就是 1 条，不能再把兜底那条重复加一遍
  assert.match(report.note, /would delete 1 cookie/);
  assert.equal(readRows(dbPath).length, 1, 'dry-run 不能改库');
});

test('dry-run 的兜底计数走 keepDays 预演，不拿 host 总条数充数', () => {
  const dir = tempDir('dryrun-keepdays');
  const now = Date.now();
  const dbPath = makeFixture({
    dir,
    cookies: [
      { host: '.deepseek.com', name: 'fresh_a', bytes: 4000, createdAt: now - 3 * day },
      { host: '.deepseek.com', name: 'fresh_b', bytes: 4000, createdAt: now - 2 * day },
    ],
  });

  const report = runClean({
    config: configFor(dir, { maxHeaderBytes: 100, safetyNetHosts: 'any' }),
    dbPath,
    stateDir: path.join(dir, 'state'),
    trigger: 'cli',
    dryRun: true,
  });

  assert.match(report.note, /would delete 0 cookie/);
});

test('mode=all 不再输出"默认不动"这种自相矛盾的 warning', () => {
  const dir = tempDir('all-warnings');
  const dbPath = makeFixture({
    dir,
    cookies: [{ host: '.deepseek.com', name: 'big', bytes: 5000 }],
  });

  const report = runClean({
    config: configFor(dir, { mode: 'all', maxHeaderBytes: 100 }),
    dbPath,
    stateDir: path.join(dir, 'state'),
    trigger: 'cli',
  });

  assert.equal(report.deleted, 1);
  assert.deepEqual(report.warnings, []);
});

test('describeReport 会把 warnings 打出来（status / 手动 clean 都靠它）', async () => {
  const { describeReport } = await import('../lib/cleaner.js');
  const text = describeReport({
    at: '2026-10-30T00:00:00.000Z',
    trigger: 'exit',
    mode: 'local',
    ok: true,
    deleted: 0,
    deletedBytes: 0,
    before: { cookies: 3, bytes: 612 },
    after: { cookies: 3, bytes: 612 },
    warnings: ['.deepseek.com 自身 612B > 600B（不是本机 origin，默认不动…）'],
  });
  assert.match(text, /warnings/);
  assert.match(text, /deepseek\.com/);
});
