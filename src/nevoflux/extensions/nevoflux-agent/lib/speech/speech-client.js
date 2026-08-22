// 语音上行的编排(P2,浏览器侧)。
//
// 把三样东西缝在一起:AudioWorklet 采集、Worker 里的 Silero VAD、到 daemon 的
// 上行。对外只有 `start()` / `stop()` 和几个回调。
//
// ## 主线程不在关键路径上
//
// 两条 `MessagePort` 分别转移进 Worker 和 AudioWorklet(ADR-0007):采集帧
// worklet → Worker 直连,主线程两端都不持有。P0-b 实测:走主线程时 97% 占空比
// 下净开销 56 ms,直连后恒为 0。**主线程最忙的时刻恰好是语音必须工作的时刻。**
//
// ## 一段话的生命周期
//
//   VAD speech-start → arm 采集(连同 400 ms 前置)→ speech_start 上行
//   ~500 ms 一片      → speech_chunk
//   VAD speech-end    → disarm(冲掉尾片)→ speech_end
//   转写回来          → speech_partial* → speech_final

import { IdleTimer } from './idle-timer.js';
import { VoicePlayer } from './player.js';

const SAMPLE_RATE = 16000;
/** 静默检查的节拍。做成轮询而不是定时器,免得每次交互都要重排一个 timer。 */
const IDLE_TICK_MS = 2000;

/** 每段一个 id;迟到的片靠它被丢掉,而不是污染下一段。 */
function newUtteranceId() {
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  // 分块:一次 apply 整个数组在长音频上会爆栈。
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(s);
}

/**
 * 把 Worker 的 error 事件翻成一句人话。
 *
 * 两种 error 长得完全不一样,补法也不一样:
 *
 *   - worker 内部抛异常 → `ErrorEvent`,有 `.message`,照原样报。
 *   - worker **加载**失败(脚本本身,或它静态 import 的模块图取不到)
 *     → 规范要求派发的是**普通 `Event`**,没有 `.message`。
 *
 * 直接取 `e.message`,后一种就显示成 "vad worker: undefined" —— 一条什么都
 * 没说的报错。而那恰恰是最常见的一种:`vad-worker.js` 唯一的静态 import 是
 * `./ort/`,那是构建期抓的资产,没进包就是这个症状(0.3.15 及之前)。
 */
export function vadWorkerErrorMessage(e, base = '') {
  const detail = e && e.message;
  if (detail) return `vad worker: ${detail}`;
  return (
    `vad worker: 加载失败 —— ${base}vad-worker.js 或它 import 的 ` +
    `ort/ort.wasm.bundle.min.mjs 取不到(浏览器侧语音资产未打进包)`
  );
}

export class SpeechClient {
  /**
   * @param {object} opts
   * @param {string} opts.sessionId
   * @param {string} [opts.baseUrl] 资源目录,默认与本文件同级
   * @param {(e:object)=>void} [opts.onEvent] 状态与转写事件
   */
  constructor(opts) {
    this.sessionId = opts.sessionId;
    this.base = opts.baseUrl || new URL('./', import.meta.url).href;
    this.onEvent = opts.onEvent || (() => {});
    /**
     * 转写通过闸门后,是否自动作为一轮用户输入提交。
     *
     * 默认关:决定「说的话算不算一次提问」是应用的事,不是采集层的事。
     * 打开时,语音输入就是一条普通的 `chat_message` —— 同 session、同 history、
     * 工具照调(Q9),daemon 那边一个特例都不需要。
     */
    this.autoSubmit = !!opts.autoSubmit;

    this.ctx = null;
    this.stream = null;
    this.capture = null;
    this.worker = null;
    this.utteranceId = null;
    this.running = false;
    this._onRuntimeMessage = null;

    // 下行(P3)。**与采集共用一个 AudioContext**,不另开。
    //
    // 一开始我给播放单开了一个 context,理由是采集固定 16 kHz 而 TTS 的采样率
    // 随引擎走(Kokoro 24k、MOSS 48k)。那是错的:一个没有任何输入流的
    // AudioContext 很可能一直处于 suspended,而 **suspended 的 context 不会调
    // `process()`,也不报任何错** —— 症状与「被静音」「队列是空的」一模一样,
    // 三者无法区分。采集的 context 挂着活的 MediaStream,一定在跑。
    //
    // 代价是播放被重采样到 16 kHz(`decodeAudioData` 代劳)。对语音而言这是
    // 可接受的:采集本来就是 16 kHz,而少一个时钟、少一类「静默不工作」的
    // 失败模式,比那点带宽值钱。
    this.player = null;
    this.turnId = null;
    this.played = 0;
    /**
     * 打断开关。
     *
     * 关掉它是为了**隔离下行**:在只有 PulseAudio 回环(`auto_null.monitor`)
     * 的机器上,播放出去的 TTS 会被采集端原样听回来,VAD 判成用户开口,于是
     * 自己把自己掐掉。那是真实的回声环路(§6.10 要探测的正是它),但它会让
     * 下行链路无法独立验证。
     */
    this.bargeInEnabled = true;
    this.idle = null;
    this._idleTick = null;
  }

