import test from 'node:test';
import assert from 'node:assert/strict';
import * as planning from '../web/contextual-planning.mjs';
import {KEY} from '../web/health.mjs';
import {ADAPTIVE_LAYOUTS_KEY} from '../web/adaptive-ui.mjs';
import {AGENT_KEY,GOALS_KEY} from '../web/agent-client.mjs';
import {ACTIVE_GOAL_KEY} from '../web/workspace.mjs';
import {DSH_RUNTIME,AGENT_RUNTIME_KEY} from '../web/super-agent.mjs';
import {installDomStub} from './dom-stub.mjs';

const clock={now:'2026-11-20T07:00:00.000Z',localDate:'2026-11-20',timezone:'Asia/Shanghai'};
const raw={contextReviewAllowed:true,backgroundReviewAllowed:true,backgroundReviewGoalKey:'health',
  selectedTypes:['workout','sleep'],workoutMinutes:91,sleepMinutes:440,capturedAt:clock.now};
const old={...raw,selectedTypes:['workout'],workoutMinutes:90};
const masked={id:'masked-1',when:'已安排',title:'本机保留的任务',detail:'任务内容来自旧授权范围，请保留。',state:'planned'};
const goal={domain:'health',title:'我的健康目标',target:null};
const stubPlan={version:1,kind:'context-review',goalIntent:'我的健康目标',protectedTaskIds:['masked-1'],previous:old,currentPlan:{title:'目标',summary:'旧计划的详情仅保存在本机。',tasks:[masked]},recentDecisions:[]};
const template={goalKey:'health',version:'version-a',runtime:DSH_RUNTIME,goal,planning:stubPlan,selectedTypes:['workout'],comparisonHistoryAllowed:false};
test('background observations use the authorized goal and new finite readings; capture time and empty, revoked or narrowed reads submit nothing',()=>{
  const build=(snapshot=raw,overrides={})=>planning.buildBackgroundReviewRequest({...template,...overrides},snapshot,'along-review-bg-1',clock);
  const request=build();
  assert.deepEqual(request.history,[]);
  assert.equal(request.runtime,DSH_RUNTIME);
  assert.deepEqual(request.snapshot.selectedTypes,['workout']);
  assert.equal(request.snapshot.sleepMinutes,null);
  assert.equal(request.snapshot.planning.previous.sleepMinutes,null);
  assert.deepEqual(request.snapshot.planning.changes,['workoutMinutes']);
  assert.equal(request.snapshot.planning.timezone,clock.timezone);
  assert.equal(request.snapshot.planning.revisionId,request.requestId);
  for(const input of [{...raw,backgroundReviewAllowed:false},{...raw,backgroundReviewGoalKey:'custom:elsewhere'},
    {...raw,contextReviewAllowed:false},{...raw,selectedTypes:['sleep']},{...raw,workoutMinutes:null},
    {...raw,workoutMinutes:90,capturedAt:'2026-11-20T07:40:00.000Z'}]) assert.equal(build(input),null);
  assert.equal(build(raw,{runtime:'kimi-code-swarm'}),null);
  assert.equal(build(raw,{paused:true}),null);
  assert.equal(build({...raw,workoutMinutes:0}).snapshot.workoutMinutes,0);
});
const privateTask={id:'private-home',title:'只在本机的旧睡眠任务',detail:'只在本机的细节',when:'每周',state:'planned'};
const adopted={version:1,title:'受保护目标',summary:'不发给模型的旧摘要',modules:[],questions:[],tasks:[privateTask]};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
let instance=0;
async function boot({initial=raw,health=raw,storage={},pending=[],fail=false,pendingGate=null}={}) {
  const dom=installDomStub({storage:{
    [KEY]:JSON.stringify({version:1,source:'healthkit',snapshot:initial,goals:[{type:'workout',target:12}]}),
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:adopted}),[GOALS_KEY]:JSON.stringify({health:{title:adopted.title,healthTypes:['workout']}}),
    [AGENT_KEY]:JSON.stringify({baseURL:'https://192.168.1.5:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)}),
    [AGENT_RUNTIME_KEY]:DSH_RUNTIME,'along.health-sharing.v1':JSON.stringify({localGoalTitle:true,localPlanText:true,tasks:[{...masked,id:privateTask.id,alias:masked.id,localText:true}]}),...storage}});
  const calls=[],host=[],accepted=[];
  window.dispatchEvent=e=>dom.fireWindow(e.type,e);
  window.AlongHealthBridge={refresh:async()=>health,backgroundReview:async(action,value)=>{
    calls.push({action,value}); if(fail) throw Error('桥暂不可用');
    if(action==='pending') {if(pendingGate) await pendingGate;return {enabled:true,runs:pending.slice()};}
    if(action==='ack') {accepted.push(value);pending.splice(0,1);}
    return {enabled:health.backgroundReviewAllowed===true};
  }};
  window.AlongAgentBridge={request({path,body}){
    if(path==='/connection/status') return Promise.resolve({along:true,runtime:DSH_RUNTIME,ready:true});
    return new Promise((resolve,reject)=>host.push({path,body,resolve,reject}));
  }};
  await import('../web/app.mjs?bg-bridge='+ ++instance);
  for(let i=0;i<5;i++) await settle();
  return {...dom,calls,host,accepted,setFail:value=>{fail=value;},observe:async detail=>{await dom.fireWindow('along-health-update',{detail});await settle();}};
}
test('the native cache contains the consented current goal only and excludes its private texts and pairing credential',async()=>{
  const dom=await boot();
  const t=dom.calls.flatMap(c=>c.value?.goals||[]).at(-1);
  assert.ok(t);
  assert.equal(t.goalKey,'health');assert.deepEqual(t.selectedTypes,['workout']);
  assert.deepEqual(t.planning.protectedTaskIds,[masked.id]);
  assert.doesNotMatch(JSON.stringify(t),/只在本机|不发给模型|受保护目标|bbbbbbbb|192\.168/);
  for(const opts of [{health:{...raw,backgroundReviewAllowed:false}},{health:{...raw,backgroundReviewGoalKey:'custom:another'}},
    {storage:{[ACTIVE_GOAL_KEY]:'finance'}},{storage:{[AGENT_RUNTIME_KEY]:'kimi-code-swarm'}}]) {
    const other=await boot(opts);
    assert.equal(other.calls.flatMap(c=>c.value?.goals||[]).length,0);
  }
});

