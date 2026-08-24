// 播放端的预缓冲。`node player.test.mjs`。
//
// 攒住再起播能把「每句都断」变成「偶尔断一次」,但它自带一个陷阱:攒的条件
// 永远不成立时就永远不出声,而**一轮只有一句话**恰好是最常见的短回答。没有
// 声音与坏掉在用户那里长得一模一样,所以这一条要钉死。

import { strict as assert } from 'node:assert';
import { VoicePlayer } from './player.js';

const cases = [];
const test = async (name, fn) => {
  try {
    await fn();
    cases.push({ name, ok: true });
  } catch (e) {
    cases.push({ name, ok: false, why: e.message });
  }
};

/** 够用的假 AudioContext:只要能记下谁被排期了。 */
function harness() {
  const started = [];
  const ctx = {
    currentTime: 0,
    createGain: () => ({
      connect() {},
      gain: { setValueAtTime() {}, cancelScheduledValues() {} },
    }),
    createBufferSource: () => ({
      connect() {},
      start(at) {
        started.push(at);
      },
      stop() {},
      onended: null,
      buffer: null,
    }),
  };
  return { ctx, started, player: new VoicePlayer(ctx, {}, () => {}) };
}

const buf = (duration) => ({ duration });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 测试里把超时压短,免得每跑一次都要等一秒多。
VoicePlayer.PREBUFFER_MAX_WAIT_MS = 40;

// 具体数字随机器实测调整(见 player.js 的注释),所以测的是**行为**,
// 不是常量本身 —— 把常量抄进断言只会让调参变成改测试。
const N = VoicePlayer.PREBUFFER_SENTENCES;
/** 短到不会自己触发「秒数够了」那条的一句。 */
const SHORT = VoicePlayer.PREBUFFER_SECONDS / (N + 1);

await test('攒够 N 句才起播,而不是来一句放一句', () => {
  const { player, started } = harness();
  for (let i = 0; i < N - 1; i++) {
    player.enqueue(i, buf(SHORT));
    assert.equal(started.length, 0, `第 ${i + 1} 句不该立刻放`);
  }
  player.enqueue(N - 1, buf(SHORT));
  assert.equal(started.length, N, '够了就把攒的一起放出去');
});

await test('一轮只有一句话时,超时必须把它放出去', async () => {
  // 这是预缓冲唯一会「永远不出声」的方式,所以它是这个文件存在的理由。
  const { player, started } = harness();
  player.enqueue(0, buf(SHORT));
  assert.equal(started.length, 0);
  await wait(VoicePlayer.PREBUFFER_MAX_WAIT_MS + 30);
  assert.equal(started.length, 1, '等到超时就该出声');
});

await test('turn-done 不必等超时', () => {
  const { player, started } = harness();
  player.enqueue(0, buf(SHORT));
  assert.equal(started.length, 0);
  player.flush();
  assert.equal(started.length, 1);
});

await test('一句很长的话本身就够,不用等第二句', () => {
  const { player, started } = harness();
  player.enqueue(0, buf(VoicePlayer.PREBUFFER_SECONDS + 0.1));
  assert.equal(started.length, 1);
});

await test('乱序到达仍然按 seq 排期', () => {
  const { player, started } = harness();
  // 一次给足能起播的量,但先给后到的那一句。
  player.enqueue(1, buf(VoicePlayer.PREBUFFER_SECONDS));
  assert.equal(started.length, 0, '缺 seq 0 时不能先放 1');
  player.enqueue(0, buf(VoicePlayer.PREBUFFER_SECONDS));
  assert.equal(started.length, 2);
});

await test('打断要把攒着的也丢掉', () => {
  const { player, started } = harness();
  player.enqueue(0, buf(SHORT));
  player.mute();
  assert.equal(player.queue.length, 0, '攒着的句子留到打断之后再响是最败好感的');
  player.flush();
  assert.equal(started.length, 0);
});

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed++;
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        ${c.why}`}`);
}
console.log('---');
console.log(failed ? `${failed} 项失败` : '全部通过');
process.exit(failed ? 1 : 0);
