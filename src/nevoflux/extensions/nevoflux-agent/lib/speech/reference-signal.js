// 回声探测的参考信号。
//
// Q39 把探测音源从「用 MOSS 现场合成」改成「随扩展分发的预录参考音」,
// 理由是探测测的是**声学回路,不是 TTS 引擎** —— 用 MOSS 会让 P0-a 依赖
// P1 的产物,还会让运行时探测必须等 730 MB 下载完。
//
// 这里更进一步:**不预录,而是确定性地合成**。三个好处:
//   - 零许可证问题(没有任何第三方录音进包)
//   - 零字节进仓库(在运行时生成,不是一个要 vendoring 的 WAV)
//   - 参数可调,校准 echoRmsFactor 时可以改频谱重跑
//
// 它不是语音,也不打算是。它只需要满足两件事:
//   1. 频谱像浊音语音,让 Silero 在回声路径上会当成语音 —— 因为探测要预测
//      的正是「回声会不会被 VAD 当成用户开口」
//   2. 时域上有清晰的音节起伏,让持续时长判据有东西可判

/**
 * 合成一段类浊音信号。
 *
 * @param {number} sampleRate
 * @param {number} seconds
 * @returns {Float32Array} 幅度约 ±0.28,留出余量避免播放端削顶
 */
export function renderReference(sampleRate, seconds = 6) {
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);

  // 三个共振峰,取的是接近中性元音的位置。
  const formants = [700, 1220, 2600];
  const bandwidths = [90, 110, 170];
  const zs = formants.map(() => [0, 0]);

  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;

    // 基频轻微起伏:恒定基频听起来像蜂鸣器,Silero 对它的反应不如对语音稳定。
    const f0 = 118 + 14 * Math.sin(2 * Math.PI * 0.9 * t);
    phase += (2 * Math.PI * f0) / sampleRate;

    // 声门源:谐波幅度按 1/h 衰减。
    let src = 0;
    for (let h = 1; h <= 12; h++) src += Math.sin(phase * h) / h;

    // 三个二阶谐振器充当共振峰。
    let y = 0;
    for (let k = 0; k < formants.length; k++) {
      const r = Math.exp((-Math.PI * bandwidths[k]) / sampleRate);
      const c = 2 * r * Math.cos((2 * Math.PI * formants[k]) / sampleRate);
      const v = src * (1 - r) + c * zs[k][0] - r * r * zs[k][1];
      zs[k][1] = zs[k][0];
      zs[k][0] = v;
      y += v;
    }

    // 音节速率包络 + 起始淡入(避免咔哒声被当成触发)+ 结束淡出。
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4.2 * t - Math.PI / 2);
    const fadeIn = Math.min(1, t / 0.02);
    const fadeOut = Math.min(1, (seconds - t) / 0.02);
    out[i] = Math.max(-1, Math.min(1, y * 0.28 * syllable * fadeIn * fadeOut));
  }
  return out;
}

/** 包成 AudioBuffer,方便直接接进音频图。 */
export function referenceBuffer(ctx, seconds = 6) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  buf.copyToChannel(renderReference(ctx.sampleRate, seconds), 0);
  return buf;
}
