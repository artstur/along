// 任务完成确认与历史任务入口：完成事实的入队、确认层的取消/确认、服务端快照驱动的状态。
// 状态只来自服务端：客户端不乐观把卡片改成「已完成」（docs/task-detail-layout.md「任务完成确认与历史任务入口」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {createEventWorkspace} from '../web/event-workspace.mjs';
import {pendingEvents,queueEvent,readEventFailures} from '../web/agent-client.mjs';

const config={userId:'u_complete',baseURL:'https://localhost:4176',fingerprint:'a'.repeat(64),token:'b'.repeat(64)};
const GOAL='g_complete';
const wire=(status='open')=>({goal:{id:GOAL,domain:'custom',status:'active',currentRevision:1},
  revision:{goalId:GOAL,revision:1,title:'睡眠目标',status:'active'},
  tasks:[{id:'t_open',goalId:GOAL,content:'睡前放下手机',status,currentRevision:1}]});
const taskItem=(status='open',seq=1)=>({seq,userId:config.userId,kind:'task_updated',goalId:GOAL,taskId:'t_open',
  payload:{snapshot:wire(status)}});

function setup(handler) {
  const dom=installDomStub();
  const calls=[];
  window.AlongAgentBridge={request:async input=>{calls.push(input);return handler(input,calls);}};
  return {dom,calls,workspace:createEventWorkspace({config})};
}

// ---- 工作台层：完成事实只入队一次，状态等服务端快照 ----

test('completing a task queues one task.completed fact and leaves the local status untouched',async()=>{
  const {workspace,calls}=setup(input=>input.path==='/sync'?{items:[taskItem('open')]}:{acked:0});
  await workspace.sync();
  const before=workspace.view().goals[GOAL].tasks[0];
  assert.equal(before.status,'open');
  const eventId=await workspace.completeTask('t_open');
  const queued=pendingEvents(config).filter(item=>item.envelope.kind==='task.completed');
  assert.equal(queued.length,1);
  const envelope=queued[0].envelope;
  assert.equal(envelope.event_type,'along.message');
  assert.equal(envelope.kind,'task.completed');
  assert.equal(envelope.task_id,'t_open');
  assert.equal(envelope.goal_id,GOAL);
  assert.equal(envelope.payload.kind,'task.completed');
  assert.equal(envelope.payload.task_id,'t_open');
  assert.ok(Number.isFinite(Date.parse(envelope.payload.completed_at)));
  assert.equal(envelope.event_id,eventId);
  // 完成事实尚未送达：本地不乐观改状态，也还没有任何请求被发出。
  assert.equal(workspace.view().goals[GOAL].tasks[0].status,'open');
  assert.equal(calls.some(call=>call.path==='/events'),false);
});

test('a late history page never overwrites the cache of the goal now shown',async()=>{
  const secondGoal='g_second';
  const snapshotOf=(id,title)=>({goal:{id,domain:'custom',status:'active',currentRevision:1},
    revision:{goalId:id,revision:1,title,status:'active'},
    tasks:[{id:'t_'+id,goalId:id,content:id+' 的任务',status:'open',currentRevision:1}]});
  let releaseA;
  const gate=new Promise(resolve=>{releaseA=resolve});
  const {workspace}=setup(async input=>{
    if(input.path==='/sync'&&input.body?.tasks_page) {
      const goalId=input.body.tasks_page.goal_id;
      if(goalId===GOAL) {
        await gate;
        return {items:[],tasks_page:{items:[{id:'t_a_paged',goalId:GOAL,content:'A 的更早任务',status:'done',currentRevision:1}]}};
      }
      return {items:[],tasks_page:{items:[{id:'t_b_paged',goalId:secondGoal,content:'B 的更早任务',status:'done',currentRevision:1}]}};
    }
    if(input.path==='/sync')return {items:[
      {seq:1,userId:config.userId,kind:'goal_updated',goalId:GOAL,payload:{snapshot:snapshotOf(GOAL,'目标 A')}},
      {seq:2,userId:config.userId,kind:'goal_updated',goalId:secondGoal,payload:{snapshot:snapshotOf(secondGoal,'目标 B')}}]};
    return {acked:0};
  });
  await workspace.sync();
  workspace.select(GOAL);
  const late=workspace.loadHistoryPage();
  await new Promise(r=>setTimeout(r,10));
  workspace.select(secondGoal);
  await workspace.loadHistoryPage();
  assert.deepEqual(workspace.historyTasks().map(task=>task.id),['t_b_paged']);
  assert.equal(workspace.historyExhausted(),true);
  // A 的迟到响应放行：不得改写 B 的卡片、游标与收口状态。
  releaseA();
  await late;
  assert.deepEqual(workspace.historyTasks().map(task=>task.id),['t_b_paged']);
  assert.equal(workspace.historyExhausted(),true);
});

