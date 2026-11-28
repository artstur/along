import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {installDomStub} from './dom-stub.mjs';

// ATS-88 独立复核提出的四项缺陷的回归。
//
// 场景来自复核附件里的复现脚本（工单 ATS-88 附件），断言改成「修复后应当的样子」：
//   - 健康：原生读回全空时不能显示「已连接」；读取失败要在当前页面立刻可见；
//   - 昵称：按「已核验的 Host + UID」隔离，换 Host、换 UID 都不串；
//   - 服务：配对成功但检查没通过时显示「已配对、服务暂不可用」，不报「已连接 Along」；
//   - OKX：重开设置页回读原生状态；撤回排队要说清本机已停采集但仍待 Host 接收。
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const AGENT_KEY='along.agent.v1';
const PROFILE_KEY='along.user-profile.v1';
const USER_ID='u_12345678';
const HOST_A='https://a.example.invalid';
const HOST_B='https://b.example.invalid';
const READY={along:true,ready:true,eventProtocol:1,userId:USER_ID};

const settle=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
let serial=0;

async function app({connection=null,bridge=null,health=null,source=null}={}) {
  const dom=installDomStub({storage:connection?{[AGENT_KEY]:JSON.stringify(connection)}:{}});
  globalThis.location={hostname:'app',protocol:'along:'};
  document.documentElement.classList={add(){},remove(){}};
  window.dispatchEvent=event=>{void dom.fireWindow(event.type,event);return true;};
  window.AlongHealthBridge=health;
  window.AlongAgentBridge={connection:async action=>action==='load'?connection:null,request:bridge,source};
  await import(`../web/app.mjs?ats88=${++serial}`);
  await settle();
  await dom.click({action:'open-settings'});
  return dom;
}
const serverSection=dom=>dom.app.innerHTML.split('aria-label="Along 服务"')[1]??'';
const sourceSection=dom=>dom.app.innerHTML.split('aria-label="数据源"')[1]?.split('aria-label="Along 服务"')[0]??'';
const toast=()=>document.querySelector('#toast').textContent;

test('a native readback without any value is not reported as connected',async()=>{
  const dom=await app({health:{refresh:async()=>({steps:null,selectedTypes:['steps'],contextReviewAllowed:true})}});
  await settle();
  assert.match(sourceSection(dom),/无可读取记录/,'读不到数值时要说读不到');
  assert.doesNotMatch(sourceSection(dom),/已连接/,'不能把空读数说成已连接');
  assert.match(sourceSection(dom),/重试/,'读不到时要能重试');
});

test('an asynchronous read failure shows up on the page that is open',async()=>{
  let fail;
  const dom=await app({health:{refresh:()=>new Promise((_,reject)=>{fail=reject;})}});
  await settle();
  assert.match(sourceSection(dom),/检查中/);
  fail(Error('isolated read error'));
  await settle();
  assert.match(sourceSection(dom),/读取失败/,'读取失败要在当前页面立刻看得见，不能只靠重开页面');
});

test('two Hosts returning the same UID never see each other nickname',async()=>{
  const bridge=async input=>input.path==='/pair'?{token:'b'.repeat(64)}
    :input.path==='/connection/status'?READY:{items:[]};
  const dom=await app({connection:{baseURL:HOST_A,token:'a'.repeat(64),fingerprint:'f'.repeat(64)},bridge});
  await dom.submitForm('nickname-form',{nickname:'OnlyHostA'});
  await dom.submitForm('pair-form',{baseURL:HOST_B,code:'stub'});
  assert.doesNotMatch(dom.app.innerHTML,/OnlyHostA/,'Host B 不能看到 Host A 的昵称');
  await dom.submitForm('nickname-form',{nickname:'OnlyHostB'});
  await dom.submitForm('pair-form',{baseURL:HOST_A,code:'stub'});
  assert.match(dom.app.innerHTML,/OnlyHostA/,'回到 Host A 要恢复 A 上次保存的昵称');
  assert.doesNotMatch(dom.app.innerHTML,/OnlyHostB/,'Host B 的昵称不能跟过来');
});

