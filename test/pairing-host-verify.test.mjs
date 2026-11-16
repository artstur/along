import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {request as tlsRequest} from 'node:https';
import {createServer} from 'node:http';
import net from 'node:net';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// 配对模块 Host 侧独立验证（配对身份绑定 + Token 只留 Mac + BC-07-04/05 的手机侧入口）。
// 与 test/along-bridge.test.mjs 的 VM 切片不同：这里把 host/agent-host.mjs 当真实进程启动，
// 用 HTTPS 走完整手机路径（一次性配对码 → /pair → Bearer → 新端点），桩 Along Agent 收真实 HTTP 调用。
// 锚点：BC-07-04（宿主绑定身份，手机/模型不可自报）、BC-07-05（透传拒绝不泄露）、AGENTS.md §5（桥接凭证只在本机）。

const BRIDGE_TOKEN='c'.repeat(64);
const CTX_TOKEN='d'.repeat(64);
const USER_B='u_bbbb2222';
const DEVICE_B='d_bbbb2222';
const HOST_FILE=fileURLToPath(new URL('../host/agent-host.mjs',import.meta.url));
const sha256hex=value=>createHash('sha256').update(value).digest('hex');

function freePort() {
  return new Promise(resolve=>{
    const server=net.createServer();
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port; server.close(()=>resolve(port));});
  });
}

