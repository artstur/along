import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {KEY as HEALTH_KEY} from '../web/health.mjs';
import {ADAPTIVE_LAYOUTS_KEY} from '../web/adaptive-ui.mjs';
import {AGENT_KEY, CONVERSATIONS_KEY, GOALS_KEY} from '../web/agent-client.mjs';
import {PLANNING_STATE_KEY} from '../web/contextual-planning.mjs';
import {AGENT_RUNTIME_KEY, DSH_RUNTIME} from '../web/super-agent.mjs';

const TICKET_KEY='along.goal-ticket.v1';
const agentConfig={baseURL:'https://192.168.1.2:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};
const intent='平均每天睡 8 小时，11 点起床，每周运动 180 分钟';
const baseline={
  contextReviewAllowed:true,selectedTypes:['workout','sleep'],workoutMinutes:190,workoutCount:4,sleepMinutes:480,
  sleepSummary:{windowDays:7,daysWithData:7,averageMinutes:470,latestWakeAt:'2026-11-11T03:00:00Z'},
  workoutSummary:{windowDays:28,todayMinutes:25,yesterdayMinutes:45,patterns:[{activity:'yoga',weekday:1,hour:12,count:4,averageMinutes:50}]},
  capturedAt:'2026-11-11T04:00:00Z',
};
const confirmedLayout={
  version:1,title:'我的健康目标',summary:'下次提醒和周末安排',modules:[],questions:[],
  tasks:[
    {id:'wind-down',when:'今晚',title:'睡前收尾提醒',detail:'按你确认的时间提醒。',state:'planned'},
    {id:'yoga',when:'明天中午',title:'查看午间课程',detail:'结合空闲时间确认。',state:'planned'},
  ],
};

const settle=()=>new Promise(resolve=>setImmediate(resolve));
let browserInstance=0;
// Health observations and all host responses here are synthetic. The actual Web entry points
// compose the request, poll it, validate the result, render the proposal, notify and adopt it.
async function browser({initial=baseline,storage={},nativeHealth,restoreConnection}={}) {
  const dom=installDomStub({storage:{
    [HEALTH_KEY]:JSON.stringify({version:1,source:'healthkit',snapshot:initial,
      goals:[{id:'weekly',type:'workout',target:180}]}),
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:confirmedLayout}),
    [GOALS_KEY]:JSON.stringify({health:{title:'我的健康目标',intent}}),
    [AGENT_KEY]:JSON.stringify(agentConfig),[AGENT_RUNTIME_KEY]:DSH_RUNTIME,
    ...storage,
  }});
  if (nativeHealth) window.AlongHealthBridge=nativeHealth;
  window.dispatchEvent=event=>dom.fireWindow(event.type,event);
  const submits=[],polls=[],notifications=[],reminderSets=[];
  window.AlongAgentBridge={
    ...(restoreConnection?{connection:restoreConnection}:{}),
    request({path,body}) {
      if (path==='/connection/status') return Promise.resolve({along:true,runtime:DSH_RUNTIME,ready:true});
      const calls=path==='/super-agent/goals'?submits:path==='/super-agent/goals/status'?polls:null;
      if (!calls) throw Error('unexpected Agent route '+path);
      return new Promise((resolve,reject)=>calls.push({body,resolve,reject}));
    },
    async notification(action,payload) {
      if (action==='replaceHealthReminders') {
        reminderSets.push(payload.items);
        return {scheduledCount:payload.items.length};
      }
      if (action==='notify') notifications.push(payload);
      return {scheduled:true};
    },
  };
  await import('../web/app.mjs?context-test='+ ++browserInstance);
  return {...dom,submits,polls,notifications,reminderSets,
    observe:detail=>dom.fireWindow('along-health-update',{detail:structuredClone(detail)}),
    read:key=>JSON.parse(dom.storage.get(key)),
    poll:async()=>{await dom.tick(3000);await settle();},
  };
}

function resultFor(request,decision='keep',{title='改到下一次晚间空档',tasks}={}) {
  const revise=decision==='revise';
  const old=confirmedLayout.tasks;
  const replacement=tasks??[old[0],{...old[1],title}];
  const changes=revise?old.flatMap(t=>{
    const changed=replacement.find(n=>n.id===t.id);
    if (!changed) return [{taskId:t.id,operation:'cancel',reason:'移除这次尚未执行的安排。'}];
    return changed.title!==t.title?[{taskId:t.id,operation:'update',reason:'可用时段已有变化。'}]:[];
  }):[];
  return {reply:decision==='need_data'?'明天提前起床是临时安排吗？':'已检查最新记录。',
    proposal:null,layout:revise?{...confirmedLayout,tasks:replacement}:null,
    reassessment:{decision,basedOnRevision:request.snapshot.planning.revisionId,
      reason:'根据最新观测重新核对已确认安排。',changes,nextReviewAt:null,watchFor:[]}};
}
function hostRun(request,result=null) {
  return {kind:'goal',runtime:DSH_RUNTIME,actual:true,requestId:request.requestId,
    source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'情境观察'},
    agents:[],assignments:[],events:[],ticket:{id:'test-ticket'},result,
    status:result?'done':'working',statusLabel:result?'已完成':'执行中',createdAt:Date.now()};
}
function answer(call,result) { call.resolve({run:hostRun(call.body,result)}); }

