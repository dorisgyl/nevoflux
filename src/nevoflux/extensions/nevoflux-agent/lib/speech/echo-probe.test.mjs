// 判据自检。`node echo-probe.test.mjs`,不需要浏览器、不需要声卡。
//
// 存在的理由:回声探测的判定是这套设计里唯一「说不清就会静默地把用户
// 推进死循环」的部分,而它要在一台没有声卡的机器上被信任。

import { selfTest, analyseProbe, sustainedRuns, DEFAULTS } from './echo-probe.js';

let failed = 0;
for (const c of selfTest()) {
  if (!c.ok) failed++;
  const mark = c.ok ? 'PASS' : 'FAIL';
  const extra = c.ok ? '' : `   got=${c.got} want=${c.want}`;
  console.log(`  ${mark}  ${c.name}${extra}`);
}

// 判据的边界值单独钉住:这些数字将来会被真实硬件校准,校准时应当看到
// 这里的期望一起改,而不是悄悄漂移。
const mk = (n, p, rms, t0 = 0) =>
  Array.from({ length: n }, (_, i) => ({ t: t0 + i * 0.032, p, rms }));

// 边界值从常数推导,不写死。常数一动,这些用例仍然表达「刚好越线 / 刚好没越线」,
// 而不是悄悄变成别的场景 —— 校准 echoRmsFactor 时这一点是关键。
const F = DEFAULTS.echoRmsFactor;
const BASE = 0.01;

const boundary = [
  {
    name: `刚好 ${DEFAULTS.sustainMs} ms 的触发算数`,
    got: sustainedRuns(mk(7, 0.9, 0.1), DEFAULTS).length,
    want: 1,
  },
  {
    name: `差一帧(${DEFAULTS.sustainMs - 32} ms)不算数`,
    got: sustainedRuns(mk(6, 0.9, 0.1), DEFAULTS).length,
    want: 0,
  },
  {
    name: `幅度恰好 ${F}× 基线 → fail`,
    got: analyseProbe({
      baseline: mk(62, 0.02, BASE),
      playback: [
        ...mk(30, 0.02, BASE * 1.8),
        ...mk(10, 0.95, BASE * F, 0.96),
        ...mk(148, 0.02, BASE * 1.8, 1.3),
      ],
    }).verdict,
    want: 'fail',
  },
  {
    name: `幅度略低于 ${F}× 基线 → 不算回声`,
    got: analyseProbe({
      baseline: mk(62, 0.02, BASE),
      playback: [
        ...mk(30, 0.02, BASE * 1.8),
        ...mk(10, 0.95, BASE * F * 0.95, 0.96),
        ...mk(148, 0.02, BASE * 1.8, 1.3),
      ],
    }).verdict,
    want: 'pass',
  },
];

for (const b of boundary) {
  const ok = b.got === b.want;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${b.name}${ok ? '' : `   got=${b.got} want=${b.want}`}`);
}

console.log('---');
console.log(failed ? `${failed} 项失败` : '全部通过');
process.exit(failed ? 1 : 0);
