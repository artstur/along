import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

// 设置页的验收（工单 TASK-88）：
//   - 能从应用内进入设置，看得到昵称、数据源、服务端配对三段与当前状态；
//   - 昵称可设可改，重启后显示最近一次保存的值，原 UID 保持有效；
//   - 数据源能授权、能连接，失败时显示实际状态并可重试；
//   - 未配对用户能在设置里完成配对，已配对用户升级后能继续连接。
//
// 复核补的回归（2026-11，独立复核提出的四项缺陷）：
//   - 健康读数全空时不能说「已连接」；读取失败要在当前页面立刻看得见；
//   - 昵称按「已核验的 Host + UID」隔离，换 Host、换 UID 都不串；
//   - 配对成功但服务检查没通过时，要说「已配对、服务暂不可用」，不能报「已连接」；
//   - OKX 状态重开设置页要回读，撤回排队要说清本机已停采集但仍待 Host 接收。
const PROFILE_KEY='along.user-profile.v1';
const AGENT_KEY='along.agent.v1';
const EVENT_KEY='along.event-connection.v1';
const HOST='https://along.example.com';
const ORIGIN='https://along.example.com:443';
const UID='u_12345678';

const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
// 只看数据源那一段：「已连接」在 Along 服务那一段也会出现，不能整页匹配。
const sources=dom=>dom.app.innerHTML.split('aria-label="数据源"')[1]?.split('aria-label="Along 服务"')[0]??'';
let serial=0;

async function app({storage={},paired=false,health=null,healthRefresh=null,request=null,source=null}={}) {
  const base={};
  if (paired) {
    base[AGENT_KEY]=JSON.stringify({baseURL:HOST,token:'b'.repeat(64),trustPolicy:'system-pki-v1',bindingScopeId:'scope-1'});
    base[EVENT_KEY]=JSON.stringify({bindingScopeId:'scope-1',userId:UID,bindingOrigin:ORIGIN});
  }
  if (health) base['along.health.v1']=JSON.stringify(health);
  const dom=installDomStub({storage:{...base,...storage}});
  const calls=[];
  globalThis.window.AlongHealthBridge={
    connect:async()=>{calls.push('health-connect');return {steps:1,selectedTypes:['steps'],contextReviewAllowed:true};},
    healthEvents:async()=>{calls.push('health-events');return {enabled:true};},
    clear:async()=>{},
    ...(healthRefresh?{refresh:healthRefresh}:{})};
  globalThis.window.AlongAgentBridge={
    connection:async action=>action==='load'?(paired?{baseURL:HOST,token:'b'.repeat(64),trustPolicy:'system-pki-v1',bindingScopeId:'scope-1'}:null):null,
    request:async input=>{calls.push(input.path);
      if (input.path==='/pair') return {token:'c'.repeat(64)};
      if (input.path==='/connection/verify') return {paired:true};
      if (input.path==='/connection/status') return {along:true,ready:true,eventProtocol:1,userId:UID};
      return {};},
    notification:async()=>({scheduled:true}),
    ...(source?{source}:{})};
  if (request) globalThis.window.AlongAgentBridge.request=request;
  await import('../web/app.mjs?settings='+ ++serial);
  await settle();
  return {...dom,calls,read:key=>JSON.parse(dom.storage.get(key))};
}

test('the settings page is reachable from the app and shows the three functions with their current status',async()=>{
  const dom=await app({paired:true});
  assert.match(dom.app.innerHTML,/topbar-profile/,'顶部栏要有个人入口');
  await dom.click({action:'open-settings'});
  assert.match(dom.app.innerHTML,/设置/);
  assert.match(dom.app.innerHTML,/昵称/,'设置页要有昵称');
  assert.match(dom.app.innerHTML,/数据源/,'设置页要有数据源');
  assert.match(dom.app.innerHTML,/Along 服务/,'设置页要有服务端配对');
  assert.match(dom.app.innerHTML,/u_12345678/,'设置页要显示当前身份');
});

