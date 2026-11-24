import test from 'node:test';
import assert from 'node:assert/strict';

// 事件待同步队列（docs/stage-a-tech-design.md §2.2.7，SD-4：队列落 web 层、协议层组件）。
// BC-08-01：收到持久回执才从待同步队列删除；BC-08-02：失败本地保留、同一份信封同号重试、成功才删，
// rejected/conflict 是终态（删除并记失败状态，重发不会变成 accepted / 只会继续冲突）。
// 信封校验与 Along Agent（along-superagent）tests/along-inbox.spec.ts 共用同一组静态向量（SD-1/SG-1）：
// 两端对每个向量必须给出相同的接受/拒绝结论；改协议先改两处向量。

// web 模块按浏览器语义引用 window/localStorage：在导入前植入替身（node --test 每个文件独立进程）。
const storage = new Map();
globalThis.localStorage = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: key => { storage.delete(key); },
};
globalThis.window = {};
const {assembleEnvelope, validateEnvelope, newEventId, EVENT_SCHEMA_VERSION, EVENT_TYPES, MESSAGE_KINDS, HEALTH_SUMMARY_TYPES} =
  await import(new URL('../web/event-envelope.mjs', import.meta.url));
const {queueEvent, flushEventQueue, readEventFailures, EVENT_QUEUE_KEY, EVENT_FAILED_KEY, readStored,bindEventAuthority,retireEventAuthority} =
  await import(new URL('../web/agent-client.mjs', import.meta.url));

const CONFIG = {baseURL: 'https://192.168.8.2:4176', fingerprint: 'a'.repeat(64), token: 'b'.repeat(64)};

function bridge(handler) {
  const requests = [];
  window.AlongAgentBridge = {request: async input => { requests.push(input); return handler(input); }};
  return requests;
}
function noBridge() { window.AlongAgentBridge = undefined; }
const pending = () => readStored(EVENT_QUEUE_KEY, []);

const USER_MESSAGE = () => ({
  event_type: 'along.user_message',
  occurred_at: '2026-11-15T08:30:00+08:00',
  timezone: 'Asia/Shanghai',
  payload: {event_type: 'along.user_message', text: '帮我把目标改成 180 分钟'},
});

// ---- 静态用例向量（与 Along Agent tests/along-inbox.spec.ts 同一组：[名字, 信封, 是否合法]）--------------------