// 桩 Along Agent：记录每一次回环调用（真实 HTTP 头与体），按路径前缀脚本化响应。
async function stubAlongAgent() {
  const calls=[];
  const script=new Map();
  const server=createServer(async(req,res)=>{
    let raw=''; for await (const chunk of req) raw+=chunk;
    // url 保留查询串（/sync 的 user_id/after_seq 断言要用），path 只留 pathname 供精确匹配。
    const url=new URL(req.url,'http://x');
    const record={path:url.pathname,url:req.url,method:req.method,headers:req.headers,
      body:raw?JSON.parse(raw):undefined};
    calls.push(record);
    // 按完整路径精确匹配：/sync 与 /sync/ack 是不同端点，不能前缀混配。
    const matched=[...script.keys()].find(path=>record.path===path);
    const outcome=matched?script.get(matched)(record):{status:200,body:{}};
    res.writeHead(outcome.status??200,{'content-type':'application/json'});
    res.end(JSON.stringify(outcome.body??{}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {calls,script,port:server.address().port,
    close:()=>new Promise(resolve=>server.close(resolve))};
}

// 手机视角的 HTTPS 调用（自签证书关校验，等同 App 的 pinning 信任）。
// Along Agent:false：每请求即断开，不给 Host 的 server.close 留 keep-alive 连接（避免停机等待）。
// 10s 硬超时 + 连接级错误重试一次：测试进程不允许被启动竞态（openssl 生成证书期间被复位）
// 挂住或误判；有副作用的调用（/pair 正确码）被复位即视为本次未生效，一次重试仍是同一意图。
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

async function spawnHost({dir,agentPort,eventIngest=false,contextTokenFile=null}) {
  const port=await freePort();
  const child=spawn(process.execPath,[HOST_FILE],{env:{
    ...process.env,
    ALONG_AGENT_STATE_DIR:dir,
    ALONG_AGENT_HOST:'127.0.0.1',
    ALONG_AGENT_PORT:String(port),
    ALONG_SUPERAGENT_URL:`http://127.0.0.1:${agentPort}`,
    ALONG_BRIDGE_TOKEN_FILE:join(dir,'bridge-token'),
    ...(contextTokenFile?{ALONG_CONTEXT_REVIEW_TOKEN_FILE:contextTokenFile}:{}),
    ...(eventIngest?{ALONG_EVENT_INGEST:'on'}:{}),
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
  const text=output.join('');
  if (!ready && child.exitCode===null && !child.killed) {
    // 只有起不来才收尾：不留下孤儿进程拖住测试进程；起成功时绝不能动它。
    child.kill('SIGKILL');
  }
  assert.match(text,/Along 服务: https:\/\/127\.0\.0\.1/,`Host 进程要起来：${text.slice(0,400)}`);
  let stopped=false;
  return {port,child,pairingCode:/一次性配对码: (\d+)/.exec(text)?.[1]??null,
    stop:()=>new Promise(resolve=>{
      // 幂等：测试内与 t.after 可能各停一次；进程已退出（含被信号杀死，exitCode 为 null）时
      // 再挂 'exit' 监听永远不会触发，必须直接放行。
      if (stopped||child.exitCode!==null||child.signalCode!==null) {stopped=true; return resolve();}
      stopped=true;
      child.once('exit',()=>resolve());
      child.kill('SIGINT');
      setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},3_000).unref?.();
    })};
}

async function waitFor(predicate,label,timeout=6_000) {
  const deadline=Date.now()+timeout;
  while (Date.now()<deadline) {
    if (predicate()) return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(false,`等待超时：${label}`);
}

// 场景一：旧 pairing.json（仅 hash）真实进程启动 → 幂等升级、鉴权门、自报身份拒绝、
// BC-07-05 透传不泄露、桥接/情境凭证只在本机与 Along Agent 之间走（BC-07-04/05、AGENTS.md §5）。
test('真实 Host：旧绑定升级 + 鉴权门 + 自报身份拒绝 + 归属拒绝透传 + 凭证不出 Mac',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-pairing-verify-'));
  const agent=await stubAlongAgent();
  writeFileSync(join(dir,'pairing.json'),JSON.stringify({hash:sha256hex('e'.repeat(64))}),{mode:0o600});
  writeFileSync(join(dir,'bridge-token'),`${BRIDGE_TOKEN}\n`,{mode:0o600});
  writeFileSync(join(dir,'context-token'),`${CTX_TOKEN}\n`,{mode:0o600});
  agent.script.set('/along-source/api/events',()=>({status:400,body:{status:'rejected',reason:'not_found'}}));
  const host=await spawnHost({dir,agentPort:agent.port,eventIngest:true,contextTokenFile:join(dir,'context-token')});
  t.after(async()=>{ await host.stop(); await agent.close(); rmSync(dir,{recursive:true,force:true}); });
  const oldPhoneToken='e'.repeat(64);
  const bearer={authorization:`Bearer ${oldPhoneToken}`};
  const pairingFile=()=>JSON.parse(readFileSync(join(dir,'pairing.json'),'utf8'));

  await waitFor(()=>agent.calls.some(item=>item.path==='/along-source/api/pairing'),'启动注册');
  const upgraded=pairingFile();
  assert.equal(upgraded.hash,sha256hex(oldPhoneToken),'旧文件升级不改配对 token hash（手机无感）');
  assert.match(upgraded.user_id,/^u_[0-9a-f]{8}$/);
  assert.match(upgraded.device_id,/^d_[0-9a-f]{8}$/);
  const registration=agent.calls.find(item=>item.path==='/along-source/api/pairing');
  assert.deepEqual(registration.body,{user_id:upgraded.user_id,device_id:upgraded.device_id});
  assert.equal(registration.headers['x-along-bridge'],'1');
  assert.equal(registration.headers['x-along-bridge-token'],BRIDGE_TOKEN,'启动注册就带桥接凭证');
  assert.equal(registration.headers['x-along-user'],upgraded.user_id);
  assert.equal(registration.headers['x-along-device'],upgraded.device_id);

  // 鉴权门：没有 Bearer 的手机请求到不了 Along Agent。
  const anonymous=await phoneCall(host.port,'/events',{method:'POST',body:{event_id:'evt-1'}});
  assert.equal(anonymous.status,401);
  assert.equal(agent.calls.filter(item=>item.path==='/along-source/api/events').length,0,'未配对请求不进回环');

  // BC-07-04：请求体自称 user_id/device_id → 400 rejected，Along Agent 一次都没被调。
  const claimedUser=await phoneCall(host.port,'/events',{method:'POST',
    headers:{...bearer,'x-along-user':USER_B,'x-along-device':DEVICE_B},
    body:{event_id:'evt-9',user_id:USER_B,payload:{event_type:'along.user_message',text:'冒充别人'}}});
  assert.deepEqual(claimedUser.json,{status:'rejected',event_id:'evt-9',reason:'identity_in_body'});
  const claimedDevice=await phoneCall(host.port,'/events',{method:'POST',
    headers:bearer,body:{event_id:'evt-10',device_id:DEVICE_B}});
  assert.equal(claimedDevice.status,400);
  assert.equal(claimedDevice.json.reason,'identity_in_body');
  const claimedSync=await phoneCall(host.port,'/sync',{method:'POST',
    headers:bearer,body:{user_id:USER_B}});
  assert.deepEqual(claimedSync.json,{error:'身份字段只能由配对会话提供'});
  const claimedAck=await phoneCall(host.port,'/sync/ack',{method:'POST',
    headers:bearer,body:{seqs:[1],user_id:USER_B}});
  assert.equal(claimedAck.status,400);
  const agentEventCalls=()=>agent.calls.filter(item=>item.path==='/along-source/api/events').length;
  const agentSyncCalls=()=>agent.calls.filter(item=>item.path.startsWith('/along-source/api/sync')).length;
  assert.equal(agentEventCalls(),0,'自报身份的 /events 不进回环');
  assert.equal(agentSyncCalls(),0,'自报身份的 /sync、/sync/ack 不进回环');

  // BC-07-05：手机带伪造身份头请求 B 的目标事件，Along Agent 收到的身份头仍是服务端绑定身份；
  // Along Agent 的归属拒绝（400 rejected not_found）原样透传，响应不含 B 的任何字段。
  const foreign=await phoneCall(host.port,'/events',{method:'POST',
    headers:{...bearer,'x-along-user':USER_B,'x-along-device':DEVICE_B},
    body:{event_id:'evt-3',goal_id:'g_bbb000000002',payload:{event_type:'along.user_message',text:'看别人的目标'}}});
  assert.equal(foreign.status,400);
  assert.deepEqual(foreign.json,{status:'rejected',reason:'not_found'});
  assert.equal(JSON.stringify(foreign).includes(USER_B),false,'响应不回显冒充的身份');
  assert.equal(JSON.stringify(foreign).includes('g_bbb000000002'),false,'响应不回显 B 的目标号');
  const forwarded=agent.calls.filter(item=>item.path==='/along-source/api/events').at(-1);
  assert.equal(forwarded.headers['x-along-user'],upgraded.user_id,'伪造的 x-along-user 不影响回环身份头');
  assert.equal(forwarded.headers['x-along-device'],upgraded.device_id);
  assert.equal(forwarded.headers['x-along-bridge-token'],BRIDGE_TOKEN);
  assert.equal('user_id' in forwarded.body,false,'转发体不注入也不保留身份字段');
  assert.equal(forwarded.headers['x-along-context-token'],undefined,'普通调用不带情境专用凭证');

  // 409 conflict 回执也按原状态码透传（BC-08-03 的手机侧语义）。
  agent.script.set('/along-source/api/events',()=>({status:409,body:{status:'conflict',event_id:'evt-3'}}));
  const conflict=await phoneCall(host.port,'/events',{method:'POST',headers:bearer,body:{event_id:'evt-3'}});
  assert.equal(conflict.status,409);
  assert.deepEqual(conflict.json,{status:'conflict',event_id:'evt-3'});

  // /sync 的 user_id 查询参数由绑定身份构造，手机传什么都改不了；分页参数夹紧。
  agent.script.set('/along-source/api/sync',record=>{
    assert.equal(record.method,'GET');
    return {status:200,body:{items:[]}};
  });
  const sync=await phoneCall(host.port,'/sync',{method:'POST',headers:{...bearer,'x-along-user':USER_B},body:{}});
  assert.equal(sync.status,200);
  const syncCalls=()=>agent.calls.filter(item=>item.path==='/along-source/api/sync').map(item=>item.url);
  assert.equal(syncCalls().at(-1),`/along-source/api/sync?user_id=${encodeURIComponent(upgraded.user_id)}&after_seq=0&limit=50`,
    'user_id 查询参数由绑定身份构造，伪造头改不了');
  await phoneCall(host.port,'/sync',{method:'POST',headers:bearer,body:{after_seq:3,limit:9999}});
  assert.equal(syncCalls().at(-1).includes('after_seq=3&limit=200'),true,'limit 夹紧到 200');
  await phoneCall(host.port,'/sync',{method:'POST',headers:bearer,body:{after_seq:-5}});
  assert.equal(syncCalls().at(-1).includes('after_seq=0&limit=50'),true,'非法 after_seq 回落 0/50');

  // /sync/ack 只透传序号，身份仍来自绑定。
  agent.script.set('/along-source/api/sync/ack',()=>({status:200,body:{acked:2}}));
  const badAck=await phoneCall(host.port,'/sync/ack',{method:'POST',headers:bearer,body:{seqs:[1,'x']}});
  assert.equal(badAck.status,400,'非法序号由 Host 先拒，不进回环');
  const ack=await phoneCall(host.port,'/sync/ack',{method:'POST',headers:bearer,body:{seqs:[3,4]}});
  assert.equal(ack.status,200);
  const ackCall=agent.calls.find(item=>item.path==='/along-source/api/sync/ack');
  assert.deepEqual(ackCall.body,{seqs:[3,4]});
  assert.equal(ackCall.headers['x-along-user'],upgraded.user_id);

  // 情境评估专用凭证：只加在情境 URL 的调用上，且桥接凭证同时在场（回写记录③）。
  agent.script.set('/along-source/api/goals/along-review-1',()=>({status:200,body:{}}));
  const review=await phoneCall(host.port,'/super-agent/goals/status',{method:'POST',
    headers:bearer,body:{runtime:'dsh-superagent',requestId:'along-review-1',contextReview:true}});
  assert.equal(review.status,200);
  const reviewCall=agent.calls.find(item=>item.path==='/along-source/api/goals/along-review-1');
  assert.equal(reviewCall.method,'GET');
  assert.equal(reviewCall.headers['x-along-bridge-token'],BRIDGE_TOKEN,'情境评估调用同样带桥接凭证');
  assert.equal(reviewCall.headers['x-along-context-token'],CTX_TOKEN,'专用情境凭证只发本机 DSH');

  // Token 只留 Mac：回环头永远是我们配置的桥接凭证；手机收到的每个响应体都不含桥接/情境凭证。
  for (const call of agent.calls) {
    if (call.headers['x-along-bridge-token']!==undefined) {
      assert.equal(call.headers['x-along-bridge-token'],BRIDGE_TOKEN);
    }
  }
  for (const response of [anonymous,claimedUser,claimedDevice,claimedSync,foreign,conflict,sync,ack,review]) {
    assert.equal(response.text.includes(BRIDGE_TOKEN)||response.text.includes(CTX_TOKEN),false,
      `手机响应不得含凭证：${response.text.slice(0,120)}`);
  }

  // 路径注入边界：requestId 是手机可控的路径段，必须过校验（防 /along-source 前缀穿越）。
  const injection=await phoneCall(host.port,'/super-agent/goals/status',{method:'POST',
    headers:bearer,body:{runtime:'dsh-superagent',requestId:'../pairing'}});
  assert.equal(injection.status,400);
});

// 场景二：/pair 生命周期——新配对生成 {hash,user_id,device_id}；换手机（重启后重新 /pair）
// user_id 不变、device_id 换新、注册重发（D1 单用户，§2.4.1）。
test('真实 Host：/pair 生成绑定，重启后重新配对 user_id 不变、device_id 换新',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-pairing-verify-'));
  const agent=await stubAlongAgent();
  writeFileSync(join(dir,'bridge-token'),BRIDGE_TOKEN,{mode:0o600});
  const host=await spawnHost({dir,agentPort:agent.port,eventIngest:true});
  t.after(async()=>{ await host.stop(); await agent.close(); rmSync(dir,{recursive:true,force:true}); });
  const pairingFile=()=>existsSync(join(dir,'pairing.json'))?JSON.parse(readFileSync(join(dir,'pairing.json'),'utf8')):null;

  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(agent.calls.filter(item=>item.path==='/along-source/api/pairing').length,0,'没有绑定就没有启动注册');
  assert.equal(pairingFile(),null);

  const wrong=await phoneCall(host.port,'/pair',{method:'POST',body:{code:'00000000'}});
  assert.equal(wrong.status,403);
  assert.equal(pairingFile(),null,'配对码错误不产生绑定');

  const paired=await phoneCall(host.port,'/pair',{method:'POST',body:{code:host.pairingCode}});
  assert.equal(paired.status,200);
  assert.deepEqual(Object.keys(paired.json),['token'],'/pair 响应只有配对 token，不含桥接凭证与身份');
  assert.match(paired.json.token,/^[a-f0-9]{64}$/);
  const first=pairingFile();
  assert.equal(first.hash,sha256hex(paired.json.token));
  assert.match(first.user_id,/^u_[0-9a-f]{8}$/);
  assert.match(first.device_id,/^d_[0-9a-f]{8}$/);
  await waitFor(()=>agent.calls.some(item=>item.path==='/along-source/api/pairing'),'配对后注册');
  const registered=agent.calls.find(item=>item.path==='/along-source/api/pairing');
  assert.deepEqual(registered.body,{user_id:first.user_id,device_id:first.device_id});
  assert.equal(registered.headers['x-along-user'],first.user_id);

  const bearer={authorization:`Bearer ${paired.json.token}`};
  agent.script.set('/along-source/api/sync',()=>({status:200,body:{items:[]}}));
  const sync=await phoneCall(host.port,'/sync',{method:'POST',headers:bearer,body:{}});
  assert.equal(sync.status,200,'新配对 token 立即可用');
  const stranger=await phoneCall(host.port,'/sync',{method:'POST',
    headers:{authorization:`Bearer ${'f'.repeat(64)}`},body:{}});
  assert.equal(stranger.status,401,'别人的 64hex token 过不了鉴权门');

  await host.stop();
  const second=await spawnHost({dir,agentPort:agent.port,eventIngest:true});
  t.after(()=>second.stop());
  assert.notEqual(second.pairingCode,host.pairingCode,'重启后是新的一次性配对码');
  const repaired=await phoneCall(second.port,'/pair',{method:'POST',body:{code:second.pairingCode}});
  assert.equal(repaired.status,200);
  const rebound=pairingFile();
  assert.equal(rebound.user_id,first.user_id,'换手机 user_id 不变（D1 单用户）');
  assert.notEqual(rebound.device_id,first.device_id,'换手机 device_id 换新');
  assert.equal(rebound.hash,sha256hex(repaired.json.token),'配对 token 换新');
  await waitFor(()=>agent.calls.some(item=>item.path==='/along-source/api/pairing' &&
    item.body?.device_id===rebound.device_id),'重绑注册');
  const rebind=agent.calls.filter(item=>item.path==='/along-source/api/pairing').at(-1);
  assert.deepEqual(rebind.body,{user_id:rebound.user_id,device_id:rebound.device_id});
  assert.equal(rebind.headers['x-along-device'],rebound.device_id);
});

// 场景三：新旧单消费开关在真实进程里的表现（BC-09-03 的手机侧）：off 新端点 503、旧 DSH 链路照旧
// 且带桥接凭证；on 新端点生效、旧 /super-Along Agent/tasks 的 DSH 分支 409 且不进回环。
test('真实 Host：ALONG_EVENT_INGEST off/on 的单消费切换',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'along-pairing-verify-'));
  writeFileSync(join(dir,'pairing.json'),JSON.stringify({
    hash:sha256hex('e'.repeat(64)),user_id:'u_aaaa1111',device_id:'d_aaaa1111'}),{mode:0o600});
  writeFileSync(join(dir,'bridge-token'),BRIDGE_TOKEN,{mode:0o600});
  const phoneToken='e'.repeat(64);
  const bearer={authorization:`Bearer ${phoneToken}`};

  const agentOff=await stubAlongAgent();
  agentOff.script.set('/along-source/api/tasks',()=>({status:200,body:{ok:true}}));
  const hostOff=await spawnHost({dir,agentPort:agentOff.port,eventIngest:false});
  t.after(async()=>{ await hostOff.stop(); await agentOff.close(); });
  const eventsOff=await phoneCall(hostOff.port,'/events',{method:'POST',headers:bearer,body:{event_id:'evt-1'}});
  assert.equal(eventsOff.status,503);
  assert.match(eventsOff.json.error,/新链路/);
  assert.equal(agentOff.calls.filter(item=>item.path==='/along-source/api/events').length,0,'off 时 /events 不进回环');
  const oldLink=await phoneCall(hostOff.port,'/super-agent/tasks',{method:'POST',headers:bearer,
    body:{runtime:'dsh-superagent',goal:{domain:'custom',title:'x',target:null}}});
  assert.equal(oldLink.status,200);
  assert.deepEqual(oldLink.json,{ok:true},'off 时旧 DSH 链路照旧');
  const oldCall=agentOff.calls.find(item=>item.path==='/along-source/api/tasks');
  assert.equal(oldCall.method,'POST');
  assert.equal(oldCall.headers['x-along-bridge-token'],BRIDGE_TOKEN,'旧链路调用同样带桥接凭证');
  assert.equal(oldCall.headers['x-along-user'],undefined,'旧链路不注入身份头（兼容现状）');

  const agentOn=await stubAlongAgent();
  const hostOn=await spawnHost({dir,agentPort:agentOn.port,eventIngest:true});
  t.after(async()=>{ await hostOn.stop(); await agentOn.close(); rmSync(dir,{recursive:true,force:true}); });
  const tasksOn=await phoneCall(hostOn.port,'/super-agent/tasks',{method:'POST',headers:bearer,
    body:{runtime:'dsh-superagent',goal:{domain:'custom',title:'x',target:null}}});
  assert.equal(tasksOn.status,409);
  assert.deepEqual(tasksOn.json,{error:'已切换新链路'});
  assert.equal(agentOn.calls.filter(item=>item.path==='/along-source/api/tasks').length,0,'on 时旧 DSH 分支不进回环');
  agentOn.script.set('/along-source/api/events',()=>({status:200,body:{status:'accepted',event_id:'evt-1',received_seq:1}}));
  const eventsOn=await phoneCall(hostOn.port,'/events',{method:'POST',headers:bearer,body:{event_id:'evt-1'}});
  assert.equal(eventsOn.status,200);
  assert.deepEqual(eventsOn.json,{status:'accepted',event_id:'evt-1',received_seq:1},'on 时新端点生效');
});