test('a nickname can be set and is shown again after a restart, and the UID is untouched',async()=>{
  const dom=await app({paired:true});
  await dom.click({action:'open-settings'});
  await dom.submitForm('nickname-form',{nickname:'小明'});
  const saved=JSON.parse(dom.storage.get(PROFILE_KEY));
  assert.equal(saved.nicknames[`${ORIGIN}|${UID}`],'小明','昵称记在这一对身份下');
  assert.equal(saved.nickname,undefined,'昵称不再自己存一份身份，归属看作用域键');
  // 重启：换一份新的 app 模块实例，读同一份本机存储。
  const restarted=await app({storage:Object.fromEntries(dom.store)});
  await restarted.click({action:'open-settings'});
  assert.match(restarted.app.innerHTML,/小明/,'重启后要显示最近一次保存的昵称');
  // 原 UID 保持有效：设置昵称不动身份与配对关系。
  assert.equal(JSON.parse(restarted.storage.get(AGENT_KEY)).token,'b'.repeat(64),'改昵称不动配对凭据');
  assert.equal(JSON.parse(restarted.storage.get(EVENT_KEY)).userId,UID,'改昵称不动 UID');
});

test('an existing user can change the nickname they already set',async()=>{
  const dom=await app({paired:true,storage:{[PROFILE_KEY]:JSON.stringify({version:1,nickname:'旧名字',userId:UID})}});
  await dom.click({action:'open-settings'});
  assert.match(dom.app.innerHTML,/旧名字/);
  await dom.submitForm('nickname-form',{nickname:'新名字'});
  assert.equal(JSON.parse(dom.storage.get(PROFILE_KEY)).nicknames[`${ORIGIN}|${UID}`],'新名字');
});

test('a nickname set before pairing is kept and belongs to the identity once pairing succeeds',async()=>{
  const dom=await app({storage:{[PROFILE_KEY]:JSON.stringify({version:1,nickname:'小明',userId:null})}});
  await dom.click({action:'open-settings'});
  await dom.submitForm('nickname-form',{nickname:'小明'});
  assert.equal(JSON.parse(dom.storage.get(PROFILE_KEY)).nicknames['|'],'小明','还没配对时昵称先记在本机');
  const paired=await app({storage:Object.fromEntries(dom.store),paired:true});
  await paired.click({action:'open-settings'});
  assert.match(paired.app.innerHTML,/小明/,'配对后昵称跟着走');
  assert.equal(JSON.parse(paired.storage.get(PROFILE_KEY)).nicknames[`${ORIGIN}|${UID}`],'小明','配对后昵称归到该身份下');
});

test('two Hosts returning the same UID do not see or overwrite each other nickname',async()=>{
  const dom=await app({paired:true});
  await dom.click({action:'open-settings'});
  await dom.submitForm('nickname-form',{nickname:'OnlyHostA'});
  // 换一台 Host：回传的还是同一个 UID，但那是另一台机器的昵称。
  await dom.submitForm('pair-form',{baseURL:'https://other.example.com',code:'123456'});
  assert.doesNotMatch(dom.app.innerHTML,/OnlyHostA/,'Host B 不能看到 Host A 的昵称');
  await dom.submitForm('nickname-form',{nickname:'OnlyHostB'});
  await dom.submitForm('pair-form',{baseURL:HOST,code:'123456'});
  assert.match(dom.app.innerHTML,/OnlyHostA/,'回到 Host A 要恢复 A 上次保存的昵称');
  assert.doesNotMatch(dom.app.innerHTML,/OnlyHostB/,'Host B 的昵称不能跟过来');
});

test('another UID on the same Host neither sees nor overwrites the nickname',async()=>{
  let current=UID;
  const dom=await app({paired:true,request:async input=>{
    if (input.path==='/pair') return {token:'c'.repeat(64)};
    if (input.path==='/connection/status') return {along:true,ready:true,eventProtocol:1,userId:current};
    return {};}});
  await dom.click({action:'open-settings'});
  await dom.submitForm('nickname-form',{nickname:'FirstProfile'});
  current='u_87654321';
  await dom.submitForm('pair-form',{baseURL:HOST,code:'123456'});
  assert.doesNotMatch(dom.app.innerHTML,/FirstProfile/,'换个 UID 看不到别人的昵称');
  await dom.submitForm('nickname-form',{nickname:'SecondProfile'});
  current=UID;
  await dom.submitForm('pair-form',{baseURL:HOST,code:'123456'});
  assert.match(dom.app.innerHTML,/FirstProfile/,'回到原 UID 要拿回自己的昵称');
  assert.doesNotMatch(dom.app.innerHTML,/SecondProfile/,'另一个 UID 的昵称不覆盖原来的');
});

