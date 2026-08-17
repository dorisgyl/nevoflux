// 语音视图渲染器的单测。`node voice-renderer.test.mjs`。
//
// 波形好不好看是视觉判断,测不了;但 Q29/Q32 里那几条**约束**是可断言的,
// 而它们恰恰是会被悄悄破坏的那部分 —— 比如有人为了统一配色把「在听」和
// 「在说」调成同一个颜色,界面看起来更协调了,而 hands-free 下用户从此分不清
// 波形动的是自己还是 agent。

import { strict as assert } from 'node:assert';
import {
  STATES,
  presentationFor,
  resolveColor,
  distinctColors,
  visibleExtras,
  smoothAmplitude,
  createRenderer,
  WaveformRenderer,
  RENDERERS,
  PRESENTATION,
} from './voice-renderer.js';

const cases = [];
const test = (name, fn) => {
  try {
    fn();
    cases.push({ name, ok: true });
  } catch (e) {
    cases.push({ name, ok: false, why: e.message });
  }
};

test('五个状态都有呈现(Q23 的四态 + v1.3 的「在执行」)', () => {
  assert.deepEqual(STATES, ['idle', 'listening', 'transcribing', 'thinking', 'speaking']);
  for (const s of STATES) {
    const p = presentationFor(s);
    assert.ok(p.color, `${s} 没有颜色`);
    assert.ok(p.motion, `${s} 没有运动方式`);
  }
});

test('「在听」「在说」「在执行」必须不同色', () => {
  // 这是 Q32 的第一条约束:形状差异在余光里看不出来,只能靠颜色。
  assert.ok(distinctColors());
});

test('波形驱动源随状态切换', () => {
  // Q32 第二条:「在听」接麦克风流,「在说」接播放流。
  assert.equal(presentationFor('listening').source, 'microphone');
  assert.equal(presentationFor('speaking').source, 'playback');
  assert.equal(presentationFor('idle').source, null);
});

test('tap-to-talk 的待机有文字,hands-free 的没有', () => {
  // Q32 第三条:同一条静止细线,两种模式下含义不同。
  assert.equal(presentationFor('idle', 'hands-free').caption, '');
  assert.ok(presentationFor('idle', 'tap-to-talk').caption.length > 0);
});

test('未知状态回落到待机而不是抛错', () => {
  // 视图不该因为一个没见过的状态名而空白。
  const p = presentationFor('nonsense');
  assert.equal(p.motion, 'still');
});

test('「在转写」是冻结的,不是静止也不是活动', () => {
  assert.equal(presentationFor('transcribing').motion, 'frozen');
  assert.equal(presentationFor('listening').motion, 'live');
  assert.equal(presentationFor('idle').motion, 'still');
});

test('语音视图里仍然显示的四样东西', () => {
  // §5.2:partial、工具状态行、artifact 图标行、结构性内容展示位。
  const got = visibleExtras({
    partial: '开放时间',
    tool: 'browser_read',
    artifact: 'report.md',
    structural: '| a | b |',
  });
  assert.deepEqual(got.map((x) => x.kind), ['partial', 'tool', 'artifact', 'structural']);
});

test('结构性内容必须能显示 —— 否则那一轮信息量是零', () => {
  // ADR-0006:40 行代码再自足的口语稿也只能说「代码在屏幕上」。
  const got = visibleExtras({ structural: 'fn main() {}' });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'structural');
});

test('没有额外内容时什么都不显示', () => {
  assert.deepEqual(visibleExtras({}), []);
});

test('振幅上升快、下降慢', () => {
  // 起音要立刻可见,尾音的衰减可以慢 —— 反过来会让「在听」看起来迟钝。
  const up = smoothAmplitude(0, 1);
  const down = smoothAmplitude(1, 0);
  assert.ok(up > 0.5, `上升太慢: ${up}`);
  assert.ok(down > 0.8, `下降太快: ${down}`);
});

test('渲染器是插槽,不是分支', () => {
  assert.ok(RENDERERS.waveform, '波形应已注册');
  assert.ok(createRenderer() instanceof WaveformRenderer);
  // 未知 id 回落,而不是让视图空白。
  assert.ok(createRenderer('digital-human') instanceof WaveformRenderer);
});

test('draw 用状态的颜色,并把幅度平滑后报回', () => {
  // 用一个记账用的假 2D 上下文 —— 画得好不好看测不了,画的是不是对的颜色能测。
  const calls = [];
  const c = {
    clearRect: () => calls.push('clear'),
    beginPath: () => calls.push('begin'),
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => calls.push('stroke'),
    set strokeStyle(v) {
      calls.push(`color:${v}`);
    },
    set lineWidth(v) {},
  };
  const r = createRenderer();
  const out = r.draw(c, { state: 'speaking', mode: 'hands-free', amplitude: 0.8, width: 100, height: 40, tick: 3 });
  assert.ok(calls.includes('clear') && calls.includes('stroke'), '应该真的画了');
  assert.ok(calls.some((x) => x.startsWith('color:')), '应该设了颜色');
  assert.equal(out.color, presentationFor('speaking').color);
  assert.ok(out.level > 0);
});

test('冻结态不推进相位', () => {
  // 「在转写」要看起来停住了,而不是慢慢动。
  const r = createRenderer();
  assert.equal(r.phase({ state: 'transcribing', mode: 'hands-free', tick: 99 }), 0);
  assert.ok(r.phase({ state: 'listening', mode: 'hands-free', tick: 99 }) > 0);
});

test('canvas 拿到的是字面量颜色,不是 var(...)', () => {
  // canvas 的 strokeStyle 不解析 CSS 自定义属性:喂 `var(--x, #y)` 不报错,
  // 只是赋值被丢弃、笔色停在默认黑 —— 五个状态于是画得一模一样。
  for (const s of STATES) {
    const c = presentationFor(s).color;
    assert.ok(!c.includes('var('), `${s} 的颜色仍是 var(...)`);
    assert.match(c, /^#[0-9a-f]{6}$/i, `${s} 的兜底颜色不是字面量: ${c}`);
  }
});

test('主题变量优先于兜底,空值不覆盖', () => {
  assert.equal(resolveColor('listening', () => '  #112233 '), '#112233');
  // 变量没定义时 getPropertyValue 返回空串 —— 不能因此把笔色设成空。
  assert.equal(resolveColor('listening', () => ''), PRESENTATION.listening.color);
  // 读取本身抛了也要给出颜色,视图不该因为取色失败而空白。
  assert.equal(
    resolveColor('speaking', () => { throw new Error('detached'); }),
    PRESENTATION.speaking.color,
  );
});

test('每个状态读的是自己的变量名', () => {
  const seen = [];
  for (const s of STATES) resolveColor(s, (n) => { seen.push(n); return ''; });
  assert.ok(seen.every((n) => n.startsWith('--nevo-voice-')), seen.join(','));
  // 「在转写」有意与「在听」同色:它是同一件事的延续。
  assert.equal(presentationFor('transcribing').colorVar, presentationFor('listening').colorVar);
});

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed++;
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        ${c.why}`}`);
}
console.log('---');
console.log(failed ? `${failed} 项失败` : '全部通过');
process.exit(failed ? 1 : 0);
