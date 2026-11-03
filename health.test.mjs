import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,addGoal,setSnapshot,advanceDemo,taskPlan,loadState} from './health.mjs';

test('workout progress and task change after a new record',()=>{
  const goal=addGoal(initialState(),'workout',2);
  const first=setSnapshot(goal,{steps:6000,weightKg:64.2,workoutMinutes:75,workoutCount:2,sleepMinutes:420},'demo');
  assert.equal(taskPlan(first).progress[0].percent,63);
  assert.match(taskPlan(first).tasks[1].detail,/45 分钟/);
  const next=advanceDemo(first);
  assert.equal(taskPlan(next).progress[0].percent,92);
  assert.match(taskPlan(next).tasks[1].detail,/10 分钟/);
});
test('weight goal needs a baseline and does not invent progress',()=>{
  const goal=addGoal(initialState(),'weight',2);
  const first=setSnapshot(goal,{steps:0,weightKg:64.2,workoutMinutes:0,workoutCount:0},'demo');
  assert.equal(first.goals[0].baselineWeight,64.2);
  assert.equal(taskPlan(first).progress[0].percent,0);
  const second=setSnapshot(first,{steps:0,weightKg:63.7,workoutMinutes:0,workoutCount:0},'demo');
  assert.equal(taskPlan(second).progress[0].percent,25);
});
test('broken stored data falls back to empty state',()=>{
  assert.deepEqual(loadState('{bad'),initialState());
  assert.deepEqual(loadState('{"version":0}'),initialState());
});