  /** 开关打断。关掉时连 Worker 直连那一跳也一并停掉。 */
  setBargeIn(on) {
    this.bargeInEnabled = !!on;
    // Worker 只在 pathMode 为 'B' 时才往直连端口发静音 —— 直接用这个杠杆,
    // 免得在音频线程上再加一个状态。
    this.worker?.postMessage({ type: 'config', pathMode: on ? 'B' : 'A' });
  }

  emit(type, data = {}) {
    this.onEvent({ type, ...data });
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.fileUrl] 用音频文件代替麦克风。
   *
   * 文件模式存在的理由不是省事:这条链路要在**没有麦克风的机器**(服务器、CI)
   * 上被验证,而它测的是转写而非声学 —— 换掉声源,VAD、切片、上行、daemon
   * 全部走同一条真实路径。
   */
  async start(opts = {}) {
    if (this.running) return;
    this.running = true;
    this.fileUrl = opts.fileUrl || null;
    this.sink = opts.sink || 'destination';
    this.idleMs = opts.idleMs;
    this.maxMs = opts.maxMs;
    // `autoSubmit` 是构造时的策略,这里只在**显式给了**的时候覆盖。
    //
    // 早先这一行写成无条件 `= !!opts.autoSubmit`,而所有调用方都是在构造器里
    // 传的它 —— 于是 start() 每次都把它抹回 false,闭环一次都没真的发生过,
    // 且毫无迹象:转写照常出、界面照常更新,只是那条消息从来没发出去。
    if (opts.autoSubmit !== undefined) this.autoSubmit = !!opts.autoSubmit;

    this.emit('step', { at: 'ctx' });
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    if (this.ctx.sampleRate !== SAMPLE_RATE) {
      // 浏览器没给到 16 kHz。继续跑,但要说出来 —— 静默地按错误采样率转写,
      // 结果是「转写全是错字」而没有任何线索指向采样率。
      this.emit('warning', {
        message: `AudioContext 给的是 ${this.ctx.sampleRate} Hz,不是 ${SAMPLE_RATE} Hz`,
      });
    }

    this.emit('step', { at: 'capture-module', ctx: this.ctx.state, sr: this.ctx.sampleRate });
    // 采集与播放的处理器在同一个模块里,一次加载。
    await this.ctx.audioWorklet.addModule(`${this.base}worklets.js`);
    this.capture = new AudioWorkletNode(this.ctx, 'speech-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    this.capture.port.onmessage = (e) => this.onWorkletMessage(e.data);

    if (this.fileUrl) {
      const buf = await fetch(this.fileUrl)
        .then((r) => r.arrayBuffer())
        .then((b) => this.ctx.decodeAudioData(b));
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.capture);
      // 同时接一路静音到 destination:输出为 0 的节点不一定会被图拉动,
      // 而不被拉动就没有帧,症状是「一切正常但什么都不发生」。
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      src.connect(mute).connect(this.ctx.destination);
      src.onended = () => this.emit('file-ended');
      this.fileSource = src;
      this.emit('warning', {
        message: `用音频文件代替麦克风:${this.fileUrl.split('/').pop()}(${buf.duration.toFixed(1)} s)`,
      });
    } else {
      // 调用方可以把**已经打开的**麦克风流传进来。
      //
      // 这不是可选的方便:`getUserMedia` 受用户手势约束,而手势活不过
      // `addModule` 这一串 await。真实入口(侧边栏那个麦克风按钮)必须在点击
      // 处理器里**同步发起**授权,再把流交给这里 —— 否则请求发出时手势已经过期,
      // 表现是既不 resolve 也不 reject 地挂住(P0-c 实测)。
      if (opts.stream) {
        this.stream = opts.stream;
        this.ownsStream = false;
      } else {
        this.emit('step', { at: 'getUserMedia' });
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        this.ownsStream = true;
      }
      this.ctx.createMediaStreamSource(this.stream).connect(this.capture);
    }

    this.emit('step', { at: 'worker' });
    this.worker = new Worker(`${this.base}vad-worker.js`, { type: 'module' });
    this.worker.onmessage = (e) => this.onVadMessage(e.data);
    this.worker.onerror = (e) =>
      this.emit('error', { message: vadWorkerErrorMessage(e, this.base) });

    this.emit('step', { at: 'playback' });
    await this.setupPlayback();
    this.emit('step', { at: 'playback-done' });

    // 采集帧直连 Worker(ADR-0007)。
    const frames = new MessageChannel();
    this.worker.postMessage({ type: 'attach-frames', port: frames.port1 }, [frames.port1]);
    this.capture.port.postMessage({ type: 'attach-frames', port: frames.port2 }, [frames.port2]);

    // 端点静音 700 ms(Q46):低于 500 会切断思考停顿,高于 1000 显得迟钝。
    // sustain 在上行链路里不用于 barge-in,只用来滤掉过短的 blip。
    this.worker.postMessage({ type: 'config', sustainMs: 250 });
    this.worker.postMessage({
      type: 'init',
      modelUrl: `${this.base}silero-vad.onnx`,
    });

    // 文件要等 VAD 就绪再放,否则开头几秒喂给了一个还没加载完模型的 Worker,
    // 而丢掉的恰好是话的开头。
    this._pendingPlay = !!this.fileSource;

    // Q45:计的是「无交互」,不是「无语音」。执行中(说话、播放、等授权)
    // 豁免静默,但绝对上限照走 —— 忘记关闭的常开麦克风是最坏结果。
    this.idle = new IdleTimer({
      idleMs: this.idleMs,
      maxMs: this.maxMs,
      onExpire: (reason) => {
        this.emit('idle-exit', { reason });
        this.stop();
      },
    });
    this._idleTick = setInterval(() => this.idle?.check(), IDLE_TICK_MS);

    // 告诉 daemon 这个 session 开了语音 —— 它据此在回答流出时挂上拆流/合成
    // 旁路。不开的话,文字回答照常,只是不出声。
    this.send('voice_mode', { session_id: this.sessionId, on: true });

    this._onRuntimeMessage = (msg) => this.onDaemonMessage(msg);
    browser.runtime.onMessage.addListener(this._onRuntimeMessage);
    this.emit('starting');
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this.utteranceId) this.endUtterance(true);
    this.send('voice_mode', { session_id: this.sessionId, on: false });
    if (this._onRuntimeMessage) {
      browser.runtime.onMessage.removeListener(this._onRuntimeMessage);
      this._onRuntimeMessage = null;
    }
    if (this._idleTick) {
      clearInterval(this._idleTick);
      this._idleTick = null;
    }
    try {
      this.recorder?.stop();
    } catch {
      /* 已经停了 */
    }
    this.recorder = null;
    this.idle = null;
    this.worker?.terminate();
    // 只关自己开的流:调用方传进来的流可能还有别的用途(比如它先做了回声探测)。
    if (this.ownsStream !== false) this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.player = null;
    this.capture = null;
    this.worker = null;
    this.emit('stopped');
  }

  // ------------------------------------------------------------- VAD

  onVadMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.emit('ready', { loadMs: msg.loadMs });
        if (this._pendingPlay) {
          this._pendingPlay = false;
          this.fileSource.start();
        }
        break;
      case 'prob':
        this.emit('level', { p: msg.prob, rms: msg.rms });
        break;
      case 'barge-in':
        // 一个事件,两件事。
        //
        // 对上行:VAD 确认这是一段真语音,新的 utterance 开始。
        // 对下行:如果 agent 正在说话,这就是打断。
        //
        // 注意静音**不在这里做** —— VAD Worker 已经通过转移进播放 worklet 的
        // MessagePort 直接停掉了音频,不经主线程(ADR-0007)。这里只补发远端
        // 取消,把算力还回去(§6.5:两件事解耦,IPC 不在关键路径上)。
        if (this.bargeInEnabled && this.turnId) {
          // 先本地静音,再发远端取消(§6.5)。用户感知的停止延迟等于这一行,
          // 远端只负责停止继续合成、把算力还回去。
          this.player?.mute();
          this.sendBargeIn();
        }
        this.beginUtterance();
        break;
      case 'speech-end':
        this.endUtterance(false);
        break;
      case 'error':
        this.emit('error', { message: `${msg.where}: ${msg.message}` });
        break;
    }
  }

  beginUtterance() {
    if (this.utteranceId) return;
    this.utteranceId = newUtteranceId();
    this.send('speech_start', {
      session_id: this.sessionId,
      utterance_id: this.utteranceId,
      sample_rate: this.ctx?.sampleRate ?? SAMPLE_RATE,
    });
    // arm 之后第一片会带上 400 ms 前置音频 —— 等 VAD 说开始再录,开头就丢了。
    this.capture?.port.postMessage({ type: 'arm' });
    this.idle?.beginBusy(); // 用户在说话
    this.emit('utterance-start', { utteranceId: this.utteranceId });
  }

  endUtterance(cancelled) {
    const id = this.utteranceId;
    if (!id) return;
    this.utteranceId = null;
    // 先 disarm:它会冲出未满的尾片,而那一片必须排在 end 之前。
    this.capture?.port.postMessage({ type: 'disarm' });
    this.send(cancelled ? 'speech_cancel' : 'speech_end', {
      session_id: this.sessionId,
      utterance_id: id,
      ...(cancelled ? { reason: 'session_ended' } : {}),
    });
    this.idle?.endBusy();
    this.emit('utterance-end', { utteranceId: id, cancelled });
  }

  // ------------------------------------------------------------- 采集

  onWorkletMessage(msg) {
    if (msg.type !== 'upload') return;
    if (!this.utteranceId) return; // disarm 之后的余片,丢掉
    this.send('speech_chunk', {
      session_id: this.sessionId,
      utterance_id: this.utteranceId,
      seq: msg.seq,
      pcm: toBase64(msg.pcm),
    });
  }

  // ------------------------------------------------------------- 播放(P3)

  async setupPlayback() {
    // 汇点。正常接 destination;无音频输出设备的机器上接一个被 MediaRecorder
    // 消费的 MediaStreamDestination —— 没有消费者的流同样不会被图拉动。
    let sink;
    if (this.sink === 'stream') {
      this.streamSink = this.ctx.createMediaStreamDestination();
      sink = this.streamSink;
      try {
        this.recorder = new MediaRecorder(this.streamSink.stream);
        this.recordedBytes = 0;
        this.recorder.ondataavailable = (e) => {
          this.recordedBytes += e.data?.size || 0;
        };
        this.recorder.start(500);
      } catch (e) {
        this.emit('error', { message: `recorder: ${e.message}` });
      }
    } else {
      sink = this.ctx.destination;
    }

    // 播放侧的分析节点。语音视图的「在说」必须由**播放流**驱动(Q32 第二条),
    // 否则那条波形只是个动画,动不动与有没有出声无关 —— 而这条链路上
    // 「以为在说话其实没出声」正是最常见的失败。
    this.playbackAnalyser = this.ctx.createAnalyser();
    this.playbackAnalyser.fftSize = 1024;
    this._playbackBuf = new Float32Array(this.playbackAnalyser.fftSize);
    this.playbackAnalyser.connect(sink);

    this.player = new VoicePlayer(this.ctx, this.playbackAnalyser, (e) => this.onPlayerMessage(e));
  }

  /** 播放流的瞬时 RMS。语音视图「在说」那一态的波形驱动源。 */
  playbackLevel() {
    if (!this.playbackAnalyser) return 0;
    this.playbackAnalyser.getFloatTimeDomainData(this._playbackBuf);
    const b = this._playbackBuf;
    let sum = 0;
    for (let i = 0; i < b.length; i += 4) sum += b[i] * b[i];
    return Math.sqrt(sum / (b.length / 4));
  }

  onPlayerMessage(msg) {
    if (msg.type === 'diag') {
      this.emit('diag', msg);
      return;
    }
    if (msg.type === 'played') {
      this.played = msg.played;
      this.emit('spoke', { seq: msg.seq, played: msg.played });
    } else if (msg.type === 'muted') {
      this.played = msg.played;
      this.emit('barge-in', { played: msg.played });
    }
  }

  /** 让 daemon 说一段话。`text` 里可以带 `<speak>`,拆流在 daemon 侧。 */
  say(text, voice) {
    this.turnId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.played = 0;
    this.player?.reset();
    // 自动播放策略仍可能把 context 挂起;采集那条流通常已经解开了它,
    // 但 resume 是幂等的,便宜。
    this.ctx?.resume().catch(() => {});
    this.send('voice_say', {
      session_id: this.sessionId,
      turn_id: this.turnId,
      text,
      ...(voice ? { voice } : {}),
    });
    this.idle?.beginBusy(); // agent 在说话 / 在合成
    this.emit('turn-start', { turnId: this.turnId });
    return this.turnId;
  }

  /**
   * 补发远端取消。
   *
   * 音频已经在 VAD Worker 直连那一跳停掉了 —— 这里只是让 daemon 别再合成,
   * 并把**实际播出的句数**报上去,好写投递注记(ADR-0004)。
   */
  sendBargeIn() {
    const turnId = this.turnId;
    if (!turnId) return;
    this.turnId = null;
    this.send('voice_barge_in', {
      session_id: this.sessionId,
      turn_id: turnId,
      played: this.played,
    });
  }

  async playAudio(p) {
    if (!this.player) return;
    try {
      const bytes = Uint8Array.from(atob(p.wav), (c) => c.charCodeAt(0));
      const buf = await this.ctx.decodeAudioData(bytes.buffer);
      // 顺带断言音频不是静音 —— 「有字节」和「有声音」是两回事,
      // 而一条全是零的 WAV 在每一层看起来都正常。
      const ch = buf.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < ch.length; i += 16) sum += ch[i] * ch[i];
      const rms = Math.sqrt(sum / Math.ceil(ch.length / 16));
      this.emit('diag', {
        what: 'decoded',
        seq: p.seq,
        samples: ch.length,
        seconds: +buf.duration.toFixed(2),
        rms: +rms.toFixed(4),
        ctx: this.ctx.state,
      });
      this.player.enqueue(p.seq, buf);
    } catch (e) {
      this.emit('error', { message: `decode audio seq=${p.seq}: ${e.message}` });
    }
  }

  /** 把转写当作一条普通的用户消息提交。 */
  submitTranscript(text) {
    this.idle?.touch();
    this.send('chat_message', {
      session_id: this.sessionId,
      message_id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      content: text,
    });
    this.emit('submitted', { text });
  }

  // ------------------------------------------------------------- 传输

  send(type, payload) {
    browser.runtime
      .sendMessage({ type: 'bg:send_to_agent', payload: { type, payload } })
      .catch((e) => this.emit('error', { message: `send ${type}: ${e.message}` }));
  }

  onDaemonMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type.startsWith('voice_')) return this.onVoiceMessage(msg);
    if (!msg.type.startsWith('speech_')) return;
    const p = msg.payload || {};
    if (p.session_id && p.session_id !== this.sessionId) return;
    switch (msg.type) {
      case 'speech_partial':
        this.emit('partial', { text: p.text, bufferedMs: p.buffered_ms, utteranceId: p.utterance_id });
        break;
      case 'speech_final':
        // 只有通过闸门的才成为一轮用户输入。被拒的照样发给上层显示 ——
        // 静默丢弃会让用户看着波形动却什么都没发生。
        if (p.accepted && this.autoSubmit && (p.text || '').trim()) {
          this.submitTranscript(p.text);
        }
        this.emit('final', {
          text: p.text,
          language: p.language,
          audioEvent: p.audio_event,
          accepted: p.accepted,
          utteranceId: p.utterance_id,
        });
        break;
      case 'speech_error':
        this.emit('error', { message: p.message, utteranceId: p.utterance_id });
        break;
    }
  }

  onVoiceMessage(msg) {
    const p = msg.payload || {};
    if (p.session_id && p.session_id !== this.sessionId) return;
    // 上一轮的迟到音频不该在新一轮里响起来 —— 与上行的 utterance_id 纪律同理。
    if (p.turn_id && this.turnId && p.turn_id !== this.turnId) return;
    switch (msg.type) {
      case 'voice_audio':
        this.playAudio(p);
        break;
      case 'voice_done':
        this.idle?.endBusy();
        // 带上引擎与回落原因:对英文用户回落是换个音色,对中文用户是从有声
        // 变没声,所以这条不能只写进日志。
        this.emit('turn-done', {
          turnId: p.turn_id,
          spoken: p.spoken,
          engine: p.engine,
          engineReason: p.engine_reason,
        });
        break;
      case 'voice_failed':
        this.emit('error', { message: p.message, turnId: p.turn_id });
        break;
    }
  }
}
