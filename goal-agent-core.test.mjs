import test from 'node:test';
import assert from 'node:assert/strict';
import {routeHealthChange,validateGoalReply,validateTaskReply} from './goal-agent-core.mjs';

test('health router stays quiet for unrelated or small changes and replans a meaningful change',()=>{
  assert.equal(routeHealthChange({workoutMinutes:75},{workoutMinutes:75,steps:12000},120).decision,'quiet');
  assert.equal(routeHealthChange({workoutMinutes:75},{workoutMinutes:76},120).decision,'quiet');
  assert.deepEqual(routeHealthChange({workoutMinutes:75},{workoutMinutes:110},120),{
    decision:'replan',reason:'本周新增 35 分钟，距目标从 45 分钟变为 10 分钟',oldRemaining:45,remaining:10,delta:35,
  });
});

test('agent proposals must preserve the deterministic goal domain and remaining progress',()=>{
  assert.equal(validateGoalReply('{"reply":"建议先试一周","proposal":{"title":"每周运动 150 分钟","target":150,"task":"安排 20 分钟活动","reason":"符合约束"}}','health').proposal.target,150);
  assert.throws(()=>validateGoalReply('{"reply":"好","proposal":{"title":"过量","target":10081,"task":"跑步","reason":"超限"}}','health'));
  assert.throws(()=>validateTaskReply('{"task":"活动 20 分钟","reason":"变化","remaining":20}',10));
});
