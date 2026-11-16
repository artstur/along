import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {safeWorkspaceGoal, createEventWorkspace} from '../web/event-workspace.mjs';

const config={userId:'u_plan',baseURL:'https://localhost:4176',fingerprint:'a'.repeat(64),token:'b'.repeat(64)};
const plan={state:'scheduled',source:'agent',explanation:'提前半小时开始准备',repeat:'daily',timezone:'Asia/Shanghai'};
const snapshot=(reminderPlan=plan,scheduledAt='2099-01-01T17:30:00.000Z')=>({
  goal:{id:'g_plan',domain:'custom',status:'active',currentRevision:1},
  revision:{goalId:'g_plan',revision:1,title:'按时休息',status:'active'},
  tasks:[{id:'t_plan',goalId:'g_plan',content:'休息前整理物品',status:'open',currentRevision:1,...(scheduledAt==null?{}:{scheduledAt}),reminderPlan}],
});

test('validated reminder intent survives sync and offline restart and reaches the existing iOS channel',async()=>{
  installDomStub();const batches=[];
  const item={seq:1,userId:config.userId,kind:'task_updated',goalId:'g_plan',payload:{snapshot:snapshot()}};
  window.AlongAgentBridge={request:async input=>input.path==='/sync'?{items:input.body.after_seq?[]:[item]}:{acked:1}};
  const workspace=createEventWorkspace({config,onNotifications:async batch=>batches.push(batch)});
  await workspace.sync();
  assert.deepEqual(workspace.view().goals.g_plan.tasks[0].reminderPlan,plan);
  assert.deepEqual(batches[0].reminders[0],{goalId:'g_plan',taskId:'t_plan',revision:1,scheduledAt:'2099-01-01T17:30:00.000Z',
    body:'休息前整理物品',repeat:'daily',timezone:'Asia/Shanghai'});
  const reopened=createEventWorkspace({config,onNotifications:async batch=>batches.push(batch)});
  assert.deepEqual(reopened.view().goals.g_plan.tasks[0].reminderPlan,plan);
  await reopened.sync();assert.deepEqual(batches[1].reminders,batches[0].reminders);
});

test('elapsed recurring anchors stay in the authoritative queue while one-time and legacy elapsed reminders expire',async()=>{
  installDomStub();const batches=[];
  const old='2020-01-01T17:30:00.000Z';let seq=1;
  const base=snapshot(plan,old);
  base.tasks.push({...base.tasks[0],id:'t_once',reminderPlan:{...plan,repeat:'once'}},
    {...base.tasks[0],id:'t_legacy',reminderPlan:undefined});
  let page=[{seq,userId:config.userId,kind:'task_updated',goalId:'g_plan',payload:{snapshot:base}}];
  window.AlongAgentBridge={request:async input=>input.path==='/sync'?{items:page.filter(item=>item.seq>input.body.after_seq)}:{acked:1}};
  const workspace=createEventWorkspace({config,onNotifications:async batch=>batches.push(batch)});
  await workspace.sync();assert.deepEqual(batches.at(-1).reminders.map(row=>row.taskId),['t_plan']);
  await workspace.sync();assert.deepEqual(batches.at(-1).reminders.map(row=>row.taskId),['t_plan']);
  const changed=structuredClone(base);changed.tasks[0].status='done';
  page=[{seq:++seq,userId:config.userId,kind:'task_updated',goalId:'g_plan',payload:{snapshot:changed}}];
  await workspace.sync();assert.deepEqual(batches.at(-1).reminders,[]);
});

test('invalid plans lose their schedule while preserving the goal and task content',()=>{
  const bad=[{...plan,timezone:'Planet/Mars'},{...plan,repeat:'monthly'},{...plan,source:'model'},
    {...plan,explanation:{}},{...plan,repeat:'weekly'},{...plan,repeat:'weekly',weekday:0},
    {...plan,weekday:2},{state:'needs_time',question:'什么时候？'},{state:'off',reason:'opt_out'}];
  for (const value of bad) {
    const task=safeWorkspaceGoal(snapshot(value)).tasks[0];
    assert.equal(task.reminderPlan,undefined);assert.equal(task.scheduledAt,undefined);
    assert.equal(task.content,'休息前整理物品');
  }
  assert.equal(safeWorkspaceGoal(snapshot(plan,null)).tasks[0].reminderPlan,undefined);
  const legacy={...plan};delete legacy.timezone;
  assert.deepEqual(safeWorkspaceGoal(snapshot(legacy)).tasks[0].reminderPlan,legacy);
  assert.deepEqual(safeWorkspaceGoal(snapshot({state:'off',reason:'opt_out'},null)).tasks[0].reminderPlan,{state:'off',reason:'opt_out'});
});

