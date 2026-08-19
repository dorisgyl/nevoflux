/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * 侧边栏的语音接线。
 *
 * `lib/speech/` 那套(采集 + VAD + 上行 + 播放 + 语音视图渲染器)本身与界面无关;
 * 这个文件负责把它接到**真正的入口**上:输入框旁边那个麦克风按钮。
 *
 * 三件事,别的都不做:
 *   1. 起停 SpeechClient,session 用侧边栏当前这条 —— 语音输入因此是一条普通的
 *      用户消息,同 history、工具照调,daemon 侧一个特例都没有。
 *   2. 把五个状态画成一条波形(Q29/Q32 的渲染器),外加 partial 一行。
 *   3. 出错时把话说出来。语音链路的失败大多是**静默**的(没声音、没报错),
 *      所以「什么都没发生」必须变成一行字。
 *
 * 按需加载:侧边栏绝大多数会话不开语音,而 ORT + Silero 是几 MB 的资产。
 */

const SPEECH_BASE = '../../lib/speech/';

let client = null;
/**
 * 我们自己开的麦克风流。
 *
 * 授权在点击处理器里发起(见 sidebar-boot.js),所以流是**这一侧**开的,
 * SpeechClient 只是借用 —— 它不会去关别人的流。开的人负责关:忘了关的后果不是
 * 报错,是麦克风一直亮着,而那是这个功能里最不能出的错。
 */
let ownedStream = null;
let ui = null;
let renderer = null;
let rafId = 0;
let statusTimer = 0;

const view = {
  state: 'idle',
  mode: 'tap-to-talk',
  mic: 0,
  partial: '',
};

/** 只用于诊断:这条链路的失败大多是静默的,没有计数就只能靠「感觉没反应」。 */
const stat = { finals: 0, accepted: 0, submitted: 0, spoken: 0, error: '' };

/** 语音是否正在跑。按钮的视觉状态由 Dioxus 自己翻,这里是**真相**。 */
export function isActive() {
  return !!client;
}

/** 计数快照。无人值守验证读它,人也可以在控制台读它。 */
export function stats() {
  return { ...stat, active: !!client, state: view.state, played: client?.played ?? 0 };
}

/** 让 agent 念一段话。`<speak>` 拆流在 daemon 侧。 */
export function speak(text) {
  return client ? client.say(text) : null;
}

function buildUi() {
  if (ui) return ui;
  const root = document.createElement('div');
  root.className = 'nf-voice';
  root.hidden = true;

  const canvas = document.createElement('canvas');
  canvas.className = 'nf-voice-wave';
  canvas.height = 34;

  const line = document.createElement('div');
  line.className = 'nf-voice-line';
  const dot = document.createElement('span');
  dot.className = 'nf-voice-dot';
  const label = document.createElement('span');
  label.className = 'nf-voice-label';
  line.append(dot, label);

  const partial = document.createElement('div');
  partial.className = 'nf-voice-partial';

  root.append(canvas, line, partial);
  // 挂在 body 上,不进 #main:Dioxus 只管 #main,插进去的节点会在下一次 diff
  // 时被移走 —— 症状是「有时候能看见,有时候看不见」。
  document.body.appendChild(root);

  ui = { root, canvas, ctx2d: canvas.getContext('2d'), dot, label, partial };
  return ui;
}

function resizeCanvas() {
  if (!ui) return;
  const w = Math.max(1, Math.floor(ui.canvas.clientWidth));
  if (ui.canvas.width !== w) ui.canvas.width = w;
}

/** 状态说明。语音条上只有一行字的位置,所以它说的是「现在轮到谁」。 */
const LABELS = {
  idle: '语音已开,按住说话',
  listening: '在听…',
  transcribing: '转写中…',
  thinking: '在处理…',
  speaking: '在回答(说话可打断)',
};

async function loadRenderer() {
  const mod = await import(`${SPEECH_BASE}voice-renderer.js`);
  const readVar = (n) => getComputedStyle(ui.root).getPropertyValue(n);
  renderer = { mod, inst: mod.createRenderer('waveform', { readVar }) };
}

function setState(next) {
  if (view.state === next) return;
  view.state = next;
  if (!ui || !renderer) return;
  ui.label.textContent = LABELS[next] || '';
  // 圆点与波形同色 —— 波形在余光里,圆点在视线里,两处必须指向同一件事。
  ui.dot.style.color = renderer.mod.resolveColor(next, (n) =>
    getComputedStyle(ui.root).getPropertyValue(n));
}

let tick = 0;
function frame() {
  tick++;
  if (ui && renderer) {
    resizeCanvas();
    const src = renderer.mod.presentationFor(view.state).source;
    const raw =
      src === 'playback' ? (client?.playbackLevel?.() ?? 0) :
      src === 'microphone' ? view.mic : 0;
    renderer.inst.draw(ui.ctx2d, {
      state: view.state,
      mode: view.mode,
      amplitude: Math.min(1, raw * 8),
      width: ui.canvas.width,
      height: ui.canvas.height,
      tick,
    });
  }
  rafId = requestAnimationFrame(frame);
}

