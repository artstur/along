import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanHealthContext,healthContextChanges,createPlanningContext,validateReassessment} from '../web/contextual-planning.mjs';
import {setSnapshot,initialState} from '../web/health.mjs';

// Synthetic observations test the transport contract, not the quality of a live Agent's judgment.
const baseline={selectedTypes:['sleep','workout'],workoutMinutes:210,sleepMinutes:480,
  capturedAt:'2026-11-11T04:00:00Z',sleepSummary:{windowDays:7,daysWithData:7,averageMinutes:470,
    latestNightMinutes:480,latestWakeAt:'2026-11-11T03:00:00Z'},
  workoutSummary:{windowDays:28,todayMinutes:90,yesterdayMinutes:30,patterns:[{activity:'yoga',weekday:1,hour:12,count:4,recentCount:1,averageMinutes:45}]}};
const oldTask={id:'yoga',when:'明天中午',title:'练习瑜伽',detail:'使用已经确认的时段。',state:'planned'};
const planning=createPlanningContext({before:baseline,after:baseline,goalIntent:'睡眠 8 小时，11 点起床，每周运动 180 分钟',
  currentPlan:{title:'健康',tasks:[oldTask]},revisionId:'review-1',now:new Date('2026-11-11T04:00:00Z')});

test('all contextual signals reach the Agent even after the weekly exercise goal is met',()=>{
  for (const patch of [
    {workoutMinutes:211}, {sleepMinutes:300},
    {sleepSummary:{...baseline.sleepSummary,latestWakeAt:'2026-11-11T01:00:00Z'}},
    {workoutSummary:{...baseline.workoutSummary,patterns:[{...baseline.workoutSummary.patterns[0],hour:19,recentCount:3}]}},
    {workoutMinutes:0,workoutSummary:{...baseline.workoutSummary,weekStartAt:'2026-11-15T16:00:00Z'}},
  ]) assert.ok(healthContextChanges(baseline,{...baseline,...patch}).length>0);
  assert.deepEqual(healthContextChanges(baseline,{...baseline,capturedAt:'2026-11-11T04:01:00Z'}),[]);
});

test('only selected aggregates cross the boundary, with unknown values preserved',()=>{
  const context=cleanHealthContext({...baseline,selectedTypes:['workout'],rawSamples:[{secret:'sample'}],sleepMinutes:0});
  assert.equal(context.sleepMinutes,null);
  assert.equal(context.sleepSummary,null);
  assert.equal(context.rawSamples,undefined);
  assert.equal(cleanHealthContext({selectedTypes:'workout',workoutMinutes:12}).workoutMinutes,null);
  assert.equal(cleanHealthContext({selectedTypes:['sleep'],sleepMinutes:null}).sleepMinutes,null);
  const state=setSnapshot(initialState(),baseline,'healthkit');
  assert.equal(state.snapshot.workoutSummary.patterns[0].activity,'yoga');
  assert.equal(state.snapshot.sleepSummary.daysWithData,7);
  assert.equal(state.snapshot.capturedAt,baseline.capturedAt);
});

test('Agent may keep a plan or ask for data without fabricating replacement tasks',()=>{
  for (const decision of ['keep','need_data']) {
    const result=validateReassessment({decision,basedOnRevision:'review-1',reason:'需结合近期变化再判断',changes:[],nextReviewAt:null},null,planning);
    assert.equal(result.decision,decision);
  }
});

test('a revision explains actual task changes and belongs to the current context',()=>{
  const layout={tasks:[{...oldTask,title:'改到周末练习'}]};
  const answer={decision:'revise',basedOnRevision:'review-1',reason:'综合近期运动量和睡眠情况，重新安排时段。',
    changes:[{taskId:'yoga',operation:'update',reason:'保留运动偏好，调整时间。'}],nextReviewAt:'2026-11-12T11:00:00+08:00'};
  assert.equal(validateReassessment(answer,layout,planning).changes[0].operation,'update');
  assert.throws(()=>validateReassessment({...answer,basedOnRevision:'old'},layout,planning),/版本/);
  assert.throws(()=>validateReassessment({...answer,changes:[]},layout,planning),/未解释/);
  assert.throws(()=>validateReassessment({...answer,nextReviewAt:'2026-11-10T00:00:00Z'},layout,planning),/复查/);
  assert.throws(()=>validateReassessment({...answer,decision:'keep'},layout,planning),/不能替换/);
});

test('a consent-scoped bedtime request can ask for timing and then propose a future reminder beside an unchanged private task',()=>{
  const privateTask={id:'private-1',title:'本机保留的任务',detail:'任务内容来自旧授权范围，请保留。',when:'已安排',state:'planned'};
  const evening={...planning,goalIntent:'希望睡前收到提醒',timezone:'Asia/Shanghai',localDate:'2026-11-11',
    now:'2026-11-11T15:00:00Z',protectedTaskIds:[privateTask.id],currentPlan:{title:'健康',tasks:[privateTask]}};
  const decision={basedOnRevision:evening.revisionId,reason:'需要本人确认今晚的提醒时间',changes:[],nextReviewAt:null};
  assert.equal(validateReassessment({...decision,decision:'need_data'},null,evening).decision,'need_data');
  const answered={...evening,recentDecisions:[{decision:'feedback',feedback:'过了零点的 00:20 提醒我准备睡觉'}]};
  const task={id:'bedtime-nov12',kind:'reminder',title:'准备睡觉',detail:'按你选的时间提醒。',
    when:'今晚过零点后',scheduledFor:'2026-11-12T00:20:00+08:00',state:'planned'};
  const proposal={...decision,decision:'revise',changes:[{taskId:task.id,operation:'add',reason:'采用用户刚回复的时刻。'}]};
  const review=next=>validateReassessment(proposal,{tasks:[privateTask,next]},answered);
  assert.equal(review(task).changes[0].operation,'add');
  assert.throws(()=>review({...task,scheduledFor:'2026-11-11T00:20:00+08:00'}),/未来时间/);
  assert.throws(()=>review({...task,scheduledFor:'2026-11-12T00:20:00'}),/时间|时区/);
  assert.equal(validateReassessment({...decision,decision:'keep',reason:'同一晚已有已采用的提醒。'},null,
    {...answered,currentPlan:{title:'健康',tasks:[privateTask,task]}}).decision,'keep');
});
