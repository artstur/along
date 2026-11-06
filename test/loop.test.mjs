import test from 'node:test';
import assert from 'node:assert/strict';
import {startExperiment, routeHealthEvent, acceptAgentSuggestion, agentRequestPayload, ORIGINAL_TASK} from '../web/loop.mjs';
import {initialState, addGoal} from '../web/health.mjs';

test('35-minute workout reroutes 75 of 120 to exactly 10 remaining',()=>{
  const before=startExperiment();
  const route=routeHealthEvent(before,{type:'workout',amount:35});
  assert.equal(before.snapshot.workoutMinutes,75);
  assert.equal(before.loop.currentTask,ORIGINAL_TASK);
  assert.equal(route.after.snapshot.workoutMinutes,110);
  assert.equal(route.remainingBefore,45);
  assert.equal(route.remainingAfter,10);
  assert.equal(route.decision,'replan');
  assert.match(route.reason,/新增 35 分钟/);
});

test('minor workout and unrelated steps stay quiet',()=>{
  const before=startExperiment();
  const minor=routeHealthEvent(before,{type:'workout',amount:1});
  const steps=routeHealthEvent(before,{type:'steps',amount:100});
  assert.equal(minor.decision,'quiet');
  assert.equal(minor.remainingAfter,44);
  assert.equal(steps.decision,'quiet');
  assert.equal(steps.after.snapshot.workoutMinutes,75);
  assert.equal(steps.remainingAfter,45);
});

test('agent suggestion cannot alter Along arithmetic',()=>{
  assert.deepEqual(acceptAgentSuggestion('{"task":"再活动 10 分钟","reason":"剩余变少","minutes":10}',10),{task:'再活动 10 分钟',reason:'剩余变少',minutes:10});
  assert.throws(()=>acceptAgentSuggestion('{"task":"跑 45 分钟","reason":"错了","minutes":45}',10),/不一致/);
});

test('experiment keeps a restorable copy of the previous goals',()=>{
  const previous=addGoal(initialState(),'weight',2);
  const experiment=startExperiment(previous);
  assert.equal(experiment.goals.length,1);
  assert.equal(experiment.loop.previousState.goals.length,1);
  assert.deepEqual(startExperiment(experiment).loop.previousState,previous);
});

test('local Agent request omits the restored HealthKit state',()=>{
  const previous={...initialState(),source:'healthkit',snapshot:{steps:12345,weightKg:61.2,workoutMinutes:99,sleepMinutes:480}};
  const experiment=startExperiment(previous);
  const payload=agentRequestPayload(experiment,{type:'workout',amount:35});
  assert.equal(payload.before.snapshot.workoutMinutes,75);
  assert.equal(payload.before.loop.currentTask,ORIGINAL_TASK);
  assert.equal(payload.before.loop.previousState,undefined);
  assert.doesNotMatch(JSON.stringify(payload),/12345|61\.2|480|healthkit/);
  assert.equal(routeHealthEvent(payload.before,payload.event).remainingAfter,10);
});