test('new observations coalesce behind one real run and its stale revision never surfaces',async()=>{
  const app=await browser();
  const first=app.observe({...baseline,workoutMinutes:200});
  assert.equal(app.submits.length,1);
  const old=app.submits[0];
  answer(old,null);
  await first;
  await app.observe({...baseline,workoutMinutes:210});
  await app.observe({...baseline,workoutMinutes:225,sleepMinutes:345});
  assert.equal(app.submits.length,1,'one ongoing review for this goal');
  await app.poll();
  assert.equal(app.polls[0].body.requestId,old.body.requestId);
  app.polls[0].resolve(hostRun(old.body,resultFor(old.body,'revise',{title:'过时的课程建议'})));
  await settle();
  assert.equal(app.submits.length,2,'one follow-up review with the latest combined context');
  assert.deepEqual(app.notifications,[]);
  assert.doesNotMatch(app.app.innerHTML,/过时的课程建议/);
  const latest=app.submits[1];
  assert.equal(latest.body.snapshot.workoutMinutes,225);
  assert.equal(latest.body.snapshot.sleepMinutes,345);
  assert.notEqual(latest.body.requestId,old.body.requestId);
  answer(latest,resultFor(latest.body));
  await settle();
  assert.equal(app.read(TICKET_KEY),null);
  assert.deepEqual(app.notifications,[]);
});

test('declining an in-flight proposal keeps the old plan after its delayed reply',async()=>{
  const app=await browser();
  const observation=app.observe({...baseline,sleepMinutes:345});
  assert.equal(app.submits.length,1);
  await app.click({action:'dismiss-task'});
  assert.equal(app.read(TICKET_KEY),null);
  const review=app.submits[0];
  answer(review,resultFor(review.body,'revise'));
  await observation;
  assert.equal(app.read(TICKET_KEY),null);
  assert.equal(app.read(ADAPTIVE_LAYOUTS_KEY).health.tasks[1].title,'查看午间课程');
  assert.deepEqual(app.notifications,[]);
});

test('every selected health signal can reach DSH independently; duplicate reads and keep stay quiet',async()=>{
  let current=structuredClone(baseline);
  const app=await browser();
  for (const [field,change] of [
    ['workoutMinutes',191], ['sleepMinutes',335],
    ['sleepSummary',{...baseline.sleepSummary,latestWakeAt:'2026-11-11T01:00:00Z'}],
    ['workoutSummary',{...baseline.workoutSummary,patterns:[{...baseline.workoutSummary.patterns[0],hour:19}]}],
  ]) {
    const count=app.submits.length;
    const previous=current;
    current={...current,[field]:change};
    const observation=app.observe(current);
    assert.equal(app.submits.length,count+1,field+' should reach the Agent');
    const review=app.submits[count];
    assert.equal(review.body.runtime,DSH_RUNTIME);
    assert.deepEqual(review.body.snapshot.planning.changes,[field]);
    assert.equal(review.body.snapshot.planning.previous.workoutMinutes,previous.workoutMinutes);
    assert.match(review.body.snapshot.planning.goalIntent,/11 点起床/);
    assert.deepEqual(review.body.snapshot.planning.currentPlan.tasks.map(t=>t.id),['wind-down','yoga']);
    answer(review,resultFor(review.body));
    await observation;
    await app.observe({...current,capturedAt:'2026-11-11T05:00:00Z'});
    assert.equal(app.submits.length,count+1);
    assert.equal(app.read(TICKET_KEY),null);
  }
  assert.deepEqual(app.notifications,[]);
});

test('a temporary status read failure is retried on the same run and a confirmed revision surfaces the actual changed task',async()=>{
  const app=await browser();
  const observation=app.observe({...baseline,sleepMinutes:350});
  const review=app.submits[0];
  answer(review,null);
  await observation;
  await app.poll();
  app.polls[0].reject(Error('临时断线'));
  await settle();
  await app.poll();
  assert.equal(app.polls[1].body.requestId,review.body.requestId);
  app.polls[1].resolve(hostRun(review.body,resultFor(review.body,'revise')));
  await settle();
  assert.equal(app.submits.length,1);
  assert.equal(app.notifications.length,1);
  assert.match(app.notifications[0].body,/改到下一次晚间空档/);
  assert.doesNotMatch(app.notifications[0].body,/睡前收尾提醒/);
  assert.equal(app.read(ADAPTIVE_LAYOUTS_KEY).health.tasks[1].title,'查看午间课程');
  await app.click({action:'accept-task'});
  assert.deepEqual(app.read(ADAPTIVE_LAYOUTS_KEY).health.tasks.map(t=>t.title),['睡前收尾提醒','改到下一次晚间空档']);
  assert.equal(app.read(TICKET_KEY),null);
});