test('a late page from an earlier batch does not land in the reloaded cache of the same goal',async()=>{
  const secondGoal='g_second';
  const snapshotOf=(id,title)=>({goal:{id,domain:'custom',status:'active',currentRevision:1},
    revision:{goalId:id,revision:1,title,status:'active'},
    tasks:[{id:'t_'+id,goalId:id,content:id+' 的任务',status:'open',currentRevision:1}]});
  let releaseA;
  const gate=new Promise(resolve=>{releaseA=resolve});
  let aRequests=0;
  const {workspace}=setup(async input=>{
    if(input.path==='/sync'&&input.body?.tasks_page) {
      const goalId=input.body.tasks_page.goal_id;
      if(goalId===GOAL) {
        aRequests+=1;
        if(aRequests===1) {
          await gate;
          return {items:[],tasks_page:{items:[{id:'t_a_stale',goalId:GOAL,content:'A 的旧批次任务',status:'done',currentRevision:1}]}};
        }
        return {items:[],tasks_page:{items:[{id:'t_a_fresh',goalId:GOAL,content:'A 的新批次任务',status:'done',currentRevision:1}]}};
      }
      return {items:[],tasks_page:{items:[{id:'t_b_paged',goalId:secondGoal,content:'B 的更早任务',status:'done',currentRevision:1}]}};
    }
    if(input.path==='/sync')return {items:[
      {seq:1,userId:config.userId,kind:'goal_updated',goalId:GOAL,payload:{snapshot:snapshotOf(GOAL,'目标 A')}},
      {seq:2,userId:config.userId,kind:'goal_updated',goalId:secondGoal,payload:{snapshot:snapshotOf(secondGoal,'目标 B')}}]};
    return {acked:0};
  });
  await workspace.sync();
  workspace.select(GOAL);
  const late=workspace.loadHistoryPage();
  await new Promise(r=>setTimeout(r,10));
  workspace.select(secondGoal);
  await workspace.loadHistoryPage();
  // A → B → A：A 的历史重新从头翻，旧批次的迟到响应不得落进 A 的新缓存。
  workspace.select(GOAL);
  const reloaded=workspace.loadHistoryPage();
  await reloaded;
  assert.deepEqual(workspace.historyTasks().map(task=>task.id),['t_a_fresh']);
  assert.equal(workspace.historyExhausted(),true);
  releaseA();
  await late;
  assert.deepEqual(workspace.historyTasks().map(task=>task.id),['t_a_fresh']);
  assert.equal(workspace.historyExhausted(),true);
});

test('a page sent before the target switch is ignored while the new target is still loading',async()=>{
  const secondGoal='g_second';
  const snapshotOf=(id,title)=>({goal:{id,domain:'custom',status:'active',currentRevision:1},
    revision:{goalId:id,revision:1,title,status:'active'},
    tasks:[{id:'t_'+id,goalId:id,content:id+' 的任务',status:'open',currentRevision:1}]});
  // A 的末页在途 → 切到 B，B 的响应也在途 → 切回 A，新 A 的请求在途。
  const gates=[];
  const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve});gates.push({release,promise});return gates[gates.length-1];};
  const aGate=gate(),bGate=gate(),aGate2=gate();
  let aCalls=0;
  const {workspace}=setup(async input=>{
    if(input.path==='/sync'&&input.body?.tasks_page) {
      const goalId=input.body.tasks_page.goal_id;
      if(goalId===GOAL) {
        aCalls+=1;
        await (aCalls===1?aGate:aGate2).promise;
        return {items:[],tasks_page:{items:[{id:'t_a_'+aCalls,goalId:GOAL,content:'A 的第 '+aCalls+' 批',status:'done',currentRevision:1}]}};
      }
      await bGate.promise;
      return {items:[],tasks_page:{items:[{id:'t_b_1',goalId:secondGoal,content:'B 的任务',status:'done',currentRevision:1}]}};
    }
    if(input.path==='/sync')return {items:[
      {seq:1,userId:config.userId,kind:'goal_updated',goalId:GOAL,payload:{snapshot:snapshotOf(GOAL,'目标 A')}},
      {seq:2,userId:config.userId,kind:'goal_updated',goalId:secondGoal,payload:{snapshot:snapshotOf(secondGoal,'目标 B')}}]};
    return {acked:0};
  });
  await workspace.sync();
  workspace.select(GOAL);
  const oldA=workspace.loadHistoryPage();
  await new Promise(r=>setTimeout(r,10));
  workspace.select(secondGoal);
  const pendingB=workspace.loadHistoryPage();
  await new Promise(r=>setTimeout(r,10));
  workspace.select(GOAL);
  const newA=workspace.loadHistoryPage();
  await new Promise(r=>setTimeout(r,10));
  // 只放行旧 A：新的 A 还没回来，状态必须原样不动（仍无分页结果、未收口）。
  aGate.release();
  await oldA;
  assert.deepEqual(workspace.historyTasks(),[]);
  assert.equal(workspace.historyExhausted(),false);
  // 放行 B：B 已经不是当前目标，同样不得写入。
  bGate.release();
  await pendingB;
  assert.deepEqual(workspace.historyTasks(),[]);
  assert.equal(workspace.historyExhausted(),false);
  // 放行新 A：正常写入，分页收口。
  aGate2.release();
  await newA;
  assert.deepEqual(workspace.historyTasks().map(task=>task.id),['t_a_2']);
  assert.equal(workspace.historyExhausted(),true);
});

test('the same task is not submitted twice while its completion is still queued',async()=>{
  const {workspace}=setup(input=>input.path==='/sync'?{items:[taskItem('open')]}:{acked:0});
  await workspace.sync();
  await workspace.completeTask('t_open');
  await assert.rejects(()=>workspace.completeTask('t_open'),/已提交/);
  assert.equal(pendingEvents(config).filter(item=>item.envelope.kind==='task.completed').length,1);
  assert.deepEqual([...workspace.pendingTaskCompletions()],['t_open']);
});

