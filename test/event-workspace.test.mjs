import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {createEventWorkspace,safeWorkspaceGoal} from '../web/event-workspace.mjs';
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

test('invalid task reminder plans never invent or schedule a time and preserve the rest of the goal',()=>{
  const when='2099-03-01T12:15:00+08:00',valid={state:'scheduled',source:'agent',repeat:'weekly',weekday:1,explanation:'提前准备'};
  const clean=(plan,scheduledAt)=>{
    const wire=snapshot();Object.assign(wire.tasks[0],{reminderPlan:plan,scheduledAt});
    return safeWorkspaceGoal(wire).tasks[0];
  };
  for (const [plan,at] of [[{...valid,weekday:8},when],[{...valid,weekday:undefined},when],[{...valid,repeat:'daily'},when],
    [{...valid,source:'guess'},when],[{...valid,explanation:' '},when],[{...valid,explanation:'字'.repeat(241)},when],
    [{state:'needs_time',question:'什么时候？'},when],[{state:'off',reason:'untimed'},when],[{state:'needs_time',question:'?'},undefined],
    [{state:'off',reason:'unknown'},undefined],[valid,undefined],[valid,'2099-02-30T12:15:00Z'],[valid,'2099-03-01T12:15:00'],[null,when]]) {
    const task=clean(plan,at);
    assert.equal(task.content,'睡前放下手机');assert.equal(task.reminderPlan,undefined);assert.equal(task.scheduledAt,undefined);
  }
  assert.deepEqual(clean({...valid,explanation:'  提前准备  ',extra:'忽略'},when).reminderPlan,valid);
  assert.equal(clean(undefined,'2099-03-01').scheduledAt,undefined);
  assert.equal(clean(undefined,when).scheduledAt,when);
});

const receiptId='out:ticket_one:assignment_one';
const receiptMessage={id:'msg_result',eventId:receiptId,role:'assistant',direction:'outbound',text:'已完成这次执行',seq:2};
function cachedReceiptWorkspace() {
  const goal={id:'g_sleep',domain:'custom',status:'active',revision:1,title:'已设定的目标',metric:null,context:[],
    tasks:Array.from({length:5},(_,i)=>({id:'t_'+i,goalId:'g_sleep',content:'已设定的任务 '+i,status:'open',revision:1}))};
  const receipt={...receiptMessage,goalId:goal.id,presentation:'execution',status:'received',conversationId:receiptId};
  return {version:1,userId:config.userId,cursor:2,activeGoalId:goal.id,conversationId:null,
    goals:{[goal.id]:goal},messages:{[receiptId]:receipt},drafts:{}};
}

