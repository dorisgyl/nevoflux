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

/// 气泡本身。样式那边靠它把气泡藏起来。
const BUBBLES = '.message-list';
/// 消息区容器 —— 无论有没有消息都在。
///
/// 守卫要盯的是它,不是气泡:全新会话显示的是欢迎屏,`.message-list` 还不存在,
/// 而「这一刻没有气泡」与「类名改了」是两件完全不同的事。第一版盯错了元素,
/// 于是在空会话里打开语音视图会直接把视图关掉。
const MESSAGE_AREA = '.message-area';

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
const stat = { finals: 0, accepted: 0, submitted: 0, spoken: 0, error: '', engine: '', engineReason: '' };

/**
 * 用户有没有开语音视图(§5.2 的 `general.voiceView`)。
 *
 * 每次开语音时现读,而不是启动时读一次缓存:设置页可能正开着,而一个「要重启
 * 才生效」的开关,在用户看来就是不生效。
 */
async function voiceViewEnabled() {
  try {
    const res = await browser.runtime.sendMessage({ type: 'bg:get_settings', key: 'settings' });
    return res?.success === true && res.data?.general?.voiceView === true;
  } catch {
    return false;
  }
}

/** 开关语音视图。返回是否真的生效 —— 类名对不上时不能假装成功。 */
function setVoiceView(on) {
  const root = document.documentElement;
  if (!on) {
    delete root.dataset.nfVoiceView;
    return true;
  }
  root.dataset.nfVoiceView = 'on';
  // 样式规则挂在 Dioxus 那边的类名上,改名之后这里会静默变成「什么都没隐藏」
  // —— 波形铺在气泡上面,两层内容叠着而没人报错。说出来。
  return !!document.querySelector(MESSAGE_AREA);
}

/**
 * 麦克风是不是真的开着。
 *
 * `client` 有两种:麦克风模式,和只播不录的常驻听众。按钮问的是前者 ——
 * 拿 `!!client` 当答案会让侧栏一起来就显示「正在录音」,而麦克风根本没开。
 */
function micRunning() {
  return !!client && !client.playbackOnly;
}

/** 语音是否正在跑。按钮的视觉状态由 Dioxus 自己翻,这里是**真相**。 */
export function isActive() {
  return micRunning();
}

/** 计数快照。无人值守验证读它,人也可以在控制台读它。 */
export function stats() {
  const bubbles = document.querySelector(BUBBLES);
  return {
    ...stat,
    active: micRunning(),
    listening: !!client?.playbackOnly,
    state: view.state,
    played: client?.played ?? 0,
    voiceView: document.documentElement.dataset.nfVoiceView === 'on',
    // 三态而不是布尔:「还没有气泡」与「有气泡但没藏住」都会让布尔值是 false,
    // 而前者正常、后者是 bug。
    bubbles: !bubbles
      ? 'none'
      : getComputedStyle(bubbles).visibility === 'hidden'
        ? 'hidden'
        : 'visible',
  };
}

/**
 * 挂一个只播不录的听众,并让它一直待着。
 *
 * daemon 决定要不要把流出的回答逐句合成,看的是 `voice_mode`(server.rs 的
 * voice_tap)。侧栏常驻这个听众,回答才会出声;不挂的话文字照常,只是没有
 * 声音 —— 而且那条路径「发失败也只是没有声音」,不会有任何报错。
 *
 * 幂等:麦克风模式本身就带播放端,已经在跑就不用再挂。
 */
