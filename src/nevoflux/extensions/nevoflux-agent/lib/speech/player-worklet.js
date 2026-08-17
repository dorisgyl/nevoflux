// 对话语音的播放端(P3)。
//
// 一句一个缓冲,按 seq 顺序播。存在的理由不是「播个声音」—— `AudioBufferSourceNode`
// 就能做到 —— 而是**打断**。
//
// ## 为什么静音要在音频线程上
//
// ADR-0007:barge-in 必须工作的那一刻,正是主线程最忙的那一刻(agent 在说话
// ⇒ token 级流式刷新 ⇒ Dioxus 高频 diff)。P0-b 实测,静音走主线程时 97% 占空比
// 下要多付 8–24 ms,而帧投递走主线程要多付 56 ms。
//
// 所以这里接受两个入口:自己的 `port`(主线程),以及一个从 VAD Worker **转移
// 进来**的 `MessagePort`。后者让「用户开口 → 音频静音」完全不经过主线程。
//
// ## 为什么要数播了几句
//
// 打断之后写进 history 的必须是**实际播出**的部分,而不是生成的全部。按原文入库
// 会让模型以为自己说完了整段,而用户只听到前三分之一 —— cascaded S2S 最隐蔽的
// bug。只有这里知道真实的播出量。

class VoicePlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {{seq:number, pcm:Float32Array}[]} */
    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.muted = false;
    /** 完整播完的句数 —— 投递注记要的就是这个数。 */
    this.played = 0;

    this.port.onmessage = (e) => this.handle(e.data);
    // 构造即报到。收得到 = 处理器活着、端口通;收不到 = 根本没被实例化。
    // 这条把「没声音」的可能性一分为二,而两半的修法完全不同。
    this.port.postMessage({ type: 'hello', sampleRate });
  }

  handle(msg) {
    switch (msg.type) {
      case 'attach-mute':
        // 从 VAD Worker 转移进来的一端。主线程两端都不持有。
        msg.port.onmessage = (e) => this.handle(e.data);
        msg.port.start?.();
        break;

      case 'audio':
        // 已经喊停了,后到的句子不该再响。注意 `reset` 会清掉 muted ——
        // 新一轮开始时必须 reset,否则上一轮的打断会让这一轮整轮哑掉,
        // 而症状是「daemon 说推了 N 句,但一句都没响」。
        if (!this.muted) {
          this.queue.push({ seq: msg.seq, pcm: new Float32Array(msg.pcm) });
          // 按 seq 保序:合成是并发的,到达顺序不保证。
          this.queue.sort((a, b) => a.seq - b.seq);
        }
        // 每一句都回报落点。静默丢弃是这条链路上最难查的失败 —— 没有报错、
        // 没有声音、daemon 那边一切正常。
        this.port.postMessage({
          type: 'queued',
          seq: msg.seq,
          muted: this.muted,
          queued: this.queue.length,
          samples: msg.pcm.byteLength / 4,
        });
        break;

      case 'mute':
        // 立刻停,连当前这句的剩余部分都不放。用户喊停时还继续说半句,
        // 是最败好感的行为。
        this.muted = true;
        this.current = null;
        this.offset = 0;
        this.queue.length = 0;
        this.port.postMessage({ type: 'muted', played: this.played });
        break;

      case 'reset':
        this.muted = false;
        this.played = 0;
        this.current = null;
        this.offset = 0;
        this.queue.length = 0;
        break;
    }
  }

  process(outputs) {
    // `outputs[0]` 不保证存在。节点未接、上下文挂起、拆除途中都会给空数组,
    // 而 **worklet 的 process() 一旦抛异常就被永久停用** —— 后面所有音频石沉
    // 大海,页面侧还收不到任何错误(异常进的是浏览器控制台,不是我们的错误
    // 通道)。表现是「daemon 说推了 N 句,但一句都没响」。
    //
    // 与采集端 `if (!ch)` 是同一类假设,方向相反:那边「没有输入」要当静音,
    // 这边「没有输出口」要当无事可做。
    // 诊断放在**任何早退之前** —— 放在后面就只能证明「没早退」,
    // 而要查的恰恰是「是不是一直在早退」。
    if (!this.everRan) {
      this.everRan = true;
      this.port.postMessage({
        type: 'alive',
        outputs: outputs.length,
        chans: outputs[0] ? outputs[0].length : -1,
        frames: outputs[0] && outputs[0][0] ? outputs[0][0].length : -1,
      });
    }

    const chan = outputs[0];
    const out = chan && chan[0];
    if (!out) return true;

    if (this.muted) {
      out.fill(0);
      return true;
    }

    let written = 0;
    while (written < out.length) {
      if (!this.current) {
        this.current = this.queue.shift() || null;
        this.offset = 0;
        if (!this.current) break; // 队列空了,剩下的补静音
      }
      const src = this.current.pcm;
      const n = Math.min(out.length - written, src.length - this.offset);
      out.set(src.subarray(this.offset, this.offset + n), written);
      written += n;
      this.offset += n;

      if (this.offset >= src.length) {
        // 一句**完整**播完了才算数。半句不算 —— 那正是打断要记的差别。
        this.played++;
        this.port.postMessage({ type: 'played', seq: this.current.seq, played: this.played });
        this.current = null;
        this.offset = 0;
      }
    }
    if (written < out.length) out.fill(0, written);
    return true;
  }
}

registerProcessor('voice-player', VoicePlayerProcessor);
