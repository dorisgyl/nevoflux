// 网络请求的捕获缓冲与脱敏。
//
// 纯逻辑,不碰任何浏览器 API,也不读时钟 —— 监听器和计时那一半在 background.js
// 里,而这一半是整个功能的隐私与内存策略所在,必须能被单独测。
//
// ## 为什么是「一段会话」而不是「一个回合」
//
// 最初捕获只活一个 agent 回合。实测下来那个窗口对真实调试没用:人要自己点几下
// 页面,等切过去回合早结束了,拿到的永远是空列表。第一个使用场景(调试自己开发
// 的页面)恰恰被这个限制挡住。
//
// 现在改成显式开启、显式结束,中间跨多少个回合都行。「默认不抓、必须由用户点名
// 才开」这条没变,变的只是那次点名的有效期。代价是数据会在你没再要求的时候继续
// 产生,所以有两道约束:随时可以停,以及一个到点自动停的上限 —— 忘记关是这种
// 设计唯一真正的风险。
//
// ## 两条硬规则
//
//   1. 没 arm 过就一个字都不存。「默认不抓」不能靠调用方自觉。
//   2. read 要能分辨三种情况:没开、开着但没东西、有数据。前两种都是空列表,
//      而模型会把空列表读成「页面没发请求」—— 实测发生过。

/** 值会被打码的 query 参数名(子串,大小写不敏感)。 */
const SECRET_PARAM_HINTS = ['token', 'key', 'secret', 'auth', 'session', 'password'];

/** 唯一会被保留的头部。白名单而不是黑名单:黑名单漏一个就是泄漏。 */
const HEADER_WHITELIST = ['content-type', 'content-length', 'cache-control', 'location', 'server'];

/** 保留键名、替换值的头部 ——「这个请求带了 Authorization」本身是有用的信息。 */
const HEADER_REDACT = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'];

/**
 * 缓冲能留多少条。
 *
 * 原来是 200 —— 那是按「一个 agent 回合」定的。改成会话制之后一次实测:GitHub
 * 几分钟就发了 532 个请求,于是 332 条被悄悄丢掉,而留下的 200 条看起来完全正常。
 * 对一段真实的调试会话来说,截断成了常态而不是边缘情况。
 */
export const MAX_RECORDS = 2000;

/** 缓冲能占多少字节。条数放大了十倍,这个也要跟上,否则先撞的是它。 */
export const MAX_BYTES = 4 * 1024 * 1024;

/**
 * 一次最多返回多少条。
 *
 * 缓冲留得多是为了不丢,返回得少是为了不烧 token —— 这两件事要分开。两千条
 * 记录进模型上下文是几十万 token,而看请求日志几乎总是只关心最近这些,或者
 * 用 only_failed 挑出坏的那几条。
 */
export const MAX_RETURNED = 100;

/**
 * 一次开启最多录多久。
 *
 * 兜底,不是功能。忘记关掉是这种设计唯一真正的风险 —— 用户开了录制去调试,
 * 然后转头做别的,浏览器就一直在记。到点自动停,比指望人记得住可靠。
 */
export const MAX_SESSION_MS = 30 * 60 * 1000;

const REDACTED = '<redacted>';

/** query 里凭证样式的参数值打码。解析不了的字符串原样返回。 */
export function redactUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  let touched = false;
  for (const name of [...u.searchParams.keys()]) {
    const lower = name.toLowerCase();
    if (SECRET_PARAM_HINTS.some((h) => lower.includes(h))) {
      u.searchParams.set(name, REDACTED);
      touched = true;
    }
  }
  return touched ? u.toString() : url;
}

/** 白名单之外的头丢掉,敏感头留键名。 */
export function redactHeaders(headers) {
  const out = {};
  for (const h of headers || []) {
    const name = String(h.name || '').toLowerCase();
    if (HEADER_REDACT.includes(name)) {
      out[name] = REDACTED;
    } else if (HEADER_WHITELIST.includes(name)) {
      out[name] = h.value;
    }
  }
  return out;
}

function isFailure(r) {
  return !!r.error || (typeof r.status === 'number' && r.status >= 400);
}

function sizeOf(r) {
  // 近似即可:这是内存护栏,不是计费。
  return JSON.stringify(r).length;
}

export class NetworkCapture {
  constructor() {
    /** tabId -> { records: [], bytes: number, dropped: number } */
    this.tabs = new Map();
    /** 到期时刻(epoch ms);null 表示没开。 */
    this.armedUntil = null;
  }

  /** 开启录制。`now` 由调用方给 —— 这个模块不读时钟,才好测。 */
  arm(now, ttlMs = MAX_SESSION_MS) {
    this.armedUntil = now + Math.min(ttlMs, MAX_SESSION_MS);
  }