test('a replan that cancels every task is adoptable',async()=>{
  const app=await browser();
  const observation=app.observe({...baseline,sleepMinutes:305});
  const review=app.submits[0];
  answer(review,resultFor(review.body,'revise',{tasks:[]}));
  await observation;
  assert.match(app.app.innerHTML,/data-action="accept-task"/);
  assert.equal(app.read(ADAPTIVE_LAYOUTS_KEY).health.tasks.length,2);
  await app.click({action:'accept-task'});
  assert.deepEqual(app.read(ADAPTIVE_LAYOUTS_KEY).health.tasks,[]);
});

test('adopting and cancelling a dated reminder replaces only the accepted reminder set',async()=>{
  const app=await browser();
  const scheduledFor=new Date(Date.now()+3*3600_000).toISOString();
  const reminder={...confirmedLayout.tasks[0],kind:'reminder',scheduledFor,title:'按新作息收尾'};
  const newSchedule=app.observe({...baseline,sleepMinutes:380});
  const review=app.submits[0];
  answer(review,resultFor(review.body,'revise',{tasks:[reminder,confirmedLayout.tasks[1]]}));
  await newSchedule;
  assert.deepEqual(app.reminderSets,[],'a proposed reminder is not yet scheduled');
  await app.click({action:'accept-task'});
  await settle();
  assert.equal(app.reminderSets.length,1);
  assert.deepEqual(app.reminderSets[0].map(({id,taskId,scheduledFor,requestId})=>({id,taskId,scheduledFor,requestId})),
    [{id:'wind-down',taskId:'wind-down',scheduledFor,requestId:review.body.requestId}]);

  const cancellation=app.observe({...baseline,sleepMinutes:335});
  const nextReview=app.submits[1];
  answer(nextReview,resultFor(nextReview.body,'revise',{tasks:[confirmedLayout.tasks[1]]}));
  await cancellation;
  assert.equal(app.reminderSets.length,1,'the current reminder remains in force while the new plan is pending');
  await app.click({action:'accept-task'});
  await settle();
  assert.deepEqual(app.reminderSets[1],[],'accepting cancellation explicitly clears previously scheduled reminders');
  assert.deepEqual(app.read(ADAPTIVE_LAYOUTS_KEY).health.tasks.map(t=>t.id),['yoga']);
});

test('need_data exposes the actual question and preserves the existing tasks',async()=>{
  const app=await browser();
  const observation=app.observe({...baseline,sleepSummary:{...baseline.sleepSummary,daysWithData:1}});
  const review=app.submits[0];
  answer(review,resultFor(review.body,'need_data'));
  await observation;
  assert.match(app.app.innerHTML,/明天提前起床是临时安排吗/);
  assert.equal(app.read(ADAPTIVE_LAYOUTS_KEY).health.tasks.length,2);
  assert.doesNotMatch(app.app.innerHTML,/data-action="accept-task"/);
  assert.match(app.app.innerHTML,/id="health-review-answer"/);
  const submission=app.app.dispatch('submit',{target:{id:'health-review-answer',fields:{answer:'只改明天'},querySelector:()=>null,reset(){}},preventDefault(){}});
  await settle();
  const answerRequest=app.submits[1];
  assert.match(JSON.stringify(answerRequest.body.snapshot.planning),/只改明天/);
  assert.match(JSON.stringify(answerRequest.body.snapshot.planning),/明天提前起床是临时安排吗/,'the Agent receives its actual question alongside this follow-up');
  answer(answerRequest,resultFor(answerRequest.body));
  await submission;
});

test('a locally generated or simulated run cannot deliver a health revision',async()=>{
  const app=await browser();
  const observation=app.observe({...baseline,sleepMinutes:345});
  const review=app.submits[0];
  review.resolve({run:{...hostRun(review.body,resultFor(review.body,'revise')),version:1,actual:false}});
  await observation;
  assert.equal(app.read(PLANNING_STATE_KEY).run.status,'blocked');
  assert.equal(app.read(ADAPTIVE_LAYOUTS_KEY).health.tasks[1].title,'查看午间课程');
  assert.deepEqual(app.notifications,[]);
  assert.doesNotMatch(app.app.innerHTML,/data-action="accept-task"/);
});

test('a review time chosen by the Agent triggers a fresh review when the visible app has no new HealthKit signal',async t=>{
  const now=Date.parse('2026-11-11T04:00:00Z');
  t.mock.timers.enable({apis:['Date'],now});
  const app=await browser();
  document.visibilityState='visible';
  const observation=app.observe({...baseline,sleepMinutes:345});
  const review=app.submits[0];
  const decision=resultFor(review.body);
  decision.reassessment.nextReviewAt='2026-11-11T04:05:00Z';
  answer(review,decision);
  await observation;
  t.mock.timers.setTime(now+240_000);
  await app.tick(60_000);
  assert.equal(app.submits.length,1);
  t.mock.timers.setTime(now+300_000);
  await app.tick(60_000);
  assert.equal(app.submits.length,2);
  assert.equal(app.submits[1].body.snapshot.planning.cause,'review');
  assert.deepEqual(app.submits[1].body.snapshot.planning.changes,[]);
  answer(app.submits[1],resultFor(app.submits[1].body));
  await settle();
  assert.deepEqual(app.notifications,[]);
});

