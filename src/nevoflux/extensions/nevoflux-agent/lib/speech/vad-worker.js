// P0-b harness — Silero VAD in a dedicated module Worker.
//
// Everything here is written to answer one question: can onnxruntime-web run
// Silero inside a moz-extension page's CSP, off the main thread, fast enough
// to make browser-side barge-in real? The constraints being probed:
//
//   - CSP is `script-src 'self' 'wasm-unsafe-eval'`; `worker-src` is not
//     declared, so it falls back to `script-src 'self'` and a blob: Worker
//     would be blocked. This file is loaded from a real file URL.
//   - moz-extension pages get no COOP/COEP, so there is no SharedArrayBuffer
//     and ORT must run single-threaded.
//   - `URL.createObjectURL` is patched below purely as a tripwire: if ORT
//     reaches for a blob worker anyway, we want that in the report rather
//     than as a mystery CSP error.

let blobUrlCalls = 0;
const realCreateObjectURL = URL.createObjectURL?.bind(URL);
if (realCreateObjectURL) {
  URL.createObjectURL = (obj) => {
    blobUrlCalls++;
    return realCreateObjectURL(obj);
  };
}

import * as ort from './ort/ort.wasm.bundle.min.mjs';

const WINDOW = 512;
const CONTEXT = 64;
const SR = 16000;

let session = null;
let state = new Float32Array(2 * 1 * 128);
let context = new Float32Array(CONTEXT);
const input = new Float32Array(CONTEXT + WINDOW);

// Tunables the harness drives from the UI.
let threshold = 0.5;
let sustainMs = 200;   // the Q46 barge-in gate

/**
 * 端点静音:连续多久低于阈值才算「说完了」。
 *
 * 这是上行链路与 barge-in 最大的差别。barge-in 要的是**快**(用户一开口就静音
 * TTS),端点要的是**别抢答**。`VadOptions::default()` 的 `min_silence_ms = 100`
 * 是给离线切分调的 —— 切碎了还有 `stitch.rs` 缝回去;在线用它,意味着用户每次
 * 组织语言停顿一下,系统就判定他说完了。
 *
 * 700 ms:低于 500 会切断思考停顿,高于 1000 会显得迟钝。中英混说的技术对话
 * 停顿比日常闲聊多,偏保守更稳。
 */
let endpointSilenceMs = 700;
let silenceMs = 0;     // 当前连续静音累计

let directPort = null; // path B: straight to the player worklet
let framePort = null;  // frames arriving straight from the capture worklet
let framesSeen = 0;    // total, unlike the 500-deep inference-time window
// Which route the mute takes. The direct port must be *suppressed* in mode A,
// not merely supplemented — it always wins the race otherwise, and mode A
// silently measures mode B.
let pathMode = 'B';

const inferMs = [];
let speaking = false;
let runStart = 0;   // audio-clock time of the first frame over threshold
let runMs = 0;      // sustained-speech accumulator
let fired = false;

// Firefox's `error.stack` carries frames but not the message, so anything
// that reports only `.stack` throws away the half that says what went wrong.
function describe(err) {
  if (!err) return 'undefined error';
  const parts = [];
  if (err.name) parts.push(err.name);
  if (err.message) parts.push(err.message);
  let out = parts.join(': ') || String(err);
  if (err.cause) out += `\n  cause: ${describe(err.cause)}`;
  if (err.stack) out += `\n  at ${String(err.stack).split('\n')[0]}`;
  return out;
}

// Fetch each asset ourselves before handing the job to ORT. When ORT fails
// to come up, the first thing worth knowing is whether the bytes were even
// reachable and served as the right type — that distinguishes a CSP/packaging
// problem from a runtime one, and the two have nothing to do with each other.
async function preflight(url) {
  try {
    const r = await fetch(url);
    const buf = r.ok ? await r.arrayBuffer() : null;
    return {
      url,
      ok: r.ok,
      status: r.status,
      type: r.headers.get('content-type'),
      bytes: buf ? buf.byteLength : 0,
    };
  } catch (e) {
    return { url, ok: false, error: describe(e) };
  }
}

