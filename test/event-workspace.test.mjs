import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {createEventWorkspace} from '../web/event-workspace.mjs';
import {pendingEvents} from '../web/agent-client.mjs';

const config={userId:'u_workspace',baseURL:'https://localhost:4176',fingerprint:'a'.repeat(64),token:'b'.repeat(64)};
const snapshot=(title='睡眠目标',revision=1)=>({goal:{id:'g_sleep',domain:'custom',status:'active',currentRevision:revision},
  revision:{goalId:'g_sleep',revision,title,status:'active'},tasks:[{id:'t_sleep',goalId:'g_sleep',content:'睡前放下手机',status:'open',currentRevision:1}]});
const change=(seq,title,revision=1)=>({seq,userId:config.userId,kind:'goal_updated',goalId:'g_sleep',payload:{snapshot:snapshot(title,revision)}});
function setup(handler) {
  const dom=installDomStub();
  const calls=[];
  window.AlongAgentBridge={request:async input=>{calls.push(input);return handler(input,calls);}};
  return {dom,calls,workspace:createEventWorkspace({config})};
}

test('chat is durable before sending; same-id retry survives reopening and uses the bound user queue',async()=>{
  let online=false;
  const {workspace,calls}=setup(input=>{
    if (!online) throw Error('offline');
    return input.path==='/events'?{status:'accepted',event_id:input.body.event_id}:{items:[]};
  });
  const first=await workspace.submit('最近睡得不好');
  await workspace.submit('我想改善睡眠');
  assert.equal(calls.length,0,'submitting must save without waiting for the network');
  assert.equal(pendingEvents(config).length,2);
  assert.equal(pendingEvents({...config,userId:'u_other'}).length,0);
  await workspace.sync();
  const firstAttempt=calls.find(call=>call.path==='/events').body;
  assert.equal(firstAttempt.event_id,first);
  assert.equal(pendingEvents(config).length,2);
  const reopened=createEventWorkspace({config});
  assert.equal(reopened.view().messages.length,2);
  online=true;await reopened.sync();
  assert.deepEqual(calls.filter(call=>call.path==='/events')[1].body,firstAttempt);
  assert.equal(pendingEvents(config).length,0);
});

test('sync applies complete validated pages, follows pagination, caches before ack and rebuilds on reopen',async()=>{
  const {workspace,calls}=setup(input=>{
    if(input.path==='/sync/ack') {
      const cache=JSON.parse(localStorage.getItem(`along.event-workspace.v1:${config.userId}`));
      assert.equal(cache.cursor,input.body.seqs.at(-1));return {acked:input.body.seqs.length};
    }
    return input.body.after_seq===0?{items:[change(1,'初始目标')],nextCursor:'1'}:{items:[change(2,'更正后的目标',2)]};
  });
  const flight=workspace.sync();assert.equal(workspace.sync(),flight,'polling is single-flight');await flight;
  assert.equal(workspace.view().cursor,2);
  assert.equal(workspace.view().goals.g_sleep.title,'更正后的目标');
  assert.equal(createEventWorkspace({config}).view().goals.g_sleep.revision,2);
  assert.deepEqual(calls.filter(item=>item.path==='/sync').map(item=>item.body.after_seq),[0,1]);
});

test('a malformed later item rejects the entire page without advancing state or acknowledging',async()=>{
  const {workspace,calls}=setup(()=>({items:[change(1,'合法'),change(2,{bad:'title'})]}));
  await workspace.sync();
  assert.equal(workspace.view().cursor,0);
  assert.deepEqual(workspace.view().goals,{});
  assert.ok(workspace.view().error);
  assert.equal(calls.some(item=>item.path==='/sync/ack'),false);
});

test('ack failure is persisted and retried after reopening before fetching the next page',async()=>{
  let fail=true;
  const {workspace,calls}=setup(input=>{
    if(input.path==='/sync/ack') {if(fail)throw Error('ack failed');return {acked:1};}
    return input.body.after_seq===0?{items:[change(1,'目标')]}:{items:[]};
  });
  await workspace.sync();assert.equal(workspace.view().cursor,1);
  fail=false;calls.length=0;
  await createEventWorkspace({config}).sync();
  assert.equal(calls[0].path,'/sync/ack');
  assert.equal(calls[1].body.after_seq,1);
});