test('execution receipts keep their own event identity and explicit conversation roots across offline restart',async()=>{
  const key='along.event-workspace.v1:'+config.userId,root='chat_root';
  const execution=(seq,eventId,fields)=>({...change(seq,'已设定的目标'),kind:'message',payload:{
    snapshot:snapshot('已设定的目标'),presentation:'execution',...fields,message:{...receiptMessage,seq,eventId}}});
  const items=[execution(1,receiptId,{}),execution(2,'out:second:worker',{conversation_id:root})];
  const {workspace}=setup(input=>input.path==='/sync'?{items:input.body.after_seq?[]:items}:{acked:2});
  await workspace.sync();
  assert.equal(workspace.view().cursor,2);
  const stored=JSON.parse(localStorage.getItem(key));
  assert.equal(stored.messages[receiptId].conversationId,undefined);
  assert.equal(stored.messages['out:second:worker'].conversationId,root);
  window.AlongAgentBridge.request=async()=>{throw Error('offline');};
  const reopened=createEventWorkspace({config});await reopened.sync();
  assert.equal(reopened.view().activeGoalId,'g_sleep');
  assert.deepEqual(reopened.view().messages.map(m=>m.eventId),[receiptId,'out:second:worker']);
});
test('offline restart migrates a goal-bound execution receipt self-reference while retaining every task and message',async()=>{
  const key='along.event-workspace.v1:'+config.userId,seed=cachedReceiptWorkspace();
  installDomStub({storage:{[key]:JSON.stringify(seed)}});
  window.AlongAgentBridge={request:async()=>{throw Error('offline');}};
  const reopened=createEventWorkspace({config});await reopened.sync();
  assert.equal(reopened.view().activeGoalId,'g_sleep');
  assert.deepEqual(reopened.view().goals.g_sleep.tasks.map(t=>t.id),seed.goals.g_sleep.tasks.map(t=>t.id));
  const [message]=reopened.view().messages;
  assert.equal(message.eventId,receiptId);assert.equal(message.conversationId,undefined);
  assert.equal(message.text,receiptMessage.text);assert.equal(message.goalId,'g_sleep');
  assert.equal(JSON.parse(localStorage.getItem(key)).messages[receiptId].conversationId,undefined);
});
test('offline restart rejects invalid conversation references outside the known goal-bound execution receipt shape',()=>{
  const key='along.event-workspace.v1:'+config.userId;
  for (const change of [{presentation:'chat'},{goalId:'other_goal'},{goalId:undefined},
    {conversationId:'out:another:event'},{role:'user'},{status:'pending'}]) {
    const seed=cachedReceiptWorkspace();Object.assign(seed.messages[receiptId],change);
    const raw=JSON.stringify(seed);installDomStub({storage:{[key]:raw}});
    assert.equal(createEventWorkspace({config}).view().cursor,0);
    assert.equal(localStorage.getItem(key),raw);
  }
});
test('an execution receipt migration keeps the validated workspace accessible when the cache is read-only',()=>{
  const key='along.event-workspace.v1:'+config.userId,raw=JSON.stringify(cachedReceiptWorkspace());
  installDomStub({storage:{[key]:raw}});
  localStorage.setItem=()=>{throw Error('storage full');};
  const restored=createEventWorkspace({config}).view();
  assert.equal(restored.activeGoalId,'g_sleep');assert.equal(restored.goals.g_sleep.tasks.length,5);
  assert.equal(restored.messages[0].conversationId,undefined);
  assert.equal(localStorage.getItem(key),raw);
});

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

test('the iOS projection follows final task state and forwards only explicit fresh local result events',async()=>{
  const now=new Date(), at=new Date(now.getTime()+60000).toISOString();
  const start=change(1,'测试目标');
  start.payload.snapshot.tasks[0].scheduledAt=at;
  const ready={...start,seq:2,kind:'task_updated',taskId:'t_sleep',createdAt:now.toISOString(),
    payload:{...start.payload,notification:{kind:'recommendation_ready',event_id:'ready_1',revision:1}}};
  let page=[start,ready], remote=false, batches=[];
  setup(input=>input.path==='/sync/ack'?{}:{items:page.filter(i=>i.seq>input.body.after_seq),remoteNotifications:remote});
  const ws=createEventWorkspace({config,onNotifications:async value=>{batches.push(value);}});
  await ws.sync();
  assert.deepEqual(batches.at(-1).reminders,[{goalId:'g_sleep',taskId:'t_sleep',revision:1,scheduledAt:at,body:'睡前放下手机'}]);
  assert.equal(batches.at(-1).results[0].eventId,'ready_1');
  await ws.sync();assert.equal(batches.at(-1).results.length,0);
  const done=change(3,'测试目标',2);done.payload.snapshot.tasks[0].status='done';
  remote=true;page=[done,{...ready,seq:4,payload:{...done.payload,notification:{...ready.payload.notification,event_id:'ready_2'}}}];
  await ws.sync();assert.deepEqual(batches.at(-1).reminders,[]);assert.deepEqual(batches.at(-1).results,[]);
});

test('native result failures survive restart and stale or unmarked progress never alerts',async()=>{
  const fresh=new Date().toISOString(), stale=new Date(Date.now()-86400000).toISOString();
  const make=(seq,createdAt,notification)=>({...change(seq,'测试'),createdAt,payload:{snapshot:snapshot('测试'),notification}});
  const mark=event_id=>({event_id,kind:'task_result',revision:1});
  const page=[make(1,fresh,mark('result_1')),make(2,stale,mark('result_2')),make(3,fresh)];
  setup(input=>input.path==='/sync/ack'?{}:{items:page.filter(i=>i.seq>input.body.after_seq),remoteNotifications:false});
  const first=createEventWorkspace({config,onNotifications:async()=>{throw Error('system unavailable');}});
  await first.sync();
  const batches=[];const reopened=createEventWorkspace({config,onNotifications:async value=>{batches.push(value);}});
  await reopened.sync();assert.deepEqual(batches[0].results.map(x=>x.eventId),['result_1']);
});

