// P2 门的验证台:说话 → 文字。
//
// 只做三件事:起一个 SpeechClient、把事件画到屏幕上、把结果同时打进 console
// (扩展页的 console 会被 `npm run start` 的 stdout 捕获,于是结果可以直接从
// 日志文件读,不必人工转抄)。

import { SpeechClient } from './speech-client.js';
import { createRenderer, visibleExtras, presentationFor } from './voice-renderer.js';

const $ = (id) => document.getElementById(id);
const log = (msg, cls = '') => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  $('log').prepend(d);
  console.log('[P2]', msg);
};

// 复用这个窗口的 session,好让转写落在同一条 history 上;拿不到就用一次性的。
const sessionId =
  window.__nevoflux_session_id || `p2_${Date.now().toString(36)}`;
$('sid').textContent = sessionId;

let client = null;
let levelTick = 0;

// ---------------------------------------------------------------- 语音视图
//
// 波形替代 markdown 气泡(Q29)。这里只做两件事:把链路的事件映射成五个状态,
// 把两条**真实**的电平接上去 —— 「在听」用 VAD 报的麦克风 RMS,「在说」用播放
// 分析节点的 RMS。后者是关键:如果波形自己动自己的,它就无法回答「到底有没有
// 出声」,而那正是这条链路最常见的失败。

const wave = $('wave');
const wctx = wave.getContext('2d');
// 从**页面上的**元素读主题变量 —— canvas 的 strokeStyle 不解析 var(),
// 必须先解析成字面量。离屏元素读不到变量,会静默退回兜底色。
const readVar = (n) => getComputedStyle(wave).getPropertyValue(n);
const renderer = createRenderer('waveform', { readVar });

const view = {
  state: 'idle',
  mode: 'hands-free',
  mic: 0,
  partial: '',
  tool: '',
  artifact: '',
  structural: '',
  speakingPeak: 0,
  quiet: 0,
  turnDone: false,
};

function setState(next) {
  if (view.state === next) return;
  view.state = next;
  $('waveState').textContent = next;
  $('waveCaption').textContent = presentationFor(next, view.mode).caption;
}

function renderExtras() {
  const slots = visibleExtras(view);
  const box = $('extras');
  box.textContent = '';
  for (const s of slots) {
    const d = document.createElement('div');
    d.className = `slot ${s.kind}`;
    if (s.kind === 'partial') d.textContent = s.text;
    else if (s.kind === 'tool') d.innerHTML = `<b>${s.name}</b> 执行中…`;
    else if (s.kind === 'artifact') d.innerHTML = `📄 <b>${s.name}</b>`;
    else d.textContent = s.preview;
    box.appendChild(d);
  }
}