test('revoking a data type also redacts it from the previous observation submitted to the Agent',async()=>{
  const app=await browser();
  const observation=app.observe({...baseline,selectedTypes:['workout'],workoutMinutes:230});
  const review=app.submits[0];
  assert.equal(review.body.snapshot.sleepMinutes,null);
  assert.equal(review.body.snapshot.planning.previous.sleepMinutes,null);
  assert.equal(review.body.snapshot.planning.previous.sleepSummary,null);
  answer(review,resultFor(review.body));
  await observation;
});

test('a legacy or unapproved health import cannot originate a new contextual review',async()=>{
  const legacy={...baseline};
  delete legacy.contextReviewAllowed;
  const app=await browser({initial:legacy});
  const observation=app.observe({...legacy,workoutMinutes:240});
  assert.equal(app.submits.length,0);
  await observation;
});

test('narrowing consent isolates old free text and identifiers while preserving accepted tasks on device',async()=>{
  const privateText='旧睡眠观测为 317 分钟';
  const privateTask={...confirmedLayout.tasks[0],id:'sleep-317',detail:privateText};
  const app=await browser({storage:{
    [GOALS_KEY]:JSON.stringify({health:{title:privateText,intent}}),
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:{...confirmedLayout,summary:privateText,tasks:[privateTask]}}),
    [CONVERSATIONS_KEY]:JSON.stringify({health:[{role:'assistant',text:privateText}]}),
  }});
  const observation=app.observe({...baseline,selectedTypes:['workout']});
  const review=app.submits[0];
  assert.doesNotMatch(JSON.stringify(review.body),/旧睡眠观测为 317 分钟|sleep-317/);
  const [retained]=review.body.snapshot.planning.currentPlan.tasks;
  assert.notEqual(retained.id,privateTask.id);
  const extra={...confirmedLayout.tasks[1],title:'下班后选一堂课'};
  const result=resultFor(review.body);
  result.layout={...confirmedLayout,tasks:[retained,extra]};
  result.reassessment={...result.reassessment,decision:'revise',changes:[{taskId:extra.id,operation:'add',reason:'根据刚收到的运动记录。'}]};
  answer(review,result);
  await observation;
  await app.click({action:'accept-task'});
  assert.deepEqual(app.read(ADAPTIVE_LAYOUTS_KEY).health.tasks,[privateTask,extra]);
  await app.click({action:'edit-goal'});
  const submission=app.submit();
  await settle();
  const explicit=app.submits[1];
  assert.doesNotMatch(JSON.stringify(explicit.body),/旧睡眠观测为 317 分钟|sleep-317/);
  assert.match(JSON.stringify(app.read(CONVERSATIONS_KEY).health),/317/,'the local chat history still exists');
  answer(explicit,{reply:'收到目标',proposal:null,layout:null});
  await submission;
});

test('an explicit goal submitted before expanded consent shares only an already selected workout total',async()=>{
  for (const [selection,expected] of [
    [['workout','sleep'],{selectedTypes:['workout'],workoutMinutes:190}],
    [['sleep'],{selectedTypes:[],workoutMinutes:null}],
    ['not-workout',{selectedTypes:[],workoutMinutes:null}],
  ]) {
    const initial={...baseline,selectedTypes:selection,contextReviewAllowed:false};
    const app=await browser({initial});
    await app.click({action:'edit-goal'});
    const submission=app.submit();
    await settle();
    const review=app.submits[0];
    assert.deepEqual(review.body.snapshot,expected);
    answer(review,{reply:'收到目标',proposal:null,layout:null});
    await submission;
  }
});

test('a blocked health review offers an explicit retry after the connection recovers',async()=>{
  const app=await browser();
  const latest={...baseline,sleepMinutes:340};
  const observation=app.observe(latest);
  app.submits[0].reject(Error('DSH 暂不可用'));
  await observation;
  assert.match(app.app.innerHTML,/data-action="retry-health-review"/);
  assert.equal(app.read(PLANNING_STATE_KEY).run.status,'blocked');
  await app.observe(latest);
  assert.equal(app.submits.length,1,'unchanged failed context must not spin');
  const retry=app.click({action:'retry-health-review'});
  assert.equal(app.submits.length,2);
  answer(app.submits[1],resultFor(app.submits[1].body));
  await retry;
  await settle();
  assert.equal(app.read(TICKET_KEY),null);
});

test('an approved existing goal receives a first assessment on the first unchanged native observation',async()=>{
  const app=await browser();
  const observation=app.observe(baseline);
  assert.equal(app.submits.length,1);
  assert.match(app.app.innerHTML,/<div class="review-in-progress"><span role="status">正在评估当前任务<\/span><button[^>]+data-action="dismiss-task"/,'a pending review appears once with the option to retain the plan');
  assert.doesNotMatch(app.app.innerHTML,/正在规划下一步/);
  const review=app.submits[0];
  assert.match(review.body.snapshot.planning.goalIntent,/11 点起床/);
  answer(review,resultFor(review.body));
  await observation;
  await app.observe(baseline);
  assert.equal(app.submits.length,1);
  assert.match(app.app.innerHTML,/保留当前安排/);
});

