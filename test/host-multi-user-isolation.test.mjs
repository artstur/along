import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {request as tlsRequest} from 'node:https';
import {createServer} from 'node:http';
import net from 'node:net';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {KimiCodeAgent} from '../host/kimi-code-agent.mjs';
import {taskNotifications} from '../host/task-notifications.mjs';
import {registerDailyGrant} from '../host/daily-delegation.mjs';

// 每用户隔离（docs/cloud-deploy-multi-user.md §4 M2，验收 #2）：
// - 每请求身份：/sync、/events 回环身份头等于请求者自己的绑定（A、B 各自解析，不共享单例）；
// - /goal/event 每用户一把锁：A、B 并发都推进，同一用户并发第二条 429；
// - 通知登记 notification-device.<userId>.json 互不覆盖，别人的事件推不到本机设备；
// - Kimi 运行键 `${userId}:${requestId}`：B 查 A 的 requestId 报「运行记录不存在」；
// - 每日委托 recipient 用请求自身绑定的 token 哈希：A 查不到 B 的索引。

const USER_A='u_aaaa1111',USER_B='u_bbbb2222';
const BRIDGE_TOKEN='c'.repeat(64);
const HOST_FILE=fileURLToPath(new URL('../host/agent-host.mjs',import.meta.url));
const PAIR_CODE_FILE=fileURLToPath(new URL('../host/pair-code.mjs',import.meta.url));
const sha256hex=value=>createHash('sha256').update(value).digest('hex');

// ---- 单元切片：Kimi 运行键与通知登记 --------------------------------------------------------------------------------

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