test('a task the server already closed cannot be completed again',async()=>{
  const {workspace}=setup(input=>input.path==='/sync'?{items:[taskItem('done')]}:{acked:0});
  await workspace.sync();
  assert.equal(workspace.view().goals[GOAL].tasks[0].status,'done');
  await assert.rejects(()=>workspace.completeTask('t_open'),/不可完成/);
  assert.equal(pendingEvents(config).filter(item=>item.envelope.kind==='task.completed').length,0);
});

test('the server sync row is what turns the task into done',async()=>{
  let served=false;
  const {workspace,calls}=setup(input=>{
    if(input.path==='/events')return {status:'accepted',event_id:input.body.event_id};
    if(input.path==='/sync'){
      const after=input.body.after_seq??0;
      if(after===0)return {items:[taskItem('open',1)]};
      return {items:served?[taskItem('done',2)]:[]};
    }
    return {acked:0};
  });
  await workspace.sync();
  assert.equal(workspace.view().goals[GOAL].tasks[0].status,'open');
  await workspace.completeTask('t_open');
  served=true;
  await workspace.sync();
  assert.equal(workspace.view().goals[GOAL].tasks[0].status,'done');
  assert.ok(calls.some(call=>call.path==='/events'));
});

test('a completion already submitted is not submitted again until the server snapshot confirms it',async()=>{
  let failing=false;
  const {workspace,calls}=setup(input=>{
    if(input.path==='/events')return {status:'accepted',event_id:input.body.event_id};
    if(input.path==='/sync'){
      if (failing) throw Error('同步暂不可用');
      const after=input.body.after_seq??0;
      return {items:after===0?[taskItem('open',1)]:[taskItem('done',2)]};
    }
    return {acked:0};
  });
  await workspace.sync();
  await workspace.completeTask('t_open');
  // 事实已受理，但随后的同步失败：快照没更新，客户端不能再次提交同一条任务的完成事实。
  failing=true;
  await workspace.sync();
  assert.deepEqual([...workspace.pendingTaskCompletions()],['t_open']);
  await assert.rejects(()=>workspace.completeTask('t_open'),/已提交/);
  assert.equal(calls.filter(call=>call.path==='/events').length,1);
  // 同步恢复后补拉：快照确认完成，台账收敛，完成键重新按状态判断。
  failing=false;
  await workspace.sync();
  assert.equal(workspace.view().goals[GOAL].tasks[0].status,'done');
  assert.deepEqual([...workspace.pendingTaskCompletions()],[]);
});

// ---- 页面层：卡片、确认层与历史任务入口 ----