test('connected legacy health imports show how to enable assessment in their existing source card',async()=>{
  const app=await browser({initial:{...baseline,contextReviewAllowed:false}});
  assert.match(app.app.innerHTML,/启用任务评估/);
  assert.equal(app.submits.length,0);
});

test('a saved personal health goal binds explicitly and owns its revision even when the user changes goals',async()=>{
  const key='custom:my-health-plan',other='custom:my-japanese';
  const app=await browser({storage:{
    'along.active-goal.v1':key,
    [GOALS_KEY]:JSON.stringify({[key]:{title:'未来 12 周健康计划',intent},[other]:{title:'日语 N5'}}),
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:confirmedLayout,[key]:{...confirmedLayout,title:'未来 12 周健康计划'},[other]:{...confirmedLayout,title:'日语 N5'}}),
  }});
  assert.match(app.app.innerHTML,/允许此目标使用所选摘要/);
  assert.equal(app.submits.length,0);
  await app.click({action:'link-goal-health'});
  const review=app.submits[0];
  assert.equal(review.body.goal.domain,'custom');
  assert.equal(review.body.goal.title,'未来 12 周健康计划');
  assert.match(review.body.snapshot.planning.goalIntent,/11 点起床/);
  await app.app.dispatch('change',{target:{id:'goal-select',value:other}});
  assert.doesNotMatch(app.app.innerHTML,/正在评估|允许此目标使用所选摘要/);
  answer(review,resultFor(review.body,'revise'));
  await settle();
  assert.doesNotMatch(app.app.innerHTML,/改到下一次晚间空档/);
  assert.equal(app.notifications[0].goalKey,key);
  await app.fireWindow('along-notification-open',{detail:app.notifications[0]});
  assert.match(app.app.innerHTML,/采用调整后的安排/);
  await app.click({action:'accept-task'});
  const layouts=app.read(ADAPTIVE_LAYOUTS_KEY);
  assert.equal(layouts[key].tasks[1].title,'改到下一次晚间空档');
  assert.equal(layouts.health.tasks[1].title,'查看午间课程');
  assert.equal(layouts[other].tasks[1].title,'查看午间课程');
});

test('native disconnect blocks cached assessments and gives the user a source action before stale tasks',async()=>{
  const app=await browser({nativeHealth:{async refresh(){throw Object.assign(Error('尚未选择 Apple Health'),{code:'health_not_connected'});}}});
  document.visibilityState='visible';
  await settle();
  await app.tick(60_000);
  assert.equal(app.submits.length,0);
  const section=app.app.innerHTML.slice(app.app.innerHTML.indexOf('aria-label="动态任务"'));
  assert.ok(section.indexOf('连接 Apple Health')>=0&&section.indexOf('连接 Apple Health')<section.indexOf('睡前收尾提醒'));
  assert.doesNotMatch(section,/class="source-tag real">已连接/);
  assert.match(section,/查看|已有|上次|当前/);
});

test('a native observation arriving before Keychain restoration is reviewed immediately when pairing returns',async()=>{
  let restore;
  const waiting=new Promise(resolve=>{restore=resolve;});
  const app=await browser({storage:{[AGENT_KEY]:'{}'},restoreConnection:()=>waiting,nativeHealth:{async refresh(){return baseline;}}});
  assert.equal(app.submits.length,0);
  restore(agentConfig);
  await settle();
  assert.equal(app.submits.length,1);
  answer(app.submits[0],resultFor(app.submits[0].body));
  await settle();
});

test('a task detail-only revision shows the actual before and after values',async()=>{
  const app=await browser();
  const observation=app.observe({...baseline,sleepMinutes:320});
  const review=app.submits[0];
  const detail='优先安排早上的轻松散步，留出午间休息。';
  const next={...confirmedLayout.tasks[1],detail};
  const reply=resultFor(review.body,'revise',{tasks:[confirmedLayout.tasks[0],next]});
  reply.reassessment.changes=[{taskId:next.id,operation:'update',reason:'按昨夜的恢复情况调整。'}];
  answer(review,reply);
  await observation;
  assert.match(app.app.innerHTML,/优先安排早上的轻松散步/);
  assert.match(app.app.innerHTML,/结合空闲时间确认。/);
});