  /** 停止并丢弃全部数据。 */
  disarm() {
    this.armedUntil = null;
    this.tabs.clear();
  }

  /**
   * 现在还在录吗。到点的话顺手清掉 ——「过期」和「已停」对外必须是同一件事,
   * 不能留下一份还读得到的过期数据。
   */
  isArmed(now) {
    if (this.armedUntil === null) return false;
    if (now >= this.armedUntil) {
      this.disarm();
      return false;
    }
    return true;
  }

  /** 还能录多久(秒)。没开时是 0。 */
  remainingS(now) {
    return this.isArmed(now) ? Math.max(0, Math.round((this.armedUntil - now) / 1000)) : 0;
  }

  record(tabId, entry, now) {
    // 没开就不存。这条是「默认不抓」的实现,不是防御性检查。
    if (!this.isArmed(now)) return;
    let slot = this.tabs.get(tabId);
    if (!slot) {
      slot = { records: [], bytes: 0, dropped: 0 };
      this.tabs.set(tabId, slot);
    }
    slot.records.push(entry);
    slot.bytes += sizeOf(entry);
    // 两个上限同时生效:一个页面可能发两千个小请求,也可能发三个巨型 URL。
    while (slot.records.length > MAX_RECORDS || slot.bytes > MAX_BYTES) {
      const gone = slot.records.shift();
      if (!gone) break;
      slot.bytes -= sizeOf(gone);
      slot.dropped++;
    }
  }

  /** 哪些标签页有数据。给「当前这页是空的,但别的页有」那种情况用。 */
  capturedTabIds() {
    return [...this.tabs.keys()];
  }

  read(tabId, { onlyFailed = false } = {}, now = 0) {
    const empty = { total: 0, failed: 0, dropped: 0, by_status: {} };
    if (!this.isArmed(now)) {
      // 「没开」和「开着但没东西」是两件事,而两者都是空列表。只给一个布尔位
      // 不够 —— 模型读到的是这段 JSON,实测里它把 active:true 的空列表也读成
      // 了「未开启」。所以把区别和出路都写进去。
      return {
        active: false,
        records: [],
        summary: empty,
        remaining_s: 0,
        message:
          '网络捕获未开启。在提示词里写出 browser_network_requests 即可开启,' +
          '开启后会一直记录(最多 30 分钟)直到你要求停止,期间你自己点击页面' +
          '产生的请求也会被记录。',
      };
    }

    const slot = this.tabs.get(tabId);
    const remaining_s = this.remainingS(now);
    if (!slot || slot.records.length === 0) {
      const others = this.capturedTabIds().filter((id) => id !== tabId);
      return {
        active: true,
        records: [],
        summary: empty,
        remaining_s,
        message:
          `网络捕获开启中(还剩 ${remaining_s} 秒),但这个标签页还没有记录到请求。` +
          (others.length
            ? `有记录的标签页:${others.join(', ')} —— 换 tab_id 再读一次。`
            : '让页面产生请求(重新加载,或直接在页面上操作),然后再读一次。') +
          '捕获不包含开启之前发生的请求。',
      };
    }

    const matched = onlyFailed ? slot.records.filter(isFailure) : slot.records.slice();
    // 只返回最近的一段。旧的还在缓冲里,但一次性全给出去就是几十万 token。
    const records = matched.slice(-MAX_RETURNED);
    const by_status = {};
    let failed = 0;
    for (const r of slot.records) {
      const k = r.error ? 'error' : String(r.status ?? 'unknown');
      by_status[k] = (by_status[k] || 0) + 1;
      if (isFailure(r)) failed++;
    }
    // 数字自己不会说话。上一次实测里,模型看到 dropped: 332 就自行编了一个
    // 「并发请求被采样合并」的解释,于是用户以为什么都没丢 —— 而实际上五百多个
    // 请求里只剩了两百个。给了数据就要给读法。
    const notes = [];
    if (records.length < matched.length) {
      notes.push(
        `符合条件的有 ${matched.length} 条,这里只返回最近的 ${records.length} 条。` +
          '更早的仍在缓冲里,用 only_failed 缩小范围可以看到别的。'
      );
    }
    if (slot.dropped > 0) {
      notes.push(
        `另有 ${slot.dropped} 条更早的记录已被缓冲淘汰(每个标签页最多留 ` +
          `${MAX_RECORDS} 条),它们无法再取回 —— 这段记录不完整。`
      );
    }
    const out = {
      active: true,
      records,
      summary: {
        total: slot.records.length,
        matched: matched.length,
        returned: records.length,
        failed,
        dropped: slot.dropped,
        by_status,
      },
      remaining_s,
    };
    if (notes.length) out.message = notes.join('');
    return out;
  }
}
