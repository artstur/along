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
async function start(storage,{native=CURRENT,late=false,owner,online=false}={}) {
  const dom=installDomStub({storage}),calls=[],notifications=[],nativeCalls=[];
  delete window.AlongHealthBridge;document.visibilityState='visible';
  let resolveNative;
  const nativePromise=late?new Promise(resolve=>{resolveNative=resolve;}):Promise.resolve(native);
  window.AlongAgentBridge={
    connection:async(action)=>{nativeCalls.push(action);if(action==='load')return nativePromise;if(action==='workspace')return owner??{};throw Error('unexpected native write '+action);},
    request:async input=>{calls.push(input);if(!online)throw Error('isolated offline transport');
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
}
function preserved(dom,original) {
  const before=JSON.parse(original[CACHE]),after=dom.read(CACHE);
  for(const field of ['cursor','activeGoalId','returnGoalId','messages','drafts'])assert.deepEqual(after[field],before[field]);
  assert.deepEqual(after.goals.g_selected.tasks,before.goals.g_selected.tasks);
  assert.deepEqual(dom.read(SHARE).dailyDelegation,grant);assert.equal(dom.read(SHARE).dailyRevokedAt,undefined);
  assert.ok(dom.calls.every(call=>['/connection/status','/sync'].includes(call.path)),'migration must never submit a user message or reconfigure the Host');
  assert.ok(dom.notifications.every(call=>call.action==='pendingLegacyNotification'),'offline migration must never reissue or withdraw a notification');
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