test('the data source section shows the real connection state and can retry a failed connection',async()=>{
  const dom=await app({paired:true});
  await dom.click({action:'open-settings'});
  assert.match(dom.app.innerHTML,/Apple Health/,'数据源要列出 Apple Health');
  assert.match(dom.app.innerHTML,/未连接/,'没导入真实数据时要显示未连接');
  await dom.click({action:'event-health-connect'});
  assert.ok(dom.calls.includes('health-connect'),'健康连接走既有的原生授权流程');
});

test('a native readback without any value is not reported as connected',async()=>{
  const dom=await app({paired:true,healthRefresh:async()=>({steps:null,selectedTypes:['steps'],contextReviewAllowed:true})});
  await settle();
  await dom.click({action:'open-settings'});
  assert.match(sources(dom),/无可读取记录/,'读不到数值时要说读不到');
  assert.doesNotMatch(sources(dom),/已连接/,'不能把空读数说成已连接');
  assert.match(sources(dom),/重试/,'读不到时要能重试');
});

test('an asynchronous read failure shows up on the page that is open',async()=>{
  let fail;
  const dom=await app({paired:true,healthRefresh:()=>new Promise((_,reject)=>{fail=reject;})});
  await settle();
  await dom.click({action:'open-settings'});
  assert.match(dom.app.innerHTML,/检查中/);
  fail(Error('isolated read error'));
  await settle();
  assert.match(dom.app.innerHTML,/读取失败/,'读取失败要在当前页面立刻看得见，不能只靠重开页面');
});

test('an unpaired user can complete pairing from the settings page',async()=>{
  const dom=await app();
  await dom.click({action:'open-settings'});
  assert.match(dom.app.innerHTML,/未配对/,'没配对时要显示未配对');
  assert.match(dom.app.innerHTML,/pair-form/,'设置页要给出配对表单');
  await dom.submitForm('pair-form',{baseURL:HOST,code:'123456'});
  assert.ok(dom.calls.includes('/pair'),'设置页的配对走既有的 /pair 流程');
  assert.equal(JSON.parse(dom.storage.get(AGENT_KEY)).token,'c'.repeat(64),'配对凭据按既有方式落盘');
});

test('a paired user keeps connecting after an upgrade and can retry a broken connection',async()=>{
  const dom=await app({paired:true});
  await dom.click({action:'open-settings'});
  assert.match(dom.app.innerHTML,/已连接/,'已配对且检查通过时显示已连接');
  await dom.click({action:'settings-retry-connection'});
  assert.ok(dom.calls.includes('/connection/status'),'重试走既有的连接检查');
  assert.equal(JSON.parse(dom.storage.get(AGENT_KEY)).token,'b'.repeat(64),'重试不换掉已有凭据');
});

test('pairing that succeeds while the service is unavailable is not reported as connected',async()=>{
  const dom=await app({request:async input=>{
    if (input.path==='/pair') return {token:'c'.repeat(64)};
    throw Object.assign(Error('DSH Along Source 未就绪（503）'),{status:503});}});
  await dom.click({action:'open-settings'});
  await dom.submitForm('pair-form',{baseURL:HOST,code:'123456'});
  assert.match(dom.app.innerHTML,/已配对/,'配对成功要说已配对');
  assert.match(dom.app.innerHTML,/服务暂不可用/,'服务检查没通过要说服务暂不可用');
  assert.doesNotMatch(dom.app.innerHTML,/连接需处理/,'不能说连接需处理：那会让用户以为配对没成');
  assert.doesNotMatch(document.querySelector('#toast').textContent,/已连接 Along/,'提示不能报「已连接 Along」');
  const token=JSON.parse(dom.storage.get(AGENT_KEY)).token;
  await dom.click({action:'settings-retry-connection'});
  await settle();
  assert.equal(JSON.parse(dom.storage.get(AGENT_KEY)).token,token,'重试复用已有凭据，不重新配对');
});