test('weekly timezone and original civil clock reach iOS while a legacy plan cannot invent repetition',async()=>{
  installDomStub();const batches=[];
  const weekly={...plan,repeat:'weekly',weekday:1,timezone:'America/New_York',wallTime:'2099-01-05T06:30:00.000Z'};
  const at='2099-01-05T06:30:00.000Z'; // Monday at 01:30 in New York.
  const data=snapshot(weekly,at);
  const legacy={...weekly};delete legacy.timezone;delete legacy.wallTime;
  data.tasks.push({...data.tasks[0],id:'t_legacy_plan',reminderPlan:legacy});
  window.AlongAgentBridge={request:async input=>input.path==='/sync'?{items:input.body.after_seq?[]:[
    {seq:1,userId:config.userId,kind:'task_updated',goalId:'g_plan',payload:{snapshot:data}}]}:{acked:1}};
  await createEventWorkspace({config,onNotifications:async batch=>batches.push(batch)}).sync();
  const [current,old]=batches[0].reminders;
  assert.equal(current.weekday,1);assert.equal(current.timezone,'America/New_York');assert.equal(current.wallTime,weekly.wallTime);
  assert.equal(old.repeat,undefined);assert.equal(old.timezone,undefined);assert.equal(old.scheduledAt,at);
});

test('off, cancellation and a rescheduled recurrence reconcile the same task identity',async()=>{
  installDomStub();const batches=[];let seq=1;
  let data=snapshot();
  let page=[{seq,userId:config.userId,kind:'task_updated',goalId:'g_plan',payload:{snapshot:data}}];
  window.AlongAgentBridge={request:async input=>input.path==='/sync'?{items:page.filter(item=>item.seq>input.body.after_seq)}:{acked:1}};
  const workspace=createEventWorkspace({config,onNotifications:async batch=>batches.push(batch)});
  await workspace.sync();
  data=snapshot({...plan,explanation:'调整后的准备时间'},'2099-01-01T17:00:00.000Z');data.tasks[0].currentRevision=2;
  page=[{seq:++seq,userId:config.userId,kind:'task_updated',goalId:'g_plan',payload:{snapshot:data}}];
  await workspace.sync();
  assert.equal(batches.at(-1).reminders[0].taskId,batches[0].reminders[0].taskId);
  assert.equal(batches.at(-1).reminders[0].scheduledAt,'2099-01-01T17:00:00.000Z');
  data=snapshot({state:'off',reason:'opt_out'},null);
  page=[{seq:++seq,userId:config.userId,kind:'task_updated',goalId:'g_plan',payload:{snapshot:data}}];
  await workspace.sync();assert.deepEqual(batches.at(-1).reminders,[]);
  data=snapshot();data.tasks[0].status='cancelled';
  page=[{seq:++seq,userId:config.userId,kind:'task_updated',goalId:'g_plan',payload:{snapshot:data}}];
  await workspace.sync();assert.deepEqual(batches.at(-1).reminders,[]);assert.deepEqual(batches.at(-1).activeTasks,[]);
});

test('an unrelated wallTime cannot replace the Agent scheduled civil clock after its first occurrence',()=>{
  const bad={...plan,wallTime:'2099-01-01T01:00:00.000Z'};
  const projected=safeWorkspaceGoal(snapshot(bad)).tasks[0];
  assert.equal(projected.reminderPlan,undefined);
  assert.equal(projected.scheduledAt,undefined);
  assert.equal(projected.content,'休息前整理物品');
});

test('an original civil clock may shift only through the matching timezone DST gap',()=>{
  const spring={...plan,timezone:'America/New_York',wallTime:'2026-03-07T07:30:00.000Z'};
  assert.deepEqual(safeWorkspaceGoal(snapshot(spring,'2026-03-08T07:30:00.000Z')).tasks[0].reminderPlan,spring);
  assert.equal(safeWorkspaceGoal(snapshot(spring,'2026-03-08T08:30:00.000Z')).tasks[0].reminderPlan,undefined);
  assert.equal(safeWorkspaceGoal(snapshot(spring,'2026-03-09T07:30:00.000Z')).tasks[0].reminderPlan,undefined);
  const normal={...plan,wallTime:'2020-01-01T17:30:00.000Z'};
  assert.deepEqual(safeWorkspaceGoal(snapshot(normal)).tasks[0].reminderPlan,normal);
});