test('another UID neither sees nor overwrites the nickname, and the old one comes back',async()=>{
  let current=USER_ID;
  const bridge=async input=>input.path==='/pair'?{token:'c'.repeat(64)}
    :input.path==='/connection/status'?{...READY,userId:current}:{items:[]};
  const dom=await app({connection:{baseURL:HOST_A,token:'a'.repeat(64),fingerprint:'f'.repeat(64)},bridge});
  await dom.submitForm('nickname-form',{nickname:'FirstProfile'});
  current='u_87654321';
  await dom.submitForm('pair-form',{baseURL:HOST_A,code:'stub'});
  assert.doesNotMatch(dom.app.innerHTML,/FirstProfile/,'换个 UID 看不到别人的昵称');
  await dom.submitForm('nickname-form',{nickname:'SecondProfile'});
  current=USER_ID;
  await dom.submitForm('pair-form',{baseURL:HOST_A,code:'stub'});
  assert.match(dom.app.innerHTML,/FirstProfile/,'回到原 UID 要拿回自己的昵称');
  assert.doesNotMatch(dom.app.innerHTML,/SecondProfile/,'另一个 UID 的昵称不覆盖原来的');
  const stored=JSON.parse(dom.storage.get(PROFILE_KEY));
  assert.equal(stored.version,2);
  assert.equal(stored.nicknames[`https://a.example.invalid:443|${USER_ID}`],'FirstProfile');
  assert.equal(stored.nicknames['https://a.example.invalid:443|u_87654321'],'SecondProfile');
});

test('the OKX row is re-read when the settings page is reopened and speaks the revoke state',async()=>{
  const goal={id:'g_okx',domain:'custom',status:'active',revision:1,title:'OKX 目标',metric:null,context:[],tasks:[],
    dataSources:[{provider:'okx',status:'recommended',reason:'只读接入账户摘要'}]};
  const workspace={version:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,
    goals:{[goal.id]:goal},messages:{},drafts:{}};
  const config={baseURL:'https://along.example.com',token:'b'.repeat(64),trustPolicy:'system-pki-v1',bindingScopeId:'scope-1'};
  let status={provider:'okx',state:'connected',syncState:'pending'};
  const calls=[];
  const dom=installDomStub({storage:{
    [AGENT_KEY]:JSON.stringify(config),
    'along.event-connection.v1':JSON.stringify({bindingScopeId:'scope-1',userId:'u_app_b',bindingOrigin:'https://along.example.com:443'}),
    'along.event-workspace.v1:u_app_b':JSON.stringify(workspace)}});
  globalThis.window.AlongHealthBridge={connect:async()=>({}),healthEvents:async()=>({enabled:true}),clear:async()=>{}};
  globalThis.window.AlongAgentBridge={
    connection:async()=>config,
    request:async input=>{
      if (input.path==='/connection/status') return {along:true,ready:true,eventProtocol:1,userId:'u_app_b'};
      if (input.path==='/sync') return {items:[]};
      return {};},
    notification:async()=>({scheduled:true}),
    source:async(action,id)=>{calls.push([action,id]);return status;}};
  await import(`../web/app.mjs?ats88-okx=${++serial}`);
  await settle();
  await dom.click({action:'open-settings'});
  await settle();
  assert.match(sourceSection(dom),/OKX/,'有 OKX 数据源的目标要在设置页列出 OKX');
  assert.match(sourceSection(dom),/等待同步到 Mac/,'还没收到回执时要说明在等 Host 接收');
  // Host 确认收到后，重开设置页要回读，不能还停在旧状态。
  status={provider:'okx',state:'connected',syncState:'received'};
  await dom.click({action:'settings-back'});
  await dom.click({action:'open-settings'});
  await settle();
  assert.match(sourceSection(dom),/Mac 已收到摘要/,'重开设置页要回读原生状态');
  // 撤回排队：本机已停采集，但还等 Host 接收——不能只说「尚未连接」。
  status={provider:'okx',state:'disconnected',syncState:'pending'};
  await dom.click({action:'settings-back'});
  await dom.click({action:'open-settings'});
  await settle();
  assert.match(sourceSection(dom),/已停止采集/,'撤回排队要说本机已停采集');
  assert.match(sourceSection(dom),/撤回仍待 Host 接收/,'撤回排队要说明仍待 Host 接收');
  assert.ok(calls.some(([action,id])=>action==='status'&&id==='g_okx'),'状态要从原生读');
});

