import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {request} from 'node:https';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {installDomStub} from './review-ffa95c5/test/dom-stub.mjs';

let serial = 0;
const wait = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
const key = 'along.agent.v1';
const nicknameKey = 'along.user-profile.v1';
const fingerprint = 'f'.repeat(64);
const userId = 'u_12345678';
const a = 'https://a.example.invalid';
const b = 'https://b.example.invalid';
const config = {baseURL:a, token:'a'.repeat(64), fingerprint};
const readyResponse = {along:true, ready:true, eventProtocol:1, userId};
const toast = () => document.querySelector('#toast').textContent;
const serverSection = dom => dom.app.innerHTML.split('aria-label="Along 服务"')[1] ?? '';
const healthSection = dom => dom.app.innerHTML.split('aria-label="数据源"')[1]?.split('aria-label="Along 服务"')[0] ?? '';

async function app({connection, bridge, health, source, stored} = {}) {
  const dom = installDomStub({storage: {...(connection ? {[key]:JSON.stringify(connection)} : {}), ...stored}});
  globalThis.location = {hostname:'app', protocol:'along:'};
  document.documentElement.classList = {add(){},remove(){}};
  window.dispatchEvent = e => { void dom.fireWindow(e.type,e); return true; };
  window.AlongHealthBridge = health;
  window.AlongAgentBridge = {connection:async action=>action==='load'?connection:null, request:bridge, source};
  await import(`./review-ffa95c5/web/app.mjs?independent=${++serial}`);
  await wait();
  await dom.click({action:'open-settings'});
  return dom;
}

async function healthAndIdentity() {
  const dom = await app({health:{refresh:async()=>({steps:null,selectedTypes:['steps'],contextReviewAllowed:true})}});
  assert.match(healthSection(dom), /已连接/);
  assert.doesNotMatch(healthSection(dom), /无可读取记录/);
  console.log('Health: selected type + all-null native result -> 已连接; proven with native payload shape');

  let finishRefresh;
  const delayed = await app({health:{refresh:()=>new Promise((_,reject)=>{finishRefresh=reject;})}});
  assert.match(healthSection(delayed), /检查中/);
  finishRefresh(Error('isolated read error'));
  await wait();
  assert.match(healthSection(delayed), /检查中/);
  await delayed.click({action:'settings-back'});
  await delayed.click({action:'open-settings'});
  assert.match(healthSection(delayed), /读取失败/);
  console.log('Health: asynchronous read failure while Settings is open leaves 检查中 until leaving/reopening');

  const bridge = async input => input.path==='/pair' ? {token:'b'.repeat(64)} :
    input.path==='/connection/status' ? readyResponse : {items:[]};
  const identity = await app({connection:config,bridge});
  await identity.submitForm('nickname-form',{nickname:'OnlyHostA'});
  await identity.submitForm('pair-form',{baseURL:b,code:'ignored-by-stub'});
  assert.match(identity.app.innerHTML, /OnlyHostA/);
  assert.equal(JSON.parse(identity.storage.get(key)).baseURL,b);
  await identity.submitForm('nickname-form',{nickname:'OnlyHostB'});
  await identity.submitForm('pair-form',{baseURL:a,code:'ignored-by-stub'});
  assert.match(identity.app.innerHTML,/OnlyHostB/);
  console.log('Profile: Host A and Host B returning the same UID see and overwrite each other’s nickname');

  let current = userId;
  const separate = await app({connection:config,bridge:async input=>input.path==='/pair'?{token:'c'.repeat(64)}:
    input.path==='/connection/status'?{...readyResponse,userId:current}:{items:[]}});
  await separate.submitForm('nickname-form',{nickname:'FirstProfile'});
  current='u_87654321';
  await separate.submitForm('pair-form',{baseURL:a,code:'stub'});
  assert.doesNotMatch(separate.app.innerHTML,/FirstProfile/);
  await separate.submitForm('nickname-form',{nickname:'SecondProfile'});
  current=userId;
  await separate.submitForm('pair-form',{baseURL:a,code:'stub'});
  assert.doesNotMatch(separate.app.innerHTML,/FirstProfile|SecondProfile/);
  assert.equal(JSON.parse(separate.storage.get(nicknameKey)).nickname,'SecondProfile');
  console.log('Profile: A saves, B saves, A returns -> A’s prior nickname is lost');
}