test('cache write failure leaves the cursor unchanged and prevents ack; queue write failure preserves the draft',async()=>{
  const {workspace,calls}=setup(()=>({items:[change(1,'目标')]}));
  const original=localStorage.setItem;
  localStorage.setItem=()=>{throw Error('storage full');};
  await workspace.sync();assert.equal(workspace.view().cursor,0);
  assert.equal(calls.some(item=>item.path==='/sync/ack'),false);
  await assert.rejects(workspace.submit('不能丢的原话'),/storage full/);
  assert.equal(workspace.view().messages.length,0);
  localStorage.setItem=original;
});

test('bad pagination and foreign ownership never enter the cache; terminal receipts remain visible',async()=>{
  const {workspace}=setup(input=>input.path==='/events'?{status:'rejected',event_id:input.body.event_id,reason:'not_found'}:
    {items:[{...change(1,'目标'),userId:'u_other'}],nextCursor:'wrong'});
  await workspace.submit('帮我安排');await workspace.sync();
  assert.equal(workspace.view().messages[0].status,'rejected');
  assert.equal(workspace.view().cursor,0);
  assert.equal(createEventWorkspace({config:{...config,userId:'u_other'}}).view().messages.length,0);
});

test('idle polls do not replace the composing form, and retired connections cannot overwrite a newer cache',async()=>{
  let changes=0,release;
  const {calls}=setup(()=>({items:[]}));
  const workspace=createEventWorkspace({config,onChange:()=>{changes++;}});
  await workspace.sync();await workspace.sync();assert.equal(changes,0);
  window.AlongAgentBridge.request=()=>new Promise(resolve=>{release=resolve;});
  const flight=workspace.sync();await new Promise(resolve=>setImmediate(resolve));
  workspace.dispose();
  release({items:[change(1,'来自旧连接的结果')]});await flight;
  assert.equal(createEventWorkspace({config}).view().cursor,0);
  assert.equal(changes,0);assert.ok(calls.length>=2);
});

test('leaving a new-goal conversation returns to the prior goal without rebinding its durable result',async()=>{
  let items=[];
  const {workspace,calls}=setup(input=>{
    if(input.path==='/events')return {status:'accepted',event_id:input.body.event_id};
    if(input.path==='/sync/ack')return {acked:input.body.seqs.length};
    return {items:items.filter(item=>item.seq>input.body.after_seq)};
  });
  items=[change(1,'原目标')];
  await workspace.sync();
  workspace.select('g_sleep');
  workspace.select(null);
  workspace.setDraft('一条未发送草稿');
  assert.equal(createEventWorkspace({config}).draft(),'一条未发送草稿','重开后要恢复新对话的未发送文字');
  const eventId=await workspace.submit('新目标的原话');
  assert.equal(workspace.draft(),'','发送成功落队列后才清掉对应草稿');
  const conversationId=workspace.view().conversationId;
  workspace.setDraft('首句发送后的未发送补充');
  assert.equal(workspace.leaveConversation(),'g_sleep');
  assert.equal(workspace.view().activeGoalId,'g_sleep');
  assert.equal(workspace.view().conversationId,conversationId,'返回不能丢掉待同步对话的关联号');
  workspace.select(null);
  assert.equal(workspace.view().conversationId,conversationId,'重开未完成的新目标时要恢复原会话');
  assert.equal(workspace.draft(),'首句发送后的未发送补充','首句已发送后输入的第二句草稿也必须恢复');
  workspace.leaveConversation();
  const pending=pendingEvents(config).find(item=>item.event_id===eventId);
  assert.equal(pending.causation_id,undefined,'新对话的首条消息仍是原对话根');
  items=[change(2,'新目标'),{seq:3,userId:config.userId,kind:'message',goalId:'g_new',payload:{
    snapshot:{goal:{id:'g_new',domain:'custom',status:'active',currentRevision:1},revision:{goalId:'g_new',revision:1,title:'新目标',status:'active'},tasks:[]},
    conversation_id:conversationId,message:{id:'msg_new',eventId:'evt_new',role:'assistant',direction:'outbound',text:'已整理好',seq:3,causationId:eventId}}}];
  await workspace.sync();
  assert.equal(workspace.view().activeGoalId,'g_sleep','迟到的新目标结果不能抢走用户已返回的原目标');
  assert.equal(workspace.view().messages.find(message=>message.eventId==='evt_new').goalId,'g_new');
  assert.ok(calls.some(call=>call.path==='/events'));
});
