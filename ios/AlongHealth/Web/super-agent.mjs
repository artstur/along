export const SUPER_AGENT_RUNS_KEY = 'along.super-agent-runs.v2';

const TASK_STATES = new Set(['temporary', 'planned', 'deferred']);
const DOMAINS = new Set(['health', 'finance', 'custom']);

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

export function createPendingSuperAgentRun(request, createdAt=Date.now()) {
  return {
    version:2,actual:false,runtime:'dsh-superagent',requestId:request.requestId,task:request.task,
    source:{kind:'along',label:'Along 动态任务'},trigger:{kind:'dynamic-task',label:'正在提交给 DSH'},
    eval:null,ticket:null,mandate:null,assignments:[],events:[],status:'working',statusLabel:'连接 DSH Super Agent',progress:2,
    createdAt,updatedAt:createdAt,
  };
}

export function createFailedSuperAgentRun(request, error, updatedAt=Date.now()) {
  return {...createPendingSuperAgentRun(request,updatedAt),status:'blocked',statusLabel:'DSH 暂不可用',error:cleanText(error,'DSH Super Agent 请求失败',500),updatedAt};
}

export function safeSuperAgentRun(value) {
  if (!value || value.runtime!=='dsh-superagent' || typeof value.requestId!=='string') return null;
  if (value.actual===true && (!value.source || !value.trigger || !Array.isArray(value.assignments) || !Array.isArray(value.events))) return null;
  if (value.version===2 || value.actual===true) return value;
  return null;
}