let tick = 0;
function frame() {
  tick++;
  // Q32 第二条:驱动源随状态切换。
  const src = presentationFor(view.state).source;
  const raw = src === 'playback' ? (client?.playbackLevel() ?? 0) : src === 'microphone' ? view.mic : 0;
  if (view.state === 'speaking') view.speakingPeak = Math.max(view.speakingPeak, raw);

  // 播完之后回到「在听」。用**播放流安静了**来判断,而不是 turn-done ——
  // daemon 说「推完了」的时候,最后一句通常还在放。
  if (view.turnDone && view.state === 'speaking') {
    view.quiet = raw < 0.002 ? view.quiet + 1 : 0;
    if (view.quiet > 30) { view.turnDone = false; view.quiet = 0; setState('listening'); }
  }

  renderer.draw(wctx, {
    state: view.state,
    mode: view.mode,
    amplitude: Math.min(1, raw * 8),
    width: wave.width,
    height: wave.height,
    tick,
  });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

$('voiceMode').onchange = (e) => {
  view.mode = e.target.value;
  $('waveCaption').textContent = presentationFor(view.state, view.mode).caption;
};

$('sampleStructural').onchange = (e) => {
  // 示例内容,不是链路产物 —— 这一格存在的意义是「本质不可朗读的东西必须能被看到」。
  view.structural = e.target.checked
    ? '| 时段     | 状态 |\n|----------|------|\n| 09:00-17:00 | 开放 |'
    : '';
  renderExtras();
};

function onEvent(e) {
  switch (e.type) {
    case 'starting':
      $('state').textContent = '加载 VAD…';
      break;
    case 'ready':
      $('state').textContent = '在听';
      setState('listening');
      log(`VAD 就绪(${e.loadMs.toFixed(0)} ms)—— 现在说话`, 'ok');
      break;
    case 'level':
      // 每 8 帧画一次就够,不然主线程全在改 DOM。
      view.mic = e.rms ?? 0;
      if (levelTick++ % 8 === 0) {
        $('p').textContent = e.p.toFixed(3);
        $('pBar').style.width = `${Math.round(e.p * 100)}%`;
      }
      break;
    case 'utterance-start':
      setState('listening');
      $('state').textContent = '录音中';
      $('partial').textContent = '…';
      log(`utterance 开始 ${e.utteranceId}`);
      break;
    case 'utterance-end':
      // 「在转写」是冻结的波形:它是「在听」的延续,不是一件新事。
      setState(e.cancelled ? 'listening' : 'transcribing');
      $('state').textContent = e.cancelled ? '已取消' : '转写中';
      log(`utterance 结束 ${e.utteranceId}${e.cancelled ? '(取消)' : ''}`);
      break;
    case 'partial':
      view.partial = e.text || '';
      renderExtras();
      $('partial').textContent = e.text || '…';
      log(`partial(${e.bufferedMs} ms):${e.text}`);
      break;
    case 'final': {
      view.partial = '';
      renderExtras();
      setState('listening');
      $('state').textContent = '在听';
      $('partial').textContent = '—';
      const li = document.createElement('li');
      li.innerHTML =
        `<b>${e.text || '(空)'}</b>` +
        `<span class="meta">${e.language} · ${e.audioEvent || 'no-tag'} · ` +
        `${e.accepted ? '<span class="ok">accepted</span>' : '<span class="warn">rejected</span>'}</span>`;
      $('finals').prepend(li);
      log(`final:${e.text}  [${e.language}/${e.audioEvent}/${e.accepted ? 'accepted' : 'rejected'}]`,
          e.accepted ? 'ok' : 'warn');
      console.log('[P2-FINAL]', JSON.stringify(e));
      break;
    }
    case 'warning':
      log(e.message, 'warn');
      break;
    case 'error':
      log(`错误:${e.message}`, 'bad');
      break;
    case 'submitted':
      log(`已作为一轮用户输入提交:${e.text}`, 'ok');
      break;
    case 'idle-exit':
      log(`静默退出(${e.reason === 'max' ? '达到绝对上限' : '无交互超时'})`, 'warn');
      break;
    case 'turn-start':
      // 合成期间是「在执行」:有事在做但还没有声音,与「在听」必须一眼可辨。
      setState('thinking');
      view.speakingPeak = 0;
      view.turnDone = false;
      $('turnState').textContent = '合成中…';
      log(`turn 开始 ${e.turnId}`);
      break;
    case 'spoke':
      $('turnState').textContent = `已播 ${e.played} 句`;
      log(`播完第 ${e.seq} 句(累计 ${e.played})`);
      break;
    case 'turn-done':
      view.turnDone = true;
      $('turnState').textContent = `完成,推了 ${e.spoken} 句`;
      log(`turn 结束,daemon 推了 ${e.spoken} 句`, 'ok');
      break;
    case 'barge-in':
      view.turnDone = false;
      setState('listening');
      $('turnState').textContent = `被打断(实播 ${e.played} 句)`;
      log(`打断:音频已停,实际播出 ${e.played} 句 —— 投递注记按这个数`, 'warn');
      break;
    case 'step':
      log(`步骤 ${e.at}${e.ctx ? ` ctx=${e.ctx} sr=${e.sr}` : ''}`);
      break;
    case 'diag':
      // 排期成功 = 音频真的进了图。这是「在说」的起点,比 turn-done 早得多。
      if (e.what === 'scheduled') setState('speaking');
      log(`诊断 ${e.what}: ${JSON.stringify(e)}`, 'warn');
      break;
    case 'file-ended':
      log('音频文件播放完毕 —— 端点静音 700 ms 后应落 final');
      break;
    case 'stopped':
      setState('idle');
      $('state').textContent = '已停止';
      log('已停止');
      break;
  }
}

$('start').onclick = async () => {
  $('start').disabled = true;
  try {
    client = new SpeechClient({ sessionId, onEvent, autoSubmit: $('autoSubmit').checked });
    const src = $('source').value;
    await client.start(src === 'mic' ? {} : { fileUrl: new URL(src, import.meta.url).href });
    $('stop').disabled = false;
    $('say').disabled = false;
    client.setBargeIn($('bargeIn').checked);
  } catch (e) {
    log(`启动失败:${e.message}`, 'bad');
    $('start').disabled = false;
  }
};

$('bargeIn').onchange = (e) => {
  client?.setBargeIn(e.target.checked);
  log(`打断${e.target.checked ? '开启' : '关闭'}`);
};

$('say').onclick = () => {
  client?.say($('sayText').value);
};

$('stop').onclick = async () => {
  $('stop').disabled = true;
  await client?.stop();
  client = null;
  $('start').disabled = false;
  $('say').disabled = true;
};

// 语音视图的无人验收。
//
// 「好不好看」测不了,但 Q32 的约束是像素级可判的:五个状态**必须**画出不同的
// 颜色、冻结态**必须**真的不动、活动态**必须**真的在动。这三条正是最容易被
// 悄悄破坏的部分 —— 比如 canvas 拿到一个 `var(--x)` 后笔色停在默认黑,界面上
// 五个状态长得一模一样,而没有任何报错。
function sweepRenderer() {
  const off = document.createElement('canvas');
  off.width = wave.width;
  off.height = wave.height;
  const c = off.getContext('2d', { willReadFrequently: true });
  // 取色器绑在**页面上的** canvas 上:离屏元素读不到 CSS 变量。
  const r = createRenderer('waveform', { readVar });

  const dominant = () => {
    const d = c.getImageData(0, 0, off.width, off.height).data;
    const count = new Map();
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      ink++;
      const k = `#${d[i].toString(16).padStart(2, '0')}${d[i + 1].toString(16).padStart(2, '0')}${d[i + 2].toString(16).padStart(2, '0')}`;
      count.set(k, (count.get(k) || 0) + 1);
    }
    let best = null;
    let n = 0;
    for (const [k, v] of count) if (v > n) { best = k; n = v; }
    return { color: best, ink };
  };

  const settle = (state, amp, tick) => {
    // 平滑是有状态的:不settle 就在比较「上一态残留的振幅」。
    for (let i = 0; i < 80; i++) {
      r.draw(c, { state, mode: 'hands-free', amplitude: amp, width: off.width, height: off.height, tick });
    }
    return dominant();
  };

  const colors = {};
  let blank = [];
  for (const st of ['idle', 'listening', 'transcribing', 'thinking', 'speaking']) {
    const got = settle(st, 0.8, 5);
    colors[st] = got.color;
    if (!got.ink) blank.push(st);
  }

  // 冻结:同一态、不同 tick,像素必须逐字节相同。
  settle('transcribing', 0.8, 5);
  const a = c.getImageData(0, 0, off.width, off.height).data;
  r.draw(c, { state: 'transcribing', mode: 'hands-free', amplitude: 0.8, width: off.width, height: off.height, tick: 40 });
  const b = c.getImageData(0, 0, off.width, off.height).data;
  let frozen = true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { frozen = false; break; }

  // 活动:同一态、不同 tick,像素必须**不**同 —— 否则「在听」看起来是死的。
  settle('listening', 0.8, 5);
  const c1 = c.getImageData(0, 0, off.width, off.height).data;
  r.draw(c, { state: 'listening', mode: 'hands-free', amplitude: 0.8, width: off.width, height: off.height, tick: 12 });
  const c2 = c.getImageData(0, 0, off.width, off.height).data;
  let moving = false;
  for (let i = 0; i < c1.length; i++) if (c1[i] !== c2[i]) { moving = true; break; }

  const distinct =
    colors.listening !== colors.speaking &&
    colors.speaking !== colors.thinking &&
    colors.listening !== colors.thinking;

  // 主题变量真的被读到了 —— 兜底色与页面变量在浅色主题下同值,所以额外
  // 断言取到的不是黑(那是 strokeStyle 赋值被丢弃后的样子)。
  const themed = readVar('--nevo-voice-speaking').trim();
  const usesTheme = !!themed && colors.speaking === themed.toLowerCase();

  return { colors, distinct, frozen, moving, blank, usesTheme, themed };
}

