import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const AGENT='along.agent.v1',EVENT='along.event-connection.v1',USER='u_offline_upgrade';
const CACHE=`along.event-workspace.v1:${USER}`,SHARE='along.health-sharing.v1';
const OLD={baseURL:'https://192.168.1.2:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};
const CURRENT={...OLD,bindingScopeId:'native-scope-upgrade'};
const grant={id:'dlg_offline',goalKey:'health',topics:['sleep','workout'],weeklyWorkoutMinutes:180};
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
let serial=0;
function seed() {
  const goal=id=>({id,domain:'custom',status:'active',revision:1,title:`原目标 ${id}`,metric:null,context:[],tasks:[{
    id:`t_${id}`,goalId:id,status:'open',revision:1,content:`原任务 ${id}`,scheduledAt:'2099-01-01T12:00:00Z',
    reminderPlan:{state:'scheduled',source:'user',repeat:'once',explanation:'用户原提醒'}}]});
  const a=goal('g_one'),b=goal('g_selected');
  const messages={
    direct_user:{eventId:'direct_user',goalId:b.id,role:'user',text:'本人原话',audience:'conversation',status:'received'},
    direct_reply:{eventId:'direct_reply',goalId:b.id,role:'assistant',text:'原直接答复',audience:'conversation',status:'received'},
    background:{eventId:'background',goalId:b.id,role:'assistant',text:'后台执行记录不可混入聊天',audience:'background',presentation:'execution',status:'received'},
  };
  return {
    [AGENT]:JSON.stringify(OLD),'along.agent-runtime.v1':'dsh-superagent',
    [EVENT]:JSON.stringify({userId:USER,fingerprint:OLD.fingerprint}),
    [SHARE]:JSON.stringify({dailyDelegation:grant,dailyRecipient:OLD.token}),
    [CACHE]:JSON.stringify({version:1,recommendationsVersion:1,conversationVersion:1,dataSourcesVersion:1,executionVersion:2,taskCapabilityVersion:1,
      userId:USER,cursor:7,activeGoalId:b.id,returnGoalId:b.id,conversationId:null,composing:false,goals:{[a.id]:a,[b.id]:b},messages,
      drafts:{'goal:g_selected':'原未发送草稿'},notificationResults:[],notificationReceipts:[]}),
  };
}
async function start(storage,{native=CURRENT,late=false,owner,online=false,request,save}={}) {
  const dom=installDomStub({storage}),calls=[],notifications=[],nativeCalls=[];
  document.getElementById=id=>dom.app.innerHTML.includes('id="'+id+'"')?{focus(){},scrollIntoView(){}}:null;
  delete window.AlongHealthBridge;document.visibilityState='visible';
  let resolveNative;
  const nativePromise=late?new Promise(resolve=>{resolveNative=resolve;}):Promise.resolve(native);
  window.AlongAgentBridge={
    connection:async(action)=>{nativeCalls.push(action);if(action==='load')return nativePromise;if(action==='workspace')return typeof owner==='function'?owner():owner??{};if(action==='save'&&save)return save();throw Error('unexpected native write '+action);},
    request:async input=>{calls.push(input);if(request)return request(input);if(!online)throw Error('isolated offline transport');
      if(input.path==='/connection/status')return {along:true,ready:true,eventProtocol:1,userId:USER,runtime:'dsh-superagent'};
      if(input.path==='/sync')return {items:[]};
      throw Error('unexpected network mutation '+input.path);},
    notification:async(action,value)=>{notifications.push({action,value});return {};},
  };
  await import('../web/app.mjs?offline-upgrade='+ ++serial);await settle();
  return {...dom,calls,notifications,nativeCalls,restore:async()=>{resolveNative(native);await settle();},read:key=>JSON.parse(dom.storage.get(key))};
}
async function observableWorkspace(dom) {
  assert.match(dom.app.innerHTML,/<h1>原目标 g_selected<\/h1>/,'offline cold launch must render the original selected goal');
  assert.match(dom.app.innerHTML,/原目标 g_one/,'the other original goal stays selectable');
  assert.match(dom.app.innerHTML,/原任务 g_selected/);
  assert.match(dom.app.innerHTML,/<option value="g_selected" selected/);
  await dom.click({action:'event-task-detail',taskId:'t_g_selected'});
  assert.match(dom.app.innerHTML,/<h1>原任务 g_selected<\/h1>/,'the original task detail opens');
  assert.match(dom.app.innerHTML,/用户原提醒/);
  await dom.click({action:'event-task-back'});
  await dom.click({action:'event-chat'});
  assert.match(dom.app.innerHTML,/本人原话/);assert.match(dom.app.innerHTML,/原直接答复/);
  assert.doesNotMatch(dom.app.innerHTML,/后台执行记录不可混入聊天/);
  assert.match(dom.app.innerHTML,/>原未发送草稿<\/textarea>/,'the selected goal draft survives');
  await dom.click({action:'agent-back'});
  await dom.fireWindow('along-notification-open',{detail:{userId:USER,goalId:'g_selected',taskId:'t_g_selected',eventId:'old_notice'}});
  assert.match(dom.app.innerHTML,/<h1>原任务 g_selected<\/h1>/,'an original notification still opens its bound task');
  assert.ok(dom.notifications.some(call=>call.action==='eventTaskOpened'&&call.value.taskId==='t_g_selected'));
  await dom.click({action:'event-task-back'});
}
function preserved(dom,original,{online=false}={}) {
  const before=JSON.parse(original[CACHE]),after=dom.read(CACHE);
  for(const field of ['cursor','activeGoalId','returnGoalId','messages','drafts'])assert.deepEqual(after[field],before[field]);
  assert.deepEqual(after.goals.g_selected.tasks,before.goals.g_selected.tasks);
  assert.deepEqual(dom.read(SHARE).dailyDelegation,grant);assert.equal(dom.read(SHARE).dailyRevokedAt,undefined);
  assert.ok(dom.calls.every(call=>['/connection/status','/sync'].includes(call.path)),'migration must never submit a user message or reconfigure the Host');
  assert.ok(dom.notifications.every(call=>['pendingLegacyNotification','eventTaskOpened',...(online?['eventTaskSync']:[])].includes(call.action)),'offline migration must never reissue or withdraw a notification');
}

test('same paired upgrade keeps original goals, task details, direct chat and drafts on the next offline cold launch',async()=>{
  const original=seed(),first=await start(original,{late:true});
  await observableWorkspace(first);
  await first.restore();
  await observableWorkspace(first);preserved(first,original);
  assert.equal(first.read(AGENT).bindingScopeId,CURRENT.bindingScopeId,'native callback really persisted the new scope');
  // Use exactly what the first real App instance wrote, without correcting the event cache.
  const second=await start(Object.fromEntries(first.store),{late:true});
  await observableWorkspace(second);
  await second.restore();await observableWorkspace(second);preserved(second,original);
  assert.equal(second.read(EVENT).bindingScopeId,CURRENT.bindingScopeId);
});


test('Build78 half-migration recovers only with the native original full-binding user proof and then survives offline without that proof',async()=>{
  const original=seed();
  original[AGENT]=JSON.stringify(CURRENT);
  original[EVENT]=JSON.stringify({userId:USER,bindingScopeId:OLD.token});
  const first=await start(original,{late:true,owner:{baseURL:OLD.baseURL,bindingScopeId:CURRENT.bindingScopeId,userId:USER}});
  assert.doesNotMatch(first.app.innerHTML,/<h1>原目标 g_selected<\/h1>/,'ambiguous origin-less token record waits for native proof');
  await first.restore();await observableWorkspace(first);preserved(first,original);
  assert.equal(first.read(EVENT).bindingOrigin,'https://192.168.1.2:4176');
  assert.equal(first.nativeCalls.filter(x=>x==='workspace').length,1);
  const again=await start(Object.fromEntries(first.store),{native:null});
  await observableWorkspace(again);preserved(again,original);
  assert.ok(!again.nativeCalls.includes('workspace'),'a repaired binding no longer depends on health metadata');
});

for(const [label,owner] of Object.entries({
  absent:undefined,other_user:{baseURL:OLD.baseURL,bindingScopeId:CURRENT.bindingScopeId,userId:'other_user'},
  other_origin:{baseURL:'https://192.168.1.9:4176',bindingScopeId:CURRENT.bindingScopeId,userId:USER},
  other_scope:{baseURL:OLD.baseURL,bindingScopeId:'scope-unknown',userId:USER},
}))test(`ambiguous Build78 cache stays isolated with ${label} native ownership evidence`,async()=>{
  const original=seed();original[AGENT]=JSON.stringify(CURRENT);original[EVENT]=JSON.stringify({userId:USER,bindingScopeId:OLD.token});
  const dom=await start(original,{owner});
  assert.doesNotMatch(dom.app.innerHTML,/<h1>原目标 g_selected<\/h1>/);
  assert.equal(dom.storage.get(EVENT),original[EVENT]);assert.equal(dom.storage.get(CACHE),original[CACHE]);
});

test('an unknown scope is never claimed even with matching native ownership metadata',async()=>{
  const original=seed();original[AGENT]=JSON.stringify(CURRENT);original[EVENT]=JSON.stringify({userId:USER,bindingScopeId:'unknown-scope'});
  const dom=await start(original,{owner:{baseURL:OLD.baseURL,bindingScopeId:CURRENT.bindingScopeId,userId:USER}});
  assert.doesNotMatch(dom.app.innerHTML,/<h1>原目标 g_selected<\/h1>/);
  assert.equal(dom.storage.get(EVENT),original[EVENT]);assert.ok(!dom.nativeCalls.includes('workspace'));
});

test('a native-unavailable legacy upgrade keeps its fingerprint-proven workspace and persists origin evidence',async()=>{
  const original=seed(),dom=await start(original,{native:null});
  await observableWorkspace(dom);preserved(dom,original);
  assert.equal(dom.read(EVENT).bindingScopeId,OLD.token);assert.equal(dom.read(EVENT).bindingOrigin,'https://192.168.1.2:4176');
});

test('revoked daily authorization remains revoked while recovering the same offline workspace',async()=>{
  const original=seed(),revocation={dailyRevokedIds:[grant.id],dailyRevokedAt:12345};
  original[SHARE]=JSON.stringify(revocation);
  const dom=await start(original);await observableWorkspace(dom);
  assert.deepEqual(dom.read(SHARE),revocation);
});


for(const [label,next] of Object.entries({
  different_origin:{...CURRENT,baseURL:'https://192.168.1.9:4176',bindingScopeId:'other-origin-scope'},
  different_token:{...CURRENT,token:'c'.repeat(64),bindingScopeId:'other-token-scope'},
}))test(`real native ${label} transition detaches the old event workspace and stays detached on another cold launch`,async()=>{
  const original=seed(),dom=await start(original,{native:next,late:true});
  await observableWorkspace(dom);const before=dom.storage.get(CACHE);await dom.restore();
  assert.doesNotMatch(dom.app.innerHTML,/<h1>原目标 g_selected<\/h1>/);
  assert.equal(dom.read(EVENT),null);assert.equal(dom.storage.get(CACHE),before);
  assert.deepEqual(dom.read(AGENT),next);assert.ok(!dom.nativeCalls.includes('workspace'),'changed identities cannot ask to migrate the old workspace');
  const again=await start(Object.fromEntries(dom.store),{native:next,owner:{baseURL:next.baseURL,bindingScopeId:next.bindingScopeId,userId:USER}});
  assert.doesNotMatch(again.app.innerHTML,/<h1>原目标 g_selected<\/h1>/);assert.equal(again.read(EVENT),null);
});

test('explicit re-pairing to another user isolates old goals even if the same origin and token are returned',async()=>{
  let paired=false;
  const original=seed(),dom=await start(original,{native:CURRENT,save:()=>CURRENT,request:async input=>{
    if(input.path==='/pair'){paired=true;return {token:OLD.token};}
    if(!paired)throw Error('isolated offline transport');
    if(input.path==='/connection/status')return {along:true,ready:true,eventProtocol:1,userId:'u_new',runtime:'dsh-superagent'};
    if(input.path==='/sync')return {items:[]};
    throw Error('unexpected route '+input.path);
  }});
  await observableWorkspace(dom);
  assert.match(dom.app.innerHTML,/id="pair-form"/);
  const before=dom.storage.get(CACHE);
  await dom.app.dispatch('submit',{target:{id:'pair-form',fields:{baseURL:OLD.baseURL,fingerprint:OLD.fingerprint,code:'12345678'},querySelector:()=>null},preventDefault(){}});
  await settle();
  assert.equal(dom.read(EVENT).userId,'u_new');assert.doesNotMatch(dom.app.innerHTML,/原目标 g_selected|本人原话|原未发送草稿/);
  assert.equal(dom.storage.get(CACHE),before);
  const again=await start(Object.fromEntries(dom.store));
  assert.equal(again.read(EVENT).userId,'u_new');assert.doesNotMatch(again.app.innerHTML,/原目标 g_selected|本人原话/);
});

test('network recovery continues the same repaired user cache and cursor without resending chat or changing task reminders',async()=>{
  const original=seed(),first=await start(original);await observableWorkspace(first);
  const calls=[];
  const again=await start(Object.fromEntries(first.store),{request:async input=>{
    calls.push(input);
    if(input.path==='/connection/status')return {along:true,ready:true,eventProtocol:1,userId:USER,runtime:'dsh-superagent'};
    if(input.path==='/sync')return {items:[]};
    throw Error('unexpected mutation '+input.path);
  }});
  await observableWorkspace(again);preserved(again,original,{online:true});
  const projection=again.notifications.find(call=>call.action==='eventTaskSync')?.value;
  assert.deepEqual(projection?.results,[]);
  assert.equal(projection?.reminders.length,2);
  assert.ok(projection.reminders.every(row=>Date.parse(row.scheduledAt)===Date.parse('2099-01-01T12:00:00Z')));
  assert.ok(calls.some(call=>call.path==='/sync'&&call.body.after_seq===7));
  assert.ok(!calls.some(call=>call.path==='/events'));
});