test('a goal created through the dropdown can connect HealthKit without granting other goals access',async()=>{
  const app=await browser({storage:{
    [HEALTH_KEY]:JSON.stringify({version:1,source:null,snapshot:null,goals:[]}),
  },nativeHealth:{async connect(){return structuredClone(baseline);}}});
  await app.app.dispatch('change',{target:{id:'goal-select',value:'new-custom'}});
  const key=app.storage.get('along.active-goal.v1');
  const submission=app.app.dispatch('submit',{target:{id:'agent-form',fields:{message:intent},querySelector:()=>null,reset(){},setAttribute(){}},preventDefault(){}});
  await settle();
  const first=app.submits[0];
  assert.deepEqual(first.body.snapshot,{});
  const title='未来 12 周睡眠和运动计划';
  answer(first,{reply:'已整理你的目标。',proposal:{title,target:null,task:'安排午间运动',reason:'结合工作时间安排。'},layout:{...confirmedLayout,title}});
  await submission;
  assert.match(app.app.innerHTML,/data-action="link-goal-health"/);
  await app.click({action:'link-goal-health'});
  await settle();
  assert.deepEqual(app.submits.slice(1).map(c=>c.body.goal.title),[title]);
  const review=app.submits[1];
  assert.match(review.body.snapshot.planning.goalIntent,/11 点起床/);
  answer(review,resultFor(review.body));
  await settle();
  assert.deepEqual(app.read(GOALS_KEY)[key].healthTypes,['workout','sleep']);
  await app.app.dispatch('change',{target:{id:'goal-select',value:'health'}});
  await app.click({action:'edit-goal'});
  const edit=app.submit();
  await settle();
  const unlinked=app.submits.at(-1);
  assert.equal(unlinked.body.snapshot.workoutMinutes??null,null);
  assert.equal(unlinked.body.snapshot.contextReviewAllowed,undefined);
  answer(unlinked,{reply:'已收到。',proposal:null,layout:null});
  await edit;
});

test('a detached goal retains its privacy restrictions when opening a task and sending a message',async()=>{
  const key='custom:detached';
  const app=await browser({storage:{
    'along.active-goal.v1':key,
    [GOALS_KEY]:JSON.stringify({[key]:{title:'旧睡眠记录 317 分钟',healthTypes:[]}}),
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({[key]:confirmedLayout}),
    ['along.health-sharing.v1:'+key]:JSON.stringify({localGoalTitle:true,localPlanText:true,tasks:[{id:'yoga',alias:'masked',localText:true}]}),
  }});
  await app.click({action:'open-task',taskId:'yoga'});
  assert.match(app.app.innerHTML,/之前的健康授权范围/);
  await app.click({action:'task-back'});
  await app.click({action:'edit-goal'});
  const submission=app.submit();
  await settle();
  const request=app.submits[0];
  assert.doesNotMatch(JSON.stringify({goal:request.body.goal,snapshot:request.body.snapshot,message:request.body.message,history:request.body.history}),/旧睡眠记录|317/);
  answer(request,{reply:'已收到。',proposal:null,layout:null});
  await submission;
});

test('a restored unacknowledged health request is recovered once after a verified Mac connection',async()=>{
  const first=await browser();
  void first.observe(baseline);
  const id=first.submits[0].body.requestId;
  const restarted=await browser({storage:Object.fromEntries(first.store),nativeHealth:{async refresh(){return baseline;}}});
  await settle();
  assert.equal(restarted.submits.length,1);
  assert.equal(restarted.submits[0].body.requestId,id,'the host can reuse a ticket that was accepted before the interruption');
  restarted.submits[0].reject(Error('The network connection was lost.'));
  await settle();
  document.visibilityState='visible';
  await restarted.tick(60_000);
  await restarted.click({action:'edit-goal'});
  await settle();
  assert.equal(restarted.submits.length,1,'an unsuccessful automatic recovery does not spin');
  const again=await browser({storage:Object.fromEntries(restarted.store),nativeHealth:{async refresh(){return baseline;}}});
  await settle();
  assert.equal(again.submits.length,0,'restarting again must not repeatedly resubmit the same failed recovery');
});

test('a verified reconnection recovers an explicit transport failure without reviving dismissals or rejected outputs',async()=>{
  for (const [error,dismissed,expected] of [
    ['代理未能连接到 Mac。请确认当前代理或 VPN 允许 Along 直连局域网，再重试评估。',false,1],
    ['iPhone 未能验证 Mac 的安全连接。若使用代理或 VPN，请允许 Along 直连局域网后重试。',false,1],
    ['连接 Mac 失败。请让 iPhone 和 Mac 接入可互访的网络，并确认 Mac 上的 Along 服务正在运行。若 Mac 地址变了，请到「编辑目标」更新地址后重试。',false,1],
    ['The operation couldn’t be completed. (kCFErrorDomainCFNetwork error 310.)',false,1],
    ['iPhone 到 Mac 的安全连接被代理或 VPN 改写，请允许 Along 直连局域网后重试',false,1],
    ['iPhone 到 Mac 的安全连接被代理或 VPN 改写，请允许 Along 直连局域网后重试',true,0],
    ['Agent 未给出有效的情境判断',false,0],
  ]) {
    const app=await browser();
    const first=app.observe(baseline);
    app.submits[0].reject(Error(error));
    await first;
    if (dismissed) await app.click({action:'dismiss-task'});
    await app.click({action:'edit-goal'});
    await settle();
    assert.equal(app.submits.length,1+expected);
    if (expected) {
      const recovery=app.submits[1];
      assert.equal(recovery.body.requestId,app.submits[0].body.requestId);
      answer(recovery,resultFor(recovery.body));
      await settle();
      assert.equal(app.read(TICKET_KEY),null);
    }
  }
});