export async function startListening(opts = {}) {
  if (client) return client;
  const { SpeechClient } = await import(`${SPEECH_BASE}speech-client.js`);
  client = new SpeechClient({
    sessionId: opts.sessionId || window[SESSION_KEY] || '',
    // 听众是后台角色:不碰语音面板(那是麦克风模式的 UI),只把出了岔子的事
    // 说出来。
    onEvent: (e) => {
      if (e.type === 'error') {
        console.warn('[NevoFlux] 语音听众:', e.message);
        return;
      }
      // 引擎回落必须说出来。对英文用户这只是换了个音色,对中文用户是**从会说
      // 中文变成只会英文** —— 而这条帧以前只有麦克风模式那条路会读,听众这条
      // 路把它丢掉了,于是用户看到的只是「怎么突然全是英文」,没有任何线索。
      if (e.type === 'turn-done' && e.engineReason) {
        stat.engine = e.engine || '';
        stat.engineReason = e.engineReason;
        console.warn(
          `[NevoFlux] 语音已改用 ${e.engine === 'kokoro' ? 'Kokoro(仅英文)' : e.engine}:${e.engineReason}`,
        );
      }
    },
  });
  await client.start({ playbackOnly: true });
  bindSession();
  console.log(`[NevoFlux] 语音听众已挂上,会话 ${client.sessionId || '(等它出现)'}`);
  return client;
}

/**
 * 让听众绑在**当前**会话上,并在它变的那一刻跟过去。
 *
 * WASM 侧用 `Reflect::set` 把 session id 写进 window(context.rs),而
 * `Reflect.set` 会走访问器的 setter —— 换成带 setter 的属性,就能在 id 落地
 * 的那一刻改绑。
 *
 * 为什么不能轮询:发消息和写 window 读的是同一个 `ctx.session.read().id`
 * (text_input.rs:781 / context.rs:412),值本来就一样,差的只是时机。轮询慢
 * 一拍,那一回合查 voice_mode 就是 false,回答不出声且无任何报错 —— 实测就是
 * 这么失败的。
 */
const SESSION_KEY = '__nevoflux_session_id';
let sessionHooked = false;
function bindSession() {
  client?.setSession(window[SESSION_KEY] || '');
  if (sessionHooked) return;
  let current = window[SESSION_KEY];
  try {
    Object.defineProperty(window, SESSION_KEY, {
      configurable: true,
      get: () => current,
      set: (v) => {
        current = v;
        if (client?.playbackOnly && client.setSession(v || '')) {
          console.log(`[NevoFlux] 语音听众改绑到会话 ${client.sessionId}`);
        }
      },
    });
    sessionHooked = true;
  } catch (e) {
    console.warn('[NevoFlux] 会话钩子没装上,回答可能不会出声:', e.message);
  }
}

/** 把听众换下来。只动听众,麦克风模式请走 stopVoice。 */
async function stopListening() {
  if (!client?.playbackOnly) return;
  const l = client;
  client = null;
  await l.stop().catch(() => {});
}

/** 用一次真实用户手势解开自动播放闸门。幂等。 */
export function resumeAudio() {
  return client?.resumeAudio();
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
      // 空档要说出来。这是「不流畅」唯一可比较的形式:第几句、断了多久、
      // 这一轮断了几次。没有它,合成端的 rtf 和用户听到的断续之间没有桥。
      if (e.what === 'underrun') {
        stat.underruns = e.total;
        stat.lastGap = e.gap;
        console.warn(`[NevoFlux] 语音空档 ${e.gap}s(第 ${e.seq} 句,本轮第 ${e.total} 次)`);
      }
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
      setVoiceView(false);
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
  // 听众占着 client,但它没有麦克风。不先换下来的话,这里会把一个只会播放的
  // 实例返回给「开始说话」,表现是点了麦克风却永远收不到音。
  await stopListening();
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
    // 视图开关在链路起来之前定,免得先看见气泡再被换掉。
    const wantView = opts.voiceView ?? (await voiceViewEnabled());
    if (wantView && !setVoiceView(true)) {
      say('语音视图未生效:找不到消息区(界面结构变了)', true);
    }
    

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
  setVoiceView(false);
  setState('idle');
  if (ui) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (!micRunning() && ui) {
        ui.root.hidden = true;
        say('');
      }
    }, 2500);
  }
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  // 麦克风关了,听众要留着 —— 否则用过一次语音之后回答就再也不出声,
  // 而这不会有任何报错。
  startListening().catch(() => {});
}
