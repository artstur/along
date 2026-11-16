import test from 'node:test';
import assert from 'node:assert/strict';

// inbox 模块 along 侧（web/event-envelope.mjs + web/agent-client.mjs 事件队列）的独立验证
// （docs/stage-a-tech-design.md §2.2.7/§4.1，验收锚点 BC-08-01/02/03 的客户端断言）。
// 与 fork 侧 tests/along-inbox-verify.spec.ts 的关系：底部 VERIFY_VECTOR_CASES 是本轮验证自己的
// 两端静态向量表——同一张表在 fork 用 zod 判、在这里用 validateEnvelope 判，两端必须同判（SD-1/SG-1）；
// 队列部分补既有 test/event-queue.test.mjs 之外的边界：不可识别回执、终态连投、终态删除后同号重发、
// 失败状态上限、坏信封不入队不发网。

// web 模块按浏览器语义引用 window/localStorage：导入前植入替身（node --test 每文件独立进程）。
const storage = new Map();
globalThis.localStorage = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: key => { storage.delete(key); },
};
globalThis.window = {};
const {validateEnvelope} = await import(new URL('../web/event-envelope.mjs', import.meta.url));
const {queueEvent, flushEventQueue, readEventFailures, EVENT_QUEUE_KEY, EVENT_FAILED_KEY, readStored} =
  await import(new URL('../web/agent-client.mjs', import.meta.url));

const CONFIG = {baseURL: 'https://192.168.8.2:4176', fingerprint: 'a'.repeat(64), token: 'b'.repeat(64)};

function bridge(handler) {
  const requests = [];
  window.AlongAgentBridge = {request: async input => { requests.push(input); return handler(input); }};
  return requests;
}
const pending = () => readStored(EVENT_QUEUE_KEY, []);

const USER_MESSAGE = () => ({
  event_type: 'along.user_message',
  occurred_at: '2026-11-15T08:30:00+08:00',
  timezone: 'Asia/Shanghai',
  payload: {event_type: 'along.user_message', text: '帮我把目标改成 180 分钟'},
});

// ---- 两端静态向量（与 fork tests/along-inbox-verify.spec.ts 同一张表，逐字对齐）-------------------------