async function okx() {
  const buildGoal=(id,dataSources)=>({goal:{id,domain:'custom',status:'active',currentRevision:1},
    revision:{goalId:id,revision:1,title:id,status:'active'}, tasks:[], dataSources});
  const goals=[buildGoal('g_okx',[{provider:'okx',status:'recommended',reason:'Review fixture'}]),buildGoal('g_other',[])];
  const items=goals.map((snapshot,i)=>({seq:i+1,userId,kind:'goal_updated',goalId:snapshot.goal.id,payload:{snapshot}}));
  const bridge=async input=>input.path==='/connection/status'?readyResponse:
    input.path==='/sync'?{items:items.filter(item=>item.seq>input.body.after_seq)}:{acked:2};
  const calls=[];
  let status={provider:'okx',state:'connected',syncState:'pending'};
  const dom=await app({connection:config,bridge,source:async(action,id)=>{
    calls.push([action,id]);
    return status;
  }});
  await wait();
  await dom.click({action:'settings-back'});
  await dom.app.dispatch('change',{target:{id:'event-goal-select',value:'g_other'}});
  await dom.click({action:'open-settings'});
  assert.doesNotMatch(healthSection(dom),/OKX/);
  await dom.click({action:'settings-back'});
  await dom.app.dispatch('change',{target:{id:'event-goal-select',value:'g_okx'}});
  await dom.click({action:'open-settings'});
  await wait();
  assert.match(healthSection(dom),/OKX/);
  assert.match(healthSection(dom),/等待同步到 Mac/);
  assert.ok(calls.some(([action,id])=>action==='status'&&id==='g_okx'));
  status={provider:'okx',state:'connected',syncState:'received'};
  await dom.click({action:'settings-back'});
  await dom.click({action:'open-settings'});
  await wait();
  assert.match(healthSection(dom),/等待同步到 Mac/);
  assert.doesNotMatch(healthSection(dom),/Mac 已收到摘要/);
  await dom.click({action:'event-okx-connect'});
  await wait();
  assert.match(healthSection(dom),/Mac 已收到摘要/);
  assert.deepEqual(calls,[['status','g_okx'],['connect','g_okx']]);
  console.log('OKX: card is hidden with another goal selected; correct goal native management is wired; cached pending status survives reopen even after native status changes to received');
  status={provider:'okx',state:'disconnected',syncState:'pending'};
  await dom.click({action:'event-okx-connect'});
  await wait();
  assert.match(healthSection(dom),/尚未连接/);
  assert.doesNotMatch(healthSection(dom),/等待|撤回/);
  console.log('OKX: native disconnected + pending (revocation queued) renders only 尚未连接');
}

function tls(port, path, payload, token) {
  return new Promise((resolve,reject)=>{
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req=request({host:'127.0.0.1',port,path,method:body?'POST':'GET',rejectUnauthorized:false,agent:false,
      headers:{...(body?{'content-type':'application/json','content-length':Buffer.byteLength(body)}:{}),...(token?{authorization:`Bearer ${token}`}:{})}},res=>{
      let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(raw)}));
    });
    req.on('error',reject); req.setTimeout(3000,()=>req.destroy(Error('isolated host timeout')));req.end(body);
  });
}