let instance=0;
// 还要拒收几次（跨页面实例共享：重载后的实例接着用同一份额度）。
let refuseBudget=0;
async function pageFixture({pending=false,offline=false,refused=false,syncFails=false,completions=null,doneSnapshot=false,pagedGoalSnapshot=false,goalOnFirstPage=false,syncHangs=false,holdFirstSync=false,storage=null}={}) {
  const goal={id:GOAL,domain:'custom',status:'active',revision:1,title:'睡眠目标',metric:null,context:[],dataSources:[],
    tasks:[{id:'t_open',goalId:GOAL,status:'open',content:'睡前放下手机',revision:1},
      {id:'t_repeat',goalId:GOAL,status:'open',content:'每天快走',revision:1,scheduledAt:'2099-01-02T11:00:00Z',
        reminderPlan:{state:'scheduled',source:'agent',repeat:'daily',timezone:'Asia/Shanghai',explanation:'每天提醒我快走',wallTime:'2099-01-02T11:00:00Z'}},
      {id:'t_done',goalId:GOAL,status:'done',content:'早起的散步',revision:2}]};
  // 缓存里的迁移版本都已是最新：这样「旧条目需要回放」是唯一的回放触发条件。
  const saved={version:1,recommendationsVersion:1,conversationVersion:1,dataSourcesVersion:1,executionVersion:2,
    taskCapabilityVersion:1,resultPresentationVersion:1,userId:config.userId,cursor:3,
    activeGoalId:GOAL,conversationId:null,goals:{[GOAL]:goal},messages:{},drafts:{}};
  if(completions) saved.completions=completions;
  const fresh={'along.agent.v1':JSON.stringify({baseURL:config.baseURL,fingerprint:config.fingerprint,token:config.token}),
    ['along.event-workspace.v1:'+config.userId]:JSON.stringify(saved)};
  if(pending) fresh['along.events.pending.v1:'+config.userId]=JSON.stringify([
    {event_id:'evt_queued_one',envelope:{event_id:'evt_queued_one',schema_version:'1',event_type:'along.message',kind:'task.completed',
      occurred_at:'2026-11-27T08:00:00.000Z',timezone:'Asia/Shanghai',goal_id:GOAL,task_id:'t_open',
      payload:{event_type:'along.message',kind:'task.completed',task_id:'t_open',completed_at:'2026-11-27T08:00:00.000Z'}}}]);
  const dom=installDomStub({storage:storage??fresh});
  // 首个 /sync 挂起，等测试放行：模拟「首读未回来时用户点了完成」。
  let held=false;
  let releasePromise=Promise.resolve();
  let release=()=>{};
  if(holdFirstSync)releasePromise=new Promise(resolve=>{release=resolve;});
  const calls=[];
  window.AlongAgentBridge={request:async r=>{calls.push(r);
    if(r.path==='/connection/status')return {along:true,ready:true,eventProtocol:1,userId:config.userId};
    if(r.path==='/events'){
      if(offline)throw Error('离线');
      // 终态回执（被拒）与真机一致：桥接把非 2xx 的回执体挂在 Error.receipt 上。
      if(refused||refuseBudget>0){
        if(refuseBudget>0) refuseBudget-=1;
        const error=Error('完成事实被拒');error.receipt={status:'rejected',event_id:r.body.event_id,reason:'invalid_envelope'};throw error;}
      return {status:'accepted',event_id:r.body.event_id};}
    if(r.path==='/sync'){
      if(syncFails)throw Error('同步暂不可用');
      if(syncHangs)await new Promise(()=>{});
      if(holdFirstSync&&!held){held=true;await releasePromise;}
      if(goalOnFirstPage){
        // 目标快照在第一页，后面还有一页：清理不能等到末页。
        if((r.body?.after_seq??0)===0)return {items:[{seq:50,userId:config.userId,goalId:GOAL,kind:'goal_updated',payload:{snapshot:{
          goal:{id:GOAL,domain:'custom',status:'active',currentRevision:1},
          revision:{goalId:GOAL,revision:1,title:'睡眠目标',status:'active'},
          tasks:[{id:'t_open',goalId:GOAL,content:'睡前放下手机',status:'done',currentRevision:2}]}}}],nextCursor:'50'};
        return {items:[{seq:51,userId:config.userId,kind:'changeset_note',payload:{}}]};
      }
      if(pagedGoalSnapshot){
        // 目标快照落在第二页：第一页 50 条无关同步项 + nextCursor。
        if((r.body?.after_seq??0)===0)return {items:Array.from({length:50},(_,n)=>({seq:n+1,userId:config.userId,kind:'changeset_note',payload:{}})),nextCursor:'50'};
        return {items:[{seq:51,userId:config.userId,goalId:GOAL,kind:'goal_updated',payload:{snapshot:{
          goal:{id:GOAL,domain:'custom',status:'active',currentRevision:1},
          revision:{goalId:GOAL,revision:1,title:'睡眠目标',status:'active'},
          tasks:[{id:'t_open',goalId:GOAL,content:'睡前放下手机',status:'done',currentRevision:2}]}}}]};
      }
      // 服务端说这项任务已经完成：同步项带上服务端当前的目标快照。
      // 同步项的序号比客户端游标小：只有回放（从 0 重拉）才会拿到它，
      // 普通同步（从游标往后）拿不到——真实服务端就是这样：目标的同步项早就被确认过。
      const items=doneSnapshot?[{seq:1,userId:config.userId,goalId:GOAL,kind:'goal_updated',payload:{snapshot:{
        goal:{id:GOAL,domain:'custom',status:'active',currentRevision:1},
        revision:{goalId:GOAL,revision:1,title:'睡眠目标',status:'active'},
        tasks:[{id:'t_open',goalId:GOAL,content:'睡前放下手机',status:'done',currentRevision:2}]}}}]:[];
      return {items,...(r.body?.tasks_page?{tasks_page:{items:[{id:'t_older',goalId:GOAL,content:'更早的历史任务',status:'done',currentRevision:1}]}}:{})};}
    if(r.path==='/sync/ack')return {acked:0};
    throw Error(r.path);},notification:async()=>({})};
  await import('../web/app.mjs?task-completion='+ ++instance);
  await new Promise(r=>setTimeout(r,30));
  return {dom,calls,release:()=>release()};
}
const sheetClick=dataset=>document.querySelector('#sheet').dispatch('click',{target:{closest:()=>({dataset})}});
// 重载页面：把本地存储原样带过去，模拟刷新／重新进入。
const STORAGE_KEYS=['along.agent.v1','along.event-workspace.v1:'+config.userId,
  'along.events.pending.v1:'+config.userId,'along.events.failed.v1:'+config.userId];
const reloadedStorage=dom=>Object.fromEntries(STORAGE_KEYS.map(key=>[key,dom.storage.get(key)]).filter(([,value])=>value!==null));

test('the open task carries a completion key while the done task does not',async()=>{
  const {dom}=await pageFixture();
  const open=dom.app.innerHTML.split('id="event-task-t_open"')[1].split('</article>')[0];
  assert.match(open,/data-action="event-task-complete" data-task-id="t_open"/);
  // 动态任务只列 open；已完成的只在历史任务里。
  assert.doesNotMatch(dom.app.innerHTML,/早起的散步/);
  assert.match(dom.app.innerHTML,/data-action="event-task-history"/);
  await dom.click({action:'event-task-history'});
  assert.match(dom.app.innerHTML,/历史任务/);
  const done=dom.app.innerHTML.split('id="event-task-t_done"')[1].split('</article>')[0];
  assert.doesNotMatch(done,/event-task-complete/);
  assert.match(done,/已完成/);
  assert.doesNotMatch(dom.app.innerHTML,/睡前放下手机/);
  await dom.click({action:'event-task-history-back'});
  assert.match(dom.app.innerHTML,/动态任务/);
});

test('a queued completion hides the key so the same task is not submitted twice',async()=>{
  const {dom}=await pageFixture({pending:true,offline:true});
  const open=dom.app.innerHTML.split('id="event-task-t_open"')[1].split('</article>')[0];
  assert.doesNotMatch(open,/event-task-complete/);
});

