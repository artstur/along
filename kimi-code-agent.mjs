import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {validateGoalReply} from './goal-agent-core.mjs';
import {safeAdaptiveLayout} from './adaptive-ui.mjs';
import {KIMI_RUNTIME} from './super-agent.mjs';

const DEFAULT_URL='http://127.0.0.1:58627';
const DEFAULT_TOKEN_PATH=join(homedir(),'.kimi-code','server.token');
const DEFAULT_STATE_PATH=join(homedir(),'.along','agent-host','kimi-runs.json');

function clean(value,fallback='',max=500) { return String(value??fallback).trim().slice(0,max)||fallback; }
function timestamp(value,fallback=Date.now()) {
  const parsed=typeof value==='number'?value:Date.parse(value);
  return Number.isFinite(parsed)?parsed:fallback;
}
function textFromMessage(message) {
  return Array.isArray(message?.content)?message.content.filter(part=>part?.type==='text').map(part=>part.text).join('\n').trim():'';
}
function jsonFromText(text) {
  const source=String(text??'').trim();
  const fenced=source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates=[fenced,source,source.slice(source.indexOf('{'),source.lastIndexOf('}')+1)].filter(Boolean);
  for (const candidate of candidates) { try { return JSON.parse(candidate); } catch { /* Try the next representation. */ } }
  return null;
}
function goalPrompt(input) {
  return `You are the main Kimi Code session for Along. Swarm mode is enabled. You MUST use Agent Swarm and delegate in parallel to at least three real subagents with distinct roles: goal strategist, constraint/risk reviewer, and dynamic-task designer. Synthesize their work yourself.

This is planning only. Do not edit files, run shell commands, browse private data, publish, pay, delete, or perform any external action. Only use the information below.

Along input:
${JSON.stringify({goal:input.goal,snapshot:input.snapshot,message:input.message,history:input.history})}

Return one final JSON object only, without markdown. It must contain:
{"reply":"Chinese response","proposal":{"active":true,"title":"goal title","target":number_or_null,"task":"next step","reason":"reason"},"layout":{"version":1,"title":"space title","badge":"status","summary":"summary","modules":[...],"tasks":[...],"questions":[...]}}
Every module must contain all fields: kind, id, title, content, facts, chips, source, target, unit, note. Use null or empty arrays for unused fields. Module kind is summary, fact_list, chips, or metric. Each task has id, when, title, detail, state (temporary|planned|deferred). Preserve any explicit number, deadline, preference and constraint from the user. Keep all user-facing text in Chinese.`;
}
function taskPrompt(input) {
  return `You are the main Kimi Code session for Along. Swarm mode is enabled. Use Agent Swarm and delegate this dynamic task to at least two real subagents with distinct planning and review roles.

Planning only: do not edit files, run shell commands, publish, pay, delete, or perform external actions.

Along task:
${JSON.stringify(input)}

Return one final JSON object only: {"summary":"Chinese delivery summary","next":"concrete next action"}.`;
}
function childAgent(child,index) {
  const failed=child.last_turn_reason==='failed';
  const done=!child.busy && child.last_turn_reason==='completed';
  const status=failed?'blocked':done?'done':child.busy?'working':'queued';
  return {
    id:child.id||`kimi-child-${index+1}`,
    name:clean(child.title,`Kimi Subagent ${index+1}`,80),
    role:'Subagent',status,
    objective:clean(child.last_prompt,'处理 Main Session 分配的并行子任务。',240),
    work:status==='working'?'正在并行工作':status==='done'?'已向 Main Session 回传结果':status==='blocked'?'子任务执行失败':'等待启动',
    progress:status==='done'?100:status==='working'?55:status==='blocked'?85:0,
    report:status==='done'?{summary:'结果已回传给 Kimi Main Session'}:null,
  };
}

