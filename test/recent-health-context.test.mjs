import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {SLEEP_REMINDER_CRITERIA,agentHealthSnapshot,cleanHealthContext,cleanPlanningContext,createPlanningContext,healthContextChanges,validateReassessment} from '../web/contextual-planning.mjs';
import {initialState,setSnapshot} from '../web/health.mjs';

const previous={startAt:'2026-10-27T16:00:00Z',endAt:'2026-11-03T16:00:00Z',daysWithData:6,value:472};
const recent={startAt:previous.endAt,endAt:'2026-11-10T16:00:00Z',daysWithData:5,value:411};
const raw={contextReviewAllowed:true,comparisonHistoryAllowed:true,selectedTypes:['sleep','workout'],capturedAt:'2026-11-11T04:00:00Z',
  sleepMinutes:450,workoutMinutes:135,recentHistory:{
    sleep:{recent:{...recent,rawSamples:['unshared']},previous},
    workout:{recent:{...recent,daysWithData:2,value:140,count:3},previous:{...previous,daysWithData:1,value:40,count:1}},
    weight:{recent:{...recent,value:61},previous:{...previous,value:60}}}};
const task={id:'private-a',title:'本机保留的任务',when:'已安排',detail:'任务内容来自旧授权范围，请保留。',state:'planned'};
const currentPlan={title:'健康',summary:'健康计划',tasks:[task]};
const makePlanning=()=>createPlanningContext({before:raw,after:raw,goalIntent:'周运动120分钟',currentPlan,
  protectedTaskIds:[task.id,'unknown'],weeklyWorkoutMinutes:120,revisionId:'review-1'});
const answer={decision:'revise',basedOnRevision:'review-1',reason:'适配近期记录。',nextReviewAt:null,changes:[]};

test('selected recent windows survive iPhone storage and agent transport even when consecutive observations match',()=>{
  const stored=setSnapshot(initialState(),raw,'healthkit').snapshot;
  const shared=agentHealthSnapshot(stored);
  assert.deepEqual(shared.recentHistory.sleep,{recent,previous});
  assert.equal(shared.recentHistory.workout.recent.count,3);
  assert.ok(!Object.hasOwn(shared.recentHistory,'weight'));
  const oldConsent=agentHealthSnapshot({...raw,comparisonHistoryAllowed:false});
  assert.deepEqual(Object.keys(oldConsent.recentHistory),['workout']);
  assert.equal(oldConsent.comparisonHistoryAllowed,false);
  const withoutConsent=setSnapshot(initialState(),{...raw,contextReviewAllowed:false},'healthkit').snapshot;
  assert.equal(withoutConsent.recentHistory,undefined);
  assert.equal(agentHealthSnapshot(withoutConsent).recentHistory,undefined);
  const later={...shared,capturedAt:'2026-11-11T04:15:00Z'};
  assert.deepEqual(healthContextChanges(shared,later),[]);
  const initial=createPlanningContext({before:null,after:shared,currentPlan,revisionId:'initial'});
  assert.equal(initial.baselineKind,'initial');
  assert.deepEqual(initial.changes,[]);
  assert.equal(makePlanning().baselineKind,'previous_observation');
  const backfilled={...later,recentHistory:{...later.recentHistory,sleep:{recent:{...recent,value:432},previous}}};
  assert.deepEqual(healthContextChanges(later,backfilled).map(c=>c.field),['recentHistory']);
});

test('compares only contiguous closed seven-day windows and preserves sparse coverage or missing observations',()=>{
  const observe=(p,r)=>agentHealthSnapshot({...raw,recentHistory:{sleep:{previous:p,recent:r}}}).recentHistory?.sleep;
  assert.equal(observe(previous,{...recent,startAt:'2026-11-01T16:00:00Z'}),undefined);
  assert.equal(observe(previous,{...recent,endAt:'2026-11-12T16:00:00Z'}),undefined);
  assert.equal(observe(previous,{...recent,daysWithData:8}),undefined);
  assert.equal(observe({...previous,startAt:'2026-10-20T16:00:00Z',endAt:'2026-10-27T16:00:00Z'},recent),undefined);
  assert.equal(observe(previous,{...recent,daysWithData:0,value:0}).recent.value,null);
  assert.equal(observe({...previous,daysWithData:1},recent).previous.daysWithData,1);
});

test('protected aliases survive cleaning and cannot be changed or removed even with a declared reason',()=>{
  const planning=makePlanning();
  assert.deepEqual(planning.protectedTaskIds,[task.id]);
  assert.equal(planning.weeklyWorkoutMinutes,120);
  const editable={...task,id:'new',title:'看最新记录',detail:'下次复查时查看已授权数据。'};
  assert.equal(validateReassessment({...answer,changes:[{taskId:'new',operation:'add',reason:'本人选择。'}]},
    {tasks:[task,editable]},planning).decision,'revise');
  for(const [operation,tasks] of [['cancel',[]],['update',[{...task,title:'擅自替换'}]]]) {
    assert.throws(()=>validateReassessment({...answer,changes:[{taskId:task.id,operation,reason:'推断有用。'}]},{tasks},planning),/本机保留/);
  }
  const legacy={...planning}; delete legacy.protectedTaskIds;
  assert.throws(()=>validateReassessment({...answer,changes:[{taskId:task.id,operation:'cancel',reason:'猜测是催练。'}]},{tasks:[]},legacy),/本机保留/);
});