test('reschedule, cancellation and archive each reconcile a complete authoritative projection',async()=>{
  const at=new Date(Date.now()+3600000).toISOString(), later=new Date(Date.now()+7200000).toISOString();
  const initial=change(1,'一号目标');initial.payload.snapshot.tasks[0].scheduledAt=at;
  let page=[initial];const batches=[];
  setup(input=>input.path==='/sync/ack'?{}:{items:page.filter(i=>i.seq>input.body.after_seq)});
  const ws=createEventWorkspace({config,onNotifications:async batch=>batches.push(batch)});
  await ws.sync();assert.equal(batches.at(-1).reminders[0].scheduledAt,at);
  const moved=structuredClone(initial);moved.seq=2;Object.assign(moved.payload.snapshot.tasks[0],{scheduledAt:later,currentRevision:2});
  page=[moved];await ws.sync();
  assert.deepEqual(batches.at(-1).reminders.map(t=>[t.goalId,t.taskId,t.revision,t.scheduledAt]),[['g_sleep','t_sleep',2,later]]);
  const canceled=structuredClone(moved);canceled.seq=3;canceled.payload.snapshot.tasks[0].status='cancelled';
  page=[canceled];await ws.sync();assert.deepEqual(batches.at(-1).activeTasks,[]);
  const archived=structuredClone(moved);archived.seq=4;
  archived.payload.snapshot.goal.status='archived';archived.payload.snapshot.revision.status='archived';
  page=[archived];await ws.sync();assert.deepEqual(batches.at(-1).reminders,[]);
  const invalid=structuredClone(initial);invalid.seq=5;invalid.userId='elsewhere';
  const count=batches.length;page=[invalid];await ws.sync();assert.equal(batches.length,count);
});

test('remote ownership follows each individual notice across registration changes',async()=>{
  const make=(seq,remote)=>({...change(seq,'测试'),remoteNotifications:remote,createdAt:new Date().toISOString(),
    payload:{snapshot:snapshot('测试'),notification:{event_id:'n_'+seq,kind:'task_result',revision:1}}});
  const items=[make(1,false),make(2,true),make(3,undefined)],results=[];
  setup(input=>input.path==='/sync/ack'?{}:{items:items.filter(i=>i.seq>input.body.after_seq),remoteNotifications:true});
  const ws=createEventWorkspace({config,onNotifications:async batch=>results.push(...batch.results)});
  await ws.sync();assert.deepEqual(results.map(n=>n.eventId),['n_1']);
});

test('a rejected APNs alert is handed back on an empty page after sync ack, survives crash and retries its receipt',async()=>{
  const at=new Date().toISOString(), initial=change(1,'测试');
  initial.createdAt=at;initial.remoteNotifications=true;
  initial.payload.notification={kind:'recommendation_ready',event_id:'handoff',revision:1};
  const fallback={userId:config.userId,kind:'recommendation_ready',eventId:'handoff',goalId:'g_sleep',revision:1,createdAt:at};
  let stage='remote';const calls=[],delivered=[];
  setup(input=>{
    if(input.path==='/sync/ack')return {};
    calls.push(input.body);
    if(stage==='remote')return {items:[initial],remoteNotifications:true};
    if(stage==='retryReceipt')throw Error('offline');
    return {items:[],notificationFallback:stage==='handoff'?[fallback]:[]};
  });
  let available=true;
  const callback=async batch=>{
    if(!available)throw Error('app suspended before adding');
    delivered.push(...batch.results.map(x=>x.eventId));
  };
  const first=createEventWorkspace({config,onNotifications:callback});
  await first.sync();assert.deepEqual(delivered,[]);assert.equal(first.view().cursor,1);
  stage='handoff';available=false;await first.sync();
  const saved=JSON.parse(localStorage.getItem('along.event-workspace.v1:'+config.userId));assert.equal(saved.notificationResults[0].eventId,'handoff');
  stage='recover';available=true;
  const resumed=createEventWorkspace({config,onNotifications:callback});
  await resumed.sync();assert.deepEqual(delivered,['handoff']);
  stage='retryReceipt';await resumed.sync();assert.deepEqual(calls.at(-1).notificationReceipts,['handoff']);
  stage='recover';await resumed.sync();assert.deepEqual(calls.at(-1).notificationReceipts,['handoff']);
  await resumed.sync();assert.deepEqual(calls.at(-1).notificationReceipts,[]);
});
test('a completed or revised recommendation is suppressed while a completed task can still report its result',async()=>{
  const at=new Date().toISOString(), page=[change(1,'测试',3)];
  Object.assign(page[0].payload.snapshot.tasks[0],{status:'done',currentRevision:2});
  const fallback=[
    {kind:'recommendation_ready',eventId:'old_goal',goalId:'g_sleep',revision:2,createdAt:at},
    {kind:'recommendation_ready',eventId:'old_task',goalId:'g_sleep',taskId:'t_sleep',revision:1,createdAt:at},
    {kind:'recommendation_ready',eventId:'done_task',goalId:'g_sleep',taskId:'t_sleep',revision:2,createdAt:at},
    {kind:'task_result',eventId:'done_result',goalId:'g_sleep',taskId:'t_sleep',revision:2,createdAt:at}];
  const batches=[];setup(input=>input.path==='/sync/ack'?{}:{items:page.filter(i=>i.seq>input.body.after_seq),notificationFallback:fallback.map(r=>({...r,userId:config.userId}))});
  const ws=createEventWorkspace({config,onNotifications:async b=>batches.push(b)});
  await ws.sync();assert.deepEqual(batches[0].results.map(r=>r.eventId),['done_result']);
});