export class KimiCodeAgent {
  constructor({baseURL=process.env.ALONG_KIMI_CODE_URL||DEFAULT_URL,token=process.env.ALONG_KIMI_CODE_TOKEN,tokenPath=DEFAULT_TOKEN_PATH,statePath=DEFAULT_STATE_PATH,workspace=process.cwd(),model=process.env.ALONG_KIMI_CODE_MODEL||'kimi-code/kimi-for-coding',fetchImpl=fetch}={}) {
    this.baseURL=baseURL.replace(/\/$/,'');this.token=token;this.tokenPath=tokenPath;this.statePath=statePath;this.workspace=workspace;this.model=model;this.fetch=fetchImpl;
    this.runs={};
    try { this.runs=JSON.parse(readFileSync(this.statePath,'utf8')); } catch(error) { if (error.code!=='ENOENT') throw error; }
  }
  authToken() {
    if (this.token) return this.token;
    if (!existsSync(this.tokenPath)) throw Error('未找到 Kimi Code Web Server token；请先在 Mac 启动 `kimi web`');
    return readFileSync(this.tokenPath,'utf8').trim();
  }
  async call(path,{method='GET',value}={}) {
    let response;
    try {
      response=await this.fetch(`${this.baseURL}${path}`,{method,headers:{authorization:`Bearer ${this.authToken()}`,...(value===undefined?{}:{'content-type':'application/json'})},...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(15_000)});
    } catch(error) { throw Error(`Kimi Code Web Server 未运行：${error.message}`); }
    let envelope;
    try { envelope=await response.json(); } catch { throw Error(`Kimi Code Web Server 返回了无效响应（${response.status}）`); }
    if (!response.ok || envelope?.code!==0) throw Error(envelope?.msg||`Kimi Code 请求失败（${response.status}）`);
    return envelope.data;
  }
  save() {
    mkdirSync(dirname(this.statePath),{recursive:true,mode:0o700});
    writeFileSync(this.statePath,JSON.stringify(this.runs,null,2),{mode:0o600});
  }
  async ready() {
    const [meta,auth,user]=await Promise.all([this.call('/api/v1/meta'),this.call('/api/v1/auth'),this.call('/api/v1/oauth/userinfo')]);
    if (!meta?.features?.some(feature=>feature.name==='swarm'&&feature.state==='Active')) throw Error('Kimi Code 当前版本未启用 Swarm');
    if (!auth?.models_ready) throw Error('Kimi Code 尚未登录；请在 Mac 上完成 /login');
    if (user?.kind==='ok' && user.userInfo?.userLevelName==='Free') throw Error('当前 Kimi Free 账号不包含 Kimi Code 权限；升级 Kimi Code 套餐后即可使用 Swarm');
    return {ready:true,version:meta.server_version,swarm:true};
  }
  async start(kind,input) {
    await this.ready();
    const agentConfig={model:this.model,swarm_mode:true,permission_mode:'manual',plan_mode:false,goal_objective:kind==='goal'?input.message:input.task.title};
    const created=await this.call('/api/v1/sessions',{method:'POST',value:{title:`Along · ${kind==='goal'?input.goal.title:input.task.title}`,metadata:{cwd:this.workspace},agent_config:agentConfig}});
    const sessionId=created.id;
    await this.call(`/api/v1/sessions/${encodeURIComponent(sessionId)}/profile`,{method:'POST',value:{agent_config:agentConfig}});
    const entry={kind,sessionId,input,createdAt:Date.now()};
    this.runs[input.requestId]=entry;this.save();
    await this.call(`/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`,{method:'POST',value:{content:[{type:'text',text:kind==='goal'?goalPrompt(input):taskPrompt(input)}],model:this.model,permission_mode:'manual',plan_mode:false,swarm_mode:true,prompt_id:input.requestId}});
    return this.status(input.requestId,kind);
  }
  async startGoal(input) { return {run:await this.start('goal',input)}; }
  async startTask(input) { return {run:await this.start('task',input)}; }
  async status(requestId,expectedKind) {
    const entry=this.runs[requestId];
    if (!entry || (expectedKind&&entry.kind!==expectedKind)) throw Error('Kimi Swarm 运行记录不存在');
    const id=encodeURIComponent(entry.sessionId);
    const [session,messagesPage,childrenPage]=await Promise.all([
      this.call(`/api/v1/sessions/${id}`),this.call(`/api/v1/sessions/${id}/messages`),this.call(`/api/v1/sessions/${id}/children`),
    ]);
    const messages=messagesPage?.items||[],children=childrenPage?.items||[];
    const assistant=[...messages].reverse().find(message=>message.role==='assistant'&&textFromMessage(message));
    const output=jsonFromText(textFromMessage(assistant));
    const blocked=session.pending_interaction==='approval'||session.pending_interaction==='question'||session.last_turn_reason==='failed';
    const done=!session.busy && session.last_turn_reason==='completed' && !!assistant;
    const agents=children.map(childAgent);
    const finished=agents.filter(agent=>agent.status==='done').length;
    const progress=done?100:blocked?Math.max(12,agents.length?65:12):session.busy?Math.min(92,25+agents.length*12+finished*10):8;
    const events=[
      {at:entry.createdAt,text:'Along 已建立 Kimi Main Session'},
      {at:entry.createdAt+1,text:'Swarm Mode 已显式开启'},
      ...agents.map((agent,index)=>({at:timestamp(children[index]?.updated_at,entry.createdAt+index+2),text:`${agent.name}：${agent.work}`})),
      ...(done?[{at:timestamp(session.updated_at),text:'Main Session 已完成汇总'}]:[]),
    ];
    const common={actual:true,runtime:KIMI_RUNTIME,requestId,source:{kind:'along',label:entry.kind==='goal'?'Along 目标':'Along 动态任务'},trigger:{kind:entry.kind,label:'Kimi Code Web Server'},eval:{decision:blocked?'blocked':done?'accept':'evaluating'},ticket:{id:entry.sessionId},mandate:'只规划目标与动态任务；不执行外部写操作。',events,status:blocked?'blocked':done?'done':'working',statusLabel:blocked?'需要在 Mac 处理':done?'Kimi Swarm 已完成':agents.length?`${agents.length} 个 Kimi Subagent 并行中`:'Kimi Main Session 正在拆解',progress,createdAt:entry.createdAt,updatedAt:timestamp(session.updated_at)};
    if (entry.kind==='task') return {version:2,...common,task:entry.input.task,assignments:agents,error:blocked?clean(session.last_turn_reason,'Kimi 会话需要处理'):undefined};
    let result=null,error;
    if (done) {
      try {
        const validated=validateGoalReply(output,entry.input.goal.domain);
        const layout=output?.layout==null?null:safeAdaptiveLayout(output.layout,entry.input.goal.domain);
        if (output?.layout!=null&&!layout) throw Error('Kimi 返回的目标空间格式不正确');
        result={...validated,layout};
      } catch(parseError) { error=`Kimi 已完成，但输出校验失败：${parseError.message}`; }
    }
    return {version:1,kind:'goal',...common,input:{goal:entry.input.goal,message:entry.input.message},assignments:[],agents,result,status:error?'blocked':common.status,statusLabel:error?'输出需要重试':common.statusLabel,error:error||(blocked?clean(session.last_turn_reason,'Kimi 会话需要处理'):undefined)};
  }
  goalStatus(requestId) { return this.status(requestId,'goal'); }
  taskStatus(requestId) { return this.status(requestId,'task'); }
}