const protectedGoalKey='along.health-sharing.v1';
const protectedPlan={...confirmedLayout,title:'十二周健康计划',summary:'仅本地的旧计划说明',
  modules:[{kind:'chips',id:'constraints',title:'条件',items:['晚班后吃饭']}],
  tasks:[{...confirmedLayout.tasks[0],title:'旧睡眠任务',id:'private-sleep-317'},
         {...confirmedLayout.tasks[1],title:'旧训练任务',id:'private-yoga-48'}]};
const restrictedStorage={
  [GOALS_KEY]:JSON.stringify({health:{title:'十二周健康计划',intent:'每周运动 180 分钟；午间有空'}}),
  [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:protectedPlan}),
  [CONVERSATIONS_KEY]:JSON.stringify({health:[{role:'user',text:'之前的私人聊天内容',localOnly:true}]}),
  [protectedGoalKey]:JSON.stringify({localGoalTitle:true,localPlanText:true,tasks:protectedPlan.tasks.map((t,i)=>({id:t.id,alias:'private-task-'+i,localText:true}))}),
};
async function chooseReviewContent(app,keys) {
  await app.click({action:'review-access'});
  const panel=document.querySelector('#sheet');
  const fields=Object.fromEntries(keys.map(key=>['allow-'+key,'on']));
  await panel.dispatch('submit',{target:{id:'review-access-form',fields},preventDefault(){}});
  await settle();
  return panel.innerHTML;
}

test('a user can preview exactly which existing goal fields and tasks to use for this goal’s reviews',async()=>{
  const app=await browser({storage:restrictedStorage});
  assert.match(app.app.innerHTML,/data-action="review-access"/);
  const panel=await chooseReviewContent(app,['title','intent','module-constraints','task-private-task-0']);
  assert.match(panel,/晚班后吃饭/);
  assert.match(panel,/旧训练任务/);
  assert.doesNotMatch(panel,/之前的私人聊天内容/);
  const review=app.submits[0];
  assert.equal(review.body.goal.title,'十二周健康计划');
  assert.match(review.body.snapshot.planning.goalIntent,/每周运动 180 分钟/);
  assert.match(review.body.snapshot.planning.goalIntent,/晚班后吃饭/);
  assert.equal(review.body.snapshot.planning.weeklyWorkoutMinutes,180);
  assert.equal(review.body.goal.target,180);
  assert.deepEqual(review.body.snapshot.planning.protectedTaskIds,['private-task-1']);
  assert.match(JSON.stringify(review.body),/旧睡眠任务/);
  assert.doesNotMatch(JSON.stringify(review.body),/private-sleep-317|private-yoga-48|旧训练任务|之前的私人聊天内容|仅本地的旧计划说明/);
  answer(review,resultFor(review.body));
  await settle();
  assert.match(app.app.innerHTML,/最近评估/);
  assert.match(app.app.innerHTML,/查看任务[\s\S]+最近评估[\s\S]+已检查最新记录。/);
  await app.observe(baseline);
  assert.equal(app.submits.length,1);
  await app.click({action:'edit-goal'});
  const explicit=app.submit();
  await settle();
  assert.doesNotMatch(JSON.stringify(app.submits[1].body),/十二周健康计划|午间有空|晚班后吃饭|旧睡眠任务|之前的私人聊天内容/);
  answer(app.submits[1],{reply:'收到',proposal:null,layout:null});
  await explicit;
});

test('revoking review fields invalidates an in-flight result and forgets derived review text before retry and restart',async()=>{
  const app=await browser({storage:restrictedStorage});
  await chooseReviewContent(app,['title','intent','task-private-task-0']);
  const previous=app.submits[0];
  assert.ok(previous);
  await chooseReviewContent(app,[]);
  answer(previous,resultFor(previous.body,'need_data'));
  await settle();
  assert.equal(app.submits.length,2);
  const current=app.submits[1];
  assert.notEqual(current.body.requestId,previous.body.requestId);
  assert.equal(current.body.goal.target,null);
  assert.equal(current.body.snapshot.planning.weeklyWorkoutMinutes,null);
  assert.deepEqual(current.body.snapshot.planning.protectedTaskIds,['private-task-0','private-task-1']);
  assert.doesNotMatch(JSON.stringify(current.body),/十二周健康计划|午间有空|旧睡眠任务|旧训练任务/);
  current.reject(Error('The network connection was lost.'));
  await settle();
  const restarted=await browser({storage:Object.fromEntries(app.store),nativeHealth:{async refresh(){return baseline;}}});
  await settle();
  assert.doesNotMatch(JSON.stringify(restarted.submits[0].body),/十二周健康计划|午间有空|旧睡眠任务|旧训练任务/);
  answer(restarted.submits[0],resultFor(restarted.submits[0].body));
  await settle();
  assert.deepEqual(restarted.read(ADAPTIVE_LAYOUTS_KEY).health.tasks,protectedPlan.tasks);
});