// 真实 Host：配对成功但 Agent 未就绪时，页面要说「已配对、服务暂不可用」，
// 并且「重试」复用既有凭据就能恢复——不重新配对、不换绑定。
function tls(port,path,payload,token) {
  return new Promise((resolve,reject)=>{
    const body=payload===undefined?null:JSON.stringify(payload);
    const req=httpsRequest({host:'127.0.0.1',port,path,method:body?'POST':'GET',rejectUnauthorized:false,agent:false,
      headers:{...(body?{'content-type':'application/json','content-length':Buffer.byteLength(body)}:{}),
        ...(token?{authorization:`Bearer ${token}`}:{})}},res=>{
      let raw='';res.on('data',chunk=>raw+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(raw)}));
    });
    req.on('error',reject);
    req.setTimeout(5000,()=>req.destroy(Error('isolated host timeout')));
    req.end(body);
  });
}
function freePort() {
  return new Promise(resolve=>{
    const server=createServer();
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});
  });
}

test('a real Host that pairs but is not ready is reported as paired and unavailable, and retry recovers it',async t=>{
  let ready=false;
  const upstream=createServer((req,res)=>{
    const probing=req.url==='/along-source/api/goals/along-status-probe';
    res.writeHead(probing&&!ready?503:200,{'content-type':'application/json'});
    res.end(JSON.stringify(probing?{service:'along-source',ready}:{items:[]}));
  });
  upstream.listen(0,'127.0.0.1');
  await once(upstream,'listening');
  const port=await freePort();
  const state=mkdtempSync(join(tmpdir(),'ats88-review-host-'));
  const bridgeFile=join(state,'bridge-token');
  writeFileSync(bridgeFile,createHash('sha256').update('ats88-review-fixture').digest('hex'),{mode:0o600});
  let host;
  const startHost=async()=>{
    host=spawn(process.execPath,['host/agent-host.mjs'],{cwd:ROOT,
      env:{...process.env,ALONG_AGENT_HOST:'127.0.0.1',ALONG_AGENT_PORT:String(port),ALONG_AGENT_STATE_DIR:state,
        ALONG_SUPERAGENT_URL:`http://127.0.0.1:${upstream.address().port}`,ALONG_BRIDGE_TOKEN_FILE:bridgeFile,ALONG_EVENT_INGEST:'on'},
      stdio:['ignore','pipe','pipe']});
    let output='';
    host.stdout.on('data',value=>output+=value);
    const deadline=Date.now()+20_000;
    while (!/一次性配对码: (\d+)/.test(output)&&Date.now()<deadline) await sleep(50);
    return /一次性配对码: (\d+)/.exec(output)?.[1]??null;
  };
  const stopHost=async()=>{
    if (host&&host.exitCode===null&&host.signalCode===null) {const done=once(host,'exit');host.kill('SIGTERM');await done;}
  };
  t.after(async()=>{await stopHost();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));rmSync(state,{recursive:true,force:true});});
  const code=await startHost();
  assert.ok(code,'隔离 Host 要能起来');
  const baseURL=`https://127.0.0.1:${port}`;
  const trace=[];
  const bridge=async input=>{
    const {status,value}=await tls(port,input.path,input.body,input.token);
    trace.push([input.path,status]);
    if (status>=400) throw Error(value.error);
    return value;
  };
  const dom=await app({bridge});
  await dom.submitForm('pair-form',{baseURL,code});
  assert.ok(trace.some(([path,status])=>path==='/pair'&&status===200));
  assert.ok(trace.some(([path,status])=>path==='/connection/status'&&status===503));
  assert.match(serverSection(dom),/已配对/,'配对成功要说已配对');
  assert.match(serverSection(dom),/服务暂不可用/,'服务检查没通过要说服务暂不可用');
  assert.doesNotMatch(serverSection(dom),/连接需处理/,'不能说连接需处理：那会让用户以为配对没成');
  assert.doesNotMatch(toast(),/已连接 Along/,'提示不能报「已连接 Along」');
  const token=JSON.parse(dom.storage.get(AGENT_KEY)).token;
  const authority=JSON.parse(readFileSync(join(state,'pairings.json'),'utf8'))[0];
  assert.equal(authority.hash,createHash('sha256').update(token).digest('hex'),'凭据按既有方式落盘');
  assert.equal((await tls(port,'/connection/verify',{},token)).status,200,'绑定仍然有效');
  // Agent 就绪后，手动重试即可恢复：复用原凭据，不重新配对。
  ready=true;
  await dom.click({action:'settings-retry-connection'});
  for (let i=0;i<80&&!serverSection(dom).includes('已连接');i++) await sleep(25);
  assert.match(serverSection(dom),/已连接/,'Agent 就绪后重试即恢复');
  assert.equal(JSON.parse(dom.storage.get(AGENT_KEY)).token,token,'重试不换掉已有凭据');
  // Host 进程停掉：状态要明确；同一 Host 重启后手动重试仍能恢复。
  ready=false;
  await dom.click({action:'settings-retry-connection'});
  for (let i=0;i<80&&!serverSection(dom).includes('服务暂不可用');i++) await sleep(25);
  assert.match(serverSection(dom),/已配对/,'Agent 掉线时仍是已配对');
  assert.match(serverSection(dom),/服务暂不可用/);
  await stopHost();
  await dom.click({action:'settings-retry-connection'});
  for (let i=0;i<80&&!serverSection(dom).includes('服务暂不可用');i++) await sleep(25);
  assert.match(serverSection(dom),/服务暂不可用/,'Host 不可达也要有明确状态');
  assert.equal(JSON.parse(dom.storage.get(AGENT_KEY)).token,token,'Host 不可达时不换凭据');
  await startHost();
  ready=true;
  await dom.click({action:'settings-retry-connection'});
  for (let i=0;i<80&&!serverSection(dom).includes('已连接');i++) await sleep(25);
  assert.match(serverSection(dom),/已连接/,'同一 Host 重启后手动重试可恢复');
  assert.equal(JSON.parse(dom.storage.get(AGENT_KEY)).token,token);
});

