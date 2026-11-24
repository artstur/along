import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const old={baseURL:'https://192.168.10.2:4176',token:'b'.repeat(64),fingerprint:'A'.repeat(64),trustPolicy:'legacy-local-pin-v1',bindingScopeId:'old-native-scope'};
const next={...old,baseURL:'https://192.168.10.9:4176',bindingScopeId:'next-native-scope'};
const proof={fromBaseURL:old.baseURL,fromBindingScopeId:old.bindingScopeId,toBaseURL:next.baseURL,toBindingScopeId:next.bindingScopeId,userId:'same-user'};
const agentKey='along.agent.v1',eventKey='along.event-connection.v1',workspaceKey='along.event-workspace.v1:same-user',sharingKey='along.health-sharing.v1';
const grant={id:'original-grant',goalKey:'health',topics:['sleep','workout'],weeklyWorkoutMinutes:180};
const goal={id:'original-goal',domain:'custom',status:'active',revision:1,title:'原合成目标',metric:null,context:[],tasks:[
 {id:'original-task',goalId:'original-goal',status:'open',content:'原合成提醒任务',revision:1,scheduledAt:'2099-01-01T14:00:00Z',reminderPlan:{state:'scheduled',source:'agent',repeat:'daily',timezone:'Asia/Shanghai',explanation:'原有固定时刻'}}]};
const cache={version:1,recommendationsVersion:1,conversationVersion:1,dataSourcesVersion:1,executionVersion:2,taskCapabilityVersion:1,resultPresentationVersion:1,
 userId:'same-user',cursor:17,pendingAck:[17],activeGoalId:goal.id,conversationId:null,returnGoalId:null,goals:{[goal.id]:goal},
 messages:{direct:{eventId:'direct',goalId:goal.id,role:'assistant',text:'原合成对话',audience:'conversation'},background:{eventId:'background',goalId:goal.id,role:'assistant',text:'后台合成状态禁止出现在chat',audience:'background'}},
 drafts:{['goal:'+goal.id]:'原合成草稿'}};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
let serial=0;
async function app({migration=proof,restore=false,revoked=false,failed=false,torn=false,tornDailyKey=null,storage={}}={}) {
 const dom=installDomStub({storage:{[agentKey]:JSON.stringify(old),'along.agent-runtime.v1':'dsh-superagent',
  [eventKey]:JSON.stringify({bindingScopeId:old.bindingScopeId,userId:'same-user',bindingOrigin:old.baseURL}),
  [workspaceKey]:JSON.stringify(cache),[sharingKey]:JSON.stringify({dailyDelegation:grant,dailyRecipient:old.bindingScopeId,...(revoked?{dailyRevokedIds:[grant.id]}:{})}),...storage}});
 if(torn||tornDailyKey) {
  const originalSet=localStorage.setItem;let fail=true;
  localStorage.setItem=(key,value)=>{
   const parsed=key===agentKey||key===tornDailyKey?JSON.parse(value):{};
   if(fail&&(torn&&key===agentKey&&parsed.baseURL===next.baseURL||key===tornDailyKey&&parsed.dailyRecipient===next.bindingScopeId)) {
    fail=false;throw Error('synthetic interrupted write');
   }
   originalSet(key,value);
  };
 }
 document.visibilityState='visible';
 const calls=[];let native=restore?next:old,holdOldAck;
 window.AlongHealthBridge={healthEvents:async()=>{calls.push(['health',native.baseURL]);return {enabled:true};}};
 window.AlongAgentBridge={connection:async(action,value)=>{
  calls.push([action,value?.baseURL]);
  if(action==='load') return restore?{...next,transportMigration:migration}:old;
  if(action==='save') {
   assert.equal(JSON.parse(dom.storage.get(agentKey)).baseURL,old.baseURL,'Web must not activate before native commit');
   if(failed)throw Error('synthetic native verification failed');
   native=next;return {...next,transportMigration:migration};
  }
 },request:async input=>{
  calls.push([input.path,input.baseURL,input.body]);
  if(input.path==='/connection/verify')return {paired:true};
  if(input.path==='/connection/status')return {along:true,ready:true,eventProtocol:1,runtime:'dsh-superagent',userId:'same-user'};
  if(input.path==='/sync/ack') {
   if(input.baseURL===old.baseURL)return new Promise(resolve=>{holdOldAck=resolve;});
   return {acked:input.body.seqs.length};
  }
  if(input.path==='/sync')return {items:[]};
  throw Error(input.path);
 },notification:async(action,value)=>{calls.push([action,value]);return {scheduled:true};}};
 await import('../web/app.mjs?verified-local-transport='+ ++serial);await settle();
 return {...dom,calls,get oldAck(){return holdOldAck;},read:key=>JSON.parse(dom.storage.get(key))};
}
async function update(dom) {
 await dom.click({action:'edit-goal'});
 await dom.app.dispatch('submit',{target:{id:'host-address-form',fields:{baseURL:next.baseURL},querySelector:()=>null,reset(){}},preventDefault(){}});
 await settle();
}

