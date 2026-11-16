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

test('upgrading an older client rehydrates already-acknowledged recommendations once without duplicate alerts or lost drafts',async()=>{
  const goal={id:'g_research',domain:'custom',status:'active',revision:1,title:'运动安排',metric:null,context:[],tasks:[
    {id:'t_research',goalId:'g_research',status:'open',content:'周五查天气安排周末徒步',revision:1},
    {id:'t_sleep',goalId:'g_research',status:'open',content:'按原计划准备睡觉',revision:2,scheduledAt:'2099-01-01T17:30:00Z'}]};
  const old={version:1,userId:config.userId,cursor:10,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},drafts:{'goal:g_research':'保留原草稿'},
    messages:{reply_research:{eventId:'reply_research',role:'assistant',text:'已找到方案',goalId:goal.id,notificationEventId:'reply_research',status:'received'}}};
  const key='along.event-workspace.v1:'+config.userId;installDomStub({storage:{[key]:JSON.stringify(old)}});
  window.AlongAgentBridge={request:async()=>{throw Error('offline');}};
  const projections=[],w=createEventWorkspace({config,onNotifications:async p=>projections.push(p)});await w.sync();
  assert.equal(w.view().cursor,10);assert.equal(w.draft(),'保留原草稿');assert.equal(w.view().goals.g_research.tasks.length,2);
  const originalTasks=w.view().goals.g_research.tasks;
  const requests=[];window.AlongAgentBridge.request=async input=>{
    requests.push(input);return input.path==='/sync'?{items:input.body.after_seq===0?[{...message(),seq:9,createdAt:new Date().toISOString()}]:[]}:{acked:1};
  };
  await w.sync();assert.equal(w.view().cursor,10);assert.equal(w.view().messages.length,1);
  assert.equal(w.view().messages[0].recommendation.options.length,1);assert.equal(w.draft(),'保留原草稿');
  assert.deepEqual(w.view().goals.g_research.tasks,originalTasks);assert.deepEqual(projections.at(-1).results,[]);
  await w.sync();assert.deepEqual(requests.filter(r=>r.path==='/sync').map(r=>r.body.after_seq),[0,10]);
  assert.equal(JSON.parse(localStorage.getItem(key)).recommendationsVersion,1);
});


test('an interrupted upgrade replay resumes its page cursor without moving the acknowledged cursor backwards',async()=>{
  const seed={version:1,userId:config.userId,cursor:10,activeGoalId:null,conversationId:null,goals:{},messages:{},drafts:{}};
  const key='along.event-workspace.v1:'+config.userId;installDomStub({storage:{[key]:JSON.stringify(seed)}});
  const cursors=[];let interrupted=true;
  window.AlongAgentBridge={request:async input=>{
    if(input.path!=='/sync')return {acked:1};
    const after=input.body.after_seq;cursors.push(after);
    if(after===0)return {items:[{...message(null),seq:2}],nextCursor:'2'};
    if(interrupted)throw Error('connection interrupted');
    return {items:[{...message(),seq:9}]};
  }};
  const first=createEventWorkspace({config});await first.sync();
  assert.equal(first.view().cursor,10);assert.equal(JSON.parse(localStorage.getItem(key)).recommendationReplayAfter,2);
  interrupted=false;const reopened=createEventWorkspace({config});await reopened.sync();
  assert.deepEqual(cursors,[0,2,2]);assert.equal(reopened.view().cursor,10);
  assert.equal(reopened.view().messages[0].recommendation.options.length,1);
  assert.equal(JSON.parse(localStorage.getItem(key)).recommendationsVersion,1);
});