test('foreign fallback alerts and receipts never cross into the paired workspace',async()=>{
  const batches=[],incoming={userId:'someone_else',kind:'task_result',eventId:'foreign',goalId:'g_sleep',revision:1,createdAt:new Date().toISOString()};
  setup(()=>({items:[],notificationFallback:[incoming]}));
  const ws=createEventWorkspace({config,onNotifications:async b=>batches.push(b)});
  await ws.sync();assert.equal(batches.length,0);assert.ok(ws.view().error);
  assert.equal(localStorage.getItem('along.event-workspace.v1:'+config.userId),null);
});
test('previously accepted local timestamps become dated iOS instants',async()=>{
  const sample=change(1,'历史任务');sample.payload.snapshot.tasks[0].scheduledAt='2099-01-01T20:00';
  const batches=[];setup(input=>input.path==='/sync/ack'?{}:{items:[sample]});
  await createEventWorkspace({config,onNotifications:async b=>batches.push(b)}).sync();
  assert.equal(batches[0].reminders[0].scheduledAt,new Date('2099-01-01T20:00').toISOString());
});

test('archiving the selected goal clears navigation without deleting its conversation or draft',async()=>{
  let items=[change(1,'原目标')];
  const {workspace}=setup(input=>{
    if(input.path==='/events')return {status:'accepted',event_id:input.body.event_id};
    if(input.path==='/sync/ack')return {acked:input.body.seqs.length};
    return {items:items.filter(item=>item.seq>input.body.after_seq)};
  });
  await workspace.sync();workspace.select('g_sleep');
  const messageId=await workspace.submit('这项合成目标先结束');
  workspace.setDraft('归档前未发送的补充');
  const archived=change(2,'原目标',2);
  archived.payload.snapshot.goal.status='archived';
  archived.payload.snapshot.revision.status='archived';
  items=[archived];await workspace.sync();
  const view=workspace.view();
  assert.equal(view.activeGoalId,null);
  assert.equal(view.returnGoalId,null);
  assert.equal(view.conversationId,null,'a new conversation must not inherit the archived goal root');
  assert.ok(view.messages.some(message=>message.eventId===messageId));
  assert.equal(view.drafts['goal:g_sleep'],'归档前未发送的补充');
  assert.equal(view.goals.g_sleep.status,'archived','history must stay cached');
  workspace.select('g_sleep');
  assert.equal(workspace.view().activeGoalId,null,'archived goals cannot be selected again');
  const nextId=await workspace.submit('另一个合成目标');
  const queued=pendingEvents(config).find(item=>item.event_id===nextId).envelope;
  assert.equal(queued.goal_id,undefined);
  assert.equal(queued.causation_id,undefined);
});

