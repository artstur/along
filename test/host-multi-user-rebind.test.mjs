import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {request as tlsRequest} from 'node:https';
import {createServer} from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {KimiCodeAgent} from '../host/kimi-code-agent.mjs';
import {taskNotifications} from '../host/task-notifications.mjs';
import {HostError} from '../host/host-error.mjs';
import {DeviceSourceError} from '../host/device-source-gateway.mjs';
import {createDeviceSourceRoute, deviceAwareSourceConnection} from '../host/device-source-routes.mjs';
import {createSourceJournal, createSourceEventBridge} from '../host/source-event-bridge.mjs';
import {createBridge} from '../host/along-bridge.mjs';
import {rememberDailyAction, includeEarlierDailyAction} from '../host/daily-action-history.mjs';
import * as goalCore from '../web/goal-agent-core.mjs';
import * as layoutMod from '../web/adaptive-ui.mjs';
import * as policyMod from '../web/contextual-planning.mjs';

// M2 请求级身份与每用户隔离（docs/cloud-deploy-multi-user.md §4 M2、验收 #2）的配对测试。
// 实现者主测试在 test/host-multi-user-isolation.test.mjs（隔离表现、/goal/event 分锁、Kimi 键、
// 通知分文件、真实进程回环身份头与每日委托查询）。本文件补它没覆盖的另一半模块目标：
// 1. 绑定一致性复查（§3.2「同一用户重新配对会整条替换绑定→旧绑定的在途守卫立即失效；
//    其他用户的绑定不受影响」）跨 task-notifications / device-source-routes / source-event-bridge 三个守卫实体；
// 2. 后台泵逐用户：source 事件泵按调用方给定的绑定跑，只处理本用户的 journal 行，不代取他人数据；
// 3. Kimi 两个用户用同一个 requestId 各得各的会话（实现者只测了 B 查 A 的编号）；
// 4. /super-agent/goals 的 include（includeEarlierDailyAction）与 remember（normalizeGoalRun 的 pair 参数）
//    都用请求自身绑定的 token 哈希（验收 #2 只断言了 /super-agent/daily-delegation 查询）；
// 5. 真实进程重配对全链路：旧 token 401、新 token 接管同一份每用户通知文件、B 完全不受影响。

const USER_A='u_aaaa1111',USER_B='u_bbbb2222';
const HOST_FILE=fileURLToPath(new URL('../host/agent-host.mjs',import.meta.url));
const PAIR_CODE_FILE=fileURLToPath(new URL('../host/pair-code.mjs',import.meta.url));
const HOST_SOURCE=readFileSync(HOST_FILE,'utf8');
const sha256hex=value=>createHash('sha256').update(value).digest('hex');

// ---- Kimi：两个用户同一个 requestId（§3.2「同一个 requestId 由不同手机发出时互不可见」）-----------

const layout={
  version:1,title:'日语阅读 60 天',badge:'试运行',summary:'每天用碎片时间阅读。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'以读为主。'}],
  tasks:[{id:'read-10',when:'今天',title:'阅读 10 分钟',detail:'选一段入门材料。',state:'planned'}],questions:[],
};
const goalResult={reply:'已拆成一个可持续的 60 天方案。',proposal:{active:true,title:'60 天学会基础日语',target:120,task:'今天阅读 10 分钟',reason:'符合每天 30 分钟的限制'},layout};
const goalInput={goal:{domain:'health',title:'运动',target:120},snapshot:{},message:'做一个计划',history:[]};

function json(data) { return new Response(JSON.stringify({code:0,msg:'success',data,request_id:'test'}),{status:200,headers:{'content-type':'application/json'}}); }
function kimiFetch(output) {
  let created=0;
  return async(url,options={})=>{
    const path=new URL(url).pathname;
    if (path==='/api/v1/meta') return json({server_version:'2.5.0',features:[{name:'swarm',state:'Active'}]});
    if (path==='/api/v1/auth') return json({models_ready:true});
    if (path==='/api/v1/oauth/userinfo') return json({kind:'ok',userInfo:{userLevelName:'Pro'}});
    if (path==='/api/v1/sessions'&&options.method==='POST') return json({id:`session-${++created}`});
    const match=path.match(/^\/api\/v1\/sessions\/([^/]+)(\/.*)?$/);
    if (match) {
      const id=decodeURIComponent(match[1]),rest=match[2]||'';
      if (rest==='/profile'||rest==='/prompts') return json({accepted:true});
      if (rest==='') return json({id,busy:false,last_turn_reason:'completed',pending_interaction:'none',updated_at:'2026-11-05T08:00:00Z'});
      if (rest==='/messages') return json({items:[{role:'assistant',content:[{type:'text',text:output}]}]});
      if (rest==='/children') return json({items:[]});
      if (rest==='/transcript') return json({items:[]});
    }
    throw Error(`unexpected ${path}`);
  };
}