const VECTOR = {
  event_id: 'evt-vector-0001', schema_version: '1', event_type: 'along.user_message',
  goal_id: 'g_vector000001', occurred_at: '2026-11-15T08:30:00+08:00', timezone: 'Asia/Shanghai',
  message_id: 'msg-vector-001', payload: {event_type: 'along.user_message', text: '把目标改成 180 分钟'},
};
const VECTOR_CASES = [
  ['基准 user_message 合法', VECTOR, true],
  ['健康摘要（带窗口）合法', {...VECTOR, event_id: 'evt-vector-0002', event_type: 'along.health_summary_updated',
    payload: {event_type: 'along.health_summary_updated', summaries: [{type: 'steps', metric_version: 'mv1', unit: '步',
      statistic: 'sum', window: {start: '2026-11-14T00:00:00+08:00', end: '2026-11-15T00:00:00+08:00'}, timezone: 'Asia/Shanghai',
      value: 5200, availability: 'ok', summarizer_version: 'summarizer-7'}]}}, true],
  ['task.completed 反馈合法', {...VECTOR, event_id: 'evt-vector-0003', event_type: 'along.message', kind: 'task.completed',
    task_id: 't_vector00001', payload: {event_type: 'along.message', kind: 'task.completed', task_id: 't_vector00001', note: '已完成'}}, true],
  ['authorization.changed 无业务载荷合法', {...VECTOR, event_id: 'evt-vector-0004', event_type: 'along.message',
    kind: 'authorization.changed', payload: {event_type: 'along.message', kind: 'authorization.changed'}}, true],
  ['schema_version 漂移拒绝', {...VECTOR, schema_version: '2'}, false],
  ['目标变更事件拒绝（D4：目标只能通过聊天改变）', {...VECTOR, event_type: 'along.goal.updated'}, false],
  ['未知 event_type 拒绝', {...VECTOR, event_type: 'along.unknown'}, false],
  ['user_message 带散落 kind 拒绝', {...VECTOR, kind: 'task.completed'}, false],
  ['envelope.kind 与 payload.kind 不一致拒绝', {...VECTOR, event_id: 'evt-vector-0005', event_type: 'along.message',
    kind: 'task.feedback', task_id: 't_vector00001', payload: {event_type: 'along.message', kind: 'task.completed', task_id: 't_vector00001'}}, false],
  ['task.completed 缺 task_id 拒绝', {...VECTOR, event_id: 'evt-vector-0006', event_type: 'along.message', kind: 'task.completed',
    payload: {event_type: 'along.message', kind: 'task.completed'}}, false],
  ['authorization.changed 带业务载荷拒绝', {...VECTOR, event_id: 'evt-vector-0007', event_type: 'along.message',
    kind: 'authorization.changed', payload: {event_type: 'along.message', kind: 'authorization.changed', note: '撤回'}}, false],
  ['摘要自报 adapter 拒绝（服务端派生）', {...VECTOR, event_id: 'evt-vector-0008', event_type: 'along.health_summary_updated',
    payload: {event_type: 'along.health_summary_updated', summaries: [{type: 'steps', metric_version: 'mv1', timezone: 'Asia/Shanghai',
      availability: 'ok', summarizer_version: 's1', adapter: 'known'}]}}, false],
  ['摘要带原始样本拒绝（健康只发汇总值）', {...VECTOR, event_id: 'evt-vector-0009', event_type: 'along.health_summary_updated',
    payload: {event_type: 'along.health_summary_updated', summaries: [{type: 'steps', metric_version: 'mv1', timezone: 'Asia/Shanghai',
      availability: 'ok', summarizer_version: 's1', samples: [{value: 1}]}]}}, false],
  ['摘要类型不在七类内仍合法（保存为待适配）', {...VECTOR, event_id: 'evt-vector-0010', event_type: 'along.health_summary_updated',
    payload: {event_type: 'along.health_summary_updated', summaries: [{type: 'blood_oxygen', metric_version: 'mv1', timezone: 'Asia/Shanghai',
      availability: 'no_permission', summarizer_version: 's1'}]}}, true],
  ['信封自称身份拒绝（user_id 只由配对会话绑定）', {...VECTOR, user_id: 'u_other001'}, false],
  ['空格原话拒绝', {...VECTOR, payload: {event_type: 'along.user_message', text: '   '}}, false],
  ['原话超长拒绝', {...VECTOR, payload: {event_type: 'along.user_message', text: '长'.repeat(801)}}, false],
  ['空摘要数组拒绝', {...VECTOR, event_id: 'evt-vector-0011', event_type: 'along.health_summary_updated',
    payload: {event_type: 'along.health_summary_updated', summaries: []}}, false],
  ['occurred_at 非时间拒绝', {...VECTOR, occurred_at: 'not-a-time'}, false],
  ['payload.event_type 与顶层错配拒绝', {...VECTOR, event_type: 'along.health_summary_updated'}, false],
];

test('SD-1/SG-1：向量两端同判，范围常量与 Along Agent 一致', () => {
  for (const [name, envelope, expected] of VECTOR_CASES) {
    assert.equal(validateEnvelope(envelope) === null, expected, `向量「${name}」的判定与 Along Agent 端不一致`);
  }
  assert.equal(EVENT_SCHEMA_VERSION, '1');
  assert.deepEqual(EVENT_TYPES, ['along.user_message', 'along.health_summary_updated', 'along.message']);
  assert.deepEqual(MESSAGE_KINDS, ['task.completed', 'task.feedback', 'authorization.changed']);
  assert.deepEqual(HEALTH_SUMMARY_TYPES,
    ['steps', 'workout', 'active_energy', 'weight', 'resting_heart_rate', 'wrist_temperature', 'sleep']);
});

test('assembleEnvelope 补齐版本与稳定事件号，坏信封不入队', () => {
  const assembled = assembleEnvelope(USER_MESSAGE());
  assert.equal(assembled.ok, true);
  assert.equal(assembled.envelope.schema_version, '1');
  assert.match(assembled.envelope.event_id, /^evt-[0-9a-z-]+$/);
  assert.equal(assembleEnvelope({...USER_MESSAGE(), schema_version: '2'}).ok, false);
  const bad = assembleEnvelope({...USER_MESSAGE(), user_id: 'u_other001'});
  assert.equal(bad.ok, false);
  assert.ok(bad.reason);
  assert.equal(newEventId().length <= 100, true);
});

