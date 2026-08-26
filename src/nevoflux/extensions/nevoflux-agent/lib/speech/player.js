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
    /**
     * 空档次数:这一轮里播放追上了合成、不得不静音等待的次数。
     *
     * 「不流畅」是一句感受,传不到日志里也没法比较。这个数字能。
     */
    this.underruns = 0;
    this.muted = false;
    /** 乱序到达的句子先存这里,按 seq 补齐后再排期。 */
    this.pending = new Map();
    this.expectSeq = 0;

    /**
     * 补齐了、但还没排期的句子。预缓冲就攒在这里。
     *
     * 为什么要攒:合成是**逐句**推过来的,一句到了就放会让播放紧贴着合成走 ——
     * 只要合成比实时慢一点点(RTF > 1),每句之间都会露出一个空档,听起来就是
     * 断断续续。先攒住一小段再起播,把这些空档合并成开头的一次等待。
     *
     * 攒不是万灵药:RTF 持续大于 1 时,攒的那点存货迟早耗尽 —— 那是引擎的问题,
     * 不是这里的。这里能做的是把「每句都断」变成「偶尔断一次」。
     */
    this.queue = [];
    this.playing = false;
    /** 攒是从什么时候开始的 —— 超时保护要用。 */
    this.holdingSince = 0;
  }

  /** 起播前至少攒几句。 */
  static PREBUFFER_SENTENCES = 3;
  /**
   * 或者攒够这么多秒的音频,先到先算。
   *
   * 3 秒不是随手定的:这台机器实测合成是 1.17x 实时(CPU 12 线程是量出来的最优,
   * CUDA 在 T4 上反而是 2.63x —— 自回归解码每步都要付一次 kernel 启动)。合成
   * 慢 17%,意味着攒下的每一秒存货能多撑约 6 秒播放,3 秒的存货够连续播约 17 秒。
   * 再长的回答仍然会断,那是产能问题,缓冲买不来。
   */
  static PREBUFFER_SECONDS = 3.0;
  /**
   * 攒最多等这么久。
   *
   * 兜底:一轮只有一句话时,前两个条件永远不成立,没有这个超时就永远不出声 ——
   * 而「只有一句」正是最常见的短回答。`flush()` 也会解开它,但那要等 daemon 的
   * turn-done 到达,而那条帧丢了就没有第二次机会。
   */
  static PREBUFFER_MAX_WAIT_MS = 2000;

  /**
   * 多大的空档才算断。
   *
   * 调度是采样级的,但 `currentTime` 的读数和 `start()` 的实际生效之间总有几
   * 毫秒的抖动。20 毫秒以下听不出来,报出来只会淹掉真正的断点。
   */
  static GAP_TOLERANCE = 0.02;

  reset() {
    this.stopAll();
    this.muted = false;
    this.played = 0;
    this.underruns = 0;
    this.nextAt = 0;
    this.pending.clear();
    this.expectSeq = 0;
    this.queue = [];
    this.playing = false;
    this.holdingSince = 0;
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
      this.queue.push({ seq: this.expectSeq, buf });
      this.expectSeq++;
    }
    this.pump();
  }

  /** 攒够了就起播;已经在播就直接续上。 */
  pump() {
    if (!this.queue.length) return;
    if (!this.playing) {
      if (!this.holdingSince) this.holdingSince = Date.now();
      const seconds = this.queue.reduce((s, q) => s + q.buf.duration, 0);
      const ready =
        this.queue.length >= VoicePlayer.PREBUFFER_SENTENCES ||
        seconds >= VoicePlayer.PREBUFFER_SECONDS ||
        Date.now() - this.holdingSince >= VoicePlayer.PREBUFFER_MAX_WAIT_MS;
      if (!ready) {
        // 还不够。等下一句到达时再问一次;真的只有一句时,超时会把它放出去。
        clearTimeout(this._holdTimer);
        this._holdTimer = setTimeout(() => this.pump(), VoicePlayer.PREBUFFER_MAX_WAIT_MS);
        return;
      }
      clearTimeout(this._holdTimer);
      this.playing = true;
      this.holdingSince = 0;
      this.onEvent({ type: 'diag', what: 'prebuffered', sentences: this.queue.length, seconds });
    }
    while (this.queue.length) {
      const { seq, buf } = this.queue.shift();
      this.schedule(seq, buf);
    }
    // 存货放完了。下一句来之前若播放已经追平,就回到攒的状态 —— 与其每句之间
    // 断一次,不如把空档合并成少数几次。
    if (this.nextAt <= this.ctx.currentTime) {
      this.playing = false;
    }
  }

  /**
   * 这一轮说完了,别再等。
   *
   * 由 turn-done 触发。没有它,一轮只有一句话时要白等一次超时。
   */
  flush() {
    clearTimeout(this._holdTimer);
    if (this.queue.length) {
      this.playing = true;
      this.holdingSince = 0;
      while (this.queue.length) {
        const { seq, buf } = this.queue.shift();
        this.schedule(seq, buf);
      }
    }
    this.playing = false;
    this.holdingSince = 0;
  }

  schedule(seq, buf) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const startAt = Math.max(this.ctx.currentTime, this.nextAt);

    // 空档:上一句放完到这一句起播之间的静音。
    //
    // 调度本身是采样级无缝的 —— `nextAt` 累加,句与句之间不留缝。所以听到断续
    // 只有一个来源:这一句**来晚了**,`nextAt` 已经过去,`startAt` 落回了
    // `currentTime`,那个差就是空档。
    //
    // 量它,因为「不流畅」这个说法本身传不到任何地方去。合成在这台机器上是
    // 0.51x(比实时快一倍),所以如果还是断,断的原因不在合成 —— 而是在这里
    // 能看见的:等文本、等网络、还是起播太早。
    if (this.nextAt > 0) {
      const gap = startAt - this.nextAt;
      if (gap > VoicePlayer.GAP_TOLERANCE) {
        this.underruns++;
        this.onEvent({
          type: 'diag',
          what: 'underrun',
          seq,
          gap: Number(gap.toFixed(2)),
          total: this.underruns,
        });
      }
    }

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
    // 攒着还没排期的那几句同样要丢掉。留着的话,打断之后它们会在下一次 pump
    // 时冒出来 —— 用户喊了停,几秒后又开口,是最败好感的一种。
    this.queue = [];
    this.playing = false;
    this.holdingSince = 0;
    clearTimeout(this._holdTimer);
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