const TASK = 't_verify00001';
const BASE = {
  event_id: 'evt-vecv-0001', schema_version: '1', event_type: 'along.user_message',
  occurred_at: '2026-11-15T08:30:00+08:00', timezone: 'Asia/Shanghai',
  payload: {event_type: 'along.user_message', text: '帮我把目标改成 180 分钟'},
};
const VERIFY_VECTOR_CASES = [
  ['最小合法 user_message', BASE, true],
  ['text 恰 800 字合法', {...BASE, event_id: 'evt-vecv-0002', payload: {event_type: 'along.user_message', text: '长'.repeat(800)}}, true],
  ['text 801 字拒绝', {...BASE, event_id: 'evt-vecv-0003', payload: {event_type: 'along.user_message', text: '长'.repeat(801)}}, false],
  ['timezone 恰 64 字合法', {...BASE, event_id: 'evt-vecv-0004', timezone: 'Z'.repeat(64)}, true],
  ['timezone 65 字拒绝', {...BASE, event_id: 'evt-vecv-0005', timezone: 'Z'.repeat(65)}, false],
  ['event_id 恰 96 字合法', {...BASE, event_id: 'a'.repeat(96)}, true],
  ['event_id 97 字拒绝', {...BASE, event_id: 'a'.repeat(97)}, false],
  ['event_id 以 - 开头拒绝', {...BASE, event_id: '-abc'}, false],
  ['base_revision 0 合法', {...BASE, event_id: 'evt-vecv-0006', base_revision: 0}, true],
  ['base_revision 负数拒绝', {...BASE, event_id: 'evt-vecv-0007', base_revision: -1}, false],
  ['note 恰 500 字合法', {...BASE, event_id: 'evt-vecv-0008', event_type: 'along.message', kind: 'task.feedback', task_id: TASK,
    payload: {event_type: 'along.message', kind: 'task.feedback', task_id: TASK, note: '注'.repeat(500)}}, true],
  ['note 501 字拒绝', {...BASE, event_id: 'evt-vecv-0009', event_type: 'along.message', kind: 'task.feedback', task_id: TASK,
    payload: {event_type: 'along.message', kind: 'task.feedback', task_id: TASK, note: '注'.repeat(501)}}, false],
  ['20 份摘要合法', {...BASE, event_id: 'evt-vecv-0010', event_type: 'along.health_summary_updated',
    payload: {event_type: 'along.health_summary_updated', summaries: Array.from({length: 20}, (_, index) => ({
      type: 'steps', metric_version: 'mv1', timezone: 'Asia/Shanghai', availability: 'ok', summarizer_version: 's1', value: index}))}}, true],
  ['21 份摘要拒绝', {...BASE, event_id: 'evt-vecv-0011', event_type: 'along.health_summary_updated',
    payload: {event_type: 'along.health_summary_updated', summaries: Array.from({length: 21}, (_, index) => ({
      type: 'steps', metric_version: 'mv1', timezone: 'Asia/Shanghai', availability: 'ok', summarizer_version: 's1', value: index}))}}, false],
  ['window 仅 night 合法', {...BASE, event_id: 'evt-vecv-0012', event_type: 'along.health_summary_updated',
    payload: {event_type: 'along.health_summary_updated', summaries: [{type: 'sleep', metric_version: 'mv1',
      window: {night: '2026-11-14T00:00:00+08:00'}, timezone: 'Asia/Shanghai', availability: 'ok', summarizer_version: 's1'}]}}, true],
  ['window 同时带 start/end/night 拒绝', {...BASE, event_id: 'evt-vecv-0013', event_type: 'along.health_summary_updated',
    payload: {event_type: 'along.health_summary_updated', summaries: [{type: 'sleep', metric_version: 'mv1',
      window: {start: '2026-11-14T00:00:00+08:00', end: '2026-11-15T00:00:00+08:00', night: '2026-11-14T00:00:00+08:00'},
      timezone: 'Asia/Shanghai', availability: 'ok', summarizer_version: 's1'}]}}, false],
  ['availability 之外的取值拒绝', {...BASE, event_id: 'evt-vecv-0014', event_type: 'along.health_summary_updated',
    payload: {event_type: 'along.health_summary_updated', summaries: [{type: 'steps', metric_version: 'mv1',
      timezone: 'Asia/Shanghai', availability: 'maybe', summarizer_version: 's1'}]}}, false],
  ['causation_id 非法形状拒绝', {...BASE, event_id: 'evt-vecv-0015', causation_id: '带 空 格'}, false],
  ['payload 带多余字段拒绝（strict）', {...BASE, event_id: 'evt-vecv-0016',
    payload: {event_type: 'along.user_message', text: 'hello', extra: 1}}, false],
];

test('SD-1/SG-1：独立向量表两端同判（本文件为 web 端）', () => {
  for (const [name, envelope, expected] of VERIFY_VECTOR_CASES) {
    assert.equal(validateEnvelope(envelope) === null, expected, `向量「${name}」的 web 判定与 fork 端不一致`);
  }
});

// ---- 队列处置边界（BC-08-01/02/03 客户端断言的补充反例）-------------------------------------------------

test('BC-08-01：200 但回执不可识别（无 status）→ 按可重试处理，待同步项保留不删', async () => {
  storage.clear();
  const requests = bridge(() => ({ok: true})); // 形状不符的 2xx：不是四种回执之一
  const outcome = await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-unknown'});
  assert.equal(outcome.status, 'retry');
  assert.equal(pending().length, 1, '不可识别的回执不删除本地项（不能假定服务端已收）');
  assert.equal(requests.length, 1);
  // 桥恢复成合法回执后一次 flush 清掉。
  bridge(input => ({status: 'accepted', event_id: input.body.event_id}));
  const after = await flushEventQueue(CONFIG);
  assert.deepEqual(after, {pending: 0, retried: 1, removed: 1});
});

