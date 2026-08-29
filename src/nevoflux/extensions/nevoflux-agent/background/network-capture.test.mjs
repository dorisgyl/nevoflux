// 网络捕获的缓冲、脱敏与会话生命周期。`node --test network-capture.test.mjs`。
//
// 这一层是整个功能的隐私与内存策略所在,而它的失败是静默的:打码漏了一个参数
// 名,凭证就进了模型上下文;上限只设了一个,另一种请求形状就把内存吃穿;录制
// 忘了停,浏览器就一直在记。
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  NetworkCapture,
  redactUrl,
  redactHeaders,
  MAX_RECORDS,
  MAX_RETURNED,
  MAX_SESSION_MS,
} from './network-capture.mjs';

const T0 = 1_000_000; // 固定时刻,不读真实时钟

test('凭证样式的 query 参数被打码,其余原样', () => {
  const got = redactUrl('https://x.com/a?page=2&access_token=abc123&q=hi');
  assert.ok(got.includes('page=2'), got);
  assert.ok(got.includes('q=hi'), got);
  assert.ok(!got.includes('abc123'), got);
  assert.ok(
    got.includes('access_token=%3Credacted%3E') || got.includes('access_token=<redacted>'),
    got
  );
});

test('不是 URL 的字符串原样带过,不抛', () => {
  assert.equal(redactUrl('not a url'), 'not a url');
});

test('敏感头保留键名,值被替换 —— 「带了认证」本身是信息', () => {
  const got = redactHeaders([
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Authorization', value: 'Bearer secret' },
    { name: 'Cookie', value: 'session=deadbeef' },
    { name: 'X-Internal', value: 'whatever' },
  ]);
  assert.equal(got['content-type'], 'application/json');
  assert.equal(got['authorization'], '<redacted>');
  assert.equal(got['cookie'], '<redacted>');
  assert.equal(got['x-internal'], undefined, '白名单之外的头不该出现');
});

test('没开启时 record 一个字都不存 —— 默认不抓是硬的', () => {
  const cap = new NetworkCapture();
  cap.record(1, { url: 'https://x.com/a', method: 'GET', status: 200 }, T0);
  cap.arm(T0);
  assert.equal(cap.read(1, {}, T0).records.length, 0);
});

test('没开启时说的是「未开启」并给出开启方法', () => {
  const cap = new NetworkCapture();
  const got = cap.read(1, {}, T0);
  assert.equal(got.active, false);
  assert.deepEqual(got.records, []);
  assert.ok(got.message.includes('browser_network_requests'), got.message);
});

test('开着但零条:说清是另一回事,并给出出路', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  const got = cap.read(1, {}, T0);
  assert.equal(got.active, true);
  assert.equal(got.records.length, 0);
  assert.ok(got.message, '零条必须带说明');
  assert.ok(!got.message.includes('未开启'), '不能和「没开」混为一谈: ' + got.message);
  assert.ok(got.remaining_s > 0);
});

test('当前页空但别的页有记录时,要说出是哪个 tab', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  cap.record(7, { url: 'https://x.com/a', method: 'GET', status: 200 }, T0);
  const got = cap.read(1, {}, T0);
  assert.equal(got.records.length, 0);
  assert.ok(got.message.includes('7'), got.message);
});

test('有记录且没截断时不带说明 —— 免得读成「没抓到」', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  cap.record(1, { url: 'https://x.com/a', method: 'GET', status: 200 }, T0);
  assert.equal(cap.read(1, {}, T0).message, undefined);
});

/// 一次实测里,模型看到 dropped: 332 就自行编了「并发请求被采样合并」的解释,
/// 于是用户以为什么都没丢 —— 而五百多个请求里实际只剩了两百个。
test('缓冲淘汰过就要说出来,而且要说清取不回来了', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  for (let i = 0; i < MAX_RECORDS + 50; i++) {
    cap.record(1, { url: 'https://x.com/' + i, method: 'GET', status: 200 }, T0);
  }
  const got = cap.read(1, {}, T0);
  assert.equal(got.summary.dropped, 50);
  assert.ok(got.message, '淘汰过必须带说明');
  assert.ok(got.message.includes('50'), got.message);
  assert.ok(got.message.includes('不完整'), '要说清这段记录不完整: ' + got.message);
});

