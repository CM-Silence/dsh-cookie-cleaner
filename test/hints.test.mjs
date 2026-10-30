import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../lib/silence.js';
import { normalizeConfig } from '../lib/config.js';
import { hostBudgetHint } from '../lib/hints.js';

const local = { host: '127.0.0.1', count: 1, bytes: 5000 };
const account = { host: '.deepseek.com', count: 2, bytes: 5000 };

function cfg(overrides = {}) {
  return normalizeConfig({ userDataDir: 'C:/tmp/x', maxHeaderBytes: 4000, ...overrides });
}

test('hostBudgetHint：没超预算返回 null', () => {
  assert.equal(hostBudgetHint({ host: '127.0.0.1', count: 1, bytes: 10 }, cfg()), null);
});

test('hostBudgetHint：mode=off 一律"只观测"，绝不承诺删除', () => {
  const off = cfg({ mode: 'off' });
  const a = hostBudgetHint(local, off);
  const b = hostBudgetHint(account, off);
  assert.match(a.text, /只观测，不会删除/);
  assert.match(b.text, /只观测，不会删除/);
  assert.doesNotMatch(a.text, /整组清掉|修剪|整库/);
  assert.equal(a.level, 'info');
});

test('hostBudgetHint：本机 origin 说"整组清掉"，且不受 safetyNet 影响', () => {
  for (const safetyNet of [true, false]) {
    const hint = hostBudgetHint(local, cfg({ safetyNet }));
    assert.match(hint.text, /本机 origin，退出后\*\*整组清掉\*\*/);
    assert.match(hint.text, /不受 keepDays 限制/);
    assert.doesNotMatch(hint.text, /不是本机 origin|最老优先/);
    assert.equal(hint.level, 'warn');
  }
});

test('hostBudgetHint：mode=all 说整库清掉', () => {
  const hint = hostBudgetHint(account, cfg({ mode: 'all' }));
  assert.match(hint.text, /mode=all，退出后整库都会清掉/);
});

test('hostBudgetHint：safetyNetHosts=any 的账号 host 才是"最老优先修剪"', () => {
  const hint = hostBudgetHint(account, cfg({ safetyNetHosts: 'any' }));
  assert.match(hint.text, /按最老优先修剪/);
  assert.match(hint.text, /30 天内的不动/);
  assert.equal(hint.level, 'warn');
});

test('hostBudgetHint：默认范围下的账号 host 是"默认不动"', () => {
  const hint = hostBudgetHint(account, cfg({ safetyNetHosts: 'local' }));
  assert.match(hint.text, /不是本机 origin，默认不动/);
  assert.match(hint.text, /safetyNetHosts=any/);
  assert.equal(hint.level, 'info');
});

test('hostBudgetHint：safetyNet=false 时账号 host 也说"默认不动"', () => {
  const hint = hostBudgetHint(account, cfg({ safetyNet: false, safetyNetHosts: 'any' }));
  assert.match(hint.text, /默认不动/);
  assert.doesNotMatch(hint.text, /修剪/);
});
