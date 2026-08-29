// 网络请求的捕获缓冲与脱敏。
//
// 纯逻辑,不碰任何浏览器 API —— 监听器那一半在 background.js 里,而这一半是
// 整个功能的隐私与内存策略所在,必须能被单独测。
//
// 两条硬规则:
//   1. 没有 start 过的标签页,record 一个字都不存。「默认不抓」不能靠调用方自觉。
//   2. read 要能区分「未开启」和「零条」。空列表会让模型断定页面没发请求。

/** 值会被打码的 query 参数名(子串,大小写不敏感)。 */
const SECRET_PARAM_HINTS = ['token', 'key', 'secret', 'auth', 'session', 'password'];

/** 唯一会被保留的头部。白名单而不是黑名单:黑名单漏一个就是泄漏。 */
const HEADER_WHITELIST = ['content-type', 'content-length', 'cache-control', 'location', 'server'];

/** 保留键名、替换值的头部 ——「这个请求带了 Authorization」本身是有用的信息。 */
const HEADER_REDACT = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'];

export const MAX_RECORDS = 200;
export const MAX_BYTES = 262144;

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
  }

  start(tabId) {
    this.tabs.set(tabId, { records: [], bytes: 0, dropped: 0 });
  }

  stop(tabId) {
    this.tabs.delete(tabId);
  }

  isActive(tabId) {
    return this.tabs.has(tabId);
  }

  clearAll() {
    this.tabs.clear();
  }

  record(tabId, entry) {
    const slot = this.tabs.get(tabId);
    // 没开启就不存。这条是「默认不抓」的实现,不是防御性检查。
    if (!slot) return;
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

  read(tabId, { onlyFailed = false } = {}) {
    const slot = this.tabs.get(tabId);
    if (!slot) {
      // 「未开启」与「零条」是两件事。只给一个布尔位不够 ——
      // 模型读到的是这段 JSON,所以把「怎么才能开」写进去。
      return {
        active: false,
        records: [],
        summary: { total: 0, failed: 0, dropped: 0, by_status: {} },
        message:
          '本回合未开启网络捕获。在提示词里写出 browser_network_requests 才会记录,' +
          '且只能记录写出它之后发生的请求。',
      };
    }
    const records = onlyFailed ? slot.records.filter(isFailure) : slot.records.slice();
    const by_status = {};
    let failed = 0;
    for (const r of slot.records) {
      const k = r.error ? 'error' : String(r.status ?? 'unknown');
      by_status[k] = (by_status[k] || 0) + 1;
      if (isFailure(r)) failed++;
    }
    return {
      active: true,
      records,
      summary: { total: slot.records.length, failed, dropped: slot.dropped, by_status },
    };
  }
}