test('actual address form saves native proof before activation and preserves same-user workspace, grants, drafts, chat and queued ACK ownership',async()=>{
 const dom=await app();
 await dom.tick(3000);await settle();assert.ok(dom.oldAck,'original workspace ACK is in flight');
 await update(dom);
 assert.deepEqual(dom.read(agentKey),next);
 assert.deepEqual(dom.read(eventKey),{bindingScopeId:next.bindingScopeId,userId:'same-user',bindingOrigin:next.baseURL});
 const state=dom.read(workspaceKey);
 assert.equal(state.cursor,17);assert.deepEqual(state.drafts,cache.drafts);assert.deepEqual(state.messages,cache.messages);
 assert.equal(dom.read(sharingKey).dailyDelegation.id,grant.id);
 assert.equal(dom.read(sharingKey).dailyRecipient,next.bindingScopeId);
 assert.equal(dom.read(sharingKey).dailyRevokedIds,undefined);
 assert.ok(dom.calls.some(([path,base])=>path==='health'&&base===next.baseURL),'connectEventWorkspace must configure native health at new transport');
 assert.ok(dom.calls.some(([path,base,body])=>path==='/sync/ack'&&base===next.baseURL&&body.seqs[0]===17));
 await dom.click({action:'event-chat'});
 await dom.app.dispatch('input',{target:{matches:selector=>selector==='#agent-form textarea',value:'迁址后的新草稿',style:{},scrollHeight:48}});
 dom.oldAck({acked:1});await settle();
 assert.equal(dom.read(workspaceKey).drafts['goal:'+goal.id],'迁址后的新草稿','late old ACK must not overwrite new draft');
 assert.equal(dom.read(workspaceKey).cursor,17,'old workspace result cannot replace new state');
 await dom.click({action:'event-chat'});await settle();
 assert.match(dom.app.innerHTML,/原合成对话/);
 assert.match(dom.app.innerHTML,/迁址后的新草稿/);
 assert.doesNotMatch(dom.app.innerHTML,/后台合成状态禁止出现在chat/);
});

test('native load proof recovers an interrupted address update offline without revoking grants',async()=>{
 const dom=await app({restore:true});
 assert.deepEqual(dom.read(agentKey),next);assert.equal(dom.read(sharingKey).dailyDelegation.id,grant.id);
 assert.equal(dom.read(eventKey).bindingScopeId,next.bindingScopeId);assert.deepEqual(dom.read(workspaceKey).drafts,cache.drafts);
});

test('failed native verification leaves the original Web connection and grant intact',async()=>{
 const dom=await app({failed:true});await update(dom);
 assert.deepEqual(dom.read(agentKey),old);assert.equal(dom.read(sharingKey).dailyDelegation.id,grant.id);
 assert.equal(dom.read(eventKey).bindingScopeId,old.bindingScopeId);
});

for (const variant of ['missing','user','old-origin','new-origin','old-scope','new-scope']) {
 test('address update cannot preserve grants with '+variant+' native proof',async()=>{
  const migration=variant==='missing'?null:{...proof,...({user:{userId:'other-user'},'old-origin':{fromBaseURL:'https://192.168.10.7:4176'},'new-origin':{toBaseURL:'https://other.example.com'},'old-scope':{fromBindingScopeId:'unknown'},'new-scope':{toBindingScopeId:'unknown'}}[variant])};
  const dom=await app({migration});await update(dom);
  assert.equal(dom.read(sharingKey).dailyDelegation,undefined);
  assert.ok(dom.read(sharingKey).dailyRevokedIds.includes(grant.id));
 });
}