test('cancelling the confirmation sends nothing and keeps the task as it was',async()=>{
  const {dom,calls}=await pageFixture();
  await dom.click({action:'event-task-complete',taskId:'t_open'});
  assert.match(document.querySelector('#sheet').innerHTML,/确认完成/);
  const before=calls.length;
  await sheetClick({action:'event-task-complete-cancel'});
  await new Promise(r=>setTimeout(r,20));
  assert.equal(calls.length,before,'取消不发任何请求');
  assert.equal(calls.some(call=>call.path==='/events'),false);
  const open=dom.app.innerHTML.split('id="event-task-t_open"')[1].split('</article>')[0];
  assert.match(open,/待完成/);
  assert.match(open,/data-action="event-task-complete"/);
});

test('confirming sends exactly one task.completed fact',async()=>{
  const {dom,calls}=await pageFixture();
  await dom.click({action:'event-task-complete',taskId:'t_open'});
  await sheetClick({action:'event-task-complete-confirm',taskId:'t_open'});
  await new Promise(r=>setTimeout(r,50));
  const events=calls.filter(call=>call.path==='/events');
  assert.equal(events.length,1);
  assert.equal(events[0].body.kind,'task.completed');
  assert.equal(events[0].body.task_id,'t_open');
  assert.equal(events[0].body.goal_id,GOAL);
  assert.equal(events[0].body.payload.task_id,'t_open');
  assert.ok(Number.isFinite(Date.parse(events[0].body.payload.completed_at)));
  // 确认后按既有发送路径同型触发一次同步，状态以服务端快照为准。
  assert.ok(calls.some(call=>call.path==='/sync'));
  // 事实已提交但快照尚未确认：同一任务不再提供完成键。
  const open=dom.app.innerHTML.split('id="event-task-t_open"')[1]?.split('</article>')[0]??'';
  assert.doesNotMatch(open,/event-task-complete/);
});

test('a task the server accepted leaves the current list before the goal snapshot arrives',async()=>{
  const {dom}=await pageFixture();
  await dom.click({action:'event-task-complete',taskId:'t_open'});
  await sheetClick({action:'event-task-complete-confirm',taskId:'t_open'});
  await new Promise(r=>setTimeout(r,50));
  // 服务端已受理这条完成事实。这一版服务端不会为完成事实补发带目标快照的同步项，
  // 客户端不能因此把这一项永远留在「动态任务」里：受理成功就离开当前列表。
  assert.doesNotMatch(dom.app.innerHTML,/睡前放下手机/);
  // 其他项保持原样。
  assert.match(dom.app.innerHTML,/动态任务/);
  assert.match(dom.app.innerHTML,/每天快走/);
});

test('a completion the server refused keeps the task in the current list and lets it be submitted again',async()=>{
  const {dom}=await pageFixture({refused:true});
  await dom.click({action:'event-task-complete',taskId:'t_open'});
  await sheetClick({action:'event-task-complete-confirm',taskId:'t_open'});
  await new Promise(r=>setTimeout(r,50));
  // 终态失败：任务仍在当前列表，完成键回来，用户可以重试。
  const open=dom.app.innerHTML.split('id="event-task-t_open"')[1]?.split('</article>')[0]??'';
  assert.match(open,/待完成/);
  assert.match(open,/data-action="event-task-complete"/);
});

test('a refused completion lets the task be submitted again even while the sync stays broken',async()=>{
  const {dom,calls}=await pageFixture({refused:true,syncFails:true});
  await dom.click({action:'event-task-complete',taskId:'t_open'});
  await sheetClick({action:'event-task-complete-confirm',taskId:'t_open'});
  await new Promise(r=>setTimeout(r,50));
  // 终态拒收已经了结：任务留在当前列表，完成键立刻回来，不等同步恢复。
  const open=dom.app.innerHTML.split('id="event-task-t_open"')[1]?.split('</article>')[0]??'';
  assert.match(open,/待完成/);
  assert.match(open,/data-action="event-task-complete"/);
  const firstEventId=calls.find(call=>call.path==='/events')?.body.event_id;
  // 刷新后仍可点击重试：终态回执与完成键都只依赖本地记录，不依赖同步成功。
  const reloaded=await pageFixture({refused:true,syncFails:true,storage:reloadedStorage(dom)});
  const again=reloaded.dom.app.innerHTML.split('id="event-task-t_open"')[1]?.split('</article>')[0]??'';
  assert.match(again,/待完成/);
  assert.match(again,/data-action="event-task-complete"/);
  // 重试是新的完成事实：新的事件号，服务端据此只记一次完成。
  await reloaded.dom.click({action:'event-task-complete',taskId:'t_open'});
  await sheetClick({action:'event-task-complete-confirm',taskId:'t_open'});
  await new Promise(r=>setTimeout(r,50));
  const retried=reloaded.calls.filter(call=>call.path==='/events');
  assert.equal(retried.length,1);
  assert.notEqual(retried[0].body.event_id,firstEventId);
});