async function actualHost() {
  let ready=false;
  const upstream=createServer((req,res)=>{
    const probing=req.url==='/along-source/api/goals/along-status-probe';
    res.writeHead(probing&&!ready?503:200,{'content-type':'application/json'});
    res.end(JSON.stringify(probing?{service:'along-source',ready}:{items:[]}));
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const state=mkdtempSync(join(tmpdir(),'ats88-isolated-host-'));
  const bridgeFile=join(state,'bridge-token');
  writeFileSync(bridgeFile,createHash('sha256').update('isolated-review-fixture').digest('hex'),{mode:0o600});
  let host;
  async function startHost() {
    host=spawn(process.execPath,['host/agent-host.mjs'],{cwd:new URL('./review-ffa95c5/',import.meta.url),
      env:{...process.env,ALONG_AGENT_HOST:'127.0.0.1',ALONG_AGENT_PORT:String(port),ALONG_AGENT_STATE_DIR:state,
        ALONG_SUPERAGENT_URL:`http://127.0.0.1:${upstream.address().port}`,ALONG_BRIDGE_TOKEN_FILE:bridgeFile,ALONG_EVENT_INGEST:'on'},
      stdio:['ignore','pipe','pipe']});
    let output='';host.stdout.on('data',value=>output+=value);
    const end=Date.now()+10000;
    while(!/一次性配对码: (\d+)/.test(output)&&Date.now()<end) await sleep(50);
    const code=/一次性配对码: (\d+)/.exec(output)?.[1];assert.ok(code,'isolated Host startup');
    return code;
  }
  async function stopHost() {
    if(host&&host.exitCode===null&&host.signalCode===null){const done=once(host,'exit');host.kill('SIGTERM');await done;}
  }
  try {
    const code=await startHost();
    const baseURL=`https://127.0.0.1:${port}`;
    assert.equal((await tls(port,'/health')).status,200);
    const trace=[];
    const bridge=async input=>{
      const {status,value}=await tls(port,input.path,input.body,input.token);
      trace.push([input.path,status]);
      if(status>=400) throw Error(value.error);
      return value;
    };
    const dom=await app({bridge});
    await dom.submitForm('pair-form',{baseURL,code:code==='00000000'?'99999999':'00000000'});
    assert.deepEqual(trace.at(-1),['/pair',403]);
    assert.match(serverSection(dom),/未配对/);
    assert.match(toast(),/配对码/);
    console.log('Host: bad code -> HTTP 403; form remains 未配对 and toast reports invalid code');

    await dom.submitForm('pair-form',{baseURL,code});
    assert.ok(trace.some(([path,status])=>path==='/pair'&&status===200));
    assert.ok(trace.some(([path,status])=>path==='/connection/status'&&status===503));
    assert.match(serverSection(dom),/连接需处理/);
    assert.match(toast(),/已连接 Along/);
    const before=JSON.parse(dom.storage.get(key));
    const authority=JSON.parse(readFileSync(join(state,'pairings.json'),'utf8'))[0];
    assert.equal(authority.hash,createHash('sha256').update(before.token).digest('hex'));
    assert.equal((await tls(port,'/connection/verify',{},before.token)).status,200);
    console.log('Host: /pair 200 + /verify 200 + /status 503 -> card 连接需处理, contradictory success toast 已连接 Along');

    ready=true;
    await dom.click({action:'settings-retry-connection'});
    for(let i=0;i<60&&!serverSection(dom).includes('已连接');i++) await sleep(25);
    assert.match(serverSection(dom),/已连接/);
    assert.equal(JSON.parse(dom.storage.get(key)).token,before.token);
    assert.match(dom.app.innerHTML,new RegExp(authority.user_id));
    ready=false;
    await dom.click({action:'settings-retry-connection'});
    for(let i=0;i<60&&!serverSection(dom).includes('连接需处理');i++) await sleep(25);
    assert.match(serverSection(dom),/连接需处理/);
    assert.equal(JSON.parse(dom.storage.get(key)).token,before.token);
    console.log('Host: Agent readiness 503 -> 200 -> 503 via retry, original binding and UID retained');

    ready=true;
    await dom.click({action:'settings-retry-connection'});
    for(let i=0;i<60&&!serverSection(dom).includes('已连接');i++) await sleep(25);
    assert.match(serverSection(dom),/已连接/);
    await stopHost();
    await dom.click({action:'settings-retry-connection'});
    for(let i=0;i<60&&!serverSection(dom).includes('连接需处理');i++) await sleep(25);
    assert.match(serverSection(dom),/连接需处理/);
    await startHost();
    await dom.click({action:'settings-retry-connection'});
    for(let i=0;i<60&&!serverSection(dom).includes('已连接');i++) await sleep(25);
    assert.match(serverSection(dom),/已连接/);
    assert.equal(JSON.parse(dom.storage.get(key)).token,before.token);
    console.log('Host: process stopped -> connection error; same Host restarted -> manual retry recovers existing binding');
  } finally {
    await stopHost();
    upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
    rmSync(state,{recursive:true,force:true});
  }
}

await healthAndIdentity();
await okx();
await actualHost();