// —— 第二轮复验补的五个场景（ats88-reverify-55daf1d.md）——

test('an unsaved nickname draft does not follow a rebind to another Host',async()=>{
  const bridge=async input=>input.path==='/pair'?{token:'b'.repeat(64)}
    :input.path==='/connection/status'?READY:{items:[]};
  const dom=await app({connection:{baseURL:HOST_A,token:'a'.repeat(64),fingerprint:'f'.repeat(64)},bridge});
  await dom.app.dispatch('input',{target:{matches:selector=>selector.includes('nickname'),value:'DraftA'}});
  // 同一对身份内的重画不能把草稿抹掉。
  await dom.click({action:'settings-retry-connection'});
  await settle();
  assert.match(dom.app.innerHTML,/DraftA/,'正在输入的草稿要留在输入框里');
  // 同一页重配到另一台 Host：草稿属于原来那对身份，不能跟过去。
  await dom.submitForm('pair-form',{baseURL:HOST_B,code:'stub'});
  assert.doesNotMatch(dom.app.innerHTML,/DraftA/,'换绑后不能显示上一对身份的草稿');
  await dom.submitForm('nickname-form',{nickname:'SavedB'});
  const stored=JSON.parse(dom.storage.get(PROFILE_KEY));
  assert.equal(stored.nicknames['https://b.example.invalid:443|u_12345678'],'SavedB','保存要写进当前身份');
  assert.equal(stored.nicknames['https://a.example.invalid:443|u_12345678'],undefined,'不能写进原来那台 Host');
});

test('two connected legacy Hosts that do not return a UID keep separate nicknames',async()=>{
  // 旧协议 Host 的就绪回包带 ready 与 runtime，不带 userId。
  const legacy=async input=>input.path==='/pair'?{token:'d'.repeat(64)}
    :input.path==='/connection/status'?{along:true,ready:true,runtime:'dsh-superagent'}:{items:[]};
  const dom=await app({connection:{baseURL:HOST_A,token:'a'.repeat(64),fingerprint:'f'.repeat(64)},bridge:legacy});
  await dom.submitForm('nickname-form',{nickname:'LegacyA'});
  await dom.submitForm('pair-form',{baseURL:HOST_B,code:'stub'});
  assert.doesNotMatch(dom.app.innerHTML,/LegacyA/,'另一台旧协议 Host 不能看到 A 的昵称');
  await dom.submitForm('nickname-form',{nickname:'LegacyB'});
  await dom.submitForm('pair-form',{baseURL:HOST_A,code:'stub'});
  assert.match(dom.app.innerHTML,/LegacyA/,'切回 A 要拿回 A 自己的昵称');
  assert.doesNotMatch(dom.app.innerHTML,/LegacyB/,'B 的昵称不能跟过来');
});

