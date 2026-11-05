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
Use at most 6 modules, 6 tasks and 6 questions. Each module has kind, id and title. A summary module has content; a fact_list module has items shaped as [{"label":"...","value":"..."}]; a chips module has string items. For a custom goal, do not use metric modules and proposal.target must be null; put learning quantities in fact_list instead. Each task has id, when, title, detail, state (temporary|planned|deferred). Questions must be strings. Preserve any explicit number, deadline, preference and constraint from the user. Keep all user-facing text in Chinese.`;
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
function transcriptFrames(transcript) {
  return (transcript?.items||[]).flatMap(item=>item?.kind==='turn'?(item.steps||[]).flatMap(step=>step.frames||[]):[]);
}
function roleName(item,index) {
  const source=clean(item,`Kimi Subagent ${index+1}`,160).replace(/^你的角色[：:]\s*/,'');
  return clean(source.split(/[（(:：]/)[0],`Kimi Subagent ${index+1}`,60);
}
function swarmToolFromTranscript(transcript) {
  return transcriptFrames(transcript).find(frame=>frame?.kind==='tool'&&frame.name==='AgentSwarm')||null;
}
function swarmAgentsFromTranscript(transcript) {
  const tool=swarmToolFromTranscript(transcript);
  if (!tool) return [];
  const items=Array.isArray(tool.input?.items)?tool.input.items:[];
  const completed=new Map();
  const pattern=/<subagent agent_id="([^"]+)" item="([^"]*)" outcome="([^"]+)">([\s\S]*?)<\/subagent>/g;
  for (const match of String(tool.output||'').matchAll(pattern)) completed.set(match[2],{id:match[1],outcome:match[3],report:clean(match[4].replace(/\s+/g,' '),'',300)});
  return items.map((item,index)=>{
    const result=completed.get(item);
    const status=result?.outcome==='completed'?'done':result?.outcome==='failed'?'blocked':'working';
    return {id:result?.id||`kimi-swarm-${index+1}`,name:roleName(item,index),role:'Subagent',status,objective:clean(item,'并行规划子任务',260),
      work:status==='done'?'已向 Main Session 回传结果':status==='blocked'?'子任务执行失败':'正在并行工作',progress:status==='done'?100:status==='blocked'?85:55,
      report:status==='done'?{summary:result.report||'结果已回传给 Kimi Main Session'}:null};
  });
}
function synthesisPrompt(entry,transcript) {
  const swarm=swarmToolFromTranscript(transcript);
  return `You are the final synthesis session for Along. The real Kimi AgentSwarm work is complete. Do not call tools. Use the Along input and the three subagent reports below, resolve conflicts conservatively, and return exactly one JSON object without markdown.

Along input:
${JSON.stringify({goal:entry.input.goal,snapshot:entry.input.snapshot,message:entry.input.message,history:entry.input.history})}

Real AgentSwarm reports:
${String(swarm?.output||'').slice(0,50_000)}

