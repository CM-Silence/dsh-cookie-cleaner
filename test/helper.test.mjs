import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import '../lib/silence.js';
import { makeFixture, readRows, tempDir } from '../test-support/fixture.mjs';
import { waitAndClean } from '../lib/helper.js';
import { normalizeConfig } from '../lib/config.js';
import { readReport } from '../lib/store.js';
import { dshRunning, lockIsStale, parseTasklistPids, readLock } from '../lib/processes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOLDER = path.join(here, '..', 'test-support', 'hold-db.mjs');

function startHolder(dbPath, holdMs) {
  const holder = spawn(process.execPath, [HOLDER, dbPath, String(holdMs)], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  return new Promise((resolve, reject) => {
    holder.stdout.once('data', () => resolve(holder));
    holder.once('error', reject);
  });
}

test('等占用进程退出后再清，且退出前一条都不动', async () => {
  const dir = tempDir('helper-e2e');
  const dbPath = makeFixture({
    dir,
    cookies: [
      { host: '127.0.0.1', name: 'token_a', bytes: 300 },
      { host: '127.0.0.1', name: 'token_b', bytes: 300 },
      { host: '.deepseek.com', name: 'session', bytes: 100 },
    ],
  });
  const stateDir = path.join(dir, 'state');

  const holder = await startHolder(dbPath, 900);

  const startedAt = Date.now();
  const report = await waitAndClean({
    pids: [holder.pid],
    config: normalizeConfig({ userDataDir: dir, vacuum: false }),
    dbPath,
    stateDir,
    timeoutMs: 15000,
  });
  const waited = Date.now() - startedAt;

  assert.ok(waited >= 700, `helper should wait for the holder (waited ${waited}ms)`);
  assert.equal(report.ok, true);
  assert.equal(report.deleted, 2);
  assert.equal(report.trigger, 'exit');
  assert.deepEqual(readRows(dbPath).map((row) => row.host), ['.deepseek.com']);

  const saved = readReport(stateDir);
  assert.equal(saved.ok, true);
  assert.equal(saved.after.cookies, 1);
});

test('窗口被别人抢走时记一条"错过"，不是傻等', async () => {
  const dir = tempDir('helper-missed');
  const dbPath = makeFixture({
    dir,
    cookies: [{ host: '127.0.0.1', name: 'token', bytes: 200 }],
  });
  const stateDir = path.join(dir, 'state');
  const holder = await startHolder(dbPath, 2500);

  const report = await waitAndClean({
    pids: [],                       // 盯的进程"已经没了"
    config: normalizeConfig({ userDataDir: dir }),
    dbPath,
    stateDir,
    timeoutMs: 15000,
    drainDelays: [0, 150, 300],     // 测试里缩短退避
  });

  assert.equal(report.ok, false);
  assert.match(report.note, /missed the exit window/);
  // 抢不到就不该动数据 —— 但要等占用进程放锁之后才读得到（它占着 EXCLUSIVE）
  await new Promise((resolve) => holder.once('exit', resolve));
  assert.equal(readRows(dbPath).length, 1);
});

/* ───────── 自指闸门：helper 自己的名字就叫 DeepSeek Harness.exe ───────── */

test('parseTasklistPids 只认 CSV 里的 pid', () => {
  const out = [
    '"DeepSeek Harness.exe","39088","Console","7","92,344 K"',
    '"DeepSeek Harness.exe","548","Console","7","189,296 K"',
    'INFO: No tasks are running which match the specified criteria.',
  ].join('\r\n');
  const pids = parseTasklistPids(out);
  assert.deepEqual([...pids].sort((a, b) => a - b), [548, 39088]);
});

test('dshRunning 会排除自己（否则 helper 永远认为 DSH 还在跑）', () => {
  const run = () => `"DeepSeek Harness.exe","${process.pid}","Console","7","1 K"`;
  assert.equal(dshRunning('DeepSeek Harness.exe', { platform: 'win32', run }), false);
});

test('dshRunning 看到别的 DSH 进程时返回 true', () => {
  const other = process.pid + 12345;
  const run = () => `"DeepSeek Harness.exe","${other}","Console","7","1 K"`;
  assert.equal(dshRunning('DeepSeek Harness.exe', { platform: 'win32', run }), true);
});

test('lockIsStale：锁在、helper 活着，但它盯的进程全没了 ⇒ 判定过期', () => {
  const stateDir = tempDir('stale-lock');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'helper.lock'), JSON.stringify({
    pid: process.pid,            // 假装 helper 还活着（就是本进程）
    pids: [999999, 999998],      // 但它盯的进程早没了
    at: Date.now(),
  }));
  assert.equal(lockIsStale(stateDir), true);
  assert.deepEqual(readLock(stateDir).pids, [999999, 999998]);
});

test('lockIsStale：盯的进程还活着就不算过期', () => {
  const stateDir = tempDir('fresh-lock');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'helper.lock'), JSON.stringify({
    pid: process.pid,
    pids: [process.pid],
    at: Date.now(),
  }));
  assert.equal(lockIsStale(stateDir), false);
});