test('Kimi 双用户同一个 requestId：各得各的会话，状态文件两把键，重启后仍互不可见',async()=>{
  const statePath=join(tmpdir(),`along-rebind-kimi-${crypto.randomUUID()}.json`);
  try {
    const agent=new KimiCodeAgent({token:'t',statePath,workspace:'/along',fetchImpl:kimiFetch(JSON.stringify(goalResult))});
    const a=await agent.startGoal({...goalInput,requestId:'req-same'},USER_A);
    const b=await agent.startGoal({...goalInput,requestId:'req-same'},USER_B);
    assert.equal(a.run.requestId,'req-same');
    assert.equal(b.run.requestId,'req-same');
    assert.equal(a.run.ticket.id,'session-1');
    assert.equal(b.run.ticket.id,'session-2','同一 requestId 不共享 Kimi 会话');
    const saved=JSON.parse(readFileSync(statePath,'utf8'));
    assert.deepEqual(Object.keys(saved).sort(),[`${USER_A}:req-same`,`${USER_B}:req-same`].sort(),
      '两个手机的同号运行在同一状态文件里各占一把键');
    assert.equal((await agent.goalStatus(USER_A,'req-same')).ticket.id,'session-1');
    assert.equal((await agent.goalStatus(USER_B,'req-same')).ticket.id,'session-2');
    const restarted=new KimiCodeAgent({token:'t',statePath,workspace:'/along',fetchImpl:kimiFetch(JSON.stringify(goalResult))});
    assert.equal((await restarted.goalStatus(USER_A,'req-same')).ticket.id,'session-1','重启后 A 的会话指针仍在');
    assert.equal((await restarted.goalStatus(USER_B,'req-same')).ticket.id,'session-2');
  } finally { rmSync(statePath,{force:true}); }
});

// ---- 绑定一致性复查：重配对整条替换绑定 → 旧绑定守卫立即失效、其他用户不受影响（§3.2）-----------