test('a protected plan duration does not become a weekly exercise target in a health assessment',async()=>{
  const app=await browser({storage:{...restrictedStorage,
    [HEALTH_KEY]:JSON.stringify({version:1,source:'healthkit',snapshot:baseline,goals:[{id:'weekly',type:'workout',target:12}]}),
    [GOALS_KEY]:JSON.stringify({health:{title:'未来 12 周健康计划',intent:'先试 12 周'}}),
  }});
  const first=app.observe(baseline);
  const review=app.submits[0];
  assert.equal(review.body.goal.target,null);
  assert.equal(review.body.snapshot.planning.weeklyWorkoutMinutes,null);
  answer(review,resultFor(review.body));
  await first;
});

test('a proposal derived from review-only content cannot leak through opening its changed or added tasks',async()=>{
  const app=await browser({storage:restrictedStorage});
  await chooseReviewContent(app,['intent','task-private-task-0']);
  const first=app.submits[0], request=first.body;
  const [allowed,withheld]=request.snapshot.planning.currentPlan.tasks;
  const replacement={...allowed,title:'按私人目标提前结束'};
  const added={...confirmedLayout.tasks[1],id:'new-private',title:'午间按私人与会约束安排'};
  const reason='根据只授权给评估的目标调整。';
  const result={reply:reason,proposal:null,layout:{...confirmedLayout,tasks:[replacement,withheld,added]},reassessment:{
    decision:'revise',basedOnRevision:request.requestId,reason,changes:[
      {taskId:allowed.id,operation:'update',reason},{taskId:added.id,operation:'add',reason}],nextReviewAt:null,watchFor:[]}};
  answer(first,result);await settle();
  await app.click({action:'accept-task'});
  const [changed,kept,newTask]=app.read(ADAPTIVE_LAYOUTS_KEY).health.tasks;
  assert.equal(changed.title,replacement.title);
  assert.deepEqual(kept,protectedPlan.tasks[1]);
  for (const task of [changed,newTask]) {
    await app.click({action:'open-task',taskId:task.id});
    assert.match(app.app.innerHTML,/仅保存在本机|限此目标评估/);
    await app.click({action:'task-back'});
  }
  const observation=app.observe({...baseline,workoutMinutes:210});
  const next=app.submits.at(-1);
  assert.notEqual(next.body.requestId,request.requestId);
  assert.doesNotMatch(JSON.stringify(next.body.snapshot.planning.recentDecisions),/根据只授权给评估的目标调整/);
  answer(next,resultFor(next.body));
  await observation;
});

test('adopting after a newly proposed reminder has expired keeps the old plan and requests a fresh review',async()=>{
  const app=await browser();
  const scheduledFor=new Date(Date.now()+3_600_000).toISOString();
  const reminder={...confirmedLayout.tasks[0],kind:'reminder',scheduledFor,title:'按新作息收尾'};
  const observation=app.observe({...baseline,sleepMinutes:380});
  const review=app.submits[0];
  answer(review,resultFor(review.body,'revise',{tasks:[reminder,confirmedLayout.tasks[1]]}));
  await observation;
  assert.match(app.app.innerHTML,/data-action="accept-task"/);
  const realNow=Date.now;
  try {
    Date.now=()=>Date.parse(scheduledFor)+60_000;
    await app.click({action:'accept-task'});
    await settle();
    assert.deepEqual(app.read(ADAPTIVE_LAYOUTS_KEY).health.tasks,confirmedLayout.tasks);
    assert.deepEqual(app.reminderSets,[]);
    assert.equal(app.submits.length,2);
    const next=app.submits[1];
    assert.notEqual(next.body.requestId,review.body.requestId);
    answer(next,resultFor(next.body));
    await settle();
    assert.equal(app.read(TICKET_KEY),null);
  } finally {Date.now=realNow;}
});

test('weekly exercise minutes use only selected, unambiguous goal or task evidence including legacy plan summaries',async()=>{
  const cases=[
    {selected:['summary'],summary:'未来12周，以睡眠为主。每周运动至少160分钟。',expected:160},
    {selected:['task-private-task-0'],title:'累计运动至少160分钟',detail:'这是本周的运动目标。',expected:160},
    {selected:['summary','task-private-task-0'],summary:'每周运动至少160分钟。',title:'本周运动目标是180分钟',expected:null},
    {selected:['summary'],summary:'每周睡眠回顾120分钟。本周运动已经完成90分钟。',expected:null},
    {selected:['summary'],summary:'每周运动120到160分钟。',expected:null},
  ];
  for (const {selected,summary='仅留本机的摘要',title='旧睡眠任务',detail='按原时间执行。',expected} of cases) {
    const plan={...protectedPlan,summary,tasks:[{...protectedPlan.tasks[0],title,detail},protectedPlan.tasks[1]]};
    const app=await browser({storage:{...restrictedStorage,
      [GOALS_KEY]:JSON.stringify({health:{title:'未来12周健康计划',intent:''}}),
      [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:plan}),
    }});
    await chooseReviewContent(app,selected);
    const review=app.submits[0];
    assert.equal(review.body.snapshot.planning.weeklyWorkoutMinutes,expected,summary+' '+title);
    assert.equal(review.body.goal.target,expected);
    answer(review,resultFor(review.body));
    await settle();
  }
});