test('the settings page returns to where it was opened from',async()=>{
  const dom=await app({paired:true});
  await dom.click({action:'open-settings'});
  await dom.click({action:'settings-back'});
  assert.doesNotMatch(dom.app.innerHTML,/data-action="open-settings"[\s\S]*数据源/,'返回后不再显示设置页');
});

test('a nickname being typed survives a background redraw and is not saved until the user does',async()=>{
  const dom=await app({paired:true});
  await dom.click({action:'open-settings'});
  // 后台同步会重画整页：正在输入的昵称不能被抹掉。
  await dom.app.dispatch('input',{target:{matches:selector=>selector.includes('nickname'),value:'小明'}});
  assert.equal(dom.storage.get(PROFILE_KEY),null,'没点保存之前不落盘');
  await dom.submitForm('nickname-form',{nickname:'小明'});
  assert.equal(JSON.parse(dom.storage.get(PROFILE_KEY)).nicknames[`${ORIGIN}|${UID}`],'小明');
});

test('the OKX row is re-read when the settings page is reopened and speaks the revoke state',async()=>{
  const goal={id:'g_okx',domain:'custom',status:'active',revision:1,title:'OKX 目标',metric:null,context:[],tasks:[],
    dataSources:[{provider:'okx',status:'recommended',reason:'只读接入账户摘要'}]};
  const saved={version:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{},drafts:{}};
  const config={baseURL:HOST,token:'b'.repeat(64),trustPolicy:'system-pki-v1',bindingScopeId:'scope-1'};
  let status={provider:'okx',state:'connected',syncState:'pending'};
  const calls=[];
  const dom=installDomStub({storage:{
    [AGENT_KEY]:JSON.stringify(config),
    [EVENT_KEY]:JSON.stringify({bindingScopeId:'scope-1',userId:'u_app_b',bindingOrigin:ORIGIN}),
    'along.event-workspace.v1:u_app_b':JSON.stringify(saved)}});
  globalThis.window.AlongHealthBridge={connect:async()=>({}),healthEvents:async()=>({enabled:true}),clear:async()=>{}};
  globalThis.window.AlongAgentBridge={
    connection:async()=>config,
    request:async input=>{
      if (input.path==='/connection/status') return {along:true,ready:true,eventProtocol:1,userId:'u_app_b'};
      if (input.path==='/sync') return {items:[]};
      return {};},
    notification:async()=>({scheduled:true}),
    source:async(action,id)=>{calls.push([action,id]);return status;}};
  await import('../web/app.mjs?settings-okx='+ ++serial);
  await settle();
  await dom.click({action:'open-settings'});
  await settle();
  assert.match(dom.app.innerHTML,/OKX/,'有 OKX 数据源的目标要在设置页列出 OKX');
  assert.match(dom.app.innerHTML,/等待同步到 Mac/,'还没收到回执时要说明在等 Host 接收');
  // Host 确认收到后，重开设置页要回读，不能还停在旧状态。
  status={provider:'okx',state:'connected',syncState:'received'};
  await dom.click({action:'settings-back'});
  await dom.click({action:'open-settings'});
  await settle();
  assert.match(dom.app.innerHTML,/Mac 已收到摘要/,'重开设置页要回读原生状态');
  // 撤回排队：本机已停采集，但还等 Host 接收——不能只说「尚未连接」。
  status={provider:'okx',state:'disconnected',syncState:'pending'};
  await dom.click({action:'settings-back'});
  await dom.click({action:'open-settings'});
  await settle();
  assert.match(dom.app.innerHTML,/已停止采集/,'撤回排队要说本机已停采集');
  assert.match(dom.app.innerHTML,/撤回仍待 Host 接收/,'撤回排队要说明仍待 Host 接收');
  assert.ok(calls.some(([action,id])=>action==='status'&&id==='g_okx'),'状态要从原生读');
});
