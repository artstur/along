import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {createEventWorkspace} from '../web/event-workspace.mjs';
import {recommendation} from './recommendation-fixture.mjs';
const config={userId:'u_research',baseURL:'https://localhost:4176',fingerprint:'a'.repeat(64),token:'b'.repeat(64)};
const snapshot={goal:{id:'g_research',domain:'custom',status:'active',currentRevision:1},revision:{goalId:'g_research',revision:1,title:'运动安排',status:'active'},tasks:[
  {id:'t_research',goalId:'g_research',status:'open',content:'周五查天气安排周末徒步',currentRevision:1},
  {id:'t_sleep',goalId:'g_research',status:'open',content:'按原计划准备睡觉',currentRevision:2,scheduledAt:'2099-01-01T17:30:00Z'}]};
const message=(rec=recommendation())=>({seq:1,userId:config.userId,kind:'message',goalId:'g_research',taskId:'t_research',payload:{snapshot,recommendation:rec,
  notification:{event_id:'reply_research',kind:'recommendation_ready',revision:1},
  message:{id:'msg_result',eventId:'reply_research',role:'assistant',direction:'outbound',text:'已找到方案',seq:1}}});

test('recommendations survive sync, duplicate delivery and offline reopening without modifying tasks or reminders',async()=>{
  installDomStub();window.AlongAgentBridge={request:async input=>input.path==='/sync'?{items:input.body.after_seq?[]:[message()]}:{acked:1}};
  const w=createEventWorkspace({config});await w.sync();
  const original=w.view().goals.g_research.tasks;assert.equal(w.view().messages[0].recommendation.options.length,1);
  assert.equal(w.view().messages[0].taskId,'t_research');await w.sync();assert.equal(w.view().messages.length,1);
  w.select('g_research');assert.equal(w.prepareRecommendationFeedback('reply_research'),true);
  window.AlongAgentBridge.request=async()=>{throw Error('offline');};
  const reopened=createEventWorkspace({config});await reopened.sync();
  assert.deepEqual(reopened.view().goals.g_research.tasks,original);
  assert.match(reopened.draft(),/周末徒步方案/);assert.equal(reopened.view().messages[0].recommendation.sources[0].url,'https://www.gz.gov.cn/route');
  let sent;
  window.AlongAgentBridge.request=async input=>{
    if(input.path==='/events'){sent=input.body;return {status:'accepted',event_id:sent.event_id};}
    if(input.path==='/sync')return {items:[]};return {acked:1};
  };
  await reopened.submit('我更想走短一点的路线');await reopened.sync();
  assert.equal(sent.event_type,'along.user_message');assert.equal(sent.goal_id,'g_research');assert.equal(sent.task_id,'t_research');
  assert.deepEqual(reopened.view().goals.g_research.tasks,original);
});

test('invalid optional evidence cannot block legacy message sync or destroy saved goals',async()=>{
  installDomStub();const invalid=recommendation();invalid.sources[0].url='https://127.0.0.1/private';
  window.AlongAgentBridge={request:async input=>input.path==='/sync'?{items:input.body.after_seq?[]:[message(invalid)]}:{acked:1}};
  const w=createEventWorkspace({config});await w.sync();assert.equal(w.view().cursor,1);
  assert.equal(w.view().messages[0].text,'已找到方案');assert.equal(w.view().messages[0].recommendation,undefined);
  assert.equal(w.view().goals.g_research.tasks.length,2);
  assert.equal(w.prepareRecommendationFeedback('reply_research'),false);
});

test('feedback cannot bind a recommendation from a different goal or resurrect a cancelled task',async()=>{
  installDomStub();window.AlongAgentBridge={request:async input=>input.path==='/sync'?{items:input.body.after_seq?[]:[message()]}:{acked:1}};
  const w=createEventWorkspace({config});await w.sync();
  w.select(null);assert.equal(w.prepareRecommendationFeedback('reply_research'),false);
  w.select('g_research');assert.equal(w.prepareRecommendationFeedback('reply_research'),true);
  const key='along.event-workspace.v1:'+config.userId,saved=JSON.parse(localStorage.getItem(key));
  saved.goals.g_research.tasks[0].status='cancelled';localStorage.setItem(key,JSON.stringify(saved));
  const reopened=createEventWorkspace({config});let sent;
  window.AlongAgentBridge.request=async input=>{
    if(input.path==='/events'){sent=input.body;return {status:'accepted',event_id:sent.event_id};}return input.path==='/sync'?{items:[]}:{acked:1};
  };
  await reopened.submit('改成室内活动');await reopened.sync();assert.equal(sent.task_id,undefined);assert.equal(sent.goal_id,'g_research');
});