async function init(msg) {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.simd = true;
  const wasmDir = new URL('./ort/', import.meta.url).href;
  ort.env.wasm.wasmPaths = wasmDir;

  const checks = await Promise.all([
    preflight(wasmDir + 'ort-wasm-simd-threaded.wasm'),
    preflight(msg.modelUrl),
  ]);
  postMessage({ type: 'preflight', checks });

  const t0 = performance.now();
  session = await ort.InferenceSession.create(msg.modelUrl, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  const loadMs = performance.now() - t0;

  postMessage({
    type: 'ready',
    loadMs,
    ortVersion: ort.env.versions?.web ?? 'unknown',
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    // `crossOriginIsolated` is what would license SAB use; SAB merely
    // existing as a constructor is not the same permission.
    crossOriginIsolated: self.crossOriginIsolated === true,
    numThreads: ort.env.wasm.numThreads,
    proxy: ort.env.wasm.proxy,
    blobUrlCalls,
    inputNames: session.inputNames,
    outputNames: session.outputNames,
  });
}

async function infer(frame) {
  input.set(context, 0);
  input.set(frame, CONTEXT);

  const feeds = {
    input: new ort.Tensor('float32', input.slice(), [1, CONTEXT + WINDOW]),
    state: new ort.Tensor('float32', state.slice(), [2, 1, 128]),
    sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(SR)]), []),
  };

  const t0 = performance.now();
  const out = await session.run(feeds);
  const dt = performance.now() - t0;

  state = Float32Array.from(out.stateN.data);
  // Context is the tail of what was just fed, exactly as the Rust path does.
  context = input.slice(input.length - CONTEXT);
  return { prob: out.output.data[0], dt };
}

async function onFrame(msg) {
  if (!session) return;
  framesSeen++;

  // 幅度必须在这里算:回声探测的判据要把「房间本来就吵」和「扬声器被听回去」
  // 分开,而概率本身分不开 —— 清晰的环境人声和清晰的回声都是高概率。
  // 帧在推理时会被拷进 `input`,所以先算。
  let sum = 0;
  for (let i = 0; i < msg.frame.length; i++) sum += msg.frame[i] * msg.frame[i];
  const rms = Math.sqrt(sum / msg.frame.length);

  const { prob, dt } = await infer(msg.frame);
  inferMs.push(dt);
  if (inferMs.length > 500) inferMs.shift();

  const frameMs = (WINDOW / SR) * 1000;
  const over = prob >= threshold;

  if (over) {
    if (runMs === 0) runStart = msg.t;
    runMs += frameMs;
    silenceMs = 0;
  } else {
    runMs = 0;
    silenceMs += frameMs;
    // 只有连续静音够久才算端点。句内停顿会被这条吃掉,而那正是它的目的。
    if (speaking && silenceMs >= endpointSilenceMs) {
      speaking = false;
      fired = false;
      postMessage({ type: 'speech-end', t: msg.t, silenceMs });
      silenceMs = 0;
    }
  }

  if (!fired && runMs >= sustainMs) {
    fired = true;
    speaking = true;
    const tag = String(msg.index);
    if (directPort && pathMode === 'B') {
      directPort.postMessage({ type: 'mute', tag });
    }
    postMessage({
      type: 'barge-in',
      // Audio-clock time of the first frame of the sustained run — the
      // honest origin for latency, not the moment the gate finally elapsed.
      speechStart: runStart,
      // Everything on this line is seconds, because `msg.t` is. Adding a
      // millisecond quantity here is what put 32 s into the gate column.
      confirmedAt: msg.t + frameMs / 1000,
      prob,
      tag,
    });
  }

  postMessage({ type: 'prob', prob, rms, t: msg.t, index: msg.index });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await init(msg);
        break;
      case 'frame':
        await onFrame(msg);
        break;
      case 'attach-direct':
        directPort = msg.port;
        directPort.start?.();
        break;
      case 'attach-frames':
        // Frames bypassing the main thread land here. Same handler, so the
        // two routes are identical past this point and the comparison is
        // about delivery only.
        framePort = msg.port;
        framePort.onmessage = (ev) => {
          onFrame(ev.data).catch((err) =>
            postMessage({ type: 'error', where: 'frame(direct)', message: describe(err) })
          );
        };
        framePort.start?.();
        break;
      case 'config':
        if (msg.threshold != null) threshold = msg.threshold;
        if (msg.sustainMs != null) sustainMs = msg.sustainMs;
        if (msg.endpointSilenceMs != null) endpointSilenceMs = msg.endpointSilenceMs;
        if (msg.pathMode != null) pathMode = msg.pathMode;
        break;
      case 'reset':
        state = new Float32Array(2 * 1 * 128);
        context = new Float32Array(CONTEXT);
        runMs = 0;
        silenceMs = 0;
        speaking = false;
        fired = false;
        break;
      case 'stats': {
        const s = [...inferMs].sort((a, b) => a - b);
        postMessage({
          type: 'stats',
          framesSeen,
          n: s.length,
          p50: s[Math.floor(s.length * 0.5)] ?? 0,
          p95: s[Math.floor(s.length * 0.95)] ?? 0,
          max: s[s.length - 1] ?? 0,
          blobUrlCalls,
        });
        break;
      }
    }
  } catch (err) {
    postMessage({ type: 'error', where: msg.type, message: describe(err) });
  }
};