test('verified migration never restores a previously revoked daily grant',async()=>{
 const dom=await app({revoked:true});await update(dom);
 assert.deepEqual(dom.read(sharingKey).dailyRevokedIds,[grant.id]);
 assert.equal(dom.read(sharingKey).dailyRecipient,old.bindingScopeId);
});


test('an interrupted Web connection write recovers the native-proved new event pointer without revoking the original grant',async()=>{
 const first=await app({torn:true});await update(first);
 assert.equal(first.read(agentKey).baseURL,old.baseURL);
 assert.equal(first.read(eventKey).bindingScopeId,next.bindingScopeId);
 const restarted=await app({restore:true,storage:Object.fromEntries([agentKey,eventKey,workspaceKey,sharingKey,'along.agent-runtime.v1','along.health-background-template.v1'].map(key=>[key,first.storage.get(key)]).filter(([,value])=>value!==null))});
 assert.deepEqual(restarted.read(agentKey),next);
 assert.equal(restarted.read(eventKey).bindingScopeId,next.bindingScopeId);
 assert.equal(restarted.read(sharingKey).dailyDelegation.id,grant.id);
 assert.equal(restarted.read(sharingKey).dailyRevokedIds,undefined);
 assert.deepEqual(restarted.read(workspaceKey).drafts,cache.drafts);
 assert.match(restarted.app.innerHTML,/原合成目标/);
});


test('same-config cold recovery finishes an authenticated old daily recipient before the early return',async()=>{
 const dom=await app({restore:true,storage:{[agentKey]:JSON.stringify(next),[eventKey]:JSON.stringify({bindingScopeId:next.bindingScopeId,userId:'same-user',bindingOrigin:next.baseURL})}});
 assert.equal(dom.read(sharingKey).dailyRecipient,next.bindingScopeId);
 assert.deepEqual(dom.read(sharingKey).dailyDelegation,grant);
 assert.equal(dom.read(sharingKey).dailyRevokedIds,undefined);
});

test('a partial daily recipient write across two goals resumes from the exact native proof',async()=>{
 const custom='custom:second',customKey=sharingKey+':'+custom;
 const customGrant={id:'second-grant',goalKey:custom,topics:['sleep']};
 const first=await app({tornDailyKey:customKey,storage:{'along.goal-custom.v1':JSON.stringify({[custom]:{title:'second synthetic health goal',healthTypes:['sleep']}}),[customKey]:JSON.stringify({dailyDelegation:customGrant,dailyRecipient:old.bindingScopeId})}});
 await update(first);
 assert.equal(first.read(sharingKey).dailyRecipient,next.bindingScopeId);
 assert.equal(first.read(customKey).dailyRecipient,old.bindingScopeId);
 const keys=[agentKey,eventKey,workspaceKey,sharingKey,customKey,'along.goal-custom.v1','along.agent-runtime.v1'];
 const restored=await app({restore:true,storage:Object.fromEntries(keys.map(key=>[key,first.storage.get(key)]).filter(([,value])=>value!==null))});
 assert.equal(restored.read(sharingKey).dailyRecipient,next.bindingScopeId);
 assert.equal(restored.read(customKey).dailyRecipient,next.bindingScopeId);
 assert.deepEqual(restored.read(customKey).dailyDelegation,customGrant);
 assert.equal(restored.read(customKey).dailyRevokedIds,undefined);
});

test('same-config proof recovery never adopts an unknown daily recipient or revives a revoked grant',async()=>{
 for(const revoked of [false,true]) {
  const dom=await app({restore:true,storage:{[agentKey]:JSON.stringify(next),[eventKey]:JSON.stringify({bindingScopeId:next.bindingScopeId,userId:'same-user',bindingOrigin:next.baseURL}),[sharingKey]:JSON.stringify({dailyDelegation:grant,dailyRecipient:revoked?old.bindingScopeId:'unknown-scope',...(revoked?{dailyRevokedIds:[grant.id]}:{})})}});
  assert.equal(dom.read(sharingKey).dailyRecipient,revoked?old.bindingScopeId:'unknown-scope');
  if(revoked)assert.deepEqual(dom.read(sharingKey).dailyRevokedIds,[grant.id]);
 }
});
