import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {AGENT_RUNTIME_KEY, DSH_RUNTIME, SUPER_AGENT_RUNS_KEY} from '../web/super-agent.mjs';

const task={id:'walk',when:'周末',title:'按原安排散步',detail:'在约定的地方碰面。',state:'planned'};
const layout={version:1,title:'周末安排',badge:'当前',summary:'保留约定。',modules:[{kind:'summary',id:'plan',title:'计划',content:'继续原计划。'}],tasks:[task],questions:[]};
const key='health:'+DSH_RUNTIME+':'+task.id;
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const oldFailure={actual:false,version:2,runtime:DSH_RUNTIME,requestId:'old',source:{},trigger:{label:'正在提交给 DSH'},status:'blocked',statusLabel:'DSH 暂不可用',error:'Along task not found',progress:2,assignments:[],events:[]};
const run=(requestId,values)=>({actual:true,runtime:DSH_RUNTIME,requestId,source:{label:'Along 动态任务'},trigger:{label:'用户执行'},status:'working',statusLabel:'已接收',progress:5,assignments:[],events:[],...values});
let seq=0;
async function open({storage={},reply=()=>({}),paired=true}={}) {
  const dom=installDomStub({storage:{
    'along.adaptive-layouts.v1':JSON.stringify({health:layout}),[AGENT_RUNTIME_KEY]:JSON.stringify(DSH_RUNTIME),
    ...(paired?{'along.agent.v1':JSON.stringify({baseURL:'https://along.test',fingerprint:'a'.repeat(64),token:'b'.repeat(64)})}:{}),
    ...storage,
  }});
  const calls=[];
  window.AlongAgentBridge={request:async({path,body})=>{
    if (!path.startsWith('/super-agent/tasks')) return {};
    calls.push({path,body});
    return reply(path,body);
  }};
  await import('../web/app.mjs?task-detail-states='+ ++seq);
  await dom.click({action:'open-task',taskId:task.id});await settle();
  return {...dom,calls};
}
const noInvented=/2%|等待接收 Trigger|尚未创建|尚未生成 Mandate|等待真实运行/;

test('a protected task shows its original description and local scope, including when a stale failure exists',async()=>{
  const dom=await open({storage:{
    'along.health-sharing.v1':JSON.stringify({tasks:[{id:task.id,alias:'private-01',localText:true}]}),
    [SUPER_AGENT_RUNS_KEY]:JSON.stringify({[key]:oldFailure}),
  }});
  await dom.fireWindow('pageshow');await dom.fireWindow('focus');
  for (let i=0;i<3;i++) {await dom.tick(4000);await dom.tick(60000);}
  await dom.click({action:'retry-task'});await settle();
  assert.match(dom.app.innerHTML,/按原安排散步/);
  assert.match(dom.app.innerHTML,/在约定的地方碰面。/);
  assert.match(dom.app.innerHTML,/仅保存在本机/);
  assert.doesNotMatch(dom.app.innerHTML,/Along task not found|DSH 暂不可用|正在提交|重试|工作记录|真实分工|编排链路/);
  assert.doesNotMatch(dom.app.innerHTML,noInvented);
  assert.deepEqual(dom.calls,[]);
  await dom.click({action:'task-back'});
  assert.match(dom.app.innerHTML,/data-action="open-task"/);
});

test('a transport failure keeps the bridge error and an explicit retry resumes with the same request',async()=>{
  let retry=false,resolvePost;
  const dom=await open({reply:(path,body)=>{
    if(path.endsWith('/status')) return run(body.requestId,{status:'done',statusLabel:'已完成',progress:100,ticket:{id:'REAL-TICKET'}});
    if (!retry) throw Error('与 Mac 的连接中断');
    return new Promise(resolve=>{resolvePost=()=>resolve({run:run(body.requestId,{ticket:{id:'REAL-TICKET'}})});});
  }});
  assert.match(dom.app.innerHTML,/与 Mac 的连接中断/);
  assert.match(dom.app.innerHTML,/data-action="retry-task"/);
  assert.doesNotMatch(dom.app.innerHTML,noInvented);
  await dom.tick(4000);await settle();
  assert.equal(dom.calls.length,1);
  retry=true;
  await dom.click({action:'retry-task'});await settle();
  assert.match(dom.app.innerHTML,/正在提交/);
  assert.doesNotMatch(dom.app.innerHTML,/progressbar|真实分工|工作记录/);
  await dom.tick(4000);await dom.click({action:'retry-task'});
  assert.equal(dom.calls.length,2);
  assert.equal(dom.calls[0].body.requestId,dom.calls[1].body.requestId);
  resolvePost();await settle();assert.match(dom.app.innerHTML,/REAL-TICKET/);
  await dom.tick(4000);await settle();
  assert.match(dom.app.innerHTML,/已完成/);
  await dom.click({action:'task-back'});await dom.click({action:'open-task',taskId:task.id});await dom.tick(4000);await settle();
  assert.equal(dom.calls.length,3,'completed jobs are neither resubmitted nor polled');
});

test('the DSH admission decision exposes the actual reason and stops task polling',async()=>{
  const dom=await open({reply:(_,body)=>({run:run(body.requestId,{
    statusLabel:'未执行',progress:32,eval:{decision:'ignore',reasons:[{code:'said',values:{text:'此安排已由用户完成。'}}]},
    events:[{at:'2026-11-11T01:00:00Z',text:'已完成接单评估'}],
  })})});
  assert.match(dom.app.innerHTML,/此安排已由用户完成/);
  assert.match(dom.app.innerHTML,/已完成接单评估/);
  assert.doesNotMatch(dom.app.innerHTML,/progressbar|真实分工|尚未创建|data-action="retry-task"/);
  await dom.tick(4000);await settle();
  assert.equal(dom.calls.length,1);
});