test('a cold start whose credential check returns 401 updates the open settings page',async()=>{
  let rejectStatus;
  const dom=await app({connection:{baseURL:HOST_A,token:'a'.repeat(64),fingerprint:'f'.repeat(64)},
    bridge:async input=>{
      if (input.path==='/connection/status') return new Promise((_,reject)=>{rejectStatus=()=>reject(Object.assign(Error('请先配对这台 Mac'),{status:401}));});
      return {};}});
  await dom.click({action:'open-settings'});
  assert.match(serverSection(dom),/检查中|已配对/);
  rejectStatus();
  await settle();
  assert.match(serverSection(dom),/凭据已失效/,'401 要在当前页面立刻提示凭据失效');
  assert.match(serverSection(dom),/重新配对/,'并指引重新配对');
});

test('a revoked OKX connection that the Host acknowledged reads as acknowledged, not as a summary receipt',async()=>{
  const goal={id:'g_okx',domain:'custom',status:'active',revision:1,title:'OKX 目标',metric:null,context:[],tasks:[],
    dataSources:[{provider:'okx',status:'recommended',reason:'只读接入账户摘要'}]};
  const workspace={version:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,
    goals:{[goal.id]:goal},messages:{},drafts:{}};
  const config={baseURL:'https://along.example.com',token:'b'.repeat(64),trustPolicy:'system-pki-v1',bindingScopeId:'scope-1'};
  const dom=installDomStub({storage:{
    [AGENT_KEY]:JSON.stringify(config),
    'along.event-connection.v1':JSON.stringify({bindingScopeId:'scope-1',userId:'u_app_b',bindingOrigin:'https://along.example.com:443'}),
    'along.event-workspace.v1:u_app_b':JSON.stringify(workspace)}});
  globalThis.window.AlongHealthBridge={connect:async()=>({}),healthEvents:async()=>({enabled:true}),clear:async()=>{}};
  globalThis.window.AlongAgentBridge={
    connection:async()=>config,
    request:async input=>{
      if (input.path==='/connection/status') return {along:true,ready:true,eventProtocol:1,userId:'u_app_b'};
      if (input.path==='/sync') return {items:[]};
      return {};},
    notification:async()=>({scheduled:true}),
    // 原生在收到断开回执后转 stopped，并把对应序号记为已接收。
    source:async()=>({provider:'okx',state:'disconnected',syncState:'received'})};
  await import(`../web/app.mjs?ats88-okx-revoke=${++serial}`);
  await settle();
  await dom.click({action:'open-settings'});
  await settle();
  assert.match(sourceSection(dom),/撤回已获 Host 接收/,'撤回拿到回执要说撤回已获接收');
  assert.doesNotMatch(sourceSection(dom),/最后一份摘要已被 Host 接收/,'不能说成最后一份摘要已被接收');
});

test('an archived goal keeps no OKX connect action',async()=>{
  const archived={id:'g_old',domain:'custom',status:'archived',revision:1,title:'已归档目标',metric:null,context:[],tasks:[],
    dataSources:[{provider:'okx',status:'recommended',reason:'只读接入账户摘要'}]};
  const current={id:'g_now',domain:'custom',status:'active',revision:1,title:'当前目标',metric:null,context:[],tasks:[],dataSources:[]};
  const workspace={version:1,userId:'u_app_b',cursor:1,activeGoalId:current.id,conversationId:null,
    goals:{[archived.id]:archived,[current.id]:current},messages:{},drafts:{}};
  const config={baseURL:'https://along.example.com',token:'b'.repeat(64),trustPolicy:'system-pki-v1',bindingScopeId:'scope-1'};
  const calls=[];
  const dom=installDomStub({storage:{
    [AGENT_KEY]:JSON.stringify(config),
    'along.event-connection.v1':JSON.stringify({bindingScopeId:'scope-1',userId:'u_app_b',bindingOrigin:'https://along.example.com:443'}),
    'along.event-workspace.v1:u_app_b':JSON.stringify(workspace)}});
  globalThis.window.AlongHealthBridge={connect:async()=>({}),healthEvents:async()=>({enabled:true}),clear:async()=>{}};
  globalThis.window.AlongAgentBridge={
    connection:async()=>config,
    request:async input=>{
      if (input.path==='/connection/status') return {along:true,ready:true,eventProtocol:1,userId:'u_app_b'};
      if (input.path==='/sync') return {items:[]};
      return {};},
    notification:async()=>({scheduled:true}),
    source:async(action,id)=>{calls.push([action,id]);return {provider:'okx',state:'disconnected',syncState:'none'};}};
  await import(`../web/app.mjs?ats88-okx-archived=${++serial}`);
  await settle();
  await dom.click({action:'open-settings'});
  await settle();
  assert.doesNotMatch(sourceSection(dom),/OKX/,'只有已归档目标保留推荐时，不该给出连不上的 OKX 入口');
  assert.ok(!calls.some(([action,id])=>action==='connect'&&id==='g_old'),'不能把已归档目标传给原生桥');
});

