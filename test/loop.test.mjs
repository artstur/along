import test from 'node:test';
import assert from 'node:assert/strict';
import {startExperiment, routeHealthEvent, acceptAgentSuggestion, agentRequestPayload, ORIGINAL_TASK} from '../web/loop.mjs';
import {routeHealthChange} from '../web/goal-agent-core.mjs';
import {initialState} from '../web/health.mjs';

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
  assert.deepEqual(acceptAgentSuggestion('{"task":"再活动 10 分钟","reason":"剩余变少","remaining":10}',10),{task:'再活动 10 分钟',reason:'剩余变少',remaining:10});
  assert.throws(()=>acceptAgentSuggestion('{"task":"跑 45 分钟","reason":"错了","remaining":45}',10),/不一致/);
});

test('a suggestion that follows the agent output contract is accepted and survives the host round trip',()=>{
  const accepted=acceptAgentSuggestion('{"task":"再活动 10 分钟","reason":"剩余变少","remaining":10}',10);
  assert.equal(accepted.task,'再活动 10 分钟');
  assert.equal(accepted.reason,'剩余变少');
  assert.doesNotThrow(()=>acceptAgentSuggestion(JSON.stringify(accepted),10));
  assert.throws(()=>acceptAgentSuggestion('{"task":"跑 45 分钟","reason":"错了","remaining":45}',10),/不一致/);
});

test('the experiment router and the real router judge significance the same way',()=>{
  for (const minutes of [1,10,14,15,19,20,35]) {
    const real=routeHealthChange({workoutMinutes:75},{workoutMinutes:75+minutes},120).decision;
    const demo=routeHealthEvent(startExperiment(),{type:'workout',amount:minutes}).decision;
    assert.equal(demo,real,`新增 ${minutes} 分钟时两条路由判断不一致`);
  }
});

test('experiment keeps a restorable copy of the previous goals',()=>{
  const previous={...initialState(),goals:[{id:'previous-goal',type:'workout',target:60}]};
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