test('一次只返回最近的一段,但摘要按全部算', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  const n = MAX_RETURNED + 30;
  for (let i = 0; i < n; i++) {
    cap.record(1, { url: 'https://x.com/' + i, method: 'GET', status: 200 }, T0);
  }
  const got = cap.read(1, {}, T0);
  assert.equal(got.records.length, MAX_RETURNED, '返回条数要封顶');
  assert.equal(got.summary.total, n, '摘要要覆盖全部,不只是返回的那些');
  assert.equal(got.summary.returned, MAX_RETURNED);
  // 返回最近的,不是最早的 —— 看日志几乎总是关心刚发生的。
  assert.ok(got.records[got.records.length - 1].url.endsWith('/' + (n - 1)), '最后一条该是最新的');
  assert.ok(got.message.includes(String(n)), got.message);
});

test('only_failed 之后的截断也要如实说', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  for (let i = 0; i < MAX_RETURNED + 10; i++) {
    cap.record(1, { url: 'https://x.com/' + i, method: 'GET', status: 500 }, T0);
  }
  const got = cap.read(1, { onlyFailed: true }, T0);
  assert.equal(got.records.length, MAX_RETURNED);
  assert.equal(got.summary.matched, MAX_RETURNED + 10);
});

// --- 会话生命周期:这次改动的核心 ---

test('跨回合存活 —— 这正是改成会话制要解决的问题', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  // 「回合」在这一层不存在。开启之后的任意时刻,人自己点出来的请求都要被记到。
  cap.record(1, { url: 'https://app.local/api', method: 'GET', status: 200 }, T0 + 60_000);
  cap.record(1, { url: 'https://app.local/save', method: 'POST', status: 500 }, T0 + 120_000);
  const got = cap.read(1, {}, T0 + 121_000);
  assert.equal(got.active, true);
  assert.equal(got.records.length, 2);
});

test('到点自动停 —— 忘记关是这种设计唯一真正的风险', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  assert.equal(cap.isArmed(T0 + MAX_SESSION_MS - 1), true);
  assert.equal(cap.isArmed(T0 + MAX_SESSION_MS), false);
});

test('过期后数据也没了,不是只是读不到', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  cap.record(1, { url: 'https://x.com/a', method: 'GET', status: 200 }, T0);
  const got = cap.read(1, {}, T0 + MAX_SESSION_MS);
  assert.equal(got.active, false);
  assert.deepEqual(got.records, []);
  // 再把时钟拨回去也不该复活。
  assert.deepEqual(cap.read(1, {}, T0).records, []);
});

test('ttl 不能超过上限 —— 调用方给再大也按上限算', () => {
  const cap = new NetworkCapture();
  cap.arm(T0, MAX_SESSION_MS * 10);
  assert.equal(cap.isArmed(T0 + MAX_SESSION_MS), false);
});

test('disarm 立刻停止并清空全部标签页', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  cap.record(1, { url: 'https://x.com/a', method: 'GET', status: 200 }, T0);
  cap.record(2, { url: 'https://x.com/b', method: 'GET', status: 200 }, T0);
  cap.disarm();
  assert.equal(cap.isArmed(T0), false);
  assert.deepEqual(cap.read(1, {}, T0).records, []);
  assert.deepEqual(cap.read(2, {}, T0).records, []);
});

test('开启期间所有标签页都记 —— 人在哪一页点都算', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  cap.record(1, { url: 'https://x.com/one', method: 'GET', status: 200 }, T0);
  cap.record(2, { url: 'https://x.com/two', method: 'GET', status: 200 }, T0);
  assert.equal(cap.read(1, {}, T0).records.length, 1);
  assert.equal(cap.read(2, {}, T0).records.length, 1);
});