async function authorizedLease() {
  const before=planning.agentHealthSnapshot({...old,comparisonHistoryAllowed:false});
  const state={evaluated:before,localDate:new Intl.DateTimeFormat('en-CA').format(new Date()),goalIntent:goal.title,
    lastDecision:{decision:'keep',requestId:'last-review',at:clock.now,reason:'保留安排',runtime:DSH_RUNTIME}};
  const first=await boot({initial:old,health:old,storage:{[planning.PLANNING_STATE_KEY]:JSON.stringify(state)}});
  const last=first.calls.flatMap(c=>c.value?.goals||[]).at(-1);
  assert.ok(last);
  assert.equal(last.paused,false);
  const request=planning.buildBackgroundReviewRequest(last,raw,'along-review-bg-receipt',clock);
  assert.ok(request);
  return {storage:Object.fromEntries(first.store),receipt:{goalKey:'health',version:last.version,requestId:request.requestId,request}};
}
test('a matching accepted background submission resumes by GET and an uncertain POST reuses its ID; neither starts a second review',async()=>{
  for(const state of ['accepted','uncertain']) {
    const {storage,receipt}=await authorizedLease();
    const dom=await boot({initial:old,health:raw,storage,pending:[{...receipt,state}]});
    assert.equal(dom.accepted.length,1);
    assert.equal(dom.host.length,1);
    const call=dom.host[0];
    assert.equal(call.path,state==='accepted'?'/super-agent/goals/status':'/super-agent/goals');
    assert.equal(call.body.requestId,receipt.requestId);
    const req=receipt.request;
    const run={kind:'goal',requestId:req.requestId,runtime:DSH_RUNTIME,actual:true,status:'done',source:{kind:'along'},trigger:{kind:'goal'},agents:[],events:[],assignments:[],
      result:{reply:'维持安排',proposal:null,layout:null,reassessment:{decision:'keep',basedOnRevision:req.requestId,changes:[],reason:'已有安排合适。',nextReviewAt:null,watchFor:[]}}};
    call.resolve(state==='accepted'?run:{run});
    await settle();await settle();
    assert.equal(JSON.parse(dom.storage.get(planning.PLANNING_STATE_KEY)).lastDecision.requestId,receipt.requestId);
    assert.equal(dom.host.length,1);
  }
});
test('a failed native handoff does not duplicate its possibly submitted work; narrowing the goal drops old receipts, clears native scope and leaves unrelated tasks alone',async()=>{
  const {storage,receipt}=await authorizedLease();
  const offline=await boot({initial:old,storage,pending:[{...receipt,state:'accepted'}],fail:true});
  assert.equal(offline.host.length,0);
  assert.ok(offline.calls.some(c=>c.action==='disarm'));
  assert.ok(!offline.calls.some(c=>c.action==='replace'&&c.value?.goals.length===0),'a failed sync must preserve a durable receipt');
  const shrunk=await boot({storage,health:{...raw,backgroundReviewAllowed:false},pending:[{...receipt,state:'accepted'}]});
  assert.ok(shrunk.calls.some(c=>c.action==='replace'&&c.value?.goals.length===0));
  assert.doesNotMatch(JSON.stringify(shrunk.host),/along-review-bg-receipt|旧睡眠任务/);
  const foreign=await boot({storage,pending:[{...receipt,version:'old-scope',state:'uncertain'}]});
  assert.ok(foreign.host.every(c=>c.body.requestId!==receipt.requestId));
  assert.equal(foreign.accepted.length,0);
});