test('通知登记：重配对后旧设备的登记与派发立即失效，新设备重写同一份每用户文件，他人文件不动',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-rebind-notes-'));
  try {
    const A='u_rebindaa',B='u_rebindbb',dA1='d_rebinda1',dA2='d_rebinda2',dB='d_rebindb1';
    // 与 agent-host 的装配一致：每个用户一个实例，binding() 按 userId 解析现役绑定（host/agent-host.mjs:205-213）。
    const bindings={[A]:{userId:A,deviceId:dA1},[B]:{userId:B,deviceId:dB}};
    const clock=Date.UTC(2026,9,11,1);
    const sent=[];
    const make=user=>taskNotifications({dir,userId:user,binding:()=>bindings[user],now:()=>clock,
      readPage:async()=>({items:[]}),send:async route=>{sent.push(route);return 'accepted';}});
    const oldWho={userId:A,deviceId:dA1},bWho={userId:B,deviceId:dB};
    const svcA=make(A),svcB=make(B);
    svcA.register(oldWho,{expectedUserId:A,token:'ab'.repeat(32),environment:'development'});
    svcB.register(bWho,{expectedUserId:B,token:'cd'.repeat(32),environment:'development'});
    // 重配对：同一用户整条替换绑定（user 不变、device 换新），他人不动。
    bindings[A]={userId:A,deviceId:dA2};
    assert.equal(svcA.active(oldWho),false,'旧绑定的登记不再活跃');
    assert.throws(()=>svcA.register(oldWho,{expectedUserId:A,token:'ee'.repeat(32),environment:'development'}),
      error=>error instanceof HostError&&error.status===409&&/通知绑定已变更/.test(error.message),
      '旧设备不能借重配对前的会话改登记');
    assert.throws(()=>svcA.scheduled(oldWho,{expectedUserId:A,reminders:[]}),
      error=>error.status===409&&/通知绑定已变更/.test(error.message));
    await svcA.dispatch();
    assert.deepEqual(sent,[],'派发自解析现役绑定：旧绑定的泵一轮也不跑');
    // 新设备在同一份每用户文件上重新登记；B 的文件不动。
    assert.equal(svcA.register({userId:A,deviceId:dA2},{expectedUserId:A,token:'ff'.repeat(32),environment:'development'}).remoteNotifications,true);
    const notes=readdirSync(dir).filter(name=>name.startsWith('notification-device.')).sort();
    assert.deepEqual(notes,[`notification-device.${A}.json`,`notification-device.${B}.json`].sort(),'仍是每用户一份，没有多出新文件');
    const stored=user=>JSON.parse(readFileSync(join(dir,`notification-device.${user}.json`),'utf8'));
    assert.equal(stored(A).token,'ff'.repeat(32));
    assert.equal(stored(A).deviceId,dA2);
    assert.equal(stored(B).token,'cd'.repeat(32),'B 的登记不被 A 重配对触碰');
    assert.equal(svcB.active(bWho),true);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('设备采集路由：重配对替换绑定后旧绑定请求按 stale_authorization 拒绝，新绑定与 B 正常',async()=>{
  const goalId='g_rebindgoal';
  const goal=u=>({goal:{id:goalId,userId:u,status:'active',currentRevision:1},
    revision:{goalId,userId:u,status:'active',revision:1},dataSources:[{provider:'okx',status:'recommended'}]});
  const pairings=[{user_id:USER_A,device_id:'d_rebinda1'},{user_id:USER_B,device_id:'d_rebindb1'}];
  const stillBound=w=>pairings.some(entry=>entry.user_id===w.userId&&entry.device_id===w.deviceId);
  const handled=[];
  const route=createDeviceSourceRoute({stillBound,readGoal:async who=>goal(who.userId),
    gateway:{handle:async args=>{handled.push(args);return {grantId:'opaque'};}}});
  const oldWho={userId:USER_A,deviceId:'d_rebinda1'};
  const first=await route({action:'status',provider:'okx',goalId,eventId:'evt_r1'},oldWho);
  assert.deepEqual(first,{status:200,value:{grantId:'opaque'}});
  assert.equal(handled[0].deviceId,'d_rebinda1');
  assert.equal(await handled[0].stillAuthorized(),true);
  // 重配对：A 的绑定整条替换（user 不变、device 换新），B 原样。
  pairings[0]={user_id:USER_A,device_id:'d_rebinda2'};
  assert.equal(await handled[0].stillAuthorized(),false,'gateway 在途捕获的守卫随重配对立即失效');
  const stale=await route({action:'status',provider:'okx',goalId,eventId:'evt_r2'},oldWho);
  assert.deepEqual(stale,{status:403,value:{event_id:'evt_r2',status:'rejected',reason:'stale_authorization'}});
  await assert.rejects(route({action:'status',provider:'okx',goalId},oldWho),
    error=>error instanceof DeviceSourceError&&error.code==='stale_authorization'&&error.status===403,
    '没有事件号可挂的旧绑定请求按 403 抛出');
  const fresh=await route({action:'status',provider:'okx',goalId},{userId:USER_A,deviceId:'d_rebinda2'});
  assert.equal(fresh.status,200,'新绑定正常工作');
  assert.equal(handled.at(-1).deviceId,'d_rebinda2');
  const other=await route({action:'status',provider:'okx',goalId},{userId:USER_B,deviceId:'d_rebindb1'});
  assert.equal(other.status,200,'B 不受 A 重配对影响');
});

test('设备来源连接：按 userId 解析现役绑定，重配对后旧捕获守卫失效、新请求拿到新 deviceId',async()=>{
  const goalId='g_rebindgoal';
  const bindings={[USER_A]:{userId:USER_A,deviceId:'d_rebinda1'},[USER_B]:{userId:USER_B,deviceId:'d_rebindb1'}};
  const seen=[];
  const facade=deviceAwareSourceConnection({binding:id=>bindings[id]??null,
    gateway:{hasScope:()=>true,owned:()=>true,
      handle:async args=>{seen.push(args);return {state:'connected'};},
      sourceSnapshot:async args=>{seen.push(args);return null;}},
    legacy:{hasSavedSource:()=>{throw Error('有 scope 时 legacy 不应被触达');},
      sourceSnapshot:async()=>{throw Error('legacy 不应被触达');},handle:async()=>{throw Error('legacy 不应被触达');}}});
  await facade.handle({userId:USER_A,goalId,input:{action:'status'}});
  assert.equal(seen[0].deviceId,'d_rebinda1');
  const captured=seen[0].stillAuthorized;
  assert.equal(await captured(),true);
  // 重配对：A 的绑定整条替换。
  bindings[USER_A]={userId:USER_A,deviceId:'d_rebinda2'};
  assert.equal(await captured(),false,'无请求语境的后台路径复用的守卫同样随重配对失效');
  await facade.handle({userId:USER_A,goalId,input:{action:'status'}});
  assert.equal(seen[1].deviceId,'d_rebinda2','新请求解析到重配对后的现役绑定');
  await facade.handle({userId:USER_B,goalId,input:{action:'status'}});
  assert.equal(seen[2].deviceId,'d_rebindb1','B 的解析不受 A 重配对影响');
  assert.throws(()=>facade.handle({userId:'u_ghost000',goalId,input:{action:'status'}}),
    error=>error instanceof HostError&&error.status===403&&/配对已变化/.test(error.message),
    '绑定表里没有的用户直接拒绝');
});

// ---- 后台泵逐用户（§4 M2）：泵只处理调用方给定绑定自己的 journal 行 --------------------------------

const PUMP_NOW=Date.parse('2026-11-18T01:00:00Z');
const disconnect=connectionId=>({connectionId,version:1,state:'disconnected',observedAt:new Date(PUMP_NOW).toISOString()});

async function pumpFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'along-rebind-pump-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const calls=[];
  const server=createServer((req,res)=>{
    req.setEncoding('utf8');let raw='';
    req.on('data',chunk=>raw+=chunk);
    req.on('end',()=>{
      const path=new URL(req.url,'http://x').pathname;
      calls.push({path,method:req.method,user:req.headers['x-along-user'],device:req.headers['x-along-device'],body:raw?JSON.parse(raw):null});
      let body={};
      if (path==='/along-source/api/source-events') body={event_id:calls.at(-1).body.event_id,status:'accepted'};
      else if (path==='/along-source/api/source-reads') body={requests:[]};
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify(body));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const bridge=createBridge({url:`http://127.0.0.1:${server.address().port}`,token:'p'.repeat(64)});
  const journal=createSourceJournal({dir:join(dir,'journal')});
  return {calls,journal,openPump:getPairings=>{const pump=createSourceEventBridge({journal,connection:{},bridge,
    endpoint:`http://127.0.0.1:${server.address().port}`,stillBound:who=>getPairings().some(entry=>entry.user_id===who.userId&&entry.device_id===who.deviceId),
    adapters:{okx:{authorized:async()=>false,listGoals:async()=>[],lookup:async()=>null,hasSaved:async()=>false}}});
    t.after(()=>pump.close());return pump;}};
}

test('source 事件泵逐用户：A 的泵只发送 A 的待发事件与身份头，不代取 B 的 outbox',async t=>{
  const f=await pumpFixture(t);
  const A='u_pumpaaaa',B='u_pumpbbbb';
  f.journal.recordVerifiedState({userId:A,deviceId:'d_pumpaaa1'},'g_pump_a','okx',disconnect('conn_a'));
  f.journal.recordVerifiedState({userId:B,deviceId:'d_pumpbbb1'},'g_pump_b','okx',disconnect('conn_b'));
  const pairings=[{user_id:A,device_id:'d_pumpaaa1'},{user_id:B,device_id:'d_pumpbbb1'}];
  const pump=f.openPump(()=>pairings);
  await pump.pump({userId:A,deviceId:'d_pumpaaa1'});
  const sent=()=>f.calls.filter(call=>call.path==='/along-source/api/source-events');
  assert.equal(sent().length,1,'A 的一轮泵只发 A 自己的一条');
  assert.equal(sent()[0].user,A);
  assert.equal(sent()[0].device,'d_pumpaaa1','身份头来自调用方给定的绑定，泵不自取身份');
  assert.equal(sent()[0].body.goal_id,'g_pump_a');
  assert.equal(f.journal.outbox(A).length,0);
  assert.equal(f.journal.outbox(B).length,1,'B 的待发事件不被 A 的泵代取');
  await pump.pump({userId:B,deviceId:'d_pumpbbb1'});
  assert.equal(sent().length,2);
  assert.equal(sent()[1].user,B);
  assert.equal(sent()[1].device,'d_pumpbbb1');
  assert.equal(sent()[1].body.goal_id,'g_pump_b');
  assert.equal(f.journal.outbox(B).length,0);
});

test('source 事件泵的一致性复查：重配对整条替换绑定后旧绑定泵不动，新绑定接手发送',async t=>{
  const f=await pumpFixture(t);
  const A='u_pumpaaaa';
  f.journal.recordVerifiedState({userId:A,deviceId:'d_pumpold1'},'g_pump_a','okx',disconnect('conn_a'));
  let pairings=[{user_id:A,device_id:'d_pumpold1'}];
  const pump=f.openPump(()=>pairings);
  // 重配对：同一用户换设备，绑定整条替换。
  pairings=[{user_id:A,device_id:'d_pumpnew2'}];
  await pump.pump({userId:A,deviceId:'d_pumpold1'});
  assert.equal(f.calls.filter(call=>call.path==='/along-source/api/source-events').length,0,'已重配对的旧绑定一轮泵都不跑');
  assert.equal(f.journal.outbox(A).length,1,'待发事件原样保留');
  await pump.pump({userId:A,deviceId:'d_pumpnew2'});
  const sent=f.calls.filter(call=>call.path==='/along-source/api/source-events');
  assert.equal(sent.length,1);
  assert.equal(sent[0].device,'d_pumpnew2');
  assert.equal(f.journal.outbox(A).length,0,'新绑定接手把待发事件发完');
});

// ---- /super-agent/goals 的 recipient：include 与 remember 都用请求自身绑定的 token 哈希（§4 M2）------

const goalsSrc=HOST_SOURCE.slice(
  HOST_SOURCE.indexOf("if (req.method==='POST' && path==='/super-agent/goals') {"),
  HOST_SOURCE.indexOf("if (req.method==='POST' && path==='/super-agent/goals/status')"));

test('「/super-agent/goals」include 与 remember 都用请求自身绑定的哈希：A 记录的当日安排 B 读不到',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-rebind-daily-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  // 真实 normalizeGoalRun（VM 提取，参照 daily-actions-contract.test.mjs），只把 rememberDailyAction
  // 落点换成记录器——路由传什么 pair 就记什么，日期与真实时钟解耦。
  const remembered=[];
  const normalizeGoalRun=vm.runInNewContext(
    HOST_SOURCE.slice(HOST_SOURCE.indexOf('function normalizeGoalRun'),HOST_SOURCE.indexOf('const server=createServer'))+'\nnormalizeGoalRun',
    {...goalCore,...layoutMod,...policyMod,rememberDailyAction:(d,pair,run)=>remembered.push({pair,requestId:run?.requestId}),dir,console:{warn:()=>{}}});
  // include 侧用真实函数与共享状态目录：记录与读取落在同一个 current-daily-actions.json，按 pair 哈希分键。
  const TZ='Asia/Shanghai',nowMs=Date.now();
  const localDate=new Intl.DateTimeFormat('en-CA',{timeZone:TZ}).format(nowMs);
  const plan=(revisionId,minutesAgo)=>({version:1,revisionId,now:new Date(nowMs-minutesAgo*60_000).toISOString(),
    timezone:TZ,localDate,dailyDelegation:{id:'delegate-0123',goalKey:'health',topics:['sleep','workout'],weeklyWorkoutMinutes:120},currentPlan:{tasks:[]}});
  const snapshotFor=planning=>({contextReviewAllowed:true,selectedTypes:['workout','sleep'],planning});
  const rememberedRun={actual:true,runtime:'dsh-superagent',status:'done',requestId:'include-a1',ticket:{id:'ticket-a'},
    input:{goal:{domain:'health'},snapshot:snapshotFor(plan('include-a1',60))},
    result:{reassessment:{dailyActions:{localDate,workoutMinutes:15,workoutReminderAt:null,sleepReminderAt:null,bedtimeAt:null,reason:'测试记录'}}}};
  rememberDailyAction(dir,'a'.repeat(64),rememberedRun,nowMs);
  // DSH 运行信封（固定日期；parseDailyActionReply/validateDailyActions 只看信封内部时钟）。
  const dshRun={actual:true,kind:'goal',runtime:'dsh-superagent',status:'done',requestId:'along-daily-1',ticket:{id:'ticket-1'},
    input:{goal:{domain:'health'},snapshot:{contextReviewAllowed:true,selectedTypes:['workout','sleep'],
      planning:{version:1,revisionId:'along-daily-1',now:'2026-11-11T11:00:00Z',timezone:TZ,localDate:'2026-11-11',
        dailyDelegation:{id:'delegate-0123',goalKey:'health',topics:['sleep','workout'],weeklyWorkoutMinutes:120},currentPlan:{tasks:[]}}}},
    result:{reply:'按今天的记录安排。\nALONG_DAILY_ACTIONS_V1 '+JSON.stringify({localDate:'2026-11-11',workoutMinutes:15,
      workoutReminderAt:'2026-11-11T20:15:00+08:00',sleepReminderAt:'2026-11-11T23:15:00+08:00',
      bedtimeAt:'2026-11-12T00:05:00+08:00',reason:'本周尚有余量，今晚保留睡前收尾时间。'}),
      layout:null,proposal:null,reassessment:{decision:'keep',basedOnRevision:'along-daily-1',reason:'保留原任务。',changes:[],nextReviewAt:null,watchFor:[]}}};
  const sent=[];
  const makeRoute=({userId,recipient})=>vm.runInNewContext(`(async(req,res,path)=>{${goalsSrc}})`,{
    body:async req=>req.input,requestedRuntime:r=>r,DSH_RUNTIME:'dsh-superagent',KIMI_RUNTIME:'kimi-code-swarm',eventIngest:false,
    respond:(res,status,data)=>({status,data:JSON.parse(JSON.stringify(data))}),
    cleanGoal:v=>v,cleanSnapshot:v=>v??{},clientText:s=>s,requestId:s=>s,upstream:fn=>fn(),
    includeEarlierDailyAction,dir,recipient,who:{userId,deviceId:'d_'+userId.slice(2)},
    dshRunnerURL:null, // M3 新增的云端 runner 分支在本切片保持关闭（runner 路径由 host-runner-agreement 覆盖）。
    kimiAgent:{startGoal:async()=>{throw Error('不应走 Kimi 分支');}},
    superAgentCall:async (path,{value})=>{sent.push(value);return {run:structuredClone(dshRun)};},
    normalizeGoalRun,console:{warn:()=>{}}});
  const call=(route,input)=>route({method:'POST',input},null,'/super-agent/goals');
  const input=planning=>({runtime:'dsh-superagent',goal:{domain:'health',title:'健康'},message:'继续',history:[],requestId:planning.revisionId,snapshot:snapshotFor(planning)});
  // A 的请求：recipient=A 的绑定哈希 → include 读到 A 自己的当日安排，remember 记到 A 的键。
  const routeA=makeRoute({userId:'u_rebindaa',recipient:'a'.repeat(64)});
  const a1=await call(routeA,input(plan('include-a2',30)));
  assert.equal(a1.status,200);
  assert.equal(sent[0].snapshot.planning.recentDecisions.length,1,'A 的请求通过自己的绑定哈希读到自己的当日安排');
  assert.equal(JSON.parse(sent[0].snapshot.planning.recentDecisions[0].reason).workoutMinutes,15);
  assert.deepEqual(remembered,[{pair:'a'.repeat(64),requestId:'along-daily-1'}],'remember 的 pair 参数是请求自身绑定的哈希');
  // B 的请求：同一份快照、同一个共享状态目录，recipient=B 的哈希 → 读不到 A 的安排。
  const routeB=makeRoute({userId:'u_rebindbb',recipient:'b'.repeat(64)});
  const b1=await call(routeB,input(plan('include-b1',30)));
  assert.equal(b1.status,200);
  assert.equal(sent[1].snapshot.planning.recentDecisions,undefined,'B 的绑定读不到 A 的每日委托安排');
  assert.deepEqual(remembered,[{pair:'a'.repeat(64),requestId:'along-daily-1'},{pair:'b'.repeat(64),requestId:'along-daily-1'}],
    'B 的 remember 也记到 B 自己的键');
  // 没有每日委托的请求：normalizeGoalRun 收到 null，不落 remember。
  const plain=await call(routeA,input({version:1,revisionId:'plain-1',now:new Date(nowMs-30_000).toISOString(),
    timezone:TZ,localDate,dailyDelegation:null,currentPlan:{tasks:[]}}));
  assert.equal(plain.status,200);
  assert.equal(remembered.length,2,'没有每日委托就不落 remember（pair=null）');
});

// ---- host 装配锚：后台泵逐绑定、每用户锁与 Kimi 调用带请求自己的 userId ---------------------------

test('host 装配锚：后台泵按绑定表逐用户，/goal/event 分锁与 Kimi 四口都带请求自己的 userId',()=>{
  assert.match(HOST_SOURCE,/for \(const entry of pairings\) sourceEvents\.pump\(\{userId:entry\.user_id,deviceId:entry\.device_id\}\)/,
    'source 事件泵按绑定表逐绑定（host/agent-host.mjs:476-478）');
  assert.match(HOST_SOURCE,/for \(const entry of \[\.\.\.pairings\]\)/,'通知派发泵按绑定表逐用户（:215-229）');
  assert.match(HOST_SOURCE,/runExclusive\(who\.userId/,'/goal/event 每用户一把锁（:463）');
  assert.match(HOST_SOURCE,/kimiAgent\.startGoal\(goalInput,who\.userId\)/);
  assert.match(HOST_SOURCE,/kimiAgent\.startTask\(dshInput,who\.userId\)/);
  assert.match(HOST_SOURCE,/kimiAgent\.goalStatus\(who\.userId,id\)/);
  assert.match(HOST_SOURCE,/kimiAgent\.taskStatus\(who\.userId,id\)/);
  assert.doesNotMatch(HOST_SOURCE,/const identity\s*=/,'没有模块级 identity 单例');
});

// ---- 真实进程：重配对全链路（HTTPS，两人同时在线）------------------------------------------------

function freePort() {
  return new Promise(resolve=>{
    const server=net.createServer();
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port; server.close(()=>resolve(port));});
  });
}

function phoneCall(port,path,{method='GET',body,headers={}}={}) {
  const attempt=()=>new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const req=tlsRequest({host:'127.0.0.1',port,path,method,rejectUnauthorized:false,agent:false,
      headers:{...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...headers}},
    res=>{
      let text=''; res.on('data',chunk=>text+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,text,json:text?JSON.parse(text):null}));
    });
    req.setTimeout(10_000,()=>{ req.destroy(new Error(`phoneCall 超时（10s）：${method} ${path} @${port}`)); });
    req.on('error',reject);
    if (payload) req.write(payload);
    req.end();
  });
  return attempt().catch(error=>{
    if (['ECONNRESET','ECONNREFUSED','EPIPE'].includes(error.code)) return attempt();
    throw error;
  });
}