// —— 第三轮复验补的三个场景（ats88-bd0392d-review.md）——

test('a save while a rebind is in flight does not write the old draft into the new identity',async()=>{
  let finishStatus;
  const bridge=async input=>{
    if (input.path==='/connection/status'&&input.baseURL===HOST_B) return new Promise(resolve=>{finishStatus=resolve;});
    return input.path==='/pair'?{token:'b'.repeat(64)}:READY;
  };
  const dom=await app({connection:{baseURL:HOST_A,token:'a'.repeat(64),fingerprint:'f'.repeat(64)},bridge});
  await dom.submitForm('nickname-form',{nickname:'SavedBeforeSwitch'});
  await dom.app.dispatch('input',{target:{matches:()=>true,value:'DraftDuringSwitch'}});
  const pending=dom.submitForm('pair-form',{baseURL:HOST_B,code:'stub'});
  await settle();
  assert.equal(typeof finishStatus,'function','B 的身份探测要处于等待中');
  await dom.submitForm('nickname-form',{nickname:'DraftDuringSwitch'});
  finishStatus(READY);
  await pending;
  const stored=JSON.parse(dom.storage.get(PROFILE_KEY)||'{"nicknames":{}}');
  assert.equal(stored.nicknames['https://b.example.invalid:443|u_12345678'],undefined,'换绑进行中不能把草稿写进新身份');
  assert.equal(stored.nicknames['https://a.example.invalid:443|u_12345678'],'SavedBeforeSwitch','原来那对身份不受影响');
});

test('an explicit same-address re-pair with new credentials leaves the new UID independent',async()=>{
  let advertisesUid=false;
  const transitions=async input=>input.path==='/pair'?{token:'e'.repeat(64)}
    :input.path==='/connection/status'?(advertisesUid?READY:{along:true,ready:true,runtime:'dsh-superagent'}):{items:[]};
  const dom=await app({connection:{baseURL:HOST_A,token:'a'.repeat(64),fingerprint:'f'.repeat(64)},bridge:transitions});
  await dom.submitForm('nickname-form',{nickname:'PreviousBinding'});
  advertisesUid=true;
  await dom.submitForm('pair-form',{baseURL:HOST_A,code:'stub'});
  const stored=JSON.parse(dom.storage.get(PROFILE_KEY));
  assert.equal(stored.nicknames['https://a.example.invalid:443|u_12345678'],undefined,'换配对码取得的新身份要独立显示');
  assert.equal(stored.nicknames['https://a.example.invalid:443|'],'PreviousBinding','旧昵称仍留在旧绑定名下');
});

test('the same binding that starts returning a UID keeps the nickname',async()=>{
  let advertisesUid=false;
  const transitions=async input=>input.path==='/connection/status'
    ?(advertisesUid?READY:{along:true,ready:true,runtime:'dsh-superagent'}):{items:[]};
  const dom=await app({connection:{baseURL:HOST_A,token:'a'.repeat(64),fingerprint:'f'.repeat(64)},bridge:transitions});
  await dom.submitForm('nickname-form',{nickname:'SameBinding'});
  advertisesUid=true;
  await dom.click({action:'settings-retry-connection'});
  await settle();
  assert.match(dom.app.innerHTML,/SameBinding/,'同一绑定升级协议时昵称要续用');
});

test('a late status probe does not override a newer successful retry',async()=>{
  const probes=[];
  const dom=await app({connection:{baseURL:HOST_A,token:'a'.repeat(64),fingerprint:'f'.repeat(64)},
    bridge:async input=>input.path==='/connection/status'
      ?new Promise((resolve,reject)=>{probes.push({resolve,reject});}):{items:[]}});
  await settle();
  assert.equal(probes.length,1);
  await dom.click({action:'settings-retry-connection'});
  await settle();
  assert.equal(probes.length,2);
  probes[1].resolve(READY);
  await settle();
  assert.match(serverSection(dom),/已连接/);
  probes[0].reject(Object.assign(Error('delayed old response'),{status:503}));
  await settle();
  assert.match(serverSection(dom),/已连接/,'晚到的旧响应不能覆盖较新的结果');
});