test('a rejected completion stays visible and retryable after the failure record is evicted',async()=>{
  // 1 次完成被拒 + 50 条别的终态拒收：最早的失败记录被挤出本地 50 条上限。
  refuseBudget=51;
  const {dom,calls}=await pageFixture({syncFails:true});
  await dom.click({action:'event-task-complete',taskId:'t_open'});
  await sheetClick({action:'event-task-complete-confirm',taskId:'t_open'});
  await new Promise(r=>setTimeout(r,50));
  const original=calls.find(call=>call.path==='/events').body.event_id;
  assert.equal(readEventFailures(config).some(row=>row.event_id===original),true);
  const visible=()=>dom.app.innerHTML.includes('id="event-task-t_open"');
  const clickable=()=>dom.app.innerHTML.includes('data-action="event-task-complete" data-task-id="t_open"');
  assert.equal(visible()&&clickable(),true,'被拒的完成：任务可见、可重试');
  // 别的任务再失败 50 次：这条完成事实的失败记录被挤出本地上限。
  for(let n=0;n<50;n++) {
    await queueEvent(config,{event_type:'along.user_message',occurred_at:new Date().toISOString(),timezone:'Asia/Shanghai',
      payload:{event_type:'along.user_message',text:'合成失败事件'}},{send:false});
  }
  await dom.tick(3000);
  await new Promise(r=>setTimeout(r,50));
  assert.equal(readEventFailures(config).length,50);
  assert.equal(readEventFailures(config).some(row=>row.event_id===original),false,'最早的失败记录已被淘汰');
  // 失败记录没了，这条被拒的完成事实仍然是「被拒」：任务可见、可重试。
  assert.equal(visible()&&clickable(),true,'失败记录被淘汰后任务仍可见可重试');
  // 刷新后同样可见可重试。
  const reloaded=await pageFixture({syncFails:true,storage:reloadedStorage(dom)});
  const visibleAfter=()=>reloaded.dom.app.innerHTML.includes('id="event-task-t_open"');
  const clickableAfter=()=>reloaded.dom.app.innerHTML.includes('data-action="event-task-complete" data-task-id="t_open"');
  assert.equal(visibleAfter()&&clickableAfter(),true,'刷新后任务仍可见可重试');
  // 重试获明确受理之后，这一项才从当前列表里移除。
  await reloaded.dom.click({action:'event-task-complete',taskId:'t_open'});
  await sheetClick({action:'event-task-complete-confirm',taskId:'t_open'});
  await new Promise(r=>setTimeout(r,50));
  const retried=reloaded.calls.filter(call=>call.path==='/events');
  assert.equal(retried.length,1);
  assert.notEqual(retried[0].body.event_id,original,'重试是新的完成事实');
  assert.equal(visibleAfter(),false,'受理之后这一项离开当前列表');
});

test('a lost receipt is retried with the same event id so the completion is not counted twice',async()=>{
  const dom=installDomStub();
  const sent=[];
  window.AlongAgentBridge={request:async input=>{
    if(input.path==='/events'){
      sent.push(input.body.event_id);
      if(sent.length===1)throw Error('回执丢失');
      return {status:'duplicate',event_id:input.body.event_id};}
    if(input.path==='/sync')return {items:[taskItem('open')]};
    return {acked:0};}};
  const workspace=createEventWorkspace({config});
  await workspace.sync();
  await workspace.completeTask('t_open');
  await workspace.sync();
  // 回执丢失：事实留在待发队列里，等下一次投递。
  assert.equal(pendingEvents(config).length,1);
  await workspace.sync();
  // 自动重投沿用同一份信封、同一事件号：服务端按事件号幂等，完成只记一次。
  assert.equal(sent.length,2);
  assert.equal(sent[0],sent[1]);
  assert.equal(pendingEvents(config).length,0);
  assert.ok(workspace.acceptedTaskCompletions().has('t_open'));
});

test('an old completion entry without a receipt keeps the task visible and retryable',async()=>{
  // 旧缓存（更早的客户端写的）：完成事实的条目没有 outcome，也没有待发事件、没有任何受理证据。
  const legacy={t_open:{eventId:'evt_legacy_0001',goalId:GOAL,revision:1}};
  const {dom}=await pageFixture({completions:legacy});
  // 没有受理证据就不当已受理：任务必须留在当前列表，完成键必须回来。
  assert.match(dom.app.innerHTML,/睡前放下手机/);
  assert.match(dom.app.innerHTML,/data-action="event-task-complete" data-task-id="t_open"/);
  // 刷新后同样：既没有被藏起来，完成键也在。
  const reloaded=await pageFixture({completions:legacy,storage:reloadedStorage(dom)});
  assert.match(reloaded.dom.app.innerHTML,/睡前放下手机/);
  assert.match(reloaded.dom.app.innerHTML,/data-action="event-task-complete" data-task-id="t_open"/);
});

test('an old completion entry converges to the server snapshot when the server says the task is done',async()=>{
  // 旧缓存里的完成条目没有结果，而服务端已经把这项任务写成完成：回放一次同步拿到服务端
  // 当前的目标快照，这项任务就该退出当前列表，也不该被再提交一次。
  const legacy={t_open:{eventId:'evt_legacy_0001',goalId:GOAL,revision:1}};
  const {dom}=await pageFixture({completions:legacy,doneSnapshot:true});
  await new Promise(r=>setTimeout(r,80));
  assert.doesNotMatch(dom.app.innerHTML,/睡前放下手机/,'服务端说已完成，这项任务退出当前列表');
  const cache=JSON.parse(dom.storage.get('along.event-workspace.v1:'+config.userId));
  assert.deepEqual(cache.completions,{},'服务端确认完成后台账一并清掉');
});

test('an old completion entry the server still reports as open stays retryable and stops replaying',async()=>{
  // 服务端说这项任务还没完成：结果不明，保持可见可重试；收敛之后不再反复回放。
  const legacy={t_open:{eventId:'evt_legacy_0001',goalId:GOAL,revision:1}};
  const {dom,calls}=await pageFixture({completions:legacy});
  await new Promise(r=>setTimeout(r,80));
  assert.match(dom.app.innerHTML,/睡前放下手机/);
  assert.match(dom.app.innerHTML,/data-action="event-task-complete" data-task-id="t_open"/);
  const cache=JSON.parse(dom.storage.get('along.event-workspace.v1:'+config.userId));
  assert.equal(cache.completions.t_open.outcome,'unknown');
  const syncs=calls.filter(call=>call.path==='/sync').length;
  await dom.tick(3000);
  await new Promise(r=>setTimeout(r,50));
  assert.equal(calls.filter(call=>call.path==='/sync').length-syncs,1,'收敛之后不再回放');
});

