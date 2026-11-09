import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState, setSnapshot, summaryHasData} from '../web/health.mjs';

test('an empty HealthKit read does not wipe the summary already on the device',()=>{
  const state=setSnapshot(initialState(),{steps:6842,workoutMinutes:75},'demo');
  const empty=setSnapshot(state,{steps:null,workoutMinutes:null,workoutCount:null,selectedTypes:[]},'healthkit');
  assert.equal(empty.snapshot.workoutMinutes,75,'撤销授权后的空读数不该清掉已有摘要');
  assert.equal(empty.source,'demo');
  const real=setSnapshot(state,{steps:7000,workoutMinutes:80},'healthkit');
  assert.equal(real.snapshot.workoutMinutes,80);
  assert.equal(real.source,'healthkit');
});

test('an empty read on a device without data still leaves the snapshot empty',()=>{
  const empty=setSnapshot(initialState(),{steps:null,workoutMinutes:null},'healthkit');
  assert.equal(summaryHasData(empty.snapshot),false);
  assert.equal(empty.snapshot.workoutMinutes,null);
});