log('就绪。点「开始收音」。');

// 自动跑一遍(`?autotest=1`)。
//
// 这条链路要在**没有人点按钮**的机器上被验证。手动验证在服务器上等于不可验证,
// 而「等别人跑一次」不是一种验证手段。
//
// 麦克风模式:本机采集设备是静音的 null-sink monitor,所以 VAD 不会误触发;
// 打断关掉,免得播放出去的 TTS 被同一个 monitor 听回来把自己掐掉。
(async () => {
  const params = new URLSearchParams(location.search);
  if (!params.has('autotest')) return;

  const text = params.get('text') ||
    '<speak>Opening hours are nine to five. Anything else?</speak>The opening hours are 9am to 5pm.';
  log('AUTOTEST 开始', 'warn');
  try {
    // 文件声源,不是麦克风:`getUserMedia` 在没有用户手势时**既不 resolve
    // 也不 reject**(实测),即使权限已预置。生产里用户会点按钮,自动验证
    // 里没有人点 —— 而这条链路测的是转写与播放,不是授权。
    $('bargeIn').checked = false;
    $('source').value = 'fixtures/zh.wav';
    client = new SpeechClient({ sessionId, onEvent });
    await client.start({
      fileUrl: new URL('fixtures/zh.wav', import.meta.url).href,
      sink: params.get('sink') || 'stream',
    });
    client.setBargeIn(false);

    // 等 VAD 就绪 —— 它是 `say` 之前唯一的前置。
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('VAD 就绪超时')), 15000);
      const tick = setInterval(() => {
        if ($('state').textContent === '在听') {
          clearInterval(tick); clearTimeout(t); res();
        }
      }, 100);
    });

    log(`AUTOTEST ctx=${client.ctx.state} sr=${client.ctx.sampleRate}`, 'warn');
    client.say(text);

    // 给合成 + 播放留出时间,然后把结果一次性汇报。
    await new Promise((r) => setTimeout(r, 25000));
    const renderCheck = sweepRenderer();
    const verdict = {
      played: client.played,
      turnId: client.turnId,
      ctx: client.ctx?.state,
      recordedBytes: client.recordedBytes ?? null,
      // 「在说」那一态的波形是否真的被播放流驱动过。0 意味着画面在动而没有声音。
      speakingPeak: +view.speakingPeak.toFixed(4),
      reachedSpeaking: view.speakingPeak > 0,
      renderer: renderCheck,
    };
    log(`AUTOTEST 结束 ${JSON.stringify(verdict)}`, verdict.played > 0 ? 'ok' : 'bad');
    console.log('[P3-RENDER]', JSON.stringify(renderCheck));
    console.log('[P2-AUTOTEST]', JSON.stringify(verdict));
  } catch (e) {
    log(`AUTOTEST 失败:${e.message}`, 'bad');
    console.log('[P2-AUTOTEST]', JSON.stringify({ error: e.message }));
  }
})();
