import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import '../lib/silence.js';
import { makeFixture, tempDir } from '../test-support/fixture.mjs';
import { normalizeConfig } from '../lib/config.js';
import { readReport } from '../lib/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VBS = path.join(here, '..', 'bin', 'watch.vbs');
const HELPER = path.join(here, '..', 'bin', 'helper.mjs');
const WSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');

const canRun = process.platform === 'win32' && existsSync(WSCRIPT);

test('哨兵：进程消失后才清，清完自己退出（且不弹窗 —— 宿主是 GUI 的 wscript）', { skip: !canRun }, async () => {
  const dir = tempDir('watcher');
  const dbPath = makeFixture({
    dir,
    cookies: [
      { host: '127.0.0.1', name: 'session_token', bytes: 400 },
      { host: '.deepseek.com', name: 'keep_me', bytes: 80 },
    ],
  });
  const stateDir = path.join(dir, 'state');

  // 一个稍后自己退出的"假 DSH"
  const fake = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 900)'], { stdio: 'ignore', windowsHide: true });
  const config = normalizeConfig({ userDataDir: dir, vacuum: false });
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_COOKIE_CLEANER_LOCK_HELD: '1',
    DSH_COOKIE_CLEANER_CONFIG: Buffer.from(JSON.stringify(config), 'utf8').toString('base64'),
    DSH_COOKIE_CLEANER_STATE: stateDir,
  };

  const watcher = spawn(WSCRIPT, ['//nologo', '//B', VBS, String(fake.pid), process.execPath, HELPER], {
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  const exited = new Promise((resolve) => watcher.once('exit', (code) => resolve(code)));

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !existsSync(path.join(stateDir, 'last-report.json'))) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const code = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 25000)),
  ]);
  assert.notEqual(code, 'timeout', '哨兵清理完必须自己退出，不能常驻');

  const report = readReport(stateDir);
  assert.ok(report, '应当写出报告');
  assert.equal(report.ok, true);
  assert.equal(report.deleted, 1);
  assert.equal(report.after.cookies, 1);
});
