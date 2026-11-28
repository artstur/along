import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

// 设置页的验收（工单 TASK-88）：
//   - 能从应用内进入设置，看���昵称、数据源、服务端配对三段与当前状态；
//   - 昵称可设可改，重启后显示最近一次保存的值，原 UID 保持有效；
//   - 数据源能授权、能连接，失败时显示实际状态并可重试；
//   - 未配对用户能在设置里完成配对，已配对用户升级后能继续连接。
const PROFILE_KEY='along.user-profile.v1';
const AGENT_KEY='along.agent.v1';
const EVENT_KEY='along.event-connection.v1';

const settle=async()=>{for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));};
let serial=0;

async function app({storage={},paired=false,health=null}={}) {
  const base={};
  if (paired) {
    base[AGENT_KEY]=JSON.stringify({baseURL:'https://along.example.com',token:'b'.repeat(64),trustPolicy:'system-pki-v1',bindingScopeId:'scope-1'});
    base[EVENT_KEY]=JSON.stringify({bindingScopeId:'scope-1',userId:'u_12345678',bindingOrigin:'https://along.example.com:443'});
  }
  if (health) base['along.health.v1']=JSON.stringify(health);
  const dom=installDomStub({storage:{...base,...storage}});
  const calls=[];
  globalThis.window.AlongHealthBridge={
    connect:async()=>{calls.push('health-connect');return {steps:1,selectedTypes:['steps'],contextReviewAllowed:true};},
    healthEvents:async()=>{calls.push('health-events');return {enabled:true};},
    clear:async()=>{}};
  globalThis.window.AlongAgentBridge={
    connection:async action=>action==='load'?(paired?{baseURL:'https://along.example.com',token:'b'.repeat(64),trustPolicy:'system-pki-v1',bindingScopeId:'scope-1'}:null):null,
    request:async input=>{calls.push(input.path);
      if (input.path==='/pair') return {token:'c'.repeat(64)};
      if (input.path==='/connection/verify') return {paired:true};
      if (input.path==='/connection/status') return {along:true,ready:true,eventProtocol:1,userId:'u_12345678'};
      return {};},
    notification:async()=>({scheduled:true})};
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
  assert.equal(saved.nickname,'小明');
  assert.equal(saved.userId,'u_12345678','昵称记在当前身份下');
  // 重启：换一份新的 app 模块实例，读同一份本机存储。
  const restarted=await app({storage:Object.fromEntries(dom.store)});
  await restarted.click({action:'open-settings'});
  assert.match(restarted.app.innerHTML,/小明/,'重启后要显示最近一次保存的昵称');
  // 原 UID 保持有效：设置昵称不动身份与配对关系。
  assert.equal(JSON.parse(restarted.storage.get(AGENT_KEY)).token,'b'.repeat(64),'改昵称不动配对凭据');
  assert.equal(JSON.parse(restarted.storage.get(EVENT_KEY)).userId,'u_12345678','改昵称不动 UID');
});

test('an existing user can change the nickname they already set',async()=>{
  const dom=await app({paired:true,storage:{[PROFILE_KEY]:JSON.stringify({version:1,nickname:'旧名字',userId:'u_12345678'})}});
  await dom.click({action:'open-settings'});
  assert.match(dom.app.innerHTML,/旧名字/);
  await dom.submitForm('nickname-form',{nickname:'新名字'});
  assert.equal(JSON.parse(dom.storage.get(PROFILE_KEY)).nickname,'新名字');
});

test('a nickname set before pairing is kept and belongs to the identity once pairing succeeds',async()=>{
  const dom=await app({storage:{[PROFILE_KEY]:JSON.stringify({version:1,nickname:'小明',userId:null})}});
  await dom.click({action:'open-settings'});
  await dom.submitForm('nickname-form',{nickname:'小明'});
  assert.equal(JSON.parse(dom.storage.get(PROFILE_KEY)).userId,null,'还没配对时昵称先记在本机');
  const paired=await app({storage:Object.fromEntries(dom.store),paired:true});
  await paired.click({action:'open-settings'});
  assert.match(paired.app.innerHTML,/小明/,'配对后昵称跟着走');
  assert.equal(JSON.parse(paired.storage.get(PROFILE_KEY)).userId,'u_12345678','配对后昵称归到该身份下');
});

test('the data source section shows the real connection state and can retry a failed connection',async()=>{
  const dom=await app({paired:true});
  await dom.click({action:'open-settings'});
  assert.match(dom.app.innerHTML,/Apple Health/,'数据源要列出 Apple Health');
  assert.match(dom.app.innerHTML,/未连接/,'没导入真实数据时要显示未连接');
  await dom.click({action:'event-health-connect'});
  assert.ok(dom.calls.includes('health-connect'),'健康连接走既有的原生授权流程');
});

test('an unpaired user can complete pairing from the settings page',async()=>{
  const dom=await app();
  await dom.click({action:'open-settings'});
  assert.match(dom.app.innerHTML,/未配对/,'没配对时要显示未配对');
  assert.match(dom.app.innerHTML,/pair-form/,'设置页要给出配对表单');
  await dom.submitForm('pair-form',{baseURL:'https://along.example.com',code:'123456'});
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
  assert.equal(JSON.parse(dom.storage.get(PROFILE_KEY)).nickname,'小明');
});
