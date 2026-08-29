// 网络捕获的缓冲与脱敏。`node --test network-capture.test.mjs`。
//
// 这一层是整个功能的隐私与内存策略所在,而它的失败是静默的:打码漏了一个参数
// 名,凭证就进了模型上下文;上限只设了一个,另一种请求形状就把内存吃穿。
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  NetworkCapture,
  redactUrl,
  redactHeaders,
  MAX_RECORDS,
} from './network-capture.mjs';

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
    { name: 'X-Internal', value: 'whatever' },
  ]);
  assert.equal(got['content-type'], 'application/json');
  assert.equal(got['authorization'], '<redacted>');
  assert.equal(got['x-internal'], undefined, '白名单之外的头不该出现');
});

test('没开启捕获时,read 说的是「未开启」而不是「零条」', () => {
  const cap = new NetworkCapture();
  const got = cap.read(1, {});
  assert.equal(got.active, false);
  assert.deepEqual(got.records, []);
  // 布尔位不够:模型读的是这段 JSON,得告诉它怎么才能开。
  assert.ok(got.message && got.message.includes('browser_network_requests'), got.message);
});

test('开启了但没有请求,是「零条」而不是「未开启」', () => {
  const cap = new NetworkCapture();
  cap.start(1);
  const got = cap.read(1, {});
  assert.equal(got.active, true);
  assert.equal(got.records.length, 0);
});

test('条数上限:超出的最旧记录被丢弃并计数', () => {
  const cap = new NetworkCapture();
  cap.start(1);
  for (let i = 0; i < MAX_RECORDS + 5; i++) {
    cap.record(1, { url: `https://x.com/${i}`, method: 'GET', status: 200 });
  }
  const got = cap.read(1, {});
  assert.equal(got.records.length, MAX_RECORDS);
  assert.equal(got.summary.dropped, 5);
  assert.ok(got.records[0].url.endsWith('/5'), '丢的该是最旧的');
});

test('字节上限:少数巨型记录同样会触发丢弃', () => {
  const cap = new NetworkCapture();
  cap.start(1);
  const huge = 'https://x.com/?p=' + 'a'.repeat(100_000);
  for (let i = 0; i < 5; i++) cap.record(1, { url: huge, method: 'GET', status: 200 });
  const got = cap.read(1, {});
  assert.ok(got.records.length < 5, `字节上限没生效,留了 ${got.records.length} 条`);
  assert.ok(got.summary.dropped > 0);
});

test('only_failed 只留 4xx/5xx 与网络错误', () => {
  const cap = new NetworkCapture();
  cap.start(1);
  cap.record(1, { url: 'https://x.com/ok', method: 'GET', status: 200 });
  cap.record(1, { url: 'https://x.com/bad', method: 'GET', status: 500 });
  cap.record(1, { url: 'https://x.com/dead', method: 'GET', error: 'net::ERR_FAILED' });
  const got = cap.read(1, { onlyFailed: true });
  assert.equal(got.records.length, 2);
});

test('摘要按状态码分布,失败数单列', () => {
  const cap = new NetworkCapture();
  cap.start(1);
  cap.record(1, { url: 'a', method: 'GET', status: 200 });
  cap.record(1, { url: 'b', method: 'GET', status: 200 });
  cap.record(1, { url: 'c', method: 'GET', status: 404 });
  const got = cap.read(1, {});
  assert.equal(got.summary.total, 3);
  assert.equal(got.summary.by_status['200'], 2);
  assert.equal(got.summary.by_status['404'], 1);
  assert.equal(got.summary.failed, 1);
});

test('标签页之间互不可见', () => {
  const cap = new NetworkCapture();
  cap.start(1);
  cap.start(2);
  cap.record(1, { url: 'https://x.com/one', method: 'GET', status: 200 });
  assert.equal(cap.read(1, {}).records.length, 1);
  assert.equal(cap.read(2, {}).records.length, 0);
});

test('stop 之后数据不再存在 —— 回合结束即清空', () => {
  const cap = new NetworkCapture();
  cap.start(1);
  cap.record(1, { url: 'https://x.com/a', method: 'GET', status: 200 });
  cap.stop(1);
  const got = cap.read(1, {});
  assert.equal(got.active, false);
  assert.deepEqual(got.records, []);
});

test('没开启时 record 不存 —— 默认不抓是硬的', () => {
  const cap = new NetworkCapture();
  cap.record(1, { url: 'https://x.com/a', method: 'GET', status: 200 });
  cap.start(1);
  assert.equal(cap.read(1, {}).records.length, 0);
});

test('clearAll 清掉所有标签页 —— 停止时的「当前页」未必是开始时的那个', () => {
  const cap = new NetworkCapture();
  cap.start(1);
  cap.start(2);
  cap.record(1, { url: 'https://x.com/a', method: 'GET', status: 200 });
  cap.clearAll();
  assert.equal(cap.isActive(1), false);
  assert.equal(cap.isActive(2), false);
  assert.equal(cap.read(1, {}).active, false);
});