Required JSON shape:
{"reply":"Chinese response","proposal":{"active":true,"title":"goal title","target":number_or_null,"task":"next step","reason":"reason"},"layout":{"version":1,"title":"space title","badge":"status","summary":"summary","modules":[...],"tasks":[...],"questions":["question"]}}
Use at most 6 modules, 6 tasks and 6 questions. Each module has kind, id and title. A summary module has content; a fact_list module has items shaped as [{"label":"...","value":"..."}]; a chips module has string items. Do not use metric modules for this custom goal. Each task must include id, when, title, detail, state (temporary|planned|deferred). Questions must be strings. proposal.target must be null. Preserve 60 days, about 30 minutes per day, reading-first, and no listening/speaking requirement. Keep all user-facing text in Chinese.`;
}
function layoutForAlong(value,domain) {
  if (!value||typeof value!=='object') return value;
  const used=new Set();
  const nextId=(raw,prefix,index)=>{
    const base=String(raw||`${prefix}-${index+1}`).toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,52)||`${prefix}-${index+1}`;
    let id=base,n=2;while(used.has(id)) id=`${base.slice(0,48)}-${n++}`;used.add(id);return id;
  };
  const modules=(Array.isArray(value.modules)?value.modules:[]).filter(module=>module&&['summary','fact_list','chips','metric'].includes(module.kind)&&!(domain==='custom'&&module.kind==='metric')).slice(0,6).map((module,index)=>{
    const base={kind:module.kind,id:nextId(module.id,'module',index),title:clean(module.title,`模块 ${index+1}`,60)};
    if (module.kind==='summary') return {...base,content:clean(module.content||module.note,'待补充',500)};
    if (module.kind==='fact_list') {
      const facts=Array.isArray(module.items)?module.items:Array.isArray(module.facts)?module.facts:[];
      return {...base,items:facts.slice(0,6).map((fact,factIndex)=>typeof fact==='object'&&fact?{label:clean(fact.label,`要点 ${factIndex+1}`,40),value:clean(fact.value,'待补充',180)}:{label:`要点 ${factIndex+1}`,value:clean(fact,'待补充',180)})};
    }
    if (module.kind==='chips') {
      const chips=Array.isArray(module.items)?module.items:Array.isArray(module.chips)?module.chips:[];
      return {...base,items:chips.slice(0,8).map(chip=>clean(chip,'要点',32))};
    }
    return {...base,source:clean(module.source,'',30),target:module.target,unit:module.unit==null?null:clean(module.unit,'',20),note:module.note==null?null:clean(module.note,'',180)};
  });
  const tasks=(Array.isArray(value.tasks)?value.tasks:[]).slice(0,6).map((task,index)=>({
    id:nextId(task?.id,'task',index),when:clean(task?.when,'待安排',80),title:clean(task?.title,`任务 ${index+1}`,100),detail:clean(task?.detail,'待补充',300),
    state:['temporary','planned','deferred'].includes(task?.state)?task.state:'planned',
  }));
  return {version:1,title:clean(value.title,'我的目标',80),badge:value.badge==null?null:clean(value.badge,'',40),summary:clean(value.summary,'目标计划已生成',600),modules,tasks,
    questions:(Array.isArray(value.questions)?value.questions:[]).slice(0,6).map(question=>clean(question,'待确认问题',240))};
}
function goalResultFromOutput(output,domain) {
  const normalized={...output,reply:clean(output?.reply,'',1200),proposal:output?.proposal==null?null:{
    ...output.proposal,
    title:clean(output.proposal.title,'',80),
    task:clean(output.proposal.task,'',120),
    reason:clean(output.proposal.reason,'',300),
  }};
  const validated=validateGoalReply(normalized,domain);
  const layout=output?.layout==null?null:safeAdaptiveLayout(layoutForAlong(output.layout,domain),domain);
  if (output?.layout!=null&&!layout) throw Error('Kimi 返回的目标空间格式不正确');
  return {...validated,layout};
}

export class KimiCodeAgent {
  constructor({baseURL=process.env.ALONG_KIMI_CODE_URL||DEFAULT_URL,token=process.env.ALONG_KIMI_CODE_TOKEN,tokenPath=DEFAULT_TOKEN_PATH,statePath=DEFAULT_STATE_PATH,workspace=process.cwd(),model=process.env.ALONG_KIMI_CODE_MODEL||'kimi-code/kimi-for-coding',fetchImpl=fetch}={}) {
    this.baseURL=baseURL.replace(/\/$/,'');this.token=token;this.tokenPath=tokenPath;this.statePath=statePath;this.workspace=workspace;this.model=model;this.fetch=fetchImpl;
    this.runs={};this.synthesisRequests=new Set();
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
    const agentConfig={model:this.model,swarm_mode:true,permission_mode:'manual',plan_mode:false};
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
  async ensureSynthesis(requestId,entry,transcript) {
    if (entry.synthesisSessionId||this.synthesisRequests.has(requestId)) return;
    this.synthesisRequests.add(requestId);
    try {
      const agentConfig={model:this.model,swarm_mode:false,permission_mode:'manual',plan_mode:false};
      const created=await this.call('/api/v1/sessions',{method:'POST',value:{title:`Along 综合 · ${entry.input.goal.title}`,metadata:{cwd:this.workspace},agent_config:agentConfig}});
      entry.synthesisSessionId=created.id;this.runs[requestId]=entry;this.save();
      await this.call(`/api/v1/sessions/${encodeURIComponent(created.id)}/prompts`,{method:'POST',value:{content:[{type:'text',text:synthesisPrompt(entry,transcript)}],model:this.model,permission_mode:'manual',plan_mode:false,swarm_mode:false,prompt_id:`${requestId}-synthesis`}});
    } finally { this.synthesisRequests.delete(requestId); }
  }
  async status(requestId,expectedKind) {
    const entry=this.runs[requestId];
    if (!entry || (expectedKind&&entry.kind!==expectedKind)) throw Error('Kimi Swarm 运行记录不存在');
    const id=encodeURIComponent(entry.sessionId);
    const [session,messagesPage,childrenPage,transcript]=await Promise.all([
      this.call(`/api/v1/sessions/${id}`),this.call(`/api/v1/sessions/${id}/messages`),this.call(`/api/v1/sessions/${id}/children`),
      this.call(`/api/v1/sessions/${id}/transcript?agent_id=main&page_size=20`),
    ]);
    const messages=messagesPage?.items||[],children=childrenPage?.items||[];
    const assistant=[...messages].reverse().find(message=>message.role==='assistant'&&textFromMessage(message));
    const transcriptOutput=[...transcriptFrames(transcript)].reverse().map(frame=>frame?.kind==='text'?jsonFromText(frame.text):null).find(Boolean);
    let output=jsonFromText(textFromMessage(assistant))||transcriptOutput;
    let parsedResult=null,outputError=null;
    if (entry.kind==='goal'&&output) { try { parsedResult=goalResultFromOutput(output,entry.input.goal.domain); } catch(error) { outputError=error; } }
    const transcriptAgents=swarmAgentsFromTranscript(transcript);
    const agents=transcriptAgents.length?transcriptAgents:children.map(childAgent);
    const swarmFinished=agents.length>0&&agents.every(agent=>['done','blocked'].includes(agent.status));
    const mainFinished=!session.busy&&session.last_turn_reason==='completed';
    if (entry.kind==='goal'&&!parsedResult&&swarmFinished&&(mainFinished||!!output)&&!entry.synthesisSessionId) await this.ensureSynthesis(requestId,entry,transcript);
    let activeSession=session;
    if (entry.synthesisSessionId&&!parsedResult) {
      const synthesisId=encodeURIComponent(entry.synthesisSessionId);
      const [synthesisSession,synthesisMessages,synthesisTranscript]=await Promise.all([
        this.call(`/api/v1/sessions/${synthesisId}`),this.call(`/api/v1/sessions/${synthesisId}/messages`),this.call(`/api/v1/sessions/${synthesisId}/transcript?agent_id=main&page_size=20`),
      ]);
      const synthesisAssistant=[...(synthesisMessages?.items||[])].reverse().find(message=>message.role==='assistant'&&textFromMessage(message));
      const synthesisOutput=[...transcriptFrames(synthesisTranscript)].reverse().map(frame=>frame?.kind==='text'?jsonFromText(frame.text):null).find(Boolean);
      const candidate=jsonFromText(textFromMessage(synthesisAssistant))||synthesisOutput;
      if (candidate) {
        output=candidate;
        try { parsedResult=goalResultFromOutput(candidate,entry.input.goal.domain);outputError=null; } catch(error) { outputError=error; }
      }
      activeSession=synthesisSession;
    }
    const blocked=activeSession.pending_interaction==='approval'||activeSession.pending_interaction==='question'||activeSession.last_turn_reason==='failed'||agents.some(agent=>agent.status==='blocked');
    const done=!blocked&&(entry.kind==='task'?swarmFinished:swarmFinished&&!!parsedResult);
    const finished=agents.filter(agent=>agent.status==='done').length;
    const progress=done?100:blocked?Math.max(12,agents.length?65:12):activeSession.busy?Math.min(96,25+agents.length*12+finished*10+(entry.synthesisSessionId?4:0)):8;
    const events=[
      {at:entry.createdAt,text:'Along 已建立 Kimi Main Session'},
      {at:entry.createdAt+1,text:'Swarm Mode 已显式开启'},
      ...agents.map((agent,index)=>({at:timestamp(children[index]?.updated_at,entry.createdAt+index+2),text:`${agent.name}：${agent.work}`})),
      ...(entry.synthesisSessionId?[{at:entry.createdAt+agents.length+2,text:'Kimi Main Session 正在综合子 Agent 结果'}]:[]),
      ...(done?[{at:timestamp(activeSession.updated_at),text:'Main Session 已完成汇总'}]:[]),
    ];
    const common={actual:true,runtime:KIMI_RUNTIME,requestId,source:{kind:'along',label:entry.kind==='goal'?'Along 目标':'Along 动态任务'},trigger:{kind:entry.kind,label:'Kimi Code Web Server'},eval:{decision:blocked?'blocked':done?'accept':'evaluating'},ticket:{id:entry.sessionId},mandate:'只规划目标与动态任务；不执行外部写操作。',events,status:blocked?'blocked':done?'done':'working',statusLabel:blocked?'需要在 Mac 处理':done?'Kimi Swarm 已完成':entry.synthesisSessionId?'Kimi Main Session 正在综合':agents.length?`${agents.length} 个 Kimi Subagent 并行中`:'Kimi Main Session 正在拆解',progress,createdAt:entry.createdAt,updatedAt:timestamp(activeSession.updated_at)};
    if (entry.kind==='task') return {version:2,...common,task:entry.input.task,assignments:agents,error:blocked?clean(session.last_turn_reason,'Kimi 会话需要处理'):undefined};
    const result=done?parsedResult:null;
    const synthesisFinished=entry.synthesisSessionId&&!activeSession.busy&&activeSession.last_turn_reason==='completed';
    const error=!done&&outputError&&(synthesisFinished||(!entry.synthesisSessionId&&mainFinished))?`Kimi 已完成，但输出校验失败：${outputError.message}`:null;
    return {version:1,kind:'goal',...common,input:{goal:entry.input.goal,message:entry.input.message},assignments:[],agents,result,status:error?'blocked':common.status,statusLabel:error?'输出需要重试':common.statusLabel,error:error||(blocked?clean(session.last_turn_reason,'Kimi 会话需要处理'):undefined)};
  }
  goalStatus(requestId) { return this.status(requestId,'goal'); }
  taskStatus(requestId) { return this.status(requestId,'task'); }
}
