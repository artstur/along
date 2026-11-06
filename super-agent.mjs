export const SUPER_AGENT_RUNS_KEY = 'along.super-agent-runs.v2';
export const GOAL_SUPER_AGENT_RUNS_KEY = 'along.goal-super-agent-runs.v1';
export const AGENT_RUNTIME_KEY = 'along.agent-runtime.v1';
export const DSH_RUNTIME = 'dsh-superagent';
export const KIMI_RUNTIME = 'kimi-code-swarm';

const TASK_STATES = new Set(['temporary', 'planned', 'deferred']);
const DOMAINS = new Set(['health', 'finance', 'custom']);
const RUNTIMES = new Set([DSH_RUNTIME, KIMI_RUNTIME]);

export function safeAgentRuntime(value) { return RUNTIMES.has(value)?value:DSH_RUNTIME; }
export function agentRuntimeLabel(runtime) { return safeAgentRuntime(runtime)===KIMI_RUNTIME?'Kimi Swarm':'DSH Agents'; }
function runtimeCopy(runtime) {
  return safeAgentRuntime(runtime)===KIMI_RUNTIME
    ? {submit:'正在提交给 Kimi',connecting:'连接 Kimi Code Swarm',unavailable:'Kimi Swarm 暂不可用',failed:'Kimi Code Swarm 请求失败'}
    : {submit:'正在提交给 DSH',connecting:'连接 DSH Super Agent',unavailable:'DSH 暂不可用',failed:'DSH Super Agent 请求失败'};
}

function cleanText(value, fallback, max=180) {
  const text=String(value ?? fallback).trim();
  return (text || fallback).slice(0,max);
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
  if (value.actual===true && (!value.source || !value.trigger || !Array.isArray(value.assignments) || !Array.isArray(value.events))) return null;
  if (value.version===2 || value.actual===true) return value;
  return null;
}

export function createGoalSuperAgentRequest({domain='health',goal,snapshot={},message,history=[],requestId}={}) {
  if (!DOMAINS.has(domain)) throw Error('目标领域无效');
  const cleanMessage=cleanText(message,'',800);
  if (!cleanMessage) throw Error('请输入目标');
  const id=requestId || `along-goal-${domain}-${crypto.randomUUID()}`;
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
  if (value.actual===true && (!value.source || !value.trigger || !Array.isArray(value.agents) || !Array.isArray(value.events))) return null;
  return value.version===1 || value.actual===true ? value : null;
}
