import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {safeWorkspaceGoal,createEventWorkspace} from '../web/event-workspace.mjs';

const config={userId:'u_sources',baseURL:'https://localhost:4176',fingerprint:'a'.repeat(64),token:'b'.repeat(64)};
const source={provider:'okx',status:'recommended',reason:'读取成交与持仓，用于复盘策略 <script>bad()</script>'};
const snapshot=(id='g_okx',dataSources=[source],domain='custom')=>({
  goal:{id,domain,status:'active',currentRevision:1},
  revision:{goalId:id,revision:1,title:id==='g_okx'?'OKEX交易复盘':'原健康目标',status:'active',
    ...(domain==='health'?{metric:{type:'workout',target:120,unit:'分钟',period:'week'}}:{})},tasks:[],
  ...(dataSources===undefined?{}:{dataSources})});
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));

test('goal snapshots retain validated source recommendations without trusting model URLs or connected claims',()=>{
  assert.deepEqual(safeWorkspaceGoal(snapshot()).dataSources,[source]);
  for(const invalid of [[{...source,provider:'arbitrary'}],[{...source,status:'connected'}],
    [{...source,url:'https://evil.example'}],[{...source,reason:' '}],[source,source]]) {
    assert.throws(()=>safeWorkspaceGoal(snapshot('g_okx',invalid)),/数据源/);
  }
});

test('source recommendations survive offline restart and remain scoped to their goal',async()=>{
  installDomStub();
  const items=[snapshot(),snapshot('g_other',[])].map((value,i)=>({seq:i+1,userId:config.userId,kind:'goal_updated',goalId:value.goal.id,payload:{snapshot:value}}));
  window.AlongAgentBridge={request:async input=>input.path==='/sync'?{items:items.filter(i=>i.seq>input.body.after_seq)}:{acked:2}};
  const ws=createEventWorkspace({config});await ws.sync();
  assert.deepEqual(ws.view().goals.g_okx.dataSources,[source]);
  assert.deepEqual(ws.view().goals.g_other.dataSources,[]);
  window.AlongAgentBridge.request=async()=>{throw Error('offline');};
  const reopened=createEventWorkspace({config});await reopened.sync();
  assert.deepEqual(reopened.view().goals.g_okx.dataSources,[source]);
  assert.deepEqual(reopened.view().goals.g_other.dataSources,[]);
});

test('an old cache replays sources once while preserving its acknowledged cursor and draft',async()=>{
  const goal=safeWorkspaceGoal(snapshot('g_okx',[]));
  const saved={version:1,recommendationsVersion:1,conversationVersion:1,userId:config.userId,cursor:10,
    activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{},drafts:{'goal:g_okx':'尚未发送'}};
  installDomStub({storage:{['along.event-workspace.v1:'+config.userId]:JSON.stringify(saved)}});
  const calls=[];
  window.AlongAgentBridge={request:async input=>{
    calls.push(input);
    return input.path==='/sync'?{items:input.body.after_seq===0?[{seq:1,userId:config.userId,kind:'goal_updated',goalId:goal.id,payload:{snapshot:snapshot()}}]:[]}:{acked:1};
  }};
  const ws=createEventWorkspace({config});await ws.sync();
  assert.equal(calls.find(c=>c.path==='/sync').body.after_seq,0);
  assert.equal(ws.view().cursor,10);
  assert.deepEqual(ws.view().goals.g_okx.dataSources,[source]);
  assert.equal(JSON.parse(localStorage.getItem('along.event-workspace.v1:'+config.userId)).drafts['goal:g_okx'],'尚未发送');
  calls.length=0;await createEventWorkspace({config}).sync();
  assert.equal(calls.find(c=>c.path==='/sync').body.after_seq,10);
});

test('a new source migration starts before an interrupted older conversation replay',async()=>{
  const goal=safeWorkspaceGoal(snapshot('g_okx',[]));
  const saved={version:1,recommendationsVersion:1,conversationReplayAfter:5,userId:config.userId,cursor:10,
    activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{},drafts:{'goal:g_okx':'保留草稿'}};
  installDomStub({storage:{['along.event-workspace.v1:'+config.userId]:JSON.stringify(saved)}});
  const requested=[];
  window.AlongAgentBridge={request:async input=>{
    if(input.path!=='/sync')return {acked:1};
    requested.push(input.body.after_seq);
    return {items:input.body.after_seq===0?[{seq:1,userId:config.userId,kind:'goal_updated',goalId:goal.id,payload:{snapshot:snapshot()}}]:[]};
  }};
  const ws=createEventWorkspace({config});await ws.sync();
  assert.deepEqual(requested,[0]);
  assert.deepEqual(ws.view().goals.g_okx.dataSources,[source]);
  assert.equal(ws.view().cursor,10);
  const cache=JSON.parse(localStorage.getItem('along.event-workspace.v1:'+config.userId));
  assert.equal(cache.drafts['goal:g_okx'],'保留草稿');
  assert.equal(cache.dataSourcesVersion,1);assert.equal(cache.conversationVersion,1);
});

test('the real goal page renders OKX setup instead of unrelated Apple Health and never claims authorization',async()=>{
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  const items=[{seq:1,userId:config.userId,kind:'goal_updated',goalId:'g_okx',payload:{snapshot:snapshot()}}];
  window.AlongAgentBridge={request:async input=>{
    if(input.path==='/connection/status')return {along:true,ready:true,runtime:'dsh-superagent',eventProtocol:1,userId:config.userId};
    if(input.path==='/sync')return {items:items.filter(i=>i.seq>input.body.after_seq)};
    if(input.path==='/sync/ack')return {acked:1};
    throw Error(input.path);
  }};
  await import(`../web/app.mjs?sources=${Date.now()}`);await settle();
  assert.match(dom.app.innerHTML,/OKX/);
  assert.match(dom.app.innerHTML,/href="https:\/\/www.okx.com\/account\/my-api"/);
  assert.match(dom.app.innerHTML,/前往 OKX 设置/);
  assert.match(dom.app.innerHTML,/尚未连接/);
  assert.match(dom.app.innerHTML,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(dom.app.innerHTML,/Apple Health|event-health-connect|已授权|已连接/);
});

test('a custom goal without a recommended source has no default health connector',async()=>{
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  window.AlongAgentBridge={request:async input=>input.path==='/connection/status'
    ?{along:true,ready:true,runtime:'dsh-superagent',eventProtocol:1,userId:config.userId}
    :input.path==='/sync'?{items:input.body.after_seq?[]:[{seq:1,userId:config.userId,kind:'goal_updated',goalId:'g_okx',payload:{snapshot:snapshot('g_okx',[])}}]}:{acked:1}};
  await import(`../web/app.mjs?no-sources=${Date.now()}`);await settle();
  assert.match(dom.app.innerHTML,/OKEX交易复盘/);
  assert.doesNotMatch(dom.app.innerHTML,/Apple Health|event-health-connect|前往 OKX 设置/);
});
