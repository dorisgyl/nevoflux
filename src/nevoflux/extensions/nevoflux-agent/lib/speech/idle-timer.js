// 语音会话的静默退出(Q45)。
//
// ## 计时的是「无交互」,不是「无语音」
//
// v1.2 定的是「90 秒无语音自动退出」。那会在 agent 埋头干活时误伤:用户说完
// 「把这三个 PR 都打开」之后不再出声,agent 跑 90 秒工具 —— 语音会**在 agent
// 还在工作时自己退出**,等回答生成出来已经没有播放通道了。这不是边缘情况,
// 是所有长任务的默认结局。
//
// 所以「交互」包括三件事:用户在说、agent 在说、agent 在执行。执行结束后计时
// 归零重新开始。
//
// ## 为什么还要一个绝对上限
//
// 无条件暂停会打穿这条超时存在的理由 ——「忘记关闭的常开麦克风是最坏结果」。
// 一个失控的轮次能让麦克风开一整天。所以执行期间不计时,但整体有个天花板。

export const DEFAULT_IDLE_MS = 90_000;
export const DEFAULT_MAX_MS = 10 * 60_000;

export class IdleTimer {
  /**
   * @param {object} opts
   * @param {number} [opts.idleMs] 无交互多久退出
   * @param {number} [opts.maxMs] 绝对上限,不受「执行中」豁免
   * @param {() => number} [opts.now] 注入时钟,便于测试
   * @param {(reason:'idle'|'max')=>void} opts.onExpire
   */
  constructor(opts) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
    this.now = opts.now ?? (() => Date.now());
    this.onExpire = opts.onExpire;

    this.startedAt = this.now();
    this.lastActivity = this.startedAt;
    /** 执行中的事项数。>0 时不计静默,但绝对上限照走。 */
    this.busy = 0;
    this.expired = false;
  }

  /** 有交互发生。 */
  touch() {
    this.lastActivity = this.now();
  }

  /** 一件会持续一段时间的事开始了(工具执行、TTS 播放、等待授权)。 */
  beginBusy() {
    this.busy++;
    this.touch();
  }

  /** 对应的事结束了。结束即重新开始计时 —— 用户是从这一刻起才真的闲下来的。 */
  endBusy() {
    if (this.busy > 0) this.busy--;
    this.touch();
  }

  /** 距离静默退出还有多久;执行中返回 Infinity。 */
  idleRemaining() {
    if (this.busy > 0) return Infinity;
    return this.idleMs - (this.now() - this.lastActivity);
  }

  maxRemaining() {
    return this.maxMs - (this.now() - this.startedAt);
  }

  /**
   * 该不该退出。由调用方按自己的节奏轮询(定时器或音频回调),
   * 这样这个类不持有任何定时器,也就不需要清理。
   */
  check() {
    if (this.expired) return null;
    if (this.maxRemaining() <= 0) {
      this.expired = true;
      this.onExpire?.('max');
      return 'max';
    }
    if (this.idleRemaining() <= 0) {
      this.expired = true;
      this.onExpire?.('idle');
      return 'idle';
    }
    return null;
  }
}