test('BC-08-03：flush 中 duplicate 与 accepted 都是终态、继续处理后续项', async () => {
  storage.clear();
  bridge(() => { throw Error('网络失败'); }); // 入队阶段暂时失败，两项留队
  await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-dup-mid'});
  await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-acc-mid'});
  assert.equal(pending().length, 2);
  bridge(input => {
    if (input.body.event_id === 'evt-dup-mid') return {status: 'duplicate', event_id: 'evt-dup-mid'};
    return {status: 'accepted', event_id: input.body.event_id, received_seq: 7};
  });
  const outcome = await flushEventQueue(CONFIG);
  assert.deepEqual(outcome, {pending: 0, retried: 2, removed: 2});
  assert.deepEqual(pending(), []);
  assert.equal(readEventFailures().length, 0, 'duplicate/accepted 不算失败状态');
});

test('BC-08-02：flush 首项暂时性失败即停，队列原样保留、顺序不重排', async () => {
  storage.clear();
  bridge(() => { throw Error('网络失败'); });
  await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-stop-1'});
  await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-stop-2'});
  bridge(input => {
    if (input.body.event_id === 'evt-stop-1') throw Error('网络失败');
    return {status: 'accepted', event_id: input.body.event_id};
  });
  const outcome = await flushEventQueue(CONFIG);
  assert.deepEqual(outcome, {pending: 2, retried: 1, removed: 0}, '第一项失败即停，第二项不跳发（至少一次、保序）');
  assert.deepEqual(pending().map(item => item.event_id), ['evt-stop-1', 'evt-stop-2']);
});

test('BC-08-03：终态删除后同号重发 → 服务端答 duplicate，再删除（重发不产生重复工作）', async () => {
  storage.clear();
  bridge(() => ({status: 'accepted', event_id: 'evt-resend'}));
  const first = await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-resend'});
  assert.equal(first.status, 'accepted');
  assert.deepEqual(pending(), []);
  // 同号重发（客户端换了机器/队列已清但服务端已收）：再入队 → 服务端 duplicate → 删除。
  const requests = bridge(input => ({status: 'duplicate', event_id: input.body.event_id}));
  const second = await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-resend'});
  assert.equal(second.status, 'duplicate');
  assert.equal(requests.length, 1, '同号重发确实发到了服务端');
  assert.deepEqual(pending(), []);
  assert.equal(readEventFailures().length, 0);
});

test('失败状态有上限（50 条），只记不重试', async () => {
  storage.clear();
  let n = 0;
  bridge(() => {
    n += 1;
    const error = Error('rejected');
    error.receipt = {status: 'rejected', event_id: `evt-cap-${String(n).padStart(3, '0')}`, reason: 'invalid_envelope'};
    throw error;
  });
  for (let index = 0; index < 55; index += 1) {
    await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: `evt-cap-${String(index + 1).padStart(3, '0')}`});
  }
  const failures = readEventFailures();
  assert.equal(failures.length, 50);
  assert.equal(failures[0].event_id, 'evt-cap-055', '最新的在前');
  assert.deepEqual(pending(), [], '被拒项全部终态删除');
});

test('BC-08-02：坏信封（缺 task_id 的完成反馈）不入队、不发网、无失败状态', async () => {
  storage.clear();
  const requests = bridge(() => ({status: 'accepted'}));
  const outcome = await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-notask', event_type: 'along.message',
    kind: 'task.completed', payload: {event_type: 'along.message', kind: 'task.completed'}});
  assert.equal(outcome.ok, false);
  assert.ok(outcome.reason);
  assert.deepEqual(pending(), []);
  assert.equal(readEventFailures().length, 0);
  assert.equal(requests.length, 0);
});
