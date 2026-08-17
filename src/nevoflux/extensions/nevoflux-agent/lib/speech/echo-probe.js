// 回声探测的判据(P0-a)。
//
// 设计文档 §6.10 定了流程 —— 2 秒静默基线 + 6 秒播放,失败判据是「播放期间
// 出现任何一次持续 ≥200 ms 的 VAD 触发,且强度**显著高于基线**」—— 但没有
// 定义什么叫「显著」。这个模块就是那句话的定义。
//
// 分析部分是纯函数,不碰音频 API:判据是这里唯一有判断力的东西,而模型只是
// 一个概率来源。这样它可以在没有声卡的机器上被验证(见文件末尾的 selfTest)。
//
// 输入是逐帧记录 `{ t, p, rms }`:
//   t    音频时钟秒
//   p    Silero 的 speech 概率
//   rms  该帧的均方根幅度(0..1)

export const DEFAULTS = {
  /** Silero 判语音的概率阈值,与在线端点判定同值。 */
  pThreshold: 0.5,

  /**
   * 触发需持续多久才算数。**刻意与 barge-in 的门限同值**:探测要回答的问题
   * 就是「回声会不会误触发 barge-in」,判据必须与真实触发条件一致,另设一个
   * 阈值等于在测别的东西。
   */
  sustainMs: 200,

  /**
   * 认定「麦克风根本没在收音」的幅度上限。真实房间里的真实麦克风永远有底噪;
   * 数字静音意味着设备被静音、被占用或不存在 —— 那种情况下**不能下结论**。
   * 1e-4 ≈ -80 dBFS,比任何真实底噪都低一个数量级以上。
   */
  silenceRms: 1e-4,

  /**
   * 触发段的幅度要高出基线多少倍才算「显著」。
   *
   * 这条是整个判据的核心,它把「房间本来就吵」和「扬声器被听回去了」分开。
   * 没有它,在咖啡馆做探测会一律判失败 —— 而那正是 §6.10 设计基线段的理由。
   *
   * **当前取 2.0(≈ +6 dB):这是「尚未校准」时的保守取值,不是实测值。**
   *
   * 方向是不对称的,所以未校准时必须偏低:
   *   调高 → 更难判成回声 → 更容易 pass → 更容易给出 hands-free。判错了,
   *          用户陷进自我打断的死循环。
   *   调低 → 更容易判成回声 → 退到 tap-to-talk。判错了,只是多点一次按钮。
   *
   * 代价是一部分隔离尚可的用户会被判失败、拿不到 hands-free。§6.10 的文案
   * 已为此写好:「提示但不阻止 —— 这是用户的机器,他可能知道些探测不知道的事」。
   *
   * ⚠ **拿到真实硬件矩阵(外放/耳机 × 多音量)后应上调至实测值。**
   */
  echoRmsFactor: 2.0,

  /**
   * 播放段整体幅度相对基线的最小变化倍数。低于它说明「播了跟没播一样」——
   * 可能是戴着耳机(隔离良好,该判通过),也可能是输出被静音、音量为零或
   * 根本没有输出设备(不该判通过)。**Web 平台读不到系统音量,这两种情况
   * 无法从信号上区分**,因此归为 inconclusive 而不是 pass。
   */
  playbackChangeFactor: 1.5,
};

/** 分位数。空数组返回 0,让调用方不必到处判空。 */
export function quantile(xs, q) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)));
  return s[i];
}

/**
 * 找出连续超过概率阈值、且持续时间达标的段。
 *
 * 分段用的是帧的时间戳而非帧数,因为丢帧在负载下是会发生的,按帧数算会把
 * 一个有空洞的段当成连续的。
 */