test('the replay keeps paging until the goal snapshot shows up on a later page',async()=>{
  // 目标同步项落在第二页：回放必须按 nextCursor 接着取，跳回旧游标就永远读不到它。
  const legacy={t_open:{eventId:'evt_legacy_0001',goalId:GOAL,revision:1}};
  const {dom}=await pageFixture({completions:legacy,pagedGoalSnapshot:true});
  await new Promise(r=>setTimeout(r,120));
  assert.doesNotMatch(dom.app.innerHTML,/睡前放下手机/,'第二页的目标快照同样能收敛');
});

test('a receipt that confirms the completion landed drops the other queued facts for that task',async()=>{
  // 台账记着的那条旧事实已经送达（回执丢了，旧信封还在队列里），用户又提交了一条新的。
  // 旧事实的回执说服务端早就收过这一件：排队里那条新的完成事实不必再送达。
  const legacy={t_open:{eventId:'evt_old_0001',goalId:GOAL,revision:1}};
  const cached={version:1,recommendationsVersion:1,conversationVersion:1,dataSourcesVersion:1,executionVersion:2,
    taskCapabilityVersion:1,resultPresentationVersion:1,userId:config.userId,cursor:3,activeGoalId:GOAL,
    conversationId:null,goals:{[GOAL]:{id:GOAL,domain:'custom',status:'active',revision:1,title:'睡眠目标',metric:null,
      context:[],dataSources:[],tasks:[{id:'t_open',goalId:GOAL,content:'睡前放下手机',status:'open',revision:1}]}},messages:{},drafts:{},
    completions:legacy};
  installDomStub({storage:{'along.agent.v1':JSON.stringify(config),['along.event-workspace.v1:'+config.userId]:JSON.stringify(cached)}});
  const envelope=(eventId)=>({event_type:'along.message',kind:'task.completed',event_id:eventId,occurred_at:'2026-11-27T08:00:00.000Z',
    timezone:'Asia/Shanghai',goal_id:GOAL,task_id:'t_open',
    payload:{event_type:'along.message',kind:'task.completed',task_id:'t_open',completed_at:'2026-11-27T08:00:00.000Z'}});
  await queueEvent(config,envelope('evt_old_0001'),{send:false});
  await queueEvent(config,envelope('evt_new_0001'),{send:false});
  assert.equal(pendingEvents(config).length,2);
  window.AlongAgentBridge={request:async input=>{
    if(input.path==='/events')return {status:'duplicate',event_id:input.body.event_id};
    if(input.path==='/sync')return {items:[]};
    return {acked:0};}};
  const workspace=createEventWorkspace({config});
  await workspace.sync();
  // 旧事实的回执确认服务端已受理：排队里那条新的完成事实当场清掉，不会变成第二次完成。
  assert.equal(pendingEvents(config).length,0);
});

test('the queued completion is cleared when the goal snapshot shows the task is done on an earlier page',async()=>{
  // 首读挂起时用户点完成；放行后第一页就是目标的 done 快照、后面还有一页：
  // 读完这一页就知道服务端已经完成，排队里那条完成事实当场清掉，不能等到末页才清。
  const legacy={t_open:{eventId:'evt_legacy_0001',goalId:GOAL,revision:1}};
  const {dom,calls,release}=await pageFixture({completions:legacy,goalOnFirstPage:true,holdFirstSync:true});
  await dom.click({action:'event-task-complete',taskId:'t_open'});
  await sheetClick({action:'event-task-complete-confirm',taskId:'t_open'});
  await new Promise(r=>setTimeout(r,60));
  assert.equal(calls.filter(call=>call.path==='/events').length,0,'状态未确认前不投递完成事实');
  assert.equal(pendingEvents(config).length,1,'完成事实先留在队列里等核对');
  release();
  await new Promise(r=>setTimeout(r,120));
  assert.equal(pendingEvents(config).length,0,'服务端说完成，排队里那条完成事实当场清掉');
  assert.doesNotMatch(dom.app.innerHTML,/睡前放下手机/);
});

test('a completion queued while the state is unconfirmed is not delivered until the state is known',async()=>{
  // 首次读取挂起：用户点完成时状态还没核对过，这条完成事实不能先送达——否则服务端会记成第二次完成。
  const legacy={t_open:{eventId:'evt_legacy_0001',goalId:GOAL,revision:1}};
  const {dom,calls}=await pageFixture({completions:legacy,syncHangs:true});
  await new Promise(r=>setTimeout(r,60));
  await dom.click({action:'event-task-complete',taskId:'t_open'});
  await sheetClick({action:'event-task-complete-confirm',taskId:'t_open'});
  await new Promise(r=>setTimeout(r,60));
  assert.equal(calls.filter(call=>call.path==='/events').length,0,'状态未确认前不投递完成事实');
  assert.equal(pendingEvents(config).length,1,'完成事实留在队列里，等核对结果');
});

