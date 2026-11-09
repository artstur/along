export const SUPER_AGENT_RUNS_KEY = 'along.super-agent-runs.v2';
export const GOAL_SUPER_AGENT_RUNS_KEY = 'along.goal-super-agent-runs.v1';
export const AGENT_RUNTIME_KEY = 'along.agent-runtime.v1';
export const DSH_RUNTIME = 'dsh-superagent';
export const KIMI_RUNTIME = 'kimi-code-swarm';
// 一次运行最多等这么久：读得到就读，读不到也到这个期限就明确停住，不让界面永远转圈。
export const AGENT_RUN_TIMEOUT_MS = 30*60_000;

const TASK_STATES = new Set(['temporary', 'planned', 'deferred']);
const DOMAINS = new Set(['health', 'finance', 'custom']);
const RUNTIMES = new Set([DSH_RUNTIME, KIMI_RUNTIME]);

export function safeAgentRuntime(value) { return RUNTIMES.has(value)?value:DSH_RUNTIME; }
export function agentRuntimeLabel(runtime) { return safeAgentRuntime(runtime)===KIMI_RUNTIME?'Kimi Swarm':'DSH Agents'; }

// App 内置页面走 along:// 自定义 scheme，不是安全上下文，crypto.randomUUID 可能不存在。
// 这些 id 只用于本机把一次请求和一次结果对上，不需要密码学强度。
export function newId(prefix='id') {
  const uuid=globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid??`${Date.now().toString(36)}-${Math.random().toString(36).slice(2).padEnd(8,'0')}`}`;
}
function runtimeCopy(runtime) {
  return safeAgentRuntime(runtime)===KIMI_RUNTIME
    ? {submit:'正在提交给 Kimi',connecting:'连接 Kimi Code Swarm',unavailable:'Kimi Swarm 暂不可用',failed:'Kimi Code Swarm 请求失败'}
    : {submit:'正在提交给 DSH',connecting:'连接 DSH Super Agent',unavailable:'DSH 暂不可用',failed:'DSH Super Agent 请求失败'};
}

function cleanText(value, fallback, max=180) {
  const text=String(value ?? fallback).trim();
  return (text || fallback).slice(0,max);
}
// 只有字符串和数字算文本：对象、数组、布尔都不是。
// 用 String() 兜底会把对象变成 "[object Object]"——那种脏文本会直接显示在用户界面上。
function isText(value) { return typeof value==='string' || (typeof value==='number' && Number.isFinite(value)); }
// 一条工作记录：没有可读文本就不进时间线——它本来就不该出现在那里。
function cleanEvent(event) {
  if (!event || typeof event!=='object') return null;
  return isText(event.text) ? event : null;
}
// 一个协作单元：类型不对的文本换成占位说明，不让脏文本冒充它的说明。
function cleanAgent(agent) {
  if (!agent || typeof agent!=='object') return null;
  const next={...agent};
  let changed=false;
  if (next.objective!=null && !isText(next.objective)) { next.objective='未提供说明'; changed=true; }
  if (next.work!=null && !isText(next.work)) { next.work=''; changed=true; }
  // 状态标签直接渲染 agent.status：类型不对就不能当成状态显示出去。
  if (next.status!=null && !isText(next.status)) { next.status=''; changed=true; }
  if (next.report && typeof next.report==='object' && next.report.summary!=null && !isText(next.report.summary)) {
    next.report={...next.report,summary:''};
    changed=true;
  }
  return changed ? next : agent;
}
// 授权边界：两种运行时给回来的形状不一样（字符串或对象），渲染层两种都读。
// 类型不对的子字段直接删掉，让渲染层自己的兜底接手。
function cleanMandate(mandate) {
  if (mandate==null) return mandate;
  if (typeof mandate==='string') return mandate;
  if (typeof mandate!=='object') return null;
  const next={...mandate};
  let changed=false;
  if (next.scope!=null && !isText(next.scope)) { delete next.scope; changed=true; }
  if (next.actor && typeof next.actor==='object' && next.actor.id!=null && !isText(next.actor.id)) {
    next.actor={...next.actor};
    delete next.actor.id;
    changed=true;
  }
  return changed ? next : mandate;
}
function sameList(left,right) { return left.length===right.length && left.every((item,index)=>item===right[index]); }
// 运行记录里会显示给人看的文本字段：类型不对的不能当成文本显示出去。
// 干净的记录原样返回——白名单不该无故换掉宿主给的记录对象。
function normalizeRunText(value, agentField) {
  const next={...value};
  let changed=false;
  if (next.statusLabel!=null && !isText(next.statusLabel)) { next.statusLabel='状态未知'; changed=true; }
  if (next.error!=null && !isText(next.error)) { delete next.error; changed=true; }
  for (const key of ['source','trigger']) {
    const part=next[key];
    if (part && typeof part==='object' && part.label!=null && !isText(part.label)) { next[key]={...part,label:'未提供说明'}; changed=true; }
  }
  if (next.ticket && typeof next.ticket==='object' && next.ticket.id!=null && !isText(next.ticket.id)) { delete next.ticket; changed=true; }
  const mandate=cleanMandate(next.mandate);
  if (mandate!==next.mandate) { next.mandate=mandate; changed=true; }
  const events=next.events.map(cleanEvent).filter(Boolean);
  if (!sameList(events,next.events)) { next.events=events; changed=true; }
  const agents=next[agentField].map(cleanAgent).filter(Boolean);
  if (!sameList(agents,next[agentField])) { next[agentField]=agents; changed=true; }
  return changed ? next : value;
}
function stableId(value) {
  let hash=2166136261;
  for (const char of String(value)) { hash^=char.codePointAt(0);hash=Math.imul(hash,16777619); }
  return (hash>>>0).toString(36);
}
function cleanTask(task) {
  if (!task || typeof task!=='object') throw Error('动态任务无效');
  return {
    id:cleanText(task.id,'task',64).replace(/[^a-z0-9_-]/gi,'-'),
    title:cleanText(task.title,'未命名任务',120),detail:cleanText(task.detail,'等待补充任务说明',1200),
    when:cleanText(task.when,'现在',120),state:TASK_STATES.has(task.state)?task.state:'temporary',
  };
}

export function createSuperAgentRequest({task,domain='health',goal=null,context={}}) {
  if (!DOMAINS.has(domain)) throw Error('任务领域无效');
  const safeTask=cleanTask(task);
  const requestId=`along-${domain}-${stableId(`${safeTask.id}:${safeTask.title}:${safeTask.detail}`)}`;
  return {requestId,task:safeTask,goal:goal?{domain,title:cleanText(goal.title,'当前目标',120),target:Number.isFinite(goal.target)?goal.target:null}:null,context};
}

export function createPendingSuperAgentRun(request, createdAt=Date.now(), runtime=DSH_RUNTIME) {
  runtime=safeAgentRuntime(runtime);
  const copy=runtimeCopy(runtime);
  return {
    version:2,actual:false,runtime,requestId:request.requestId,task:request.task,
    source:{kind:'along',label:'Along 动态任务'},trigger:{kind:'dynamic-task',label:copy.submit},
    eval:null,ticket:null,mandate:null,assignments:[],events:[],status:'working',statusLabel:copy.connecting,progress:2,
    createdAt,updatedAt:createdAt,
  };
}

export function createFailedSuperAgentRun(request, error, updatedAt=Date.now(), runtime=DSH_RUNTIME) {
  const copy=runtimeCopy(runtime);
  return {...createPendingSuperAgentRun(request,updatedAt,runtime),status:'blocked',statusLabel:copy.unavailable,error:cleanText(error,copy.failed,500),updatedAt};
}

export function safeSuperAgentRun(value) {
  if (!value || !RUNTIMES.has(value.runtime) || typeof value.requestId!=='string') return null;
  // 白名单与渲染层对「一条记录有哪些字段」的假设必须一致：渲染层直接用
  // run.source / run.trigger / run.assignments / run.events，白名单就不能
  // 放行缺这些字段的记录——哪怕它不是 actual 的那一条，否则渲染时会抛错，
  // 整个界面停在旧页面上。
  if (!value.source || !value.trigger || !Array.isArray(value.assignments) || !Array.isArray(value.events)) return null;
  if (value.version===2 || value.actual===true) return normalizeRunText(value,'assignments');
  return null;
}

export function createGoalSuperAgentRequest({domain='health',goal,snapshot={},message,history=[],requestId}={}) {
  if (!DOMAINS.has(domain)) throw Error('目标领域无效');
  const cleanMessage=cleanText(message,'',800);
  if (!cleanMessage) throw Error('请输入目标');
  const id=requestId || `along-goal-${domain}-${newId('req')}`;
  return {
    requestId:id,
    goal:{domain,title:cleanText(goal?.title,'当前目标',120),target:Number.isFinite(goal?.target)?goal.target:null},
    snapshot:snapshot && typeof snapshot==='object' ? snapshot : {},
    message:cleanMessage,
    history:Array.isArray(history)?history.slice(-12).map(item=>({role:item?.role==='assistant'?'assistant':'user',text:cleanText(item?.text,'',1200)})).filter(item=>item.text):[],
  };
}

export function createPendingGoalSuperAgentRun(request, createdAt=Date.now(), runtime=DSH_RUNTIME) {
  runtime=safeAgentRuntime(runtime);
  const copy=runtimeCopy(runtime);
  return {
    version:1,actual:false,runtime,kind:'goal',requestId:request.requestId,input:{goal:request.goal,message:request.message},
    source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:copy.submit},eval:null,ticket:null,mandate:null,
    assignments:[],agents:[],events:[],result:null,status:'working',statusLabel:copy.connecting,progress:2,createdAt,updatedAt:createdAt,
  };
}

export function createFailedGoalSuperAgentRun(request, error, updatedAt=Date.now(), runtime=DSH_RUNTIME) {
  const copy=runtimeCopy(runtime);
  const detail=cleanText(error,copy.failed,500);
  const connectionFailure=/TLS|secure connection|安全连接|certificate|证书|代理|VPN/i.test(detail);
  return {...createPendingGoalSuperAgentRun(request,updatedAt,runtime),status:'blocked',
    statusLabel:connectionFailure?'Mac 安全连接失败':copy.unavailable,error:detail,updatedAt};
}

export function safeGoalSuperAgentRun(value) {
  if (!value || value.kind!=='goal' || !RUNTIMES.has(value.runtime) || typeof value.requestId!=='string') return null;
  // 同上：渲染层会直接读 run.source / run.trigger / run.agents / run.events。
  if (!value.source || !value.trigger || !Array.isArray(value.agents) || !Array.isArray(value.events)) return null;
  return value.version===1 || value.actual===true ? normalizeRunText(value,'agents') : null;
}

// 状态读取失败时保留原因，run 继续轮询；下一次成功会覆盖掉这条错误。
// 但如果一直读不到状态（Mac 上的服务挂了），不能永远停在 working：等到期限就明确停住。
export function withRunError(run, error, now=Date.now()) {
  if (!run) return null;
  const createdAt=Number.isFinite(run.createdAt)?run.createdAt:now;
  const stalled=now-createdAt>AGENT_RUN_TIMEOUT_MS;
  return {...run,error:cleanText(error,'状态读取失败',500),...(stalled?{status:'blocked',statusLabel:'状态读取失败'}:{})};
}