test('an OS wake can reassess the same records on a new local day or after a due review; no readable observation is never sent',()=>{
  const build=(dates,snapshot={...raw,workoutMinutes:90})=>planning.buildBackgroundReviewRequest({...template,...dates},snapshot,'along-review-when-due',clock);
  assert.equal(build({evaluatedLocalDate:clock.localDate}),null);
  assert.equal(build({evaluatedLocalDate:'2026-11-19'}).snapshot.planning.cause,'review');
  assert.equal(build({evaluatedLocalDate:clock.localDate,nextReviewAt:'2026-11-20T06:59:00Z'}).snapshot.planning.cause,'review');
  assert.equal(build({evaluatedLocalDate:'2026-11-19'},{...raw,workoutMinutes:null}),null);
});

test('sequential background work can resume the newest receipt using its prior verified observations within the same scope',async()=>{
  const {storage,receipt}=await authorizedLease();
  const current={...raw,workoutMinutes:100};
  const initial=await boot({initial:old,health:old,storage});
  const t=initial.calls.flatMap(c=>c.value?.goals||[]).at(-1);
  const baseline=planning.agentHealthSnapshot({...raw,selectedTypes:['workout'],workoutMinutes:94});
  const runner={...t,evaluatedLocalDate:clock.localDate,nextReviewAt:null,planning:{...t.planning,previous:baseline}};
  const request=planning.buildBackgroundReviewRequest(runner,current,'along-review-next-in-background',clock);
  const latest={goalKey:'health',version:t.version,requestId:request.requestId,request,previousRequestId:receipt.requestId,
    evaluatedLocalDate:clock.localDate,nextReviewAt:null,baseline,state:'accepted'};
  const resumed=await boot({storage,health:current,pending:[latest]});
  assert.deepEqual(resumed.host.map(c=>[c.path,c.body.requestId]),[['/super-agent/goals/status',latest.requestId]]);
  assert.equal(resumed.accepted.length,1);
  const invalid=await boot({storage,health:current,pending:[{...latest,baseline:{...baseline,selectedTypes:['workout','sleep']}}]});
  assert.equal(invalid.accepted.length,0);
  assert.equal(invalid.host.length,0);
});

test('foreground callbacks and asynchronous handoffs cannot submit while the page is hidden',async()=>{
  const {storage,receipt}=await authorizedLease();
  let release;
  const pendingGate=new Promise(resolve=>{release=resolve;});
  const dom=await boot({storage,health:raw,pending:[{...receipt,state:'uncertain'}],pendingGate});
  document.visibilityState='hidden';release();await settle();await settle();
  assert.equal(dom.host.length,0);assert.equal(dom.accepted.length,0);
  await dom.observe({...raw,workoutMinutes:140});
  assert.equal(dom.host.length,0);
});

test('network recovery retains an adopted background request identity; revoking its permission cannot re-post that request',async()=>{
  for(const state of ['accepted','uncertain']) {
    const {storage,receipt}=await authorizedLease();
    const dom=await boot({storage,pending:[{...receipt,state}]});
    const first=dom.host[0];first.reject(Error('连接 Mac 失败。稍后再试。'));
    await settle();await settle();
    void dom.observe(raw);
    for(let i=0;i<8;i++) await settle();
    const retry=dom.host[1];
    assert.ok(retry);
    assert.equal(retry.path,state==='accepted'?'/super-agent/goals/status':'/super-agent/goals');
    assert.equal(retry.body.requestId,receipt.requestId);
    // Revoke while the retry is in flight. A late reply cannot restore the local ticket.
    void dom.observe({...raw,backgroundReviewAllowed:false,backgroundReviewGoalKey:null});
    await settle();await settle();
    assert.notEqual(JSON.parse(dom.storage.get(planning.PLANNING_STATE_KEY)).request?.requestId,receipt.requestId);
    retry.reject(Error('连接 Mac 失败。稍后再试。'));await settle();
    assert.equal(dom.host.filter(c=>c.body.requestId===receipt.requestId).length,2);
  }
});
