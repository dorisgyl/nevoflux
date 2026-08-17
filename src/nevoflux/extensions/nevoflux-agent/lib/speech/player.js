// 对话语音的播放端(P3)。
//
// ## 为什么不是 AudioWorklet
//
// 第一版用自定义 `AudioWorkletProcessor`,理由是 ADR-0007:让 VAD Worker 通过
// 转移进去的 `MessagePort` **直接**停掉音频,不经主线程。
//
// 实测在本环境下它**从不被实例化** —— 节点构造成功、连接成功、`addModule`
// 成功、`onprocessorerror` 不触发、构造函数里的报到消息一次都不到、`process()`
// 一次都不调。逐个排除了:context 挂起、汇点类型(destination / MediaStreamDestination)、
// `outputChannelCount`、处理器异常、模块加载失败、同 context 两次 `addModule`。
// 原因未确定。
//
// `AudioBufferSourceNode` 是原生节点,不存在这个问题。代价是**静音要经过主线程**。
// P0-b 的实测恰好说明这个代价是可接受的:
//
//   静音那一跳走主线程 → 97% 占空比下多付 8–24 ms
//   帧投递那一跳走主线程 → 多付 56 ms   ← 贵的是这个,而它仍然直连
//
// 换句话说,让出的是便宜的那一半。

export class VoicePlayer {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} sink 接到哪里(destination 或用于验证的 MediaStreamDestination)
   * @param {(e:object)=>void} onEvent
   */
  constructor(ctx, sink, onEvent) {
    this.ctx = ctx;
    this.onEvent = onEvent || (() => {});
    this.gain = ctx.createGain();
    this.gain.connect(sink);

    /** 已排期但尚未播完的源,打断时要全部停掉。 */
    this.scheduled = [];
    /** 下一句从什么时候开始放。保证顺序与无缝。 */
    this.nextAt = 0;
    /** **完整播完**的句数 —— 投递注记要的就是这个(ADR-0004)。 */
    this.played = 0;
    this.muted = false;
    /** 乱序到达的句子先存这里,按 seq 补齐后再排期。 */
    this.pending = new Map();
    this.expectSeq = 0;
  }

  reset() {
    this.stopAll();
    this.muted = false;
    this.played = 0;
    this.nextAt = 0;
    this.pending.clear();
    this.expectSeq = 0;
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.gain.gain.setValueAtTime(1, this.ctx.currentTime);
  }

  /** 收下一句。乱序到达会先攒着 —— 合成是并发的,到达顺序不保证。 */
  enqueue(seq, audioBuffer) {
    if (this.muted) {
      // 不静默丢弃:静默丢弃是这条链路上最难查的失败 —— 没有报错、没有声音、
      // daemon 那边一切正常。
      this.onEvent({ type: 'diag', what: 'dropped', seq, reason: 'muted' });
      return;
    }
    this.pending.set(seq, audioBuffer);
    this.drain();
  }

  drain() {
    while (this.pending.has(this.expectSeq)) {
      const buf = this.pending.get(this.expectSeq);
      this.pending.delete(this.expectSeq);
      this.schedule(this.expectSeq, buf);
      this.expectSeq++;
    }
  }

  schedule(seq, buf) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const startAt = Math.max(this.ctx.currentTime, this.nextAt);
    src.start(startAt);
    this.nextAt = startAt + buf.duration;
    src.onended = () => {
      const i = this.scheduled.indexOf(src);
      if (i >= 0) this.scheduled.splice(i, 1);
      // 只有**没被打断**地走到结尾才算播完。被 stop() 掐掉的也会触发 onended,
      // 所以要看 muted —— 半句不算,那正是打断要记的差别。
      if (!this.muted) {
        this.played++;
        this.onEvent({ type: 'played', seq, played: this.played });
      }
    };
    this.scheduled.push(src);
    this.onEvent({ type: 'diag', what: 'scheduled', seq, at: startAt, dur: buf.duration });
  }

  /** 立刻停。连当前这句的剩余部分都不放 —— 喊停之后还说半句是最败好感的。 */
  mute() {
    if (this.muted) return this.played;
    this.muted = true;
    // 先把增益归零(采样精确),再停源:顺序反过来的话,停源那一瞬可能有咔哒声。
    this.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    this.stopAll();
    this.pending.clear();
    this.onEvent({ type: 'muted', played: this.played });
    return this.played;
  }

  stopAll() {
    for (const src of this.scheduled.splice(0)) {
      try {
        src.stop();
      } catch {
        /* 已经停了 */
      }
    }
    this.nextAt = 0;
  }
}