test('an old completion entry whose event is still queued stays pending on its original event id',async()=>{
  // 旧条目、事实还在待发队列里：仍算待处理（不重复提交），队列里保留原事件号。
  const legacy={t_open:{eventId:'evt_queued_one',goalId:GOAL,revision:1}};
  const {dom}=await pageFixture({pending:true,offline:true,completions:legacy});
  const open=dom.app.innerHTML.split('id="event-task-t_open"')[1]?.split('</article>')[0]??'';
  assert.doesNotMatch(open,/event-task-complete/,'仍在队列里：同一任务不重复提交');
  assert.match(dom.app.innerHTML,/睡前放下手机/,'仍在队列里不等于已受理，任务留在当前列表');
  assert.equal(pendingEvents(config)[0].event_id,'evt_queued_one','队列里保留原事件号');
});

test('the queued fact the ledger already records is still re-sent as it is',async()=>{
  // 台账记着的那条旧事实：服务端可能已经收过（按事件号幂等，同号重投不会变成第二次完成），
  // 照常送达；用户重新提交、换了事件号的那条才需要等核对。
  const legacy={t_open:{eventId:'evt_queued_one',goalId:GOAL,revision:1}};
  const {dom,calls}=await pageFixture({pending:true,completions:legacy});
  await new Promise(r=>setTimeout(r,60));
  const events=calls.filter(call=>call.path==='/events');
  assert.equal(events.length,1,'台账记着的那条旧事实照常送达');
  assert.equal(events[0].body.event_id,'evt_queued_one','沿用原事件号与原信封');
});

test('a recurring task stays in the current list because only this occurrence is completed',async()=>{
  const {dom}=await pageFixture();
  await dom.click({action:'event-task-complete',taskId:'t_repeat'});
  await sheetClick({action:'event-task-complete-confirm',taskId:'t_repeat'});
  await new Promise(r=>setTimeout(r,50));
  // 周期任务完成的是「本次」：服务端续排、任务仍是 open，它必须留在当前列表里。
  assert.match(dom.app.innerHTML,/每天快走/);
});

test('an accepted completion stays out of the current list after the page is reloaded',async()=>{
  const dom=installDomStub();
  window.AlongAgentBridge={request:async input=>{
    if(input.path==='/events')return {status:'accepted',event_id:input.body.event_id};
    if(input.path==='/sync')return {items:[taskItem('open')]};
    return {acked:0};}};
  const workspace=createEventWorkspace({config});
  await workspace.sync();
  await workspace.completeTask('t_open');
  await workspace.sync();
  // 服务端受理了完成事实，但这一版服务端不为完成事实补发目标快照：快照里任务仍是 open。
  assert.equal(workspace.view().goals[GOAL].tasks[0].status,'open');
  assert.ok(workspace.acceptedTaskCompletions().has('t_open'));
  // 重新载入（同一份本地缓存）：完成事实仍在台账里，这项任务不回到当前列表。
  const reopened=createEventWorkspace({config});
  assert.ok(reopened.acceptedTaskCompletions().has('t_open'));
});

test('the confirmation copy matches the recurring behaviour instead of promising a move to history',async()=>{
  const {dom}=await pageFixture();
  await dom.click({action:'event-task-complete',taskId:'t_repeat'});
  const copy=document.querySelector('#sheet').innerHTML;
  assert.match(copy,/继续按原计划续排/);
  assert.doesNotMatch(copy,/移入历史任务/);
});

test('the history entry pages past the bounded snapshot and reaches the oldest completed task',async()=>{
  const {dom,calls}=await pageFixture();
  await dom.click({action:'event-task-history'});
  await new Promise(r=>setTimeout(r,60));
  const pageCall=calls.find(call=>call.path==='/sync'&&call.body?.tasks_page);
  assert.ok(pageCall,'历史入口按需翻页取回更早的任务');
  assert.equal(pageCall.body.tasks_page.goal_id,GOAL);
  assert.equal(pageCall.body.tasks_page.status,'done');
  assert.match(dom.app.innerHTML,/更早的历史任务/);
  assert.match(dom.app.innerHTML,/早起的散步/);
  // 翻到尽头后不再提供翻页入口。
  assert.doesNotMatch(dom.app.innerHTML,/event-task-history-more/);
});

test('a paged history card opens its own detail and returns to the same history list',async()=>{
  const {dom}=await pageFixture();
  await dom.click({action:'event-task-history'});
  await new Promise(r=>setTimeout(r,60));
  // 分页加载出来的历史卡片不在目标快照里：点「查看详情」要打开它自己的详情。
  await dom.click({action:'event-task-detail',taskId:'t_older'});
  assert.match(dom.app.innerHTML,/class="content event-task-detail"/);
  assert.match(dom.app.innerHTML,/更早的历史任务/);
  assert.match(dom.app.innerHTML,/返回历史任务/);
  // 返回时回到同一目标的历史列表，分页结果仍在。
  await dom.click({action:'event-task-back'});
  assert.match(dom.app.innerHTML,/历史任务/);
  assert.match(dom.app.innerHTML,/更早的历史任务/);
  assert.doesNotMatch(dom.app.innerHTML,/class="content event-task-detail"/);
  // 快照内的历史卡片同样能打开详情，并回到动态任务列表。
  await dom.click({action:'event-task-detail',taskId:'t_done'});
  assert.match(dom.app.innerHTML,/class="content event-task-detail"/);
  assert.match(dom.app.innerHTML,/早起的散步/);
  await dom.click({action:'event-task-back'});
  assert.match(dom.app.innerHTML,/历史任务/);
});
