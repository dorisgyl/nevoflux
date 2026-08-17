// 播放端逻辑的单测。`node player-worklet.test.mjs`,不需要浏览器也不需要声卡。
//
// ## 为什么要有这个
//
// 这台机器(以及任何服务器 / CI)没有真实音频输出设备。而「AudioWorkletNode
// 会不会被音频图拉动」恰恰依赖输出设备 —— 在这里跑浏览器只能测出环境,测不出
// 代码。**队列、保序、静音、计数**这四件事才是我写的东西,它们与 Web Audio 无关,
// 应该能独立验证。
//
// 尤其是 `played` 的语义:只有**完整播完**的句子才算数。打断之后写进 history 的
// 必须是实际播出的部分,而不是生成的全部 —— 模型以为自己说完了整段而用户只听到
// 前三分之一,是 cascaded S2S 最隐蔽的 bug。半句不算,就是这条断言。

import { strict as assert } from 'node:assert';

// ---- Web Audio 的最小替身 -------------------------------------------------

let registered = null;
globalThis.sampleRate = 16000;
globalThis.registerProcessor = (name, ctor) => {
  registered = { name, ctor };
};
globalThis.AudioWorkletProcessor = class {
  constructor() {
    const self = this;
    this.port = {
      _out: [],
      postMessage(m) {
        self.port._out.push(m);
      },
      onmessage: null,
    };
  }
};

await import('./player-worklet.js');
assert.ok(registered, 'registerProcessor 未被调用');
assert.equal(registered.name, 'voice-player');

// ---- 工具 -----------------------------------------------------------------

const make = () => {
  const p = new registered.ctor();
  p.port._out.length = 0; // 丢掉构造时的 hello
  return p;
};
const pcm = (n, v = 0.5) => Float32Array.from({ length: n }, () => v).buffer;
const send = (p, msg) => p.handle(msg);
/** 跑 n 个 128 帧的渲染量子。 */
const render = (p, quanta = 1) => {
  const out = [];
  for (let i = 0; i < quanta; i++) {
    const buf = new Float32Array(128);
    p.process([[buf]]);
    out.push(buf);
  }
  return out;
};
const msgs = (p, type) => p.port._out.filter((m) => m.type === type);

// ---- 用例 -----------------------------------------------------------------

const cases = [];
const test = (name, fn) => {
  try {
    fn();
    cases.push({ name, ok: true });
  } catch (e) {
    cases.push({ name, ok: false, why: e.message });
  }
};

test('构造即报到,便于分辨「处理器没跑」与「被静音」', () => {
  const p = new registered.ctor();
  assert.equal(p.port._out[0].type, 'hello');
});

test('一句完整播完才计入 played', () => {
  const p = make();
  send(p, { type: 'audio', seq: 0, pcm: pcm(128) });
  render(p, 1);
  assert.equal(msgs(p, 'played').length, 1, '整量子一句该计数');

  const q = make();
  send(q, { type: 'audio', seq: 0, pcm: pcm(200) });
  render(q, 1); // 只播了 128/200
  assert.equal(msgs(q, 'played').length, 0, '半句不该计数 —— 那正是打断要记的差别');
  render(q, 1);
  assert.equal(msgs(q, 'played').length, 1);
});

test('乱序到达按 seq 播出', () => {
  const p = make();
  send(p, { type: 'audio', seq: 1, pcm: pcm(128, 0.2) });
  send(p, { type: 'audio', seq: 0, pcm: pcm(128, 0.9) });
  const [first] = render(p, 1);
  assert.ok(Math.abs(first[0] - 0.9) < 1e-6, `先播 seq 0,得到 ${first[0]}`);
  const played = msgs(p, 'played');
  assert.equal(played[0].seq, 0);
});

test('静音立刻停,连当前这句的剩余部分都不放', () => {
  const p = make();
  send(p, { type: 'audio', seq: 0, pcm: pcm(512, 0.9) });
  render(p, 1); // 播了 128/512
  send(p, { type: 'mute' });
  const [after] = render(p, 1);
  assert.ok(after.every((v) => v === 0), '静音后不该还有声音');
  assert.equal(msgs(p, 'muted')[0].played, 0, '半句不计入');
});

test('静音期间到达的句子被记录而不是静默丢弃', () => {
  const p = make();
  send(p, { type: 'mute' });
  send(p, { type: 'audio', seq: 0, pcm: pcm(128) });
  const q = msgs(p, 'queued');
  assert.equal(q.length, 1, '每一句都该回报落点');
  assert.equal(q[0].muted, true);
  assert.equal(q[0].queued, 0, '静音时不入队');
});

test('reset 解除静音并清零,新一轮不受上一轮打断影响', () => {
  const p = make();
  send(p, { type: 'mute' });
  send(p, { type: 'reset' });
  send(p, { type: 'audio', seq: 0, pcm: pcm(128) });
  render(p, 1);
  assert.equal(msgs(p, 'played').length, 1, 'reset 后应能正常播');
});

test('队列空时输出静音而不是残留上一句', () => {
  const p = make();
  send(p, { type: 'audio', seq: 0, pcm: pcm(128, 0.9) });
  render(p, 1);
  const [silent] = render(p, 1);
  assert.ok(silent.every((v) => v === 0));
});

test('没有输出通道时安全返回,不抛异常', () => {
  // worklet 的 process() 一旦抛异常就被**永久停用** —— 后面所有音频石沉大海,
  // 而页面侧收不到任何错误。这条守的就是那个。
  const p = make();
  assert.doesNotThrow(() => p.process([]));
  assert.doesNotThrow(() => p.process([[]]));
  assert.equal(p.process([]), true, '必须继续存活');
});

test('一句跨多个渲染量子时不丢样本', () => {
  const p = make();
  const n = 128 * 3;
  send(p, { type: 'audio', seq: 0, pcm: pcm(n, 0.4) });
  const out = render(p, 3);
  for (const q of out) {
    assert.ok(q.every((v) => Math.abs(v - 0.4) < 1e-6), '样本应连续无空洞');
  }
  assert.equal(msgs(p, 'played').length, 1);
});

// ---- 报告 -----------------------------------------------------------------

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed++;
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        ${c.why}`}`);
}
console.log('---');
console.log(failed ? `${failed} 项失败` : '全部通过');
process.exit(failed ? 1 : 0);