async function stubAlongAgent() {
  const calls=[];
  const server=createServer((req,res)=>{
    let raw=''; req.setEncoding('utf8');
    req.on('data',chunk=>raw+=chunk);
    req.on('end',()=>{
      const path=new URL(req.url,'http://x').pathname;
      if (path.startsWith('/along-source/api/')) calls.push({path,body:raw?JSON.parse(raw):null});
      let body={items:[]};
      if (path==='/along-source/api/source-reads') body={requests:[]};
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify(body));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {calls,port:server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}

async function spawnHost(t,{dir,agentPort}) {
  const port=await freePort();
  const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const apnsKey=join(dir,'apns-key.p8');
  writeFileSync(apnsKey,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const child=spawn(process.execPath,[HOST_FILE],{env:{
    ...process.env,
    ALONG_AGENT_STATE_DIR:dir,
    ALONG_AGENT_HOST:'127.0.0.1',
    ALONG_AGENT_PORT:String(port),
    ALONG_SUPERAGENT_URL:`http://127.0.0.1:${agentPort}`,
    ALONG_BRIDGE_TOKEN_FILE:join(dir,'bridge-token'),
    ALONG_EVENT_INGEST:'on',
    ALONG_APNS_KEY_FILE:apnsKey,
    ALONG_APNS_TEAM_ID:'ABCDEFGHIJ',
    ALONG_APNS_KEY_ID:'1234567890',
  },stdio:['ignore','pipe','pipe']});
  const output=[];
  child.stdout.on('data',data=>output.push(String(data)));
  child.stderr.on('data',data=>output.push(String(data)));
  const deadline=Date.now()+20_000;
  let ready=false;
  while (Date.now()<deadline) {
    try { const health=await phoneCall(port,'/health'); if (health.status===200) {ready=true; break;} } catch { /* 还没起来 */ }
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  const text=()=>output.join('');
  if (!ready && child.exitCode===null && !child.killed) child.kill('SIGKILL');
  assert.match(text(),/Along 服务: https:\/\/127\.0\.0\.1/,`Host 进程要起来：${text().slice(0,400)}`);
  let stopped=false;
  const stop=()=>new Promise(resolve=>{
    if (stopped||child.exitCode!==null||child.signalCode!==null) {stopped=true; return resolve();}
    stopped=true;
    child.once('exit',()=>resolve());
    child.kill('SIGINT');
    setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},3_000).unref?.();
  });
  return {port,text,stop};
}

async function waitFor(predicate,label,timeout=6_000) {
  const deadline=Date.now()+timeout;
  while (Date.now()<deadline) {
    if (predicate()) return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(false,`等待超时：${label}`);
}

function issueCodeViaCli(dir,userId) {
  return spawnSync(process.execPath,[PAIR_CODE_FILE,userId],
    {env:{...process.env,ALONG_AGENT_STATE_DIR:dir},encoding:'utf8'});
}

test('真实进程：A 重配对整条替换绑定——旧 token 401、新 token 接管同一份通知登记文件、B 完全不受影响',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-rebind-host-'));
  writeFileSync(join(dir,'users.json'),JSON.stringify([{userId:USER_A,label:'A'},{userId:USER_B,label:'B'}]),{mode:0o600});
  writeFileSync(join(dir,'bridge-token'),'c'.repeat(64),{mode:0o600});
  const agent=await stubAlongAgent();
  const host=await spawnHost(t,{dir,agentPort:agent.port});
  // 收尾：先停 host（回环连接排空），再关桩 Along Agent、删临时目录。
  t.after(async()=>{ await host.stop(); await agent.close(); rmSync(dir,{recursive:true,force:true}); });
  const call=(token,path,body)=>phoneCall(host.port,path,{method:'POST',headers:{authorization:`Bearer ${token}`},body});
  const pair=async userId=>{
    const code=issueCodeViaCli(dir,userId).stdout.trim();
    assert.match(code,/^\d{8}$/);
    const res=await call(null,'/pair',{code});
    assert.equal(res.status,200);
    assert.match(res.json.token,/^[a-f0-9]{64}$/);
    return res.json.token;
  };
  const tokenA1=await pair(USER_A),tokenB=await pair(USER_B);
  await waitFor(()=>{
    const registrations=agent.calls.filter(item=>item.path==='/along-source/api/pairing');
    return registrations.some(item=>item.body?.user_id===USER_A)&&registrations.some(item=>item.body?.user_id===USER_B);
  },'两个绑定各自注册');
  const deviceBefore=JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8'));
  // 两人各自登记通知设备（APNs 三件套已在 env，登记可落盘）。
  const regA=await call(tokenA1,'/notifications/device',{expectedUserId:USER_A,token:'ab'.repeat(32),environment:'development'});
  const regB=await call(tokenB,'/notifications/device',{expectedUserId:USER_B,token:'cd'.repeat(32),environment:'development'});
  assert.deepEqual(regA.json,{userId:USER_A,remoteNotifications:true});
  assert.deepEqual(regB.json,{userId:USER_B,remoteNotifications:true});
  // A 重配对：换码换绑定；旧 token 全面失效（authorized 按绑定表查找，替换后未命中）。
  const tokenA2=await pair(USER_A);
  assert.notEqual(tokenA2,tokenA1);
  const staleVerify=await call(tokenA1,'/connection/verify',{});
  assert.equal(staleVerify.status,401);
  assert.equal(staleVerify.json.error,'请先配对这台 Mac');
  assert.equal((await call(tokenA1,'/notifications/device',{expectedUserId:USER_A,token:'11'.repeat(16),environment:'development'})).status,401,
    '旧 token 连通知登记也被拒');
  // 新 token 接管；B 完全不受影响。
  assert.deepEqual((await call(tokenA2,'/connection/verify',{})).json,{paired:true});
  assert.deepEqual((await call(tokenB,'/connection/verify',{})).json,{paired:true});
  const regA2=await call(tokenA2,'/notifications/device',{expectedUserId:USER_A,token:'ee'.repeat(32),environment:'development'});
  assert.deepEqual(regA2.json,{userId:USER_A,remoteNotifications:true});
  // 绑定表：恰好两条，A 的 device 换新、hash 是新 token 的 SHA-256；B 的 hash/device 原样。
  const after=JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8'));
  assert.equal(after.length,2);
  const entryA=after.find(item=>item.user_id===USER_A),entryB=after.find(item=>item.user_id===USER_B);
  assert.equal(entryA.hash,sha256hex(tokenA2));
  assert.notEqual(entryA.device_id,deviceBefore.find(item=>item.user_id===USER_A).device_id,'A 的绑定整条替换（device 换新）');
  assert.equal(entryB.hash,sha256hex(tokenB));
  assert.equal(entryB.device_id,deviceBefore.find(item=>item.user_id===USER_B).device_id,'B 的绑定一字不动');
  // 通知登记：同一份每用户文件被新绑定重写，B 的文件不动，总数仍是 2。
  const notes=readdirSync(dir).filter(name=>name.startsWith('notification-device.')).sort();
  assert.deepEqual(notes,[`notification-device.${USER_A}.json`,`notification-device.${USER_B}.json`].sort());
  const stored=user=>JSON.parse(readFileSync(join(dir,`notification-device.${user}.json`),'utf8'));
  assert.equal(stored(USER_A).token,'ee'.repeat(32));
  assert.equal(stored(USER_A).deviceId,entryA.device_id);
  assert.equal(stored(USER_B).token,'cd'.repeat(32),'B 的登记文件不被 A 重配对触碰');
});