// ---- 队列处置口径（BC-08-01/02/03）---------------------------------------------------------------------

test('BC-08-01：200 accepted 到达才从待同步队列删除，回执原样返回', async () => {
  storage.clear();
  const requests = bridge(input => ({status: 'accepted', event_id: input.body.event_id, received_seq: 4}));
  const outcome = await queueEvent(CONFIG, USER_MESSAGE());
  assert.deepEqual(outcome, {ok: true, event_id: outcome.event_id, queued: true, status: 'accepted', received_seq: 4});
  assert.deepEqual(pending(), [], '回执到达后本地项删除');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/events');
  assert.equal(requests[0].body.event_id, outcome.event_id);
});

test('BC-08-02：网络失败本地保留，同一份序列化信封同号重试，成功才删', async () => {
  storage.clear();
  let attempts = 0;
  const requests = bridge(() => {
    attempts += 1;
    if (attempts <= 1) throw Error('连接 Mac 失败');
    return {status: 'accepted', event_id: 'evt-retry', received_seq: 9};
  });
  const first = await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-retry'});
  assert.equal(first.status, 'retry');
  assert.equal(pending().length, 1, '失败保留待同步项');
  const second = await flushEventQueue(CONFIG);
  assert.deepEqual(second, {pending: 0, retried: 1, removed: 1});
  assert.deepEqual(pending(), []);
  assert.equal(requests.length, 2);
  // 重试复用同一份信封：body 逐字段相同（不重新组包，payload_hash 才稳定，§2.2.7）。
  assert.deepEqual(requests[1].body, requests[0].body);
  assert.equal(requests[1].body.event_id, 'evt-retry');
});

test('BC-08-02：401/5xx 与无桥可走都保留待同步项，不丢原文', async () => {
  storage.clear();
  bridge(() => { const error = Error('请先配对这台 Mac'); error.receipt = undefined; throw error; });
  const outcome = await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-401'});
  assert.equal(outcome.status, 'retry');
  assert.equal(pending().length, 1);
  noBridge();
  const offline = await flushEventQueue(CONFIG);
  assert.equal(offline.removed, 0);
  assert.equal(pending().length, 1, '网络失败保留，原文不丢');
  const kept = pending()[0];
  assert.equal(kept.envelope.payload.text, '帮我把目标改成 180 分钟');
});

test('BC-08-02：400 rejected 终止重试并删除本地项，失败状态本地可查', async () => {
  storage.clear();
  bridge(() => {
    const error = Error('rejected');
    error.receipt = {status: 'rejected', event_id: 'evt-rej', reason: 'invalid_envelope'};
    throw error;
  });
  const outcome = await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-rej'});
  assert.deepEqual(outcome, {ok: true, event_id: 'evt-rej', queued: true, status: 'rejected', reason: 'invalid_envelope'});
  assert.deepEqual(pending(), [], '被拒事件不再重试');
  assert.deepEqual(readEventFailures(),
    [{event_id: 'evt-rej', status: 'rejected', reason: 'invalid_envelope', at: readEventFailures()[0].at}]);
  // 被拒事件重发不会变成 accepted：flush 队列已空，不再发送。
  const after = await flushEventQueue(CONFIG);
  assert.deepEqual(after, {pending: 0, retried: 0, removed: 0});
});

test('BC-08-02：409 conflict 同号不同内容是终态，删除本地项并记录', async () => {
  storage.clear();
  bridge(() => {
    const error = Error('conflict');
    error.receipt = {status: 'conflict', event_id: 'evt-conf'};
    throw error;
  });
  const outcome = await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-conf'});
  assert.equal(outcome.status, 'conflict');
  assert.deepEqual(pending(), []);
  assert.equal(readEventFailures()[0].status, 'conflict');
});

test('BC-08-03：200 duplicate 也删除本地项（服务端已收，不产生重复工作）', async () => {
  storage.clear();
  bridge(() => ({status: 'duplicate', event_id: 'evt-dup'}));
  const outcome = await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-dup'});
  assert.equal(outcome.status, 'duplicate');
  assert.deepEqual(pending(), []);
});

