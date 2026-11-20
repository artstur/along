import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import vm from 'node:vm';
import {createBridge, readBridgeToken} from '../host/along-bridge.mjs';
import {HostError} from '../host/host-error.mjs';
import {reconcileOkxSources} from '../host/source-access.mjs';

// Host↔Along Agent 回环接口（docs/stage-a-tech-design.md §2.4/§4.2）。Along Agent 侧契约（含归属 404 不泄露）由
// along-superagent 仓库的 tests/along-bridge.spec.ts 锁定；这里锁 Host 侧：桥接凭证只在本机进程之间走、
// 身份只来自服务端绑定的配对会话、回执按 Along Agent 原状态码透传、新旧单消费开关（BC-07-04/05、BC-09-03/04）。

const TOKEN='a'.repeat(64);
const USER_A='u_aaaa1111';
const DEVICE_A='d_aaaa1111';

// ---- 桥接客户端：真实 HTTP 替身 Along Agent ------------------------------------------------------------------------------

async function stubAlongAgent(handler) {
  const seen=[];
  const server=createServer(async (req,res)=>{
    let body='';
    for await (const chunk of req) body+=chunk;
    const outcome=await handler({seen,path:new URL(req.url,'http://x').pathname,method:req.method,headers:req.headers,body});
    if (outcome.seen!==undefined) seen.push(...outcome.seen);
    res.writeHead(outcome.status??200,{'content-type':'application/json'});
    res.end(JSON.stringify(outcome.body??{}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {seen,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}

test('readBridgeToken 只认 0600 hex 文件：缺失、不存在、内容不对都返回 null',()=>{
  assert.equal(readBridgeToken(),null,'未设置 ALONG_BRIDGE_TOKEN_FILE 时没有凭证');
  assert.equal(readBridgeToken('/along/no/such/file'),null);
  const directory=mkdtempSync(join(tmpdir(),'along-bridge-'));
  try {
    const file=join(directory,'bridge-token');
    writeFileSync(file,`${TOKEN}\n`);
    assert.equal(readBridgeToken(file),TOKEN,'末尾换行要裁掉');
    writeFileSync(file,'not-a-token');
    assert.equal(readBridgeToken(file),null,'内容不是 64 位 hex 就当没配');
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('bridge 调用带 x-along-bridge、桥接 token 与绑定身份头，且不发第二份凭证',async()=>{
  const agent=await stubAlongAgent(({headers,body})=>{
    assert.equal(headers['x-along-bridge'],'1');
    assert.equal(headers['x-along-bridge-token'],TOKEN);
    assert.equal(headers['x-along-user'],USER_A);
    assert.equal(headers['x-along-device'],DEVICE_A);
    assert.equal(headers['x-along-context-token'],undefined,'专用情境凭证不随普通调用发');
    return {status:200,body:{echo:JSON.parse(body)}};
  });
  try {
    const bridge=createBridge({url:agent.url,token:TOKEN});
    const result=await bridge.call('/along-source/api/tasks',{value:{goal:'健康'},identity:{userId:USER_A,deviceId:DEVICE_A}});
    assert.deepEqual(result,{echo:{goal:'健康'}});
    assert.deepEqual(agent.seen,[]);
  } finally { await agent.close(); }
});

test('bridge.call 把上游非 2xx 一律答成上游故障（502），401 给出凭证提示',async()=>{
  const agent=await stubAlongAgent(({path})=>path==='/denied'?{status:401,body:{}}:{status:404,body:{}});
  try {
    const bridge=createBridge({url:agent.url,token:TOKEN});
    await assert.rejects(()=>bridge.call('/missing'),error=>error instanceof HostError&&error.status===502&&/404/.test(error.message),'无 error 字段时回退到状态码文案');
    await assert.rejects(()=>bridge.call('/denied'),error=>error instanceof HostError&&error.status===502&&/凭证/.test(error.message));
  } finally { await agent.close(); }
});

test('bridge.receipt 透传 200/400/409 回执，其余状态仍按上游故障抛 502',async()=>{
  const agent=await stubAlongAgent(({body})=>({status:JSON.parse(body).expect,body:{status:'rejected',reason:'not_found'}}));
  try {
    const bridge=createBridge({url:agent.url,token:TOKEN});
    for (const expect of [200,400,409]) {
      const {status,result}=await bridge.receipt('/along-source/api/events',{value:{expect}});
      assert.equal(status,expect);
      assert.deepEqual(result,{status:'rejected',reason:'not_found'});
    }
    await assert.rejects(()=>bridge.receipt('/along-source/api/events',{value:{expect:503}}),error=>error.status===502);
  } finally { await agent.close(); }
});

test('bridge.ready 容忍旧版 Along Agent 的 404，其余非 2xx 按 503 未就绪处理；网络不通也是 503',async()=>{
  const agent=await stubAlongAgent(()=>({status:404,body:{}}));
  try {
    assert.equal(await createBridge({url:agent.url,token:TOKEN}).ready(),true);
  } finally { await agent.close(); }
  const broken=await stubAlongAgent(()=>({status:500,body:{}}));
  try {
    await assert.rejects(()=>createBridge({url:broken.url,token:TOKEN}).ready(),error=>error instanceof HostError&&error.status===503);
  } finally { await broken.close(); }
  await assert.rejects(()=>createBridge({url:'http://127.0.0.1:1',token:TOKEN}).ready(),error=>error instanceof HostError&&error.status===503);
});

// ---- agent-host 新链路：VM 替身直跑（参照 recent-health-context.test.mjs 的切片写法）--------------------------

const hostSource=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');
const newLinkSource=hostSource.slice(
  hostSource.indexOf('const eventIngest = process.env.ALONG_EVENT_INGEST'),
  hostSource.indexOf('function requestId(value)'));

test('new events stay retryable while the paired identity cannot be registered upstream',async()=>{
  const link=newLinkContext({env:{ALONG_EVENT_INGEST:'on'},bridgeCall:()=>{throw new HostError('upstream unavailable',502);}});
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(()=>link.run('/events',{event_id:'evt-unregistered'}),error=>error.status===503);
  assert.equal(link.calls.some(call=>call.path.endsWith('/events')),false,'events must not be accepted before their owner can originate work');
});

function newLinkContext(overrides={}) {
  const calls=[];
  const record=(path,options)=>calls.push(JSON.parse(JSON.stringify({path,options})));
  const bridge={
    async call(path,options={}) {
      record(path,options);
      if (overrides.bridgeCall) return overrides.bridgeCall(path,options);
      if (path.includes('/along-source/api/pairing')) return {registered:true};
      return {};
    },
    async receipt(path,options={}) {
      record(path,options);
      return overrides.bridgeReceipt?overrides.bridgeReceipt(path,options):{status:200,result:{status:'accepted',event_id:'evt-1'}};
    },
  };
  const respondLog=[];
  // 整段切片按模块语义只执行一次（IIFE）：eventIngest 读取与启动注册在装配时发生，
  // handleAlongNewLink 再被逐请求调用——和生产里「模块加载一次 + 每请求进路由」一致。
  const handle=vm.runInNewContext(`(()=>{${newLinkSource}\nreturn handleAlongNewLink})()`,{
    process:{env:{...(overrides.env??{})}},
    dir:'/unused',
    localHost:true,
    // 每请求身份（M2）：绑定由 authorized 按请求自己的 token 在绑定表中命中返回；
    // overrides.identity 为 null 表示「没有绑定」（resolveBinding 按 403 拒绝）。
    authorized:overrides.identity===null?()=>null:()=>({user_id:USER_A,device_id:DEVICE_A,hash:'x'.repeat(64)}),
    pairings:[{hash:'x'.repeat(64),user_id:USER_A,device_id:DEVICE_A}],
    createApnsProvider:()=>null,
    taskNotifications:()=>({decorate:(_,page)=>page}),setInterval:()=>({unref(){}}),reconcileOkxSources,
    HostError,
    respond:(res,status,data)=>{const outcome={status,data:JSON.parse(JSON.stringify(data))};respondLog.push(outcome);return outcome;},
    body:async req=>req.input,
    upstream:fn=>fn(),
    bridge,
    bridgeToken:overrides.bridgeToken===undefined?TOKEN:overrides.bridgeToken,
    console:{warn:()=>{}},
  });
  return {calls,respondLog,handle,
    run:(path,input)=>handle({input},null,path)};
}

test('新端点在 ALONG_EVENT_INGEST 未开启时按 503 拒绝，不发起任何事件/同步回环调用',async()=>{
  const link=newLinkContext({env:{}});
  await assert.rejects(()=>link.run('/events',{event_id:'evt-1'}),error=>error instanceof HostError&&error.status===503&&/新链路/.test(error.message));
  await assert.rejects(()=>link.run('/sync',{}),error=>error.status===503);
  assert.deepEqual(link.calls.filter(item=>!item.path.includes('/pairing')),[],'被拒端点不进回环（启动注册不受开关影响）');
});

test('新端点在未配置桥接凭证时按 503 拒绝（旧链路不受影响由调用点保证）',async()=>{
  const link=newLinkContext({env:{ALONG_EVENT_INGEST:'on'},bridgeToken:null});
  await assert.rejects(()=>link.run('/sync',{}),error=>error.status===503&&/桥接凭证/.test(error.message));
  assert.deepEqual(link.calls,[]);
});

test('BC-07-04：请求体自称 user_id/device_id 直接按 rejected 拒绝，回执带原事件号',async()=>{
  const link=newLinkContext({env:{ALONG_EVENT_INGEST:'on'}});
  const outcome=await link.run('/events',{event_id:'evt-9',user_id:'u_bbbb2222',payload:{}});
  assert.deepEqual(outcome,{status:400,data:{status:'rejected',event_id:'evt-9',reason:'identity_in_body'}});
  const device=await link.run('/events',{event_id:'evt-10',device_id:'d_bbbb2222'});
  assert.equal(device.data.reason,'identity_in_body');
  const illegal=await link.run('/events',{user_id:'u_bbbb2222'});
  assert.deepEqual(illegal.data,{status:'rejected',reason:'identity_in_body'},'没有合法事件号就不回显');
  assert.equal(link.calls.filter(item=>item.path.includes('/events')).length,0,'自报身份的请求不进回环');
});

test('BC-07-05（Host 侧）：Along Agent 的归属拒绝按原状态码透传，不二次包装、不泄露对方字段',async()=>{
  const link=newLinkContext({env:{ALONG_EVENT_INGEST:'on'},
    bridgeReceipt:()=>({status:400,result:{status:'rejected',reason:'not_found'}})});
  const outcome=await link.run('/events',{event_id:'evt-3',goal_id:'g_bbb000000002',payload:{event_type:'along.user_message',text:'看别人的目标'}});
  assert.deepEqual(outcome,{status:400,data:{status:'rejected',reason:'not_found'}});
  assert.equal(JSON.stringify(outcome).includes('u_bbbb2222'),false);
  assert.equal(link.calls.some(item=>item.path==='/along-source/api/events'),true);
  const receipt=link.calls.find(item=>item.path==='/along-source/api/events');
  assert.deepEqual(receipt.options.identity,{userId:USER_A,deviceId:DEVICE_A},'身份头来自服务端绑定的配对会话');
  assert.equal(receipt.options.timeout,30_000,'/events 含 DSH 投递触发，用 30s 超时');
});

test('配对身份幂等注册：启动/首次调用都会把 {user_id,device_id} 交给 /along-source/api/pairing',async()=>{
  const fresh=newLinkContext({env:{ALONG_EVENT_INGEST:'on'},identity:null});
  // authorized 未命中（没有绑定）时新端点按 403 拒绝（配对身份缺失）。
  await assert.rejects(()=>fresh.run('/sync',{}),error=>error.status===403&&/重新配对/.test(error.message));
  const link=newLinkContext({env:{ALONG_EVENT_INGEST:'on'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(link.calls[0],{path:'/along-source/api/pairing',
    options:{value:{user_id:USER_A,device_id:DEVICE_A},identity:{userId:USER_A,deviceId:DEVICE_A},timeout:5_000}},
    '模块加载即注册既有绑定，且带绑定身份头（Along Agent 对 /along-source/api/* 一律要求 x-along-user/x-along-device）');
  // Along Agent 不可达时注册失败要静默重试：下一次新端点调用先补注册再转发。
  const retry=newLinkContext({env:{ALONG_EVENT_INGEST:'on'},
    bridgeCall:(path)=>{ if (path.includes('/pairing')&&retry.calls.filter(item=>item.path.includes('/pairing')).length===1) throw new HostError('Along 服务暂不可用：down',502); return {items:[]}; }});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(retry.calls.length,1,'启动注册失败不崩、不阻塞');
  const outcome=await retry.run('/sync',{after_seq:2,limit:10});
  assert.deepEqual(outcome,{status:200,data:{items:[]}});
  assert.equal(retry.calls.filter(item=>item.path.includes('/pairing')).length,2,'失败后下一次新端点调用会再试一次');
  assert.equal(retry.calls.at(-1).path,'/along-source/api/sync?user_id=u_aaaa1111&after_seq=2&limit=10');
  assert.equal(retry.calls.at(-1).options.method,'GET');
});

test('/sync 与 /sync/ack 把绑定身份带进回环调用，ack 序号非法按 400 拒绝',async()=>{
  const link=newLinkContext({env:{ALONG_EVENT_INGEST:'on'}});
  await link.run('/sync',{});
  assert.equal(link.calls.at(-1).path,'/along-source/api/sync?user_id=u_aaaa1111&after_seq=0&limit=50','缺省游标走 0/50');
  await assert.rejects(()=>link.run('/sync/ack',{seqs:[1,'x']}),/同步确认序号无效/);
  await assert.rejects(()=>link.run('/sync/ack',{seqs:[]}),/同步确认序号无效/);
  await link.run('/sync/ack',{seqs:[3,4]});
  assert.deepEqual(link.calls.at(-1),{path:'/along-source/api/sync/ack',
    options:{value:{seqs:[3,4]},identity:{userId:USER_A,deviceId:DEVICE_A}}});
});

// 旧 pairing.json 的幂等升级测试随 M1 迁到 test/host-multi-user-pairing.test.mjs：
// 配对逻辑收敛进 host/pairing.mjs 后可直接 import 断言，不再需要 VM 源码切片。

test('新链路路由行必须 await：未 await 的异步处理函数会把设计内错误变成未处理拒绝、打崩进程',()=>{
  // P0 回归锚（agent-host.mjs 路由区）：handleAlongNewLink 是 async，路由行若写成
  // `return handleAlongNewLink(...)`，off→503、ack 非法→400、上游故障→502 都到不了外层
  // try/catch，进程直接退出；必须 `return await` 才能按设计语义应答手机。
  assert.match(hostSource,/return await handleAlongNewLink\(req,res,path\)/);
  assert.doesNotMatch(hostSource,/return handleAlongNewLink\(req,res,path\);/);
});

// ---- 旧链路 409：新链路开启后 DSH 分支停止消费用户输入（BC-09-03）------------------------------------------------

function routeSlice(startMarker,endMarker,context) {
  const start=hostSource.indexOf(startMarker);
  const end=hostSource.indexOf(endMarker,start);
  return vm.runInNewContext(`(async(req,res,path)=>{${hostSource.slice(start,end)}})`,context);
}

test('ALONG_EVENT_INGEST=on 时旧 /super-agent/goals|tasks 的 DSH 分支 409，Kimi 分支不受影响',async()=>{
  const seen=[];
  const shared={
    body:async req=>req.input,requestedRuntime:r=>r,KIMI_RUNTIME:'kimi-code-swarm',DSH_RUNTIME:'dsh-superagent',
    respond:(res,status,data)=>({status,data}),upstream:fn=>fn(),
    cleanGoal:v=>v,cleanSnapshot:v=>v??{},clientText:s=>s,requestId:s=>s,normalizeGoalRun:r=>r,
    agentHealthSnapshot:v=>v?.context,
    // 每请求身份（M2）：Kimi 运行键带 userId 前缀，路由把请求自己的绑定传给 kimiAgent。
    who:{userId:'u_aaaa1111',deviceId:'d_aaaa1111'},
    dshRunnerURL:null, // M3 云端 runner 分支：切片里保持关闭（runner 路径由 host-runner-agreement 覆盖）。
    kimiAgent:{startGoal:async input=>{seen.push(['kimi-goal',input]);return {};},startTask:async input=>{seen.push(['kimi-task',input]);return {};}},
    superAgentCall:async (path,{value})=>{seen.push(['dsh',path,value]);return {};},
  };
  const goalsRoute=routeSlice("if (req.method==='POST' && path==='/super-agent/goals') {","if (req.method==='POST' && path==='/super-agent/goals/status')",{...shared,eventIngest:true});
  const tasksRoute=routeSlice("if (req.method==='POST' && path==='/super-agent/tasks') {","if (req.method==='POST' && path==='/super-agent/tasks/status')",{...shared,eventIngest:true});
  for (const [route,kind,routePath] of [[goalsRoute,'goal','/super-agent/goals'],[tasksRoute,'task','/super-agent/tasks']]) {
    seen.length=0;
    assert.deepEqual(JSON.parse(JSON.stringify(await route({method:'POST',input:{runtime:'dsh-superagent'}},null,routePath))),{status:409,data:{error:'已切换新链路'}});
    assert.deepEqual(seen,[],'新链路开启后 DSH 分支停止消费用户输入');
    seen.length=0;
    assert.equal(JSON.parse(JSON.stringify(await route({method:'POST',input:{runtime:'kimi-code-swarm',goal:{domain:'health'},snapshot:{},message:'继续',requestId:'r1'}},null,routePath))).status,200);
    assert.deepEqual(seen.map(([who])=>who),[`kimi-${kind}`],'Kimi 分支不经 DSH 适配器，不受开关影响');
  }
  const offGoals=routeSlice("if (req.method==='POST' && path==='/super-agent/goals') {","if (req.method==='POST' && path==='/super-agent/goals/status')",{...shared,eventIngest:false});
  const offTasks=routeSlice("if (req.method==='POST' && path==='/super-agent/tasks') {","if (req.method==='POST' && path==='/super-agent/tasks/status')",{...shared,eventIngest:false});
  seen.length=0;
  assert.equal(JSON.parse(JSON.stringify(await offGoals({method:'POST',input:{runtime:'dsh-superagent',goal:{domain:'health'},snapshot:{},message:'继续',requestId:'r1'}},null,'/super-agent/goals'))).status,200);
  assert.deepEqual(seen.map(([who])=>who),['dsh'],'off 时旧链路照旧');
  seen.length=0;
  assert.equal(JSON.parse(JSON.stringify(await offTasks({method:'POST',input:{runtime:'dsh-superagent',goal:{domain:'health'}}},null,'/super-agent/tasks'))).status,200);
  assert.deepEqual(seen.map(([who])=>who),['dsh']);
});