export function sustainedRuns(frames, { pThreshold, sustainMs }) {
  const runs = [];
  let cur = null;
  for (const f of frames) {
    if (f.p >= pThreshold) {
      if (!cur) cur = { start: f.t, end: f.t, frames: [] };
      cur.end = f.t;
      cur.frames.push(f);
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);

  return runs
    .map((r) => ({
      ...r,
      durationMs: (r.end - r.start) * 1000 + frameSpanMs(r.frames),
      medianRms: quantile(r.frames.map((f) => f.rms), 0.5),
      peakP: Math.max(...r.frames.map((f) => f.p)),
    }))
    .filter((r) => r.durationMs >= sustainMs);
}

// 一段的时长要把最后一帧自身覆盖的时长算进去,否则单帧段会得到 0 ms。
function frameSpanMs(frames) {
  if (frames.length < 2) return 32; // 512 样本 @16 kHz
  const gaps = [];
  for (let i = 1; i < frames.length; i++) gaps.push((frames[i].t - frames[i - 1].t) * 1000);
  return quantile(gaps, 0.5);
}

/**
 * 判定。返回 `{ verdict, reason, metrics }`。
 *
 * verdict ∈ 'pass' | 'fail' | 'inconclusive'
 *
 * **fail-safe 方向是明确的:凡是拿不准的一律 inconclusive,而 inconclusive 的
 * 处置是退到 tap-to-talk。** 猜错方向的代价不对称 —— 误判通过会让用户陷入
 * 自我打断的死循环,误判失败只是多点一次按钮。
 */
export function analyseProbe({ baseline, playback }, options = {}) {
  const opt = { ...DEFAULTS, ...options };

  const baseRmsP95 = quantile(baseline.map((f) => f.rms), 0.95);
  const playRmsP95 = quantile(playback.map((f) => f.rms), 0.95);
  const basePP95 = quantile(baseline.map((f) => f.p), 0.95);

  const metrics = {
    baselineFrames: baseline.length,
    playbackFrames: playback.length,
    baselineRmsP95: baseRmsP95,
    playbackRmsP95: playRmsP95,
    baselineSpeechP95: basePP95,
    rmsRatio: baseRmsP95 > 0 ? playRmsP95 / baseRmsP95 : Infinity,
    runs: [],
  };

  if (!baseline.length || !playback.length) {
    return { verdict: 'inconclusive', reason: 'no-frames', metrics };
  }

  // 麦克风没在收音 —— 真实麦克风永远有底噪。
  if (baseRmsP95 < opt.silenceRms) {
    return { verdict: 'inconclusive', reason: 'mic-silent', metrics };
  }

  const runs = sustainedRuns(playback, opt);
  const echoFloor = baseRmsP95 * opt.echoRmsFactor;
  const offenders = runs.filter((r) => r.medianRms >= echoFloor);
  metrics.runs = runs.map((r) => ({
    startMs: Math.round(r.start * 1000),
    durationMs: Math.round(r.durationMs),
    medianRms: r.medianRms,
    peakP: r.peakP,
    aboveBaseline: r.medianRms >= echoFloor,
  }));
  metrics.echoFloor = echoFloor;

  if (offenders.length) {
    return { verdict: 'fail', reason: 'echo-detected', metrics };
  }

  // 播了跟没播一样:隔离良好与输出静音在信号上无法区分。
  if (metrics.rmsRatio < opt.playbackChangeFactor) {
    return { verdict: 'inconclusive', reason: 'output-unverified', metrics };
  }

  return { verdict: 'pass', reason: 'no-sustained-echo', metrics };
}

/**
 * 用一次用户确认解开 `output-unverified`。
 *
 * 「戴耳机(隔离良好)」与「输出被静音 / 音量为零」在信号上完全相同,而 Web
 * 平台读不到系统音量 —— 这个歧义**无法从信号解决**,只能问。而问这一句同时
 * 就确认了输出可闻,所以它不是额外负担,是唯一的信息来源。
 *
 * 与 §6.10「探测通过不弹任何东西」不冲突:那条讲的是**通知**,这是一次性的
 * **设置步骤**,且只在真的分不清时才出现 —— fail 与 pass 都不会问。
 *
 * @param {boolean|null} heard 用户是否听到了参考音;null = 未作答
 */
export function resolveOutputUnverified(result, heard) {
  if (result.reason !== 'output-unverified') return result;
  if (heard === true) {
    // 输出可闻,却没有任何东西回到麦克风 —— 这正是隔离良好的定义。
    return { ...result, verdict: 'pass', reason: 'isolated-output-confirmed' };
  }
  if (heard === false) {
    return { ...result, verdict: 'inconclusive', reason: 'output-inaudible' };
  }
  return result;
}

/** 结果落 `config.toml` 时的设备键(Q49)。 */
export function deviceKey(inputId, outputId) {
  // 拿不到输出设备标识时,键不完整 —— 调用方据此退化为「任何 devicechange
  // 都作废结果」。
  return { key: `in:${inputId || 'unknown'}|out:${outputId || 'unknown'}`, complete: !!outputId };
}

// ---------------------------------------------------------------- self test
//
// 判据是这个模块唯一有判断力的部分,而它要在一台没有声卡的机器上被信任。
// 这些用例覆盖每一条分支,用合成帧,不碰任何音频 API。

export function selfTest() {
  const mk = (n, p, rms, t0 = 0) =>
    Array.from({ length: n }, (_, i) => ({ t: t0 + i * 0.032, p, rms }));

  // 夹具从常数推导,而不是写死数值。这样调整 echoRmsFactor 时,用例仍然表达
  // 它本来要表达的场景("刚好越线"、"明显没越线"),而不是悄悄换了含义。
  const F = DEFAULTS.echoRmsFactor;
  const cases = [];
  const check = (name, got, want) => cases.push({ name, ok: got === want, got, want });

  // 安静房间 + 戴耳机:播放期毫无变化 → 信号上无法区分「隔离好」与「输出静音」
  const headphones = analyseProbe({
    baseline: mk(62, 0.02, 0.004),
    playback: mk(188, 0.02, 0.004),
  });
  check('耳机/静音无法区分 → inconclusive', headphones.verdict, 'inconclusive');
  check('且理由是 output-unverified', headphones.reason, 'output-unverified');

  // 一次用户确认就能解开它 —— 这是加那句问话的全部意义。
  check('确认听到了 → pass', resolveOutputUnverified(headphones, true).verdict, 'pass');
  check('确认没听到 → inconclusive', resolveOutputUnverified(headphones, false).verdict, 'inconclusive');
  check('未作答 → 维持原判', resolveOutputUnverified(headphones, null).reason, 'output-unverified');
  // 确认只作用于那一个歧义,不能改写别的判定。
  const echoed = { verdict: 'fail', reason: 'echo-detected', metrics: {} };
  check('确认不影响 fail', resolveOutputUnverified(echoed, true).verdict, 'fail');

  // 麦克风数字静音 → 不下结论
  check(
    '麦克风无信号 → inconclusive',
    analyseProbe({ baseline: mk(62, 0.0, 0.0), playback: mk(188, 0.0, 0.0) }).verdict,
    'inconclusive'
  );

  // 外放漏音:播放期出现 320 ms、幅度明显越过门槛的语音段
  check(
    '回声 → fail',
    analyseProbe({
      baseline: mk(62, 0.02, 0.01),
      playback: [
        ...mk(30, 0.02, 0.03),
        ...mk(10, 0.95, 0.01 * F * 1.5, 0.96),
        ...mk(148, 0.02, 0.03, 1.3),
      ],
    }).verdict,
    'fail'
  );

  // 咖啡馆:基线本来就吵且偶有语音,播放期幅度抬升但没有越过门槛的段。
  // 这一条是 echoRmsFactor 存在的理由 —— 没有它,吵环境一律判失败。
  check(
    '吵环境但无回声 → pass(基线的作用)',
    analyseProbe({
      baseline: [...mk(50, 0.1, 0.03), ...mk(12, 0.9, 0.04, 1.6)],
      playback: [
        ...mk(90, 0.1, 0.04 * DEFAULTS.playbackChangeFactor * 1.2),
        ...mk(10, 0.92, 0.04 * F * 0.8, 2.9),
        ...mk(88, 0.1, 0.04 * DEFAULTS.playbackChangeFactor * 1.2, 3.3),
      ],
    }).verdict,
    'pass'
  );

  // 短促触发(96 ms < 200 ms)不算数 —— 与 barge-in 门限一致
  check(
    '短于门限的触发 → pass',
    analyseProbe({
      baseline: mk(62, 0.02, 0.004),
      playback: [...mk(30, 0.02, 0.02), ...mk(3, 0.99, 0.06, 0.96), ...mk(155, 0.02, 0.02, 1.06)],
    }).verdict,
    'pass'
  );

  check('无帧 → inconclusive', analyseProbe({ baseline: [], playback: [] }).verdict, 'inconclusive');

  return cases;
}
