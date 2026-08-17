// 语音上行的采集端(P2)。
//
// 一个 worklet 同时供两条下游:
//
//   VAD   —— 连续的 512 样本窗,不管在不在录
//   上行  —— 只在 armed 期间,~500 ms 一片,**并且带 400 ms 前置音频**
//
// ## 为什么要前置缓冲
//
// `crates/asr/src/vad.rs` 的 `speech_pad_ms = 200` 有硬证据:补白只给 30 ms 时,
// 混合语料里第一个音节回来是「菜」(声母错)、「うち」变成「血」;100 ms 以上
// 才对。而在线检测比离线更吃亏 —— VAD 是在概率越过阈值时才说「开始了」,那一刻
// 语音已经响了一会儿。**等 VAD 说开始再录,开头就已经丢了。**
//
// 所以这里始终维持一个环形缓冲,armed 的第一件事是把它整个吐出去。400 ms 而非
// 200 ms,是因为要同时覆盖离线那 200 ms 的补白经验和在线检测本身的延迟;代价是
// 25 KB 内存。
//
// ## 为什么上行是 i16
//
// 麦克风的物理分辨率本来就是 16 位,转 i16 不损失可听信息,却把上行体积减半。
// VAD 已经在 f32 上跑完了,送 daemon 的只需喂 ASR。

const FRAME = 512; // Silero 的窗
const PREROLL_MS = 400;
const CHUNK_MS = 500;

class SpeechCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.prerollLen = Math.round((sampleRate * PREROLL_MS) / 1000);
    this.chunkLen = Math.round((sampleRate * CHUNK_MS) / 1000);

    // VAD 窗
    this.frame = new Float32Array(FRAME);
    this.frameUsed = 0;
    this.frameIndex = 0;
    this.frameStart = 0;

    // 前置环形缓冲
    this.ring = new Float32Array(this.prerollLen);
    this.ringWrite = 0;
    this.ringFilled = 0;

    // 上行累积
    this.armed = false;
    this.chunk = null;
    this.chunkUsed = 0;
    this.seq = 0;

    this.framePort = null;

    this.port.onmessage = (e) => this.control(e.data);
  }

  control(msg) {
    switch (msg.type) {
      case 'attach-frames':
        // VAD 帧直连 Worker,主线程不持有任一端(ADR-0007)。
        this.framePort = msg.port;
        this.framePort.start?.();
        break;
      case 'arm':
        this.arm();
        break;
      case 'disarm':
        this.disarm();
        break;
    }
  }

  arm() {
    if (this.armed) return;
    this.armed = true;
    this.seq = 0;
    this.chunk = new Float32Array(this.chunkLen);
    this.chunkUsed = 0;

    // 先把环形缓冲里的历史音频灌进第一片 —— 这就是前置音频。
    const n = this.ringFilled;
    const start = (this.ringWrite - n + this.ring.length) % this.ring.length;
    for (let i = 0; i < n; i++) {
      this.pushUpload(this.ring[(start + i) % this.ring.length]);
    }
  }

  disarm() {
    if (!this.armed) return;
    // 最后一片可能不满,照发 —— 丢掉它就是丢掉话尾。
    if (this.chunkUsed > 0) {
      this.emitChunk(this.chunk.subarray(0, this.chunkUsed));
    }
    this.armed = false;
    this.chunk = null;
    this.chunkUsed = 0;
  }

  pushUpload(sample) {
    this.chunk[this.chunkUsed++] = sample;
    if (this.chunkUsed === this.chunkLen) {
      this.emitChunk(this.chunk);
      this.chunk = new Float32Array(this.chunkLen);
      this.chunkUsed = 0;
    }
  }

  emitChunk(samples) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      // 负半轴用 32768、正半轴用 32767,才不会在满量程处回绕。
      pcm[i] = v < 0 ? v * 32768 : v * 32767;
    }
    this.port.postMessage({ type: 'upload', seq: this.seq++, pcm: pcm.buffer }, [pcm.buffer]);
  }

  process(inputs) {
    // 没有输入不等于「暂停」,等于**静音**。
    //
    // 早退在这里是个 bug:源消失(文件播完、麦克风被拔掉或被抢占)之后就不再
    // 发帧,VAD 于是永远累积不到端点所需的静音,那一段话就永远不会收尾 ——
    // 屏幕上停在最后一个 partial,像卡死一样。麦克风模式下看不到,因为麦克风
    // 会持续送静音样本;而「源没了」恰恰是最需要收尾的时刻。
    let ch = inputs[0] && inputs[0][0];
    if (!ch) {
      if (!this.silence) this.silence = new Float32Array(128);
      ch = this.silence;
    }

    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];

      // 环形缓冲永远在转 —— armed 之前的音频正是我们要的那部分。
      this.ring[this.ringWrite] = s;
      this.ringWrite = (this.ringWrite + 1) % this.ring.length;
      if (this.ringFilled < this.ring.length) this.ringFilled++;

      if (this.armed) this.pushUpload(s);

      // VAD 窗
      if (this.frameUsed === 0) {
        this.frameStart = currentTime + i / sampleRate;
      }
      this.frame[this.frameUsed++] = s;
      if (this.frameUsed === FRAME) {
        const out = this.frame.slice();
        const msg = { type: 'frame', frame: out, t: this.frameStart, index: this.frameIndex++ };
        if (this.framePort) {
          this.framePort.postMessage(msg, [out.buffer]);
        } else {
          this.port.postMessage(msg, [out.buffer]);
        }
        this.frameUsed = 0;
      }
    }
    return true;
  }
}

registerProcessor('speech-capture', SpeechCaptureProcessor);
