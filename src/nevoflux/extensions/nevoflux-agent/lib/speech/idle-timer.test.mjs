// 静默退出的单测。`node idle-timer.test.mjs`。
//
// 时钟是注入的,所以这些边界不需要真的等 90 秒 —— 而「等 90 秒手动看一眼」
// 恰恰是最不可能被真正验证的那种测试。

import { strict as assert } from 'node:assert';
import { IdleTimer } from './idle-timer.js';

let t = 0;
const now = () => t;
const mk = (opts = {}) =>
  new IdleTimer({ idleMs: 1000, maxMs: 10_000, now, ...opts });

const cases = [];
const test = (name, fn) => {
  t = 0;
  try {
    fn();
    cases.push({ name, ok: true });
  } catch (e) {
    cases.push({ name, ok: false, why: e.message });
  }
};

test('闲着够久就退出', () => {
  const it = mk();
  t = 999;
  assert.equal(it.check(), null);
  t = 1000;
  assert.equal(it.check(), 'idle');
});

test('交互会把计时归零', () => {
  const it = mk();
  t = 900;
  it.touch();
  t = 1800; // 距上次交互 900 < 1000
  assert.equal(it.check(), null);
  t = 1901;
  assert.equal(it.check(), 'idle');
});

test('执行期间不计静默 —— 这是 v1.2 会误伤的那一条', () => {
  // 用户说完就不出声了,agent 跑很久的工具。旧语义会在 agent 还在工作时
  // 退出语音,等回答出来已经没有播放通道。
  const it = mk();
  it.beginBusy();
  t = 5000;
  assert.equal(it.check(), null, '执行中不该退出');
  assert.equal(it.idleRemaining(), Infinity);
});

test('执行结束后重新开始计时,而不是接着旧的算', () => {
  const it = mk();
  it.beginBusy();
  t = 5000;
  it.endBusy();
  t = 5999;
  assert.equal(it.check(), null, '刚忙完就退出等于没豁免');
  t = 6000;
  assert.equal(it.check(), 'idle');
});

test('嵌套的忙碌要全部结束才恢复计时', () => {
  const it = mk();
  it.beginBusy();
  it.beginBusy();
  it.endBusy();
  t = 5000;
  assert.equal(it.check(), null, '还有一件在跑');
  it.endBusy();
  t = 6001;
  assert.equal(it.check(), 'idle');
});

test('绝对上限不受执行中豁免 —— 否则失控的一轮能让麦克风开一整天', () => {
  const it = mk();
  it.beginBusy(); // 一直忙
  t = 9999;
  assert.equal(it.check(), null);
  t = 10_000;
  assert.equal(it.check(), 'max', '上限必须能穿透豁免');
});

test('上限优先于静默,理由不同要能分辨', () => {
  const it = mk({ idleMs: 100, maxMs: 100 });
  t = 200;
  assert.equal(it.check(), 'max');
});

test('只报一次', () => {
  const it = mk();
  t = 2000;
  assert.equal(it.check(), 'idle');
  assert.equal(it.check(), null, '过期之后不该反复触发退出');
});

test('回调收到理由', () => {
  const seen = [];
  const it = mk({ onExpire: (r) => seen.push(r) });
  t = 2000;
  it.check();
  assert.deepEqual(seen, ['idle']);
});

test('endBusy 多于 beginBusy 时不会变成负数', () => {
  const it = mk();
  it.endBusy();
  it.endBusy();
  it.beginBusy();
  t = 5000;
  assert.equal(it.check(), null, '计数下溢会让豁免永久生效');
});

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed++;
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        ${c.why}`}`);
}
console.log('---');
console.log(failed ? `${failed} 项失败` : '全部通过');
process.exit(failed ? 1 : 0);