test('an unpaired device shows connection setup and sends no task requests',async()=>{
  const dom=await open({paired:false});
  assert.match(dom.app.innerHTML,/连接这台 Mac/);
  assert.match(dom.app.innerHTML,/data-action="edit-goal"/);
  assert.doesNotMatch(dom.app.innerHTML,/progressbar|真实分工|工作记录|DSH 暂不可用/);
  assert.equal(dom.calls.length,0);
});

test('an old actual job under the same protected task never surfaces or polls on foreground',async()=>{
  const dom=await open({storage:{
    'along.health-sharing.v1':JSON.stringify({tasks:[{id:task.id,alias:'masked',localText:true}]}),
    [SUPER_AGENT_RUNS_KEY]:JSON.stringify({['health:'+task.id]:run('along-health-older',{ticket:{id:'PRIVATE-HISTORICAL-JOB'}})}),
  }});
  await dom.fireWindow('pageshow');await dom.fireWindow('focus');await dom.tick(4000);await settle();
  assert.match(dom.app.innerHTML,/仅保存在本机/);
  assert.doesNotMatch(dom.app.innerHTML,/PRIVATE-HISTORICAL-JOB/);
  assert.equal(dom.calls.length,0);
});

test('an earlier request for the same card cannot stand in for the current task',async()=>{
  const dom=await open({storage:{[SUPER_AGENT_RUNS_KEY]:JSON.stringify({[key]:run('along-health-oldversion',{ticket:{id:'STALE-TICKET'}})})},
    reply:(_,body)=>({run:run(body.requestId,{ticket:{id:'CURRENT-TICKET'}})})});
  assert.match(dom.app.innerHTML,/CURRENT-TICKET/);
  assert.doesNotMatch(dom.app.innerHTML,/STALE-TICKET/);
  assert.equal(dom.calls.length,1);
});

test('a response for a different request cannot start polling an unrelated ticket',async()=>{
  const dom=await open({reply:()=>({run:run('another-request',{ticket:{id:'WRONG-TICKET'}})})});
  assert.match(dom.app.innerHTML,/与本次任务匹配/);
  assert.doesNotMatch(dom.app.innerHTML,/WRONG-TICKET/);
  await dom.tick(4000);await settle();
  assert.equal(dom.calls.length,1);
});

test('a legacy run with conflicting runtime or task identity is never shown on this task',async()=>{
  for (const fields of [{runtime:'kimi-code-swarm'},{task:{id:'different'}},{task:{id:task.id,detail:'Earlier revision'}}]) {
    const dom=await open({storage:{[SUPER_AGENT_RUNS_KEY]:JSON.stringify({['health:'+task.id]:run('legacy-id',{...fields,ticket:{id:'OLD-JOB'}})})},
      reply:(_,body)=>({run:run(body.requestId,{ticket:{id:'CURRENT-JOB'}})})});
    assert.match(dom.app.innerHTML,/CURRENT-JOB/);
    assert.doesNotMatch(dom.app.innerHTML,/OLD-JOB/);
  }
});

test('narrowing consent while a task is being submitted discards the late response without notification or polling',async()=>{
  const before={contextReviewAllowed:true,selectedTypes:['workout','sleep'],workoutMinutes:32,sleepMinutes:440};
  let deliver;
  const dom=await open({storage:{'along.health.v1':JSON.stringify({version:1,source:'healthkit',snapshot:before,goals:[{id:'weekly',type:'workout',target:120}]})},
    reply:(_,body)=>new Promise(resolve=>{deliver=()=>resolve({run:run(body.requestId,{status:'done',ticket:{id:'WITHDRAWN-JOB'}})});})});
  const notifications=[];
  window.AlongAgentBridge.notification=async(action,payload)=>{notifications.push({action,payload});return {scheduled:true};};
  await dom.fireWindow('along-health-update',{detail:{...before,contextReviewAllowed:false,selectedTypes:['workout']}});
  deliver();await settle();await dom.tick(4000);await settle();
  assert.match(dom.app.innerHTML,/任务详情/);
  assert.match(dom.app.innerHTML,/仅保存在本机/);
  assert.doesNotMatch(dom.app.innerHTML,/WITHDRAWN-JOB|任务协作|<i><\/i>/);
  assert.doesNotMatch(dom.storage.get(SUPER_AGENT_RUNS_KEY),/WITHDRAWN-JOB/);
  assert.deepEqual(notifications,[]);
  assert.equal(dom.calls.length,1);
});

test('a late submission for the previous task text cannot overwrite a new job for the same card',async()=>{
  const newLayout={...layout,tasks:[{...task,detail:'更换后的位置。'}]};
  const later={requestId:'changed-plan',role:'assistant',text:'更新安排',layout:newLayout};
  let oldReply;
  const dom=await open({storage:{'along.goal-conversations.v1':JSON.stringify({health:[later]})},reply:(_,body)=>{
    if (body.task.detail===task.detail) return new Promise(resolve=>{oldReply=()=>resolve({run:run(body.requestId,{status:'done',ticket:{id:'LATE-JOB'}})});});
    return {run:run(body.requestId,{ticket:{id:'LATEST-JOB'}})};
  }});
  await dom.click({action:'accept-goal',requestId:'changed-plan'});
  await dom.click({action:'open-task',taskId:task.id});await settle();
  oldReply();await settle();
  assert.equal(dom.calls.length,2);
  assert.match(dom.app.innerHTML,/LATEST-JOB/);
  assert.doesNotMatch(dom.storage.get(SUPER_AGENT_RUNS_KEY),/LATE-JOB/);
});
