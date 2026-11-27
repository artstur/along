import {assembleEnvelope} from './event-envelope.mjs?v=102';

export const AGENT_KEY = 'along.agent.v1';
export const GOALS_KEY = 'along.goal-custom.v1';
export const CONVERSATIONS_KEY = 'along.goal-conversations.v1';
// 事件待同步队列（docs/stage-a-tech-design.md §2.2.7，SD-4：队列落 web 层，协议层组件、不接任何 UI）。
// pending 存序列化信封本身：重试复用同一份信封、不重新组包，payload_hash 才稳定（同号重试不被误判
// conflict，001 §4.3）。failed 记录终态回执（rejected/conflict），让「已登记但被拒」本地可查。
export const EVENT_QUEUE_KEY = 'along.events.pending.v1';
export const EVENT_FAILED_KEY = 'along.events.failed.v1';
const EVENT_FAILED_LIMIT = 50;

export function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function writeStored(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export async function agentCall(config, path, body) {
  if (!window.AlongAgentBridge?.request) throw Error('请在 iPhone 的 Along App 中连接 Along');
  if (!config?.baseURL) throw Error('请先完成 Along 连接设置');
  if (path !== '/pair' && !config.token) throw Error('请先连接 Along');
  // 叶指纹只在旧 pin 形态（Mac 私网）需要；云端系统信任形态由原生判定策略，不靠网页上报指纹。
  // bindingScopeId 是稳定的归属标识，不是凭证，也不发给模型。
  const payload = {
    baseURL: config.baseURL,
    path,
    token: config.token ?? '',
    body,
  };
  if (config.fingerprint) payload.fingerprint = config.fingerprint;
  if (config.bindingScopeId) payload.bindingScopeId = config.bindingScopeId;
  return window.AlongAgentBridge.request(payload);
}

// ---- 事件待同步队列（BC-08-01/02 的客户端断言）----------------------------------------------------------

const eventKey = (base, config) => config?.userId ? `${base}:${config.userId}` : base;
const eventAuthorities=new Map();
const authority=config=>JSON.stringify([config?.baseURL,config?.bindingScopeId,config?.token]);
export function bindEventAuthority(config) {eventAuthorities.set(config.userId,authority(config));}
export function retireEventAuthority(config) {
  if(eventAuthorities.get(config.userId)===authority(config))eventAuthorities.set(config.userId,null);
}
export function pendingEvents(config) { return readStored(eventKey(EVENT_QUEUE_KEY,config), []); }

function dropPending(eventId,config,envelope) {
  writeStored(eventKey(EVENT_QUEUE_KEY,config), pendingEvents(config).filter(item => item.event_id !== eventId||JSON.stringify(item.envelope)!==envelope));
}

function recordFailure(eventId, receipt,config) {
  const failures = readStored(eventKey(EVENT_FAILED_KEY,config), []);
  failures.unshift({event_id:eventId, status:receipt?.status, reason:receipt?.reason, at:new Date().toISOString()});
  writeStored(eventKey(EVENT_FAILED_KEY,config), failures.slice(0, EVENT_FAILED_LIMIT));
}

/**
 * 发送一个待同步项并按回执处置（§2.2.7）：
 * - 200 accepted|duplicate → 删除本地项（重复回执也是成功：服务端已收，BC-08-03）；
 * - 400 rejected / 409 conflict → 终止重试并删除本地项，失败状态记入 EVENT_FAILED_KEY 可查
 *   （被拒事件重发不会变成 accepted，同号不同内容重发只会继续冲突）；
 * - 401/404/5xx 与网络失败 → 保留待同步项，等下一次 flush 用同一份信封同号重试（BC-08-02）。
 * iOS 桥把非 2xx 的回执体挂在 Error.receipt 上（仅协议层透传，不带状态码时一律按可重试处理）。
 */
async function sendQueuedEvent(config, item) {
  const envelope=JSON.stringify(item.envelope);
  let receipt;
  try {
    receipt = await agentCall(config, '/events', item.envelope);
  } catch (error) {
    receipt = error?.receipt;
    if (receipt?.status !== 'rejected' && receipt?.status !== 'conflict') {
      return {event_id:item.event_id, status:'retry', error:error?.message ?? '网络失败'};
    }
  }
  // A reply from the retired Mac must not acknowledge the new cloud authority's queue.
  // The exact current envelope is re-read as well, so a same-id replacement is never lost.
  if(eventAuthorities.has(config.userId)&&eventAuthorities.get(config.userId)!==authority(config)||
    !pendingEvents(config).some(row=>row.event_id===item.event_id&&JSON.stringify(row.envelope)===envelope))
    return {event_id:item.event_id,status:'retry',error:'投递归属或事件已更新'};
  if(receipt?.event_id!==item.event_id)return {event_id:item.event_id,status:'retry',error:'回执事件不匹配'};
  if (receipt?.status === 'accepted' || receipt?.status === 'duplicate') {
    dropPending(item.event_id,config,envelope);
    return {event_id:item.event_id, status:receipt.status, ...(receipt.received_seq !== undefined ? {received_seq:receipt.received_seq} : {})};
  }
  if (receipt?.status === 'rejected' || receipt?.status === 'conflict') {
    recordFailure(item.event_id, receipt,config);
    dropPending(item.event_id,config,envelope);
    return {event_id:item.event_id, status:receipt.status, reason:receipt.reason};
  }
  return {event_id:item.event_id, status:'retry', error:'回执不可识别'};
}

/**
 * 信封入队并立即尝试投递一次。信封先经共享校验（event-envelope.mjs）：不合格不入队（发了也只会被
 * 拒，重试没有意义）；缺 event_id 时生成稳定新号；同号已在队中时不重复入队（服务端可能已见过第一份
 * 序列化信封，换内容只会把 duplicate 变 conflict）。真机页面接线随阶段 B 迁移切换，本阶段不接 UI。
 */
export async function queueEvent(config, envelope, {send=true}={}) {
  const assembled = assembleEnvelope(envelope);
  if (!assembled.ok) return {ok:false, reason:assembled.reason};
  const {envelope:safe} = assembled;
  const queued = pendingEvents(config);
  if (queued.some(item => item.event_id === safe.event_id)) return {ok:true, event_id:safe.event_id, queued:false};
  queued.push({event_id:safe.event_id, envelope:safe});
  writeStored(eventKey(EVENT_QUEUE_KEY,config), queued);
  if (!send) return {ok:true,event_id:safe.event_id,queued:true,status:'pending'};
  const outcome = await sendQueuedEvent(config, {event_id:safe.event_id, envelope:safe});
  return {ok:true, event_id:safe.event_id, queued:true, ...outcome};
}

/**
 * 按入队顺序重投待同步项（同一份序列化信封、同一 event_id）。终态回执（accepted/duplicate/rejected/
 * conflict）继续处理后续项；遇到需要保留重试的暂时性失败即停止，保持顺序与至少一次语义。
 */
export async function flushEventQueue(config) {
  let removed = 0, retried = 0;
  for (const item of pendingEvents(config)) {
    const outcome = await sendQueuedEvent(config, item);
    retried += 1;
    if (outcome.status === 'retry') break;
    removed += 1;
  }
  return {pending:pendingEvents(config).length, retried, removed};
}

/** 本地失败状态（被拒/冲突回执），供排查「为什么没有生效」；只记录、不提供任何重试入口。 */
export function readEventFailures(config) {
  return readStored(eventKey(EVENT_FAILED_KEY,config), []);
}

export async function loadNativeConnection() {
  if (!window.AlongAgentBridge?.connection) return null;
  return window.AlongAgentBridge.connection('load');
}

export async function saveNativeConnection(config) {
  if (!window.AlongAgentBridge?.connection) return null;
  // 原生会补上 trustPolicy 与 bindingScopeId（docs/iphone-ca-profile-design.md §2.2），
  // 网页必须用原生确认过的值，而不是自己猜出来的。
  return window.AlongAgentBridge.connection('save', config);
}