test('flush 按入队顺序处置：终态继续、暂时性失败即停，顺序不重排', async () => {
  storage.clear();
  bridge(() => { throw Error('网络失败'); }); // 入队阶段全部暂时失败，只留队不发成功
  await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-order-1'});
  await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-order-2'});
  await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-order-3'});
  assert.equal(pending().length, 3);
  bridge(input => {
    if (input.body.event_id === 'evt-order-1') {
      const error = Error('rejected');
      error.receipt = {status: 'rejected', event_id: 'evt-order-1', reason: 'invalid_envelope'};
      throw error;
    }
    throw Error('网络失败');
  });
  const first = await flushEventQueue(CONFIG);
  assert.deepEqual(first, {pending: 2, retried: 2, removed: 1}, '被拒项删除后继续，网络失败即停');
  assert.deepEqual(pending().map(item => item.event_id), ['evt-order-2', 'evt-order-3'], '顺序保持');
  assert.equal(readEventFailures()[0].event_id, 'evt-order-1');
  // 桥恢复后一次 flush 清空剩余项。
  bridge(input => ({status: 'accepted', event_id: input.body.event_id}));
  const second = await flushEventQueue(CONFIG);
  assert.deepEqual(second, {pending: 0, retried: 2, removed: 2});
});

test('同号不重复入队（服务端可能已见过第一份信封），缺号时生成稳定新号', async () => {
  storage.clear();
  bridge(() => { throw Error('网络失败'); });
  const first = await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-same'});
  assert.equal(first.queued, true);
  const second = await queueEvent(CONFIG, {...USER_MESSAGE(), event_id: 'evt-same'});
  assert.deepEqual(second, {ok: true, event_id: 'evt-same', queued: false});
  assert.equal(pending().length, 1, '同号只保留第一份信封');
  const generated = await queueEvent(CONFIG, USER_MESSAGE());
  assert.equal(generated.ok, true);
  assert.match(generated.event_id, /^evt-/);
  assert.equal(pending().length, 2);
});

test('校验不合格的信封不入队：发了也只会被拒，重试没有意义', async () => {
  storage.clear();
  const requests = bridge(() => ({status: 'accepted'}));
  const outcome = await queueEvent(CONFIG, {...USER_MESSAGE(), user_id: 'u_other001'});
  assert.equal(outcome.ok, false);
  assert.deepEqual(pending(), []);
  assert.equal(readEventFailures().length, 0, '未入队也没有失败状态');
  assert.equal(requests.length, 0);
});

test('wrong receipt identity and an altered same-id envelope never delete the durable event',async()=>{
  storage.clear();bridge(()=>({status:'accepted',event_id:'wrong-id'}));
  const first=await queueEvent(CONFIG,{...USER_MESSAGE(),event_id:'exact-event'});assert.equal(first.status,'retry');assert.equal(pending().length,1);
  bridge(()=>{const rows=pending();rows[0].envelope.payload.text='legitimate replacement';localStorage.setItem(EVENT_QUEUE_KEY,JSON.stringify(rows));
    return {status:'accepted',event_id:'exact-event'};});
  await flushEventQueue(CONFIG);assert.equal(pending().length,1);assert.equal(pending()[0].envelope.payload.text,'legitimate replacement');
});
test('retired Mac ACK cannot delete cloud authority queue; new cloud duplicate receipt can',async()=>{
  storage.clear();const old={...CONFIG,userId:'u_queue0001'},next={...old,baseURL:'https://cloud.example.com',token:'c'.repeat(64)};
  bindEventAuthority(old);let release,started;
  const began=new Promise(resolve=>started=resolve),held=new Promise(resolve=>release=resolve);
  bridge(async input=>{started();await held;return {status:'accepted',event_id:input.body.event_id};});
  const pendingSend=queueEvent(old,{...USER_MESSAGE(),event_id:'handoff-in-flight'});
  await began;retireEventAuthority(old);bindEventAuthority(next);release();await pendingSend;
  const {pendingEvents}=await import('../web/agent-client.mjs');assert.equal(pendingEvents(next).length,1);
  bridge(input=>({status:'duplicate',event_id:input.body.event_id}));await flushEventQueue(next);assert.equal(pendingEvents(next).length,0);
  retireEventAuthority(next);
});
