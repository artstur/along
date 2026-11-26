// 任务完成确认与历史任务入口：完成事实的入队、确认层的取消/确认、服务端快照驱动的状态。
// 状态只来自服务端：客户端不乐观把卡片改成「已完成」（docs/task-detail-layout.md「任务完成确认与历史任务入口」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {createEventWorkspace} from '../web/event-workspace.mjs';
import {pendingEvents} from '../web/agent-client.mjs';

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

// ---- 页面层：卡片、确认层与历史任务入口 ----

let instance=0;
async function pageFixture({pending=false,offline=false}={}) {
  const goal={id:GOAL,domain:'custom',status:'active',revision:1,title:'睡眠目标',metric:null,context:[],dataSources:[],
    tasks:[{id:'t_open',goalId:GOAL,status:'open',content:'睡前放下手机',revision:1},
      {id:'t_done',goalId:GOAL,status:'done',content:'早起的散步',revision:2}]};
  const saved={version:1,recommendationsVersion:1,conversationVersion:1,executionVersion:2,userId:config.userId,cursor:3,
    activeGoalId:GOAL,conversationId:null,goals:{[GOAL]:goal},messages:{},drafts:{}};
  const storage={'along.agent.v1':JSON.stringify({baseURL:config.baseURL,fingerprint:config.fingerprint,token:config.token}),
    ['along.event-workspace.v1:'+config.userId]:JSON.stringify(saved)};
  if(pending) storage['along.events.pending.v1:'+config.userId]=JSON.stringify([
    {event_id:'evt_queued_one',envelope:{event_id:'evt_queued_one',schema_version:'1',event_type:'along.message',kind:'task.completed',
      occurred_at:'2026-11-27T08:00:00.000Z',timezone:'Asia/Shanghai',goal_id:GOAL,task_id:'t_open',
      payload:{event_type:'along.message',kind:'task.completed',task_id:'t_open',completed_at:'2026-11-27T08:00:00.000Z'}}}]);
  const dom=installDomStub({storage});
  const calls=[];
  window.AlongAgentBridge={request:async r=>{calls.push(r);
    if(r.path==='/connection/status')return {along:true,ready:true,eventProtocol:1,userId:config.userId};
    if(r.path==='/events'){if(offline)throw Error('离线');return {status:'accepted',event_id:r.body.event_id};}
    if(r.path==='/sync')return {items:[]};
    if(r.path==='/sync/ack')return {acked:0};
    throw Error(r.path);},notification:async()=>({})};
  await import('../web/app.mjs?task-completion='+ ++instance);
  await new Promise(r=>setTimeout(r,30));
  return {dom,calls};
}
const sheetClick=dataset=>document.querySelector('#sheet').dispatch('click',{target:{closest:()=>({dataset})}});

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
});