test('both runtime dispatches receive the window guidance, metric semantics and no invented weekly target',async()=>{
  const host=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');
  const source=host.slice(host.indexOf('function cleanGoalTitle'),host.indexOf('async function runExclusive'));
  const {cleanGoal,cleanSnapshot}=vm.runInNewContext(source+'\n;({cleanGoal,cleanSnapshot})',{SLEEP_REMINDER_CRITERIA,agentHealthSnapshot,cleanHealthContext,cleanPlanningContext});
  const planning=makePlanning();
  const review=cleanSnapshot({...raw,planning},'health',120);
  assert.equal(review.planning.weeklyWorkoutMinutes,120);
  assert.match(review.planning.reviewCriteria,/recentHistory/);
  assert.match(review.planning.reviewCriteria,/protectedTaskIds/);
  assert.equal(cleanSnapshot({...raw,planning},'custom',null).planning.weeklyWorkoutMinutes,null);
  assert.equal(cleanSnapshot({...raw,planning},'health',12).planning.weeklyWorkoutMinutes,null);
  assert.equal(cleanGoal({domain:'health',title:'计划',target:null},true).target,null);
  assert.throws(()=>cleanGoal({domain:'health',title:'计划',target:null}));
  const consented=cleanSnapshot({...raw,selectedTypes:['workout'],planning},'health',120);
  assert.ok(!consented.planning.previous.recentHistory?.sleep);
  assert.ok(!consented.recentHistory?.sleep);
  const oldScope=cleanSnapshot({...raw,comparisonHistoryAllowed:false,planning},'health',120);
  assert.deepEqual(Object.keys(oldScope.planning.previous.recentHistory),['workout']);
  assert.equal(oldScope.planning.previous.comparisonHistoryAllowed,false);
  const dispatch=host.slice(host.indexOf("    if (req.method==='POST' && path==='/super-agent/goals')"),
    host.indexOf("    if (req.method==='POST' && path==='/super-agent/goals/status')"));
  const received=[];
  const send=vm.runInNewContext('(async(req,res,path)=>{'+dispatch+'})',{
    body:async req=>req.input,requestedRuntime:r=>r,cleanGoal,cleanSnapshot,clientText:s=>s,requestId:s=>s,KIMI_RUNTIME:'kimi-code-swarm',
    respond:(_res,_status,rest)=>rest,upstream:fn=>fn(),normalizeGoalRun:r=>r,
    kimiAgent:{startGoal:async input=>{received.push(input);return {}}},
    superAgentCall:async (path,{value,contextReview})=>{assert.equal(path,'/along-source/api/goals');assert.equal(contextReview,true);received.push(value);return {}},
  });
  for (const runtime of ['kimi-code-swarm','dsh-superagent']) await send({method:'POST',input:{
    requestId:'review-1',runtime,goal:{domain:'health',title:'12周计划',target:12},message:'评估我近期的目标进展',history:[],snapshot:{...raw,planning},
  }},null,'/super-agent/goals');
  const bedtimePlan={...planning,goalIntent:'我想稳定作息，下一次睡前请提醒我。',
    reviewCriteria:'从旧版客户端带来的任意指示',currentPlan:{...planning.currentPlan,tasks:[task]}};
  for (const runtime of ['dsh-superagent','kimi-code-swarm']) await send({method:'POST',input:{
    requestId:'review-1',runtime,goal:{domain:'health',title:'健康',target:null},message:'复查已采用的任务',history:[],
    snapshot:{...raw,selectedTypes:['workout'],planning:bedtimePlan},
  }},null,'/super-agent/goals');
  for (const {snapshot} of received.slice(2)) {
    assert.equal(snapshot.sleepSummary,null,'an explicit sleep goal cannot unlock observations');
    assert.deepEqual(snapshot.planning.protectedTaskIds,[task.id]);
    const criteria=snapshot.planning.reviewCriteria;
    assert.doesNotMatch(criteria,/从旧版客户端/);
    assert.match(criteria,/睡前提醒/);
    assert.match(criteria,/kind=reminder/);
    assert.match(criteria,/scheduledFor/);
    assert.match(criteria,/need_data/);
    assert.match(criteria,/planning.timezone/);
    assert.match(criteria,/一次性请求/);
    assert.match(criteria,/授权睡眠摘要/);
    assert.match(criteria,/本地今天余下的时间/);
    assert.match(criteria,/拒绝|暂停/);
  }
  assert.deepEqual(received[0],received[1]);
  assert.equal(received[0].goal.target,null,'the plan horizon must not become an exercise target');
  assert.equal(received[0].snapshot.recentHistory.sleep.recent.value,411);
  assert.equal(received[0].snapshot.planning.reviewCriteria,review.planning.reviewCriteria);
});