test('Kimi 运行键带 userId 前缀：B 查 A 的 requestId 报「运行记录不存在」，回执 requestId 仍是手机自己的编号',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-iso-kimi-'));
  const statePath=join(dir,'kimi-runs.json');
  try {
    const agent=new KimiCodeAgent({token:'t',statePath,workspace:'/along',fetchImpl:kimiFetch(JSON.stringify(goalResult))});
    await agent.startGoal({...goalInput,requestId:'req-iso'},USER_A);
    const saved=JSON.parse(readFileSync(statePath,'utf8'));
    assert.deepEqual(Object.keys(saved),[`${USER_A}:req-iso`],'运行记录按 userId:requestId 分键，不共享全局键');
    assert.equal(saved[`${USER_A}:req-iso`].sessionId,'session-1');
    const run=await agent.goalStatus(USER_A,'req-iso');
    assert.equal(run.requestId,'req-iso','回执 requestId 仍是手机自己的编号，不带前缀');
    await assert.rejects(()=>agent.goalStatus(USER_B,'req-iso'),/运行记录不存在/,'B 查 A 的 requestId 无记录');
    await assert.rejects(()=>agent.taskStatus(USER_A,'req-iso'),/运行记录不存在/,'goal 与 task 的键也分开');
    await assert.rejects(()=>agent.goalStatus(undefined,'req-iso'),/缺少用户身份/,'缺用户身份直接拒绝，不落到无前缀键');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('通知登记按用户分文件互不覆盖；别人的事件记录推不到本机设备',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-iso-notes-'));
  try {
    const A={userId:'u_isoaa1111',deviceId:'d_isoaa1111'},B={userId:'u_isobb2222',deviceId:'d_isobb2222'};
    const clock=Date.UTC(2026,9,11,1);
    const sent=[];
    const make=(user,readPage=async()=>({items:[]}))=>taskNotifications({dir,userId:user.userId,binding:()=>user,now:()=>clock,readPage,
      send:async route=>{sent.push(route);return 'accepted';}});
    const input=(user,token='ab'.repeat(32))=>({token,environment:'development',expectedUserId:user.userId});
    make(A).register(A,input(A));
    make(B).register(B,input(B,'cd'.repeat(32)));
    assert.deepEqual(readdirSync(dir).sort(),
      [`notification-device.${A.userId}.json`,`notification-device.${B.userId}.json`].sort(),'每用户一份登记文件');
    const stored=user=>JSON.parse(readFileSync(join(dir,`notification-device.${user.userId}.json`),'utf8'));
    assert.equal(stored(A).token,'ab'.repeat(32));
    assert.equal(stored(B).token,'cd'.repeat(32));
    make(B).register(B,input(B,'ee'.repeat(32)));
    assert.equal(stored(A).token,'ab'.repeat(32),'B 重登记不动 A 的文件');
    assert.equal(stored(B).token,'ee'.repeat(32));
    // A 的泵拿到 userId 不是 A 的事件记录：ingest 拒绝，不推到 A 的设备。
    const pages=[];
    const a=make(A,async()=>({items:pages}));
    pages.push({seq:1,createdAt:new Date(clock+1).toISOString(),userId:B.userId,goalId:'g_test',
      payload:{notification:{kind:'recommendation_ready',event_id:'event:1',revision:2}}});
    await a.dispatch();
    assert.deepEqual(sent,[],'别人的事件记录不会成为 A 设备的推送');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('Kimi 运行记录接到 host 状态目录（跟随 ALONG_AGENT_STATE_DIR）',()=>{
  const source=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');
  assert.match(source,/statePath:join\(dir,'kimi-runs\.json'\)/,'kimi-runs.json 不再固定在 ~/.along/agent-host');
  assert.doesNotMatch(source,/identity\s*=\s*null/,'模块级 identity 单例已移除');
});

// ---- 真实进程：HTTPS 全链路（两个用户各自配对后的隔离表现）---------------------------------------------------------

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

// 桩 Along Agent：记录回环调用的头与体，按路径应答最小集。
async function stubAlongAgent() {
  const calls=[];
  const server=createServer(async(req,res)=>{
    let raw=''; for await (const chunk of req) raw+=chunk;
    const url=new URL(req.url,'http://x');
    const record={path:url.pathname,url:req.url,method:req.method,headers:req.headers,body:raw?JSON.parse(raw):undefined};
    calls.push(record);
    let body={};
    if (record.path==='/along-source/api/events') body={status:'accepted',event_id:record.body?.event_id};
    else if (record.path==='/along-source/api/sync'||record.path==='/along-source/api/goals') body={items:[]};
    else if (record.path==='/along-source/api/source-reads') body={requests:[]};
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify(body));
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
    CODEX_BIN:join(dir,'codex-stub.mjs'),
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

// /goal/event 的最小健康输入：before 0 → after 20（目标 100）触发 replan，remaining=80。
const goalEventInput=()=>({goal:{domain:'health',title:'本周运动目标',target:100},
  before:{selectedTypes:['workout'],workoutMinutes:0},after:{selectedTypes:['workout'],workoutMinutes:20}});

test('多用户隔离全链路：回环身份头、通知分文件、每日委托索引、/goal/event 各自锁',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-multi-user-iso-'));
  // 测试桩 codex：用开始/释放屏障确认请求确实在途，不靠 CPU 时序碰并发窗口。
  writeFileSync(join(dir,'codex-stub.mjs'),`#!/usr/bin/env node
import {writeFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
let output=null;
const argv=process.argv.slice(2);
for (let i=0;i<argv.length;i++) if (argv[i]==='--output-last-message') output=argv[i+1];
let raw='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>raw+=chunk);
process.stdin.on('end',()=>{
  const remaining=Number(/"remaining":(\\d+)/.exec(raw)?.[1]??0);
  writeFileSync(join(root,'codex-started-'+process.pid),'started');
  const deadline=Date.now()+20_000;
  const timer=setInterval(()=>{
    if (!existsSync(join(root,'codex-release-'+process.pid)) && Date.now()<deadline) return;
    clearInterval(timer);
    writeFileSync(output,JSON.stringify({task:'按当前节奏继续',reason:'测试桩建议',remaining}));
  },20);
});
`,{mode:0o600});
  chmodSync(join(dir,'codex-stub.mjs'),0o700);
  writeFileSync(join(dir,'users.json'),JSON.stringify([{userId:USER_A,label:'A'},{userId:USER_B,label:'B'}]),{mode:0o600});
  writeFileSync(join(dir,'bridge-token'),BRIDGE_TOKEN,{mode:0o600});
  const agent=await stubAlongAgent();
  const host=await spawnHost(t,{dir,agentPort:agent.port});
  // 统一收尾：先停 host（回环连接排空），再关桩 Along Agent、删临时目录；
  // 少关任何一个监听都会让 node --test 进程挂着不退出。
  const started=()=>readdirSync(dir).filter(name=>/^codex-started-\d+$/.test(name));
  const release=()=>{for(const name of started())writeFileSync(join(dir,name.replace('started','release')),'release');};
  t.after(async()=>{ release(); await host.stop(); await agent.close(); rmSync(dir,{recursive:true,force:true}); });
  const call=(token,path,body)=>phoneCall(host.port,path,{method:'POST',headers:{authorization:`Bearer ${token}`},body});

  // CLI 发码 → 两人各自配对，两个 token 同时有效。
  const codeA=issueCodeViaCli(dir,USER_A).stdout.trim();
  const codeB=issueCodeViaCli(dir,USER_B).stdout.trim();
  assert.match(codeA,/^\d{8}$/); assert.match(codeB,/^\d{8}$/);
  const pairA=await call(null,'/pair',{code:codeA});
  const pairB=await call(null,'/pair',{code:codeB});
  assert.equal(pairA.status,200); assert.equal(pairB.status,200);
  const tokenA=pairA.json.token,tokenB=pairB.json.token;
  assert.match(tokenA,/^[a-f0-9]{64}$/); assert.match(tokenB,/^[a-f0-9]{64}$/);
  await waitFor(()=>{
    const registrations=agent.calls.filter(item=>item.path==='/along-source/api/pairing');
    return registrations.some(item=>item.body?.user_id===USER_A)&&registrations.some(item=>item.body?.user_id===USER_B);
  },'两个绑定各自注册');

  // 验收 #2：/sync 转发头 x-along-user 等于请求者绑定——A、B 各自解析，不共享身份。
  assert.equal((await call(tokenA,'/sync',{})).status,200);
  assert.equal((await call(tokenB,'/sync',{})).status,200);
  const syncs=()=>agent.calls.filter(item=>item.path==='/along-source/api/sync');
  assert.equal(syncs().at(-1).headers['x-along-user'],USER_B,'B 的 /sync 带自己的身份头');
  assert.equal(syncs().at(-2).headers['x-along-user'],USER_A,'A 的 /sync 带自己的身份头');
  assert.equal(syncs().at(-2).url.includes(`user_id=${USER_A}`),true,'/sync 查询参数同样来自请求者绑定');

  // /events 同理：转发头按请求者绑定；A 的事件不会挂在 B 名下。
  assert.deepEqual((await call(tokenA,'/events',{event_id:'evt-a'})).json,{status:'accepted',event_id:'evt-a'});
  assert.deepEqual((await call(tokenB,'/events',{event_id:'evt-b'})).json,{status:'accepted',event_id:'evt-b'});
  const events=()=>agent.calls.filter(item=>item.path==='/along-source/api/events');
  assert.equal(events().at(-1).headers['x-along-user'],USER_B);
  assert.equal(events().at(-2).headers['x-along-user'],USER_A);

  // 通知登记：notification-device.<userId>.json 互不覆盖（APNs 三件套已在 env，登记可落盘）。
  const registerA=await call(tokenA,'/notifications/device',{expectedUserId:USER_A,token:'ab'.repeat(32),environment:'development'});
  const registerB=await call(tokenB,'/notifications/device',{expectedUserId:USER_B,token:'cd'.repeat(32),environment:'development'});
  assert.deepEqual(registerA.json,{userId:USER_A,remoteNotifications:true});
  assert.deepEqual(registerB.json,{userId:USER_B,remoteNotifications:true});
  const stored=user=>JSON.parse(readFileSync(join(dir,`notification-device.${user}.json`),'utf8'));
  assert.equal(stored(USER_A).token,'ab'.repeat(32));
  assert.equal(stored(USER_B).token,'cd'.repeat(32),'B 的登记写在自己的文件里');

  // 每日委托索引：键含请求绑定自己的 pair 哈希——A 查不到 B 的委托授权。
  const pairings=JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8'));
  const hashB=pairings.find(item=>item.user_id===USER_B).hash;
  registerDailyGrant(dir,hashB,'daily-anchor',{goalKey:'health',id:'delegation',topics:['sleep'],requestId:'req-daily',ticketId:'ticket-1'});
  assert.deepEqual((await call(tokenA,'/super-agent/daily-delegation',{goalKey:'health',anchors:['daily-anchor']})).json,{grant:null},
    'A 的绑定查不到 B 的每日委托索引');
  assert.equal((await call(tokenB,'/super-agent/daily-delegation',{goalKey:'health',anchors:['daily-anchor']})).json.grant.id,'delegation');

  // /goal/event 每用户一把锁：A、B 并发都推进；同一用户并发第二条 429。
  const a1=call(tokenA,'/goal/event',goalEventInput());
  await waitFor(()=>started().length===1,'A 的第一条请求实际进入执行');
  const b1=call(tokenB,'/goal/event',goalEventInput());
  const a2=call(tokenA,'/goal/event',goalEventInput());
  const a2r=await a2;
  assert.equal(a2r.status,429,'同一用户并发第二条 429');
  assert.match(a2r.json.error,/正在处理/);
  await waitFor(()=>started().length===2,'A 尚未完成时，B 能独立进入执行');
  release();
  const [b1r,a1r]=await Promise.all([b1,a1]);
  assert.equal(b1r.status,200,'B 不被 A 的在途请求阻塞');
  assert.equal(b1r.json.suggestion.remaining,80);
  assert.equal(a1r.status,200,'A 的第一条请求正常完成');
  assert.equal(a1r.json.suggestion.remaining,80);
  assert.equal(a1r.json.decision,'replan');
});
