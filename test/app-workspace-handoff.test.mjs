import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
const userId='u_12345678',deviceId='d_12345678';
const old={baseURL:'https://192.168.10.2:4176',token:'b'.repeat(64),fingerprint:'A'.repeat(64),trustPolicy:'legacy-local-pin-v1',bindingScopeId:'original-native-scope'};
const next={baseURL:'https://cloud.example.com',token:'c'.repeat(64),trustPolicy:'system-pki-v1',bindingScopeId:'cloud-native-scope',runtime:'dsh-superagent'};
const proof={purpose:'along-personal-workspace-handoff/v1',migrationId:'handoff-synthetic-0001',userId,deviceId,
 fromBaseURL:old.baseURL,fromBindingScopeId:old.bindingScopeId,toBaseURL:next.baseURL,toBindingScopeId:next.bindingScopeId,
 manifestSHA256:'1'.repeat(64),snapshotSHA256:'2'.repeat(64),syncPrefixSHA256:'3'.repeat(64),syncHighWaterMark:117};
const agentKey='along.agent.v1',eventKey='along.event-connection.v1',workspaceKey='along.event-workspace.v1:'+userId,sharingKey='along.health-sharing.v1';
const grant={id:'original-grant',goalKey:'health',topics:['sleep','workout'],weeklyWorkoutMinutes:180};
const goal={id:'original-goal',domain:'custom',status:'active',revision:1,title:'原合成目标',metric:null,context:[],tasks:[
 {id:'original-task',goalId:'original-goal',status:'open',content:'原合成任务',revision:1,scheduledAt:'2099-01-01T14:00:00Z',reminderPlan:{state:'scheduled',source:'agent',repeat:'daily',timezone:'Asia/Shanghai',explanation:'原固定时刻'}}]};
const cache={version:1,recommendationsVersion:1,conversationVersion:1,dataSourcesVersion:1,executionVersion:2,taskCapabilityVersion:1,resultPresentationVersion:1,
 userId,cursor:117,pendingAck:[117],activeGoalId:goal.id,conversationId:null,returnGoalId:null,goals:{[goal.id]:goal},
 messages:{direct:{eventId:'direct',goalId:goal.id,role:'assistant',text:'原合成对话',audience:'conversation'},
  background:{eventId:'background',goalId:goal.id,role:'assistant',text:'后台合成编排禁止进入聊天',audience:'background'}},drafts:{['goal:'+goal.id]:'原草稿'}};