/** 关掉自己开的麦克风。幂等 —— 正常停止与静默超时都会走到它。 */
function releaseStream() {
  if (!ownedStream) return;
  try {
    ownedStream.getTracks().forEach((t) => t.stop());
  } catch {
    /* 轨道可能已经结束了 */
  }
  ownedStream = null;
}

function say(text, isError) {
  if (!ui) return;
  ui.partial.textContent = text;
  ui.partial.classList.toggle('nf-voice-error', !!isError);
}

function onEvent(e, onStopped) {
  switch (e.type) {
    case 'ready':
      setState('listening');
      break;
    case 'level':
      view.mic = e.rms ?? 0;
      break;
    case 'utterance-start':
      setState('listening');
      break;
    case 'utterance-end':
      setState(e.cancelled ? 'listening' : 'transcribing');
      break;
    case 'partial':
      say(e.text || '');
      break;
    case 'final':
      stat.finals++;
      if (e.accepted) stat.accepted++;
      // 被闸门挡下的转写(纯噪声、纯 BGM)不该悄悄消失 —— 用户说了话,
      // 界面上什么都不动是最让人不确定的反馈。
      say(e.accepted ? e.text : `(未采纳:${e.audioEvent || '判为非语音'})`);
      setState(e.accepted ? 'thinking' : 'listening');
      break;
    case 'submitted':
      stat.submitted++;
      setState('thinking');
      break;
    case 'spoke':
      stat.spoken = e.played;
      break;
    case 'diag':
      if (e.what === 'scheduled') setState('speaking');
      break;
    case 'turn-done':
      // 只有回落时才有原因。有的话就说出来 —— 否则用户听到的是英文腔的中文,
      // 或者干脆没声音,而界面上一切正常。
      if (e.engineReason) {
        stat.engine = e.engine || '';
        say(`已改用${e.engine === 'kokoro' ? 'Kokoro(仅英文)' : e.engine}:${e.engineReason}`, true);
      }
      break;
    case 'barge-in':
      setState('listening');
      break;
    case 'idle-exit':
      say(e.reason === 'max' ? '语音已自动关闭(达到时长上限)' : '语音已自动关闭(长时间无交互)');
      break;
    case 'error':
      stat.error = e.message;
      // The daemon's "model not found" already names where to get it; anything
      // else is shown as-is. Rewriting arbitrary errors into a friendlier
      // sentence is how the one detail that identifies the problem gets lost.
      say(e.message, true);
      break;
    case 'stopped':
      // 客户端也可能是**自己**停的(Q45 静默超时、启动失败),那条路不经过
      // stopVoice(),所以释放必须挂在这里而不是只挂在停止按钮上。
      client = null;
      releaseStream();
      setState('idle');
      onStopped?.();
      break;
  }
}

/**
 * 起。
 *
 * @param {object} opts
 * @param {MediaStream} [opts.stream] **在点击处理器里同步发起**的麦克风流。
 *   授权受用户手势约束,而手势活不过启动过程里那串 await —— 所以流由调用方开,
 *   这里只接。
 * @param {string} [opts.fileUrl] 用音频文件代替麦克风(无人值守验证用)。
 * @param {() => void} [opts.onStopped] 语音自行停止时(静默超时、失败)回调,
 *   用来把按钮的视觉状态掰回来。
 */
export async function startVoice(opts = {}) {
  if (client) return client;
  buildUi();
  ui.root.hidden = false;
  say('正在加载语音模型…');

  try {
    if (!renderer) await loadRenderer();
    setState('idle');
    if (!rafId) rafId = requestAnimationFrame(frame);

    const { SpeechClient } = await import(`${SPEECH_BASE}speech-client.js`);
    const sessionId = opts.sessionId || window.__nevoflux_session_id || '';
    client = new SpeechClient({
      sessionId,
      // 侧边栏里说的话就是提问 —— 这正是「接进侧边栏」与 demo 的区别:
      // demo 验证链路,这里要的是一轮真的对话。
      autoSubmit: true,
      onEvent: (e) => onEvent(e, opts.onStopped),
    });
    ownedStream = opts.stream || null;
    await client.start(
      opts.fileUrl ? { fileUrl: opts.fileUrl, sink: opts.sink } : { stream: opts.stream },
    );
    return client;
  } catch (e) {
    say(`语音启动失败:${e && e.message ? e.message : e}`, true);
    // 浏览器侧的资产(ORT / silero)随扩展一起打包,缺失只可能发生在开发树里;
    // daemon 侧的 ASR 权重则是用户要下的那份,由「设置 → 语音模型」负责。
    // 两种缺失的补法不同,所以报错也不能混成一句。
    if (String(e).includes('backend') || String(e).includes('fetch')) {
      say('语音启动失败:浏览器侧语音资产未就绪(开发树:scripts/fetch-speech-assets.sh)', true);
    }
    await stopVoice();
    opts.onStopped?.();
    throw e;
  }
}

/** 停。UI 留在屏幕上一小会儿,好让最后一行提示被看见。 */
export async function stopVoice() {
  const c = client;
  client = null;
  try {
    await c?.stop();
  } catch {
    /* 已经停了 */
  }
  releaseStream();
  setState('idle');
  if (ui) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (!client && ui) {
        ui.root.hidden = true;
        say('');
      }
    }, 2500);
  }
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}