test('reopening an older cache removes archived selections and keeps an unbound conversation resumable',async()=>{
  const {workspace}=setup(input=>input.path==='/sync/ack'?{acked:1}:{items:[change(1,'原目标')]});
  await workspace.sync();workspace.select('g_sleep');workspace.select(null);
  const eventId=await workspace.submit('尚未完成的新目标');
  workspace.setDraft('新目标的第二句草稿');workspace.leaveConversation();
  const key=`along.event-workspace.v1:${config.userId}`;
  const cached=JSON.parse(localStorage.getItem(key));
  cached.goals.g_sleep.status='archived';
  localStorage.setItem(key,JSON.stringify(cached));
  const reopened=createEventWorkspace({config});
  assert.equal(reopened.view().activeGoalId,null);
  assert.equal(reopened.view().returnGoalId,null);
  assert.equal(reopened.view().conversationId,eventId,'unbound work must not be discarded with an unrelated archived goal');
  reopened.select(null);
  assert.equal(reopened.draft(),'新目标的第二句草稿');
  assert.ok(reopened.view().messages.some(message=>message.eventId===eventId));
});

test('archiving after switching goals detaches any previously bound conversation root',async()=>{
  const item=(seq,goalId,status='active',revision=1)=>({seq,userId:config.userId,kind:'goal_updated',goalId,payload:{snapshot:{
    goal:{id:goalId,domain:'custom',status,currentRevision:revision},
    revision:{goalId,revision,title:goalId,status},tasks:[]}}});
  let items=[item(1,'g_one'),item(2,'g_two')];
  const {workspace}=setup(input=>{
    if(input.path==='/events')return {status:'accepted',event_id:input.body.event_id};
    if(input.path==='/sync/ack')return {acked:input.body.seqs.length};
    return {items:items.filter(item=>item.seq>input.body.after_seq)};
  });
  await workspace.sync();
  workspace.select('g_one');const first=await workspace.submit('First goal message');
  workspace.select('g_two');await workspace.submit('Archive second goal');
  assert.equal(workspace.view().conversationId,first,'the old root must be present to expose this boundary');
  items=[item(3,'g_two','archived',2)];await workspace.sync();
  assert.equal(workspace.view().activeGoalId,'g_one','upstream restores the remaining active goal');
  assert.equal(workspace.view().conversationId,null);
  workspace.select(null);
  const fresh=await workspace.submit('A fresh goal');
  const envelope=pendingEvents(config).find(item=>item.event_id===fresh).envelope;
  assert.equal(envelope.goal_id,undefined);
  assert.equal(envelope.causation_id,undefined);
});

test('a conversation draft stays reachable after goal binding without overwriting an existing goal draft',async()=>{
  for (const existingDraft of ['', 'An earlier draft for this goal']) {
    let items=[change(1,'已存目标')];
    const {workspace}=setup(input=>{
      if(input.path==='/events')return {status:'accepted',event_id:input.body.event_id};
      if(input.path==='/sync/ack')return {acked:input.body.seqs.length};
      return {items:items.filter(item=>item.seq>input.body.after_seq)};
    });
    await workspace.sync();workspace.select('g_sleep');
    if (existingDraft) workspace.setDraft(existingDraft);
    workspace.select(null);
    const root=await workspace.submit('Start a synthetic conversation');
    workspace.setDraft('The unsent second sentence');
    items=[{seq:2,userId:config.userId,kind:'message',goalId:'g_sleep',payload:{snapshot:snapshot(),conversation_id:root,
      message:{id:'msg_binding',eventId:'evt_binding',role:'assistant',direction:'outbound',text:'已关联目标',seq:2,causationId:root}}}];
    await workspace.sync();
    assert.equal(workspace.view().activeGoalId,'g_sleep');
    assert.equal(workspace.draft(),'The unsent second sentence');
    assert.equal(workspace.view().draftScope,`conversation:${root}`);
    const reopened=createEventWorkspace({config});
    assert.equal(reopened.draft(),'The unsent second sentence');
    // Losing the current root while visiting another conversation must not orphan the bound draft.
    reopened.select(null);reopened.select('g_sleep');
    assert.equal(reopened.draft(),'The unsent second sentence');
    const next=await reopened.submit(reopened.draft());
    const queued=pendingEvents(config).find(item=>item.event_id===next).envelope;
    assert.equal(queued.goal_id,'g_sleep');
    assert.equal(queued.payload.text,'The unsent second sentence');
    assert.equal(reopened.draft(),existingDraft,'an older goal draft stays separate until the newer conversation draft is sent');
  }
});
