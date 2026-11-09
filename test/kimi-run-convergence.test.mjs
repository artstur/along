import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import {KimiCodeAgent, KIMI_RUN_TIMEOUT_MS} from '../host/kimi-code-agent.mjs';

const layout={
  version:1,title:'日语阅读 60 天',badge:'试运行',summary:'每天用碎片时间阅读。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'以读为主。'}],
  tasks:[{id:'read-10',when:'今天',title:'阅读 10 分钟',detail:'选一段入门材料。',state:'planned'}],questions:[],
};
const goalResult={reply:'已拆成一个可持续的 60 天方案。',proposal:{active:true,title:'60 天学会基础日语',target:120,task:'今天阅读 10 分钟',reason:'符合每天 30 分钟的限制'},layout};

function json(data) { return new Response(JSON.stringify({code:0,msg:'success',data,request_id:'test'}),{status:200,headers:{'content-type':'application/json'}}); }
function assistant(text) { return {role:'assistant',content:[{type:'text',text}]}; }
function swarmFrame(items,output) { return {kind:'turn',steps:[{frames:[{kind:'tool',name:'AgentSwarm',input:{items},output}]}]}; }

// 一个可配置的 Kimi Code Web Server 替身：session-1 是主会话，session-2 是综合会话。
function kimiServer({mainSession={},mainMessages=[],children=[],transcript=[],synthesisSession={},synthesisMessages=[],synthesisTranscript=[]}={}) {
  const calls=[];
  let created=0;
  const fetchImpl=async(url,options={})=>{
    const path=new URL(url).pathname;
    calls.push({path,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
    if (path==='/api/v1/meta') return json({server_version:'2.5.0',features:[{name:'swarm',state:'Active'}]});
    if (path==='/api/v1/auth') return json({models_ready:true});
    if (path==='/api/v1/oauth/userinfo') return json({kind:'ok',userInfo:{userLevelName:'Pro'}});
    if (path==='/api/v1/sessions'&&options.method==='POST') return json({id:`session-${++created}`});
    const match=path.match(/^\/api\/v1\/sessions\/([^/]+)(\/.*)?$/);
    if (match) {
      const id=decodeURIComponent(match[1]),rest=match[2]||'',main=id==='session-1';
      if (rest==='/profile') return json({id,agent_config:{swarm_mode:true}});
      if (rest==='/prompts') return json({accepted:true});
      if (rest==='') return json({id,busy:false,last_turn_reason:'completed',pending_interaction:'none',updated_at:'2026-11-05T08:00:00Z',...(main?mainSession:synthesisSession)});
      if (rest==='/messages') return json({items:main?mainMessages:synthesisMessages});
      if (rest==='/children') return json({items:main?children:[]});
      if (rest==='/transcript') return json({items:main?transcript:synthesisTranscript});
    }
    throw Error(`unexpected ${path}`);
  };
  return {fetchImpl,calls};
}

function withAgent(world) {
  const statePath=join(tmpdir(),`along-kimi-convergence-${crypto.randomUUID()}.json`);
  const server=kimiServer(world);
  const agent=new KimiCodeAgent({token:'secret-token',statePath,workspace:'/along',fetchImpl:server.fetchImpl});
  return {...server,agent,statePath,cleanup:()=>rmSync(statePath,{force:true})};
}

const goalInput={goal:{domain:'health',title:'运动',target:120},snapshot:{},message:'做一个计划',history:[]};

test('a finished main session with a valid result converges even when no subagent is visible',async()=>{
  const {agent,cleanup}=withAgent({mainMessages:[assistant(JSON.stringify(goalResult))]});
  try {
    const response=await agent.startGoal({requestId:'req-no-agents',...goalInput});
    assert.equal(response.run.status,'done','主回合已经给出结果，运行必须收敛，不能一直 working');
    assert.ok(response.run.result);
  } finally { cleanup(); }
});

test('a subagent that never reports does not keep a finished run working',async()=>{
  const {agent,cleanup}=withAgent({
    mainMessages:[assistant(JSON.stringify(goalResult))],
    transcript:[swarmFrame(['目标策略师','风险评审','任务设计师'],
      '<subagent agent_id="agent-0" item="目标策略师" outcome="completed">ok</subagent><subagent agent_id="agent-1" item="风险评审" outcome="completed">ok</subagent>')],
  });
  try {
    const response=await agent.startGoal({requestId:'req-late-subagent',...goalInput});
    assert.equal(response.run.status,'done','没回传的子 Agent 不能把已经完成的运行拖成 working');
    assert.ok(response.run.result);
  } finally { cleanup(); }
});

test('a finished main session without a result still gets one synthesis run',async()=>{
  const {agent,calls,cleanup}=withAgent({synthesisMessages:[assistant(JSON.stringify(goalResult))]});
  try {
    const response=await agent.startGoal({requestId:'req-synthesis',...goalInput});
    // 主会话本身也会 POST /api/v1/sessions，必须按标题区分出综合会话，否则这条断言是假阳性。
    const synthesis=calls.filter(call=>call.path==='/api/v1/sessions'&&call.method==='POST'&&String(call.body?.title||'').startsWith('Along 综合'));
    assert.equal(synthesis.length,1,'主回合结束但没有结果时应该开一次综合会话');
    assert.equal(response.run.status,'done');
    assert.ok(response.run.result);
  } finally { cleanup(); }
});

test('a swarm that reports nothing at all converges to blocked instead of working',async()=>{
  const {agent,cleanup}=withAgent({transcript:[swarmFrame(['目标策略师'],'<subagent agent_id="agent-0" item="目标策略师" outcome="completed">ok</subagent>')]});
  try {
    const response=await agent.startGoal({requestId:'req-no-output',...goalInput});
    assert.equal(response.run.status,'blocked','会话结束了却一个字都没给，必须落到终态');
    assert.match(response.run.error,/没有返回可用结果/);
  } finally { cleanup(); }
});

test('a failed subagent does not throw away a validated result',async()=>{
  const {agent,cleanup}=withAgent({
    mainMessages:[assistant(JSON.stringify(goalResult))],
    transcript:[swarmFrame(['目标策略师','风险评审'],
      '<subagent agent_id="agent-0" item="目标策略师" outcome="completed">ok</subagent><subagent agent_id="agent-1" item="风险评审" outcome="failed">boom</subagent>')],
  });
  try {
    const response=await agent.startGoal({requestId:'req-subagent-failed',...goalInput});
    assert.equal(response.run.status,'done','一个子 Agent 失败不该连坐掉已经校验过的结果');
    assert.ok(response.run.result);
    assert.ok(response.run.agents.some(item=>item.status==='blocked'),'失败的子 Agent 要在卡片上标出来');
  } finally { cleanup(); }
});

test('a task run converges once the main session finishes',async()=>{
  const {agent,cleanup}=withAgent({});
  try {
    const response=await agent.startTask({requestId:'req-task',task:{id:'t1',title:'整理书桌',detail:'把书收好',when:'今天',state:'temporary'},context:{}});
    assert.equal(response.run.status,'done','动态任务运行也必须收敛');
  } finally { cleanup(); }
});

// 已经开过综合会话的运行：主会话的状态不能被综合会话遮住。
function withSynthesisRun(world,{mainSession={},synthesisSession={},synthesisMessages=[]}={}) {
  const statePath=join(tmpdir(),`along-kimi-convergence-${crypto.randomUUID()}.json`);
  const server=kimiServer({...world,mainSession,synthesisSession,synthesisMessages});
  writeFileSync(statePath,JSON.stringify({'req-synthesis-run':{
    kind:'goal',sessionId:'session-1',createdAt:Date.now(),
    input:{goal:{domain:'health',title:'运动',target:120},snapshot:{},message:'做一个计划',history:[]},
    synthesisSessionId:'session-syn',
  }}));
  const agent=new KimiCodeAgent({token:'secret-token',statePath,workspace:'/along',fetchImpl:server.fetchImpl});
  return {...server,agent,statePath,cleanup:()=>rmSync(statePath,{force:true})};
}

test('a main session waiting for approval is not hidden by the synthesis session',async()=>{
  const {agent,cleanup}=withSynthesisRun({},{
    mainSession:{busy:false,last_turn_reason:'completed',pending_interaction:'approval'},
    synthesisSession:{busy:true,last_turn_reason:'running',pending_interaction:'none'},
  });
  try {
    const run=await agent.goalStatus('req-synthesis-run');
    assert.equal(run.status,'blocked','主会话等着用户在 Mac 上批准时，运行不能报 working');
    assert.match(run.statusLabel,/Mac/);
  } finally { cleanup(); }
});

test('a failed main session is not hidden by the synthesis session',async()=>{
  const {agent,cleanup}=withSynthesisRun({},{
    mainSession:{busy:false,last_turn_reason:'failed'},
    synthesisSession:{busy:true,last_turn_reason:'running',pending_interaction:'none'},
  });
  try {
    const run=await agent.goalStatus('req-synthesis-run');
    assert.equal(run.status,'blocked','主会话已经失败时，运行不能报 working');
  } finally { cleanup(); }
});

test('a finished synthesis that delivered a valid result ends the run',async()=>{
  const {agent,cleanup}=withSynthesisRun({},{
    mainSession:{busy:true,last_turn_reason:'running'},
    synthesisSession:{busy:false,last_turn_reason:'completed'},
    synthesisMessages:[assistant(JSON.stringify(goalResult))],
  });
  try {
    const run=await agent.goalStatus('req-synthesis-run');
    assert.equal(run.status,'done','综合会话已经交付了校验过的结果，运行就该结束');
    assert.ok(run.result);
  } finally { cleanup(); }
});

test('a run that never advances stops waiting instead of working forever',async()=>{
  const {agent,statePath,fetchImpl,cleanup}=withAgent({mainSession:{busy:true,last_turn_reason:'running'}});
  try {
    await agent.startGoal({requestId:'req-stuck',...goalInput});
    const fresh=new KimiCodeAgent({token:'secret-token',statePath,workspace:'/along',fetchImpl});
    const running=await fresh.goalStatus('req-stuck');
    assert.equal(running.status,'working','还没到阈值时不应该提前判失败');
    const saved=JSON.parse(readFileSync(statePath,'utf8'));
    saved['req-stuck'].createdAt=Date.now()-KIMI_RUN_TIMEOUT_MS-1_000;
    writeFileSync(statePath,JSON.stringify(saved));
    // 运行记录在宿主内存里，改盘上的状态要重新起一个实例才生效。
    const expired=await new KimiCodeAgent({token:'secret-token',statePath,workspace:'/along',fetchImpl}).goalStatus('req-stuck');
    assert.equal(expired.status,'blocked','一直等下去不是终态，超时要明确停住');
    assert.match(expired.error,/Kimi 长时间/);
  } finally { cleanup(); }
});