// --- 上限与筛选 ---

test('条数上限:超出的最旧记录被丢弃并计数', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  for (let i = 0; i < MAX_RECORDS + 5; i++) {
    cap.record(1, { url: 'https://x.com/' + i, method: 'GET', status: 200 }, T0);
  }
  const got = cap.read(1, {}, T0);
  assert.equal(got.summary.total, MAX_RECORDS, '缓冲里留住的条数要封顶');
  assert.equal(got.summary.dropped, 5);
  // 丢的是最旧的:第 0..4 号没了,缓冲里最旧的是 5 号。
  assert.equal(got.summary.by_status['200'], MAX_RECORDS);
});

test('字节上限:远不到条数上限也会因为体积触发丢弃', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  // 每条约 100KB,五十条就超过 4MB —— 条数才 50,离 2000 条还远得很。
  // 两个上限都要有的理由就在这:一个页面可能发两千个小请求,也可能发几十个巨型 URL。
  const huge = 'https://x.com/?p=' + 'a'.repeat(100_000);
  const n = 50;
  for (let i = 0; i < n; i++) cap.record(1, { url: huge, method: 'GET', status: 200 }, T0);
  const got = cap.read(1, {}, T0);
  assert.ok(got.summary.total < n, '字节上限没生效,留了 ' + got.summary.total + ' 条');
  assert.ok(got.summary.total < MAX_RECORDS, '这一条不该是被条数上限挡下的');
  assert.ok(got.summary.dropped > 0);
});

test('only_failed 只留 4xx/5xx 与网络错误', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  cap.record(1, { url: 'https://x.com/ok', method: 'GET', status: 200 }, T0);
  cap.record(1, { url: 'https://x.com/bad', method: 'GET', status: 500 }, T0);
  cap.record(1, { url: 'https://x.com/dead', method: 'GET', error: 'net::ERR_FAILED' }, T0);
  assert.equal(cap.read(1, { onlyFailed: true }, T0).records.length, 2);
});

test('摘要按状态码分布,失败数单列', () => {
  const cap = new NetworkCapture();
  cap.arm(T0);
  cap.record(1, { url: 'a', method: 'GET', status: 200 }, T0);
  cap.record(1, { url: 'b', method: 'GET', status: 200 }, T0);
  cap.record(1, { url: 'c', method: 'GET', status: 404 }, T0);
  const got = cap.read(1, {}, T0);
  assert.equal(got.summary.total, 3);
  assert.equal(got.summary.by_status['200'], 2);
  assert.equal(got.summary.by_status['404'], 1);
  assert.equal(got.summary.failed, 1);
});

// --- 路由登记 ---
//
// 这不是纯逻辑测试,它读 background.js 的源码 —— 因为这个 bug 没有别的地方能
// 抓到:动作没登记进 DIRECT_ACTIONS 就会被转发给 sidebar WASM,那边没有处理器,
// 消息被静默丢弃,daemon 等满 30 秒超时。没有任何一处报错。
//
// 这个代码库里同一个 bug 已经犯过五次,注释都是事后补的教训,所以钉死。
test('网络动作都登记进了 DIRECT_ACTIONS,且都有 case', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('./background.js', import.meta.url)), 'utf8');

  const start = src.indexOf('const DIRECT_ACTIONS = new Set([');
  assert.ok(start > 0, '找不到 DIRECT_ACTIONS —— 它被改名或移走了,这个测试要跟着改');
  const block = src.slice(start, src.indexOf(']);', start));
  const q = String.fromCharCode(39);

  for (const action of ['network_capture_start', 'network_capture_stop', 'network_requests']) {
    assert.ok(
      block.includes(q + action + q),
      action + ' 不在 DIRECT_ACTIONS 里 —— 它会被转发到 sidebar 然后静默超时'
    );
    assert.ok(src.includes('case ' + q + action + q), action + ' 没有对应的 case');
  }
});
