// 语音视图的渲染器插槽(Q29 / §5.2)。
//
// ## 为什么是插槽而不是「波形 or markdown」二元分支
//
// §5.2 的架构约束:数字人已被列为未来项,v1 就该是抽象 + 第一个实现,
// 否则加数字人时改的是分支逻辑,而不是加一个实现。
//
// ## 状态与颜色
//
// Q32 定了三条约束,这里全部落成数据:
//
//   1. 「在听」「在说」「在执行」必须**一眼可辨** —— 用**颜色**而非形状区分,
//      形状差异在余光里看不出来。
//   2. 波形驱动源随状态切换:「在听」接麦克风流,「在说」接播放流。
//   3. tap-to-talk 的「待机」需文字提示 —— hands-free 的待机是「它在听着」,
//      tap-to-talk 的待机是「等你按」,同一条静止细线含义不同。

/** Q23 的五态(v1.3 增补了「在执行」)。 */
export const STATES = ['idle', 'listening', 'transcribing', 'thinking', 'speaking'];

/**
 * 每个状态的呈现。
 *
 * 颜色写成「变量名 + 字面量兜底」两半,而不是一个 `var(--x, #y)` 字符串:
 * **canvas 的 `strokeStyle` 不解析 CSS 自定义属性**。喂给它一个 `var(...)`
 * 不会报错,只是赋值被丢弃,笔色停在上一次的值(默认黑)—— 于是五个状态画出来
 * 一模一样,而 Q32 的第一条约束正是「必须一眼可辨」。
 *
 * 分成两半之后:DOM 那部分照旧用变量(主题可换),canvas 这边显式解析一次。
 */
export const PRESENTATION = {
  idle: {
    colorVar: '--nevo-voice-idle',
    color: '#8a8a8e',
    motion: 'still',
    // tap-to-talk 的待机必须有字,否则与 hands-free 的待机无从分辨。
    captionByMode: { 'hands-free': '', 'tap-to-talk': '按住说话' },
  },
  listening: {
    colorVar: '--nevo-voice-listening',
    color: '#0a7a3d',
    motion: 'live',
    source: 'microphone',
    captionByMode: { 'hands-free': '', 'tap-to-talk': '松开结束' },
  },
  transcribing: {
    // 与「在听」同色系但冻结:它是「在听」的延续,不是一件新事。
    colorVar: '--nevo-voice-listening',
    color: '#0a7a3d',
    motion: 'frozen',
    captionByMode: { 'hands-free': '', 'tap-to-talk': '' },
  },
  thinking: {
    colorVar: '--nevo-voice-thinking',
    color: '#a05a00',
    motion: 'breathe',
    captionByMode: { 'hands-free': '', 'tap-to-talk': '' },
  },
  speaking: {
    colorVar: '--nevo-voice-speaking',
    color: '#3b6fd4',
    motion: 'live',
    source: 'playback',
    captionByMode: { 'hands-free': '', 'tap-to-talk': '' },
  },
};

/** 状态的呈现参数。未知状态回落到待机,而不是抛错 —— 视图不该因为一个状态名而空白。 */
export function presentationFor(state, mode = 'hands-free') {
  const p = PRESENTATION[state] || PRESENTATION.idle;
  return {
    color: p.color,
    colorVar: p.colorVar,
    motion: p.motion,
    source: p.source || null,
    caption: (p.captionByMode && p.captionByMode[mode]) || '',
  };
}

/**
 * 把状态的颜色解析成 canvas 能用的字面量。
 *
 * `readVar` 是 `(name) => string`(浏览器里就是 `getComputedStyle(el).getPropertyValue`)。
 * 传函数而不是 DOM 元素,是为了这条路径在 Node 里也可被断言 —— 它是整个渲染器里
 * 唯一一处「主题换了颜色跟不跟」的逻辑。
 */
