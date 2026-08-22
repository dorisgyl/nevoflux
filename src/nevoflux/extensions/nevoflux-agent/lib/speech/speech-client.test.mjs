// SpeechClient 里不碰 DOM 的那部分。`node speech-client.test.mjs`。
//
// 这个文件是被一个 bug 逼出来的:`autoSubmit` 只在 `start()` 里读,而所有调用方
// 都在构造器里传它 —— start() 于是每次把它抹回 false,闭环一次都没真的发生过。
// 症状为零:转写照出、界面照更新,只是那条消息从来没发出去。
//
// 「一个只在别处被读的构造参数」是可以被静态钉住的,不需要浏览器。

import { strict as assert } from 'node:assert';
import { SpeechClient, vadWorkerErrorMessage } from './speech-client.js';

const cases = [];
const test = async (name, fn) => {
  try {
    await fn();
    cases.push({ name, ok: true });
  } catch (e) {
    cases.push({ name, ok: false, why: e.message });
  }
};

/**
 * 跑**真的** `start()`,让它走到需要 `AudioContext` 的那一行为止。
 *
 * 选项处理在创建音频上下文之前,所以这一段是真实执行的 —— 在 Node 里复刻一份
 * 「start 会怎么处理选项」等于测一份影子实现,而影子实现正好在原件改坏时仍然通过。
 */
async function startUntilAudio(client, opts) {
  assert.equal(typeof globalThis.AudioContext, 'undefined', 'Node 里不该有 AudioContext');
  await client.start(opts).catch(() => {});
  return client;
}

await test('构造器传的 autoSubmit 生效', () => {
  assert.equal(new SpeechClient({ sessionId: 's', autoSubmit: true }).autoSubmit, true);
  assert.equal(new SpeechClient({ sessionId: 's' }).autoSubmit, false);
});

await test('start() 不带 autoSubmit 时不得覆盖构造器的选择', async () => {
  // 这正是那个 bug:start({fileUrl}) 把构造时的 true 抹成了 false。
  const c = new SpeechClient({ sessionId: 's', autoSubmit: true });
  await startUntilAudio(c, { fileUrl: 'x.wav' });
  assert.equal(c.autoSubmit, true);
});

await test('start() 显式给了就以它为准', async () => {
  const c = new SpeechClient({ sessionId: 's', autoSubmit: true });
  await startUntilAudio(c, { autoSubmit: false });
  assert.equal(c.autoSubmit, false);
});

await test('默认关 —— 「说的话算不算提问」是应用的决定', () => {
  assert.equal(new SpeechClient({ sessionId: 's' }).autoSubmit, false);
});

await test('资源目录默认与本文件同级', () => {
  // 侧边栏是从 wasm/chat-sidebar/ 动态 import 过来的:base 若按调用方的位置算,
  // worklet 与权重就会 404,而那会表现成「VAD 永远不 ready」。
  const c = new SpeechClient({ sessionId: 's' });
  assert.ok(c.base.endsWith('/lib/speech/'), c.base);
});

await test('worker 加载失败必须说清楚,不能报 undefined', () => {
  // Worker 的脚本(或它静态 import 的模块图)取不到时,派发的是**普通 Event**
  // —— 没有 .message;只有 worker 内部真抛了才是 ErrorEvent。不做这个区分,
  // 加载失败就显示成 "vad worker: undefined",而那正是「ort/ 没进包」在用户
  // 那边的样子:一条什么都没说的报错。
  const msg = vadWorkerErrorMessage({ type: 'error' }, 'moz-extension://x/lib/speech/');
  assert.ok(!msg.includes('undefined'), msg);
  assert.ok(msg.includes('ort/'), msg);
});

await test('worker 内部抛的错要原样保留', () => {
  const msg = vadWorkerErrorMessage({ type: 'error', message: 'boom' }, '');
  assert.ok(msg.includes('boom'), msg);
});

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed++;
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        ${c.why}`}`);
}
console.log('---');
console.log(failed ? `${failed} 项失败` : '全部通过');
process.exit(failed ? 1 : 0);