const settle=async()=>{for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));};let serial=0;
async function app({migration=proof,revoked=false,storage={},tornKey=null}={}) {
 const dom=installDomStub({storage:{[agentKey]:JSON.stringify(old),'along.agent-runtime.v1':'dsh-superagent',
  [eventKey]:JSON.stringify({bindingScopeId:old.bindingScopeId,userId,bindingOrigin:old.baseURL}),[workspaceKey]:JSON.stringify(cache),
  [sharingKey]:JSON.stringify({dailyDelegation:grant,dailyRecipient:old.bindingScopeId,...(revoked?{dailyRevokedIds:[grant.id]}:{})}),...storage}});
 if(tornKey){const original=localStorage.setItem;let fail=true;localStorage.setItem=(key,value)=>{if(fail&&key===tornKey&&JSON.parse(value).baseURL===next.baseURL){fail=false;throw Error('isolated interruption');}original(key,value);};}
 document.visibilityState='visible';const calls=[];
 window.AlongHealthBridge={healthEvents:async()=>{calls.push('health');return {enabled:true};}};
 window.AlongAgentBridge={connection:async action=>action==='load'?{...next,workspaceHandoff:migration}:null,
  request:async input=>{calls.push(input);if(input.baseURL!==next.baseURL)throw Error('retired source transport');if(input.path==='/connection/verify')return {paired:true};
   if(input.path==='/connection/status')return {along:true,ready:true,eventProtocol:1,runtime:'dsh-superagent',userId};
   if(input.path==='/sync')return {items:[]};if(input.path==='/sync/ack')return {acked:input.body.seqs.length};throw Error(input.path);},
  notification:async()=>({scheduled:true})};
 await import('../web/app.mjs?workspace-handoff='+ ++serial);await settle();return {...dom,calls,read:key=>JSON.parse(dom.storage.get(key))};
}
test('native-proved cloud handoff preserves original goal/tasks/drafts/direct chat and moves only surviving daily recipient',async()=>{
 const dom=await app();assert.deepEqual(dom.read(agentKey),next);assert.deepEqual(dom.read(eventKey),{bindingScopeId:next.bindingScopeId,userId,bindingOrigin:next.baseURL+':443'});
 const state=dom.read(workspaceKey);assert.equal(state.goals[goal.id].title,goal.title);assert.deepEqual(state.goals[goal.id].tasks,goal.tasks);assert.deepEqual(state.messages,cache.messages);assert.deepEqual(state.drafts,cache.drafts);
 assert.equal(state.cursor,117);assert.equal(state.notificationHandoffThrough,117);assert.deepEqual(state.workspaceHandoff,proof);
 assert.equal(dom.read(sharingKey).dailyRecipient,next.bindingScopeId);assert.equal(dom.read(sharingKey).dailyDelegation.id,grant.id);
 assert.equal(dom.calls.some(x=>x?.path==='/events'),false,'no synthetic messages or health envelope is submitted by Web handoff');
 await dom.click({action:'event-chat'});assert.match(dom.app.innerHTML,/原合成对话/);assert.match(dom.app.innerHTML,/原草稿/);assert.doesNotMatch(dom.app.innerHTML,/后台合成编排禁止进入聊天/);
});
test('cloud handoff does not revive a withdrawn grant',async()=>{const dom=await app({revoked:true});assert.deepEqual(dom.read(sharingKey).dailyRevokedIds,[grant.id]);assert.equal(dom.read(sharingKey).dailyRecipient,old.bindingScopeId);});
for(const [name,change] of Object.entries({user:{userId:'u_aaaaaaaa'},device:{deviceId:'other'},oldScope:{fromBindingScopeId:'unknown'},newScope:{toBindingScopeId:'unknown'},
 oldOrigin:{fromBaseURL:'https://192.168.3.2:4176'},newOrigin:{toBaseURL:'https://wrong.example.com'},prefix:{syncHighWaterMark:116},digest:{manifestSHA256:'bad'}})) {
 test('invalid cloud handoff '+name+' preserves original cache and authority',async()=>{const dom=await app({migration:{...proof,...change}});
  assert.deepEqual(dom.read(agentKey),old);assert.equal(dom.read(eventKey).bindingScopeId,old.bindingScopeId);assert.equal(dom.read(sharingKey).dailyRecipient,old.bindingScopeId);assert.equal(dom.read(workspaceKey).cursor,117);});
}
test('partial frontend cutover resumes idempotently and later cloud cursor growth does not break cold reopen',async()=>{
 const first=await app({tornKey:agentKey});assert.equal(first.read(agentKey).baseURL,old.baseURL);assert.equal(first.read(eventKey).bindingScopeId,next.bindingScopeId);
 const storage=Object.fromEntries(first.store);const resumed=await app({storage});assert.deepEqual(resumed.read(agentKey),next);
 const grown={...resumed.read(workspaceKey),cursor:130,pendingAck:[]};const reopened=await app({migration:Object.fromEntries(Object.entries(proof).reverse()),storage:{...Object.fromEntries(resumed.store),[workspaceKey]:JSON.stringify(grown)}});
 assert.deepEqual(reopened.read(agentKey),next);assert.equal(reopened.read(workspaceKey).cursor,130);assert.equal(reopened.read(sharingKey).dailyRecipient,next.bindingScopeId);
});
test('an unproven cache ahead of the frozen prefix cannot adopt the new cloud identity',async()=>{
 const dom=await app({storage:{[workspaceKey]:JSON.stringify({...cache,cursor:130})}});assert.deepEqual(dom.read(agentKey),old);assert.equal(dom.read(eventKey).bindingScopeId,old.bindingScopeId);
});