export function resolveColor(state, readVar) {
  const p = presentationFor(state);
  if (typeof readVar !== 'function') return p.color;
  let v = '';
  try {
    v = readVar(p.colorVar);
  } catch {
    v = '';
  }
  v = (v || '').trim();
  return v || p.color;
}

/**
 * 「在听」与「在说」必须不同色 —— 否则 hands-free 下用户分不清波形动的是
 * 自己还是 agent,会对着 TTS 说话。这条是可断言的,不是口头约定。
 */
export function distinctColors() {
  return (
    PRESENTATION.listening.color !== PRESENTATION.speaking.color &&
    PRESENTATION.speaking.color !== PRESENTATION.thinking.color &&
    PRESENTATION.listening.color !== PRESENTATION.thinking.color
  );
}

/** 语音视图里除波形之外仍然显示的东西(§5.2 的四个口子)。 */
export function visibleExtras({ partial, tool, artifact, structural }) {
  const out = [];
  if (partial) out.push({ kind: 'partial', text: partial });
  // 工具只显示名字与转圈,不显示参数与结果:声音负责「没卡」,视觉负责「在干什么」。
  if (tool) out.push({ kind: 'tool', name: tool });
  if (artifact) out.push({ kind: 'artifact', name: artifact });
  // 本质不可朗读的内容必须显示,否则语音视图下这一轮的信息量是零(ADR-0006)。
  if (structural) out.push({ kind: 'structural', preview: structural });
  return out;
}

/**
 * 波形的振幅平滑。
 *
 * 直接画瞬时振幅会抖得看不出状态;完全平滑又会让「在听」看起来像静止。
 * 上升快、下降慢 —— 说话的起音要立刻可见,尾音的衰减可以慢一点。
 */
export function smoothAmplitude(prev, next, { attack = 0.6, release = 0.12 } = {}) {
  const k = next > prev ? attack : release;
  return prev + (next - prev) * k;
}

/**
 * 渲染器插槽。第一个实现是波形;数字人是第二个。
 *
 * 实现只需要 `draw(ctx2d, frame)` —— 状态到呈现参数的映射由上面那些纯函数
 * 完成,所以换一个实现时不必重新决定「在说」是什么颜色。
 */
export class WaveformRenderer {
  static id = 'waveform';

  /** @param {{readVar?:(name:string)=>string}} [opts] 主题变量读取器,不给就用字面量兜底。 */
  constructor(opts = {}) {
    this.level = 0;
    this.readVar = opts.readVar || null;
  }

  /**
   * @param {CanvasRenderingContext2D} c
   * @param {{state:string, mode:string, amplitude:number, width:number, height:number}} f
   */
  draw(c, f) {
    const p = presentationFor(f.state, f.mode);
    const color = resolveColor(f.state, f.readVar || this.readVar);
    const target = p.motion === 'live' ? f.amplitude : p.motion === 'breathe' ? 0.18 : 0.02;
    this.level = smoothAmplitude(this.level, target);

    const { width: w, height: h } = f;
    c.clearRect(0, 0, w, h);
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.beginPath();
    const mid = h / 2;
    const amp = Math.max(1, this.level * (h / 2 - 2));
    for (let x = 0; x < w; x++) {
      const t = x / w;
      // 静止态是一条细线;有幅度时是一段驻波,足以看出「在动」而不喧宾夺主。
      const y = mid + Math.sin(t * Math.PI * 6 + this.phase(f)) * amp * Math.sin(t * Math.PI);
      if (x === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
    return { color, level: this.level, caption: p.caption };
  }

  phase(f) {
    // 冻结态不推进相位 —— 「在转写」要看起来停住了,而不是慢慢动。
    return presentationFor(f.state, f.mode).motion === 'frozen' ? 0 : (f.tick || 0) * 0.25;
  }
}

/** 已注册的渲染器。加数字人时在这里多一项,不动任何分支。 */
export const RENDERERS = { waveform: WaveformRenderer };

export function createRenderer(id = 'waveform', opts = {}) {
  const R = RENDERERS[id] || WaveformRenderer;
  return new R(opts);
}
