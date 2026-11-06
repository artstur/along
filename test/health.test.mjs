import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState, setSnapshot, loadState} from '../web/health.mjs';

test('broken stored data falls back to empty state',()=>{
  assert.deepEqual(loadState('{bad'),initialState());
  assert.deepEqual(loadState('{"version":0}'),initialState());
});

test('partial HealthKit selection never treats missing workouts as zero progress',()=>{
  const state=setSnapshot(initialState(),{steps:6000,selectedTypes:['steps']},'healthkit');
  assert.equal(state.snapshot.workoutMinutes,null);
  assert.equal(state.snapshot.workoutCount,null);
  assert.deepEqual(state.snapshot.selectedTypes,['steps']);
});

test('new HealthKit aggregates remain local and selected without changing workout progress',()=>{
  const state=setSnapshot(initialState(),{
    selectedTypes:['workout','activeEnergy','restingHeartRate','wristTemperature'],
    workoutMinutes:75,workoutCount:2,activeEnergyKcal:356,restingHeartRate:59,wristTemperatureC:35.8,
  },'healthkit');
  assert.equal(state.snapshot.activeEnergyKcal,356);
  assert.equal(state.snapshot.restingHeartRate,59);
  assert.equal(state.snapshot.wristTemperatureC,35.8);
  assert.equal(state.snapshot.workoutMinutes,75);
  assert.equal(state.snapshot.workoutCount,2);
});

test('demo snapshots keep the workout record and unknown sources are rejected',()=>{
  const state=setSnapshot(initialState(),{steps:6842,workoutMinutes:75,workoutCount:2},'demo');
  assert.equal(state.snapshot.workoutMinutes,75);
  assert.equal(state.snapshot.selectedTypes,null);
  assert.throws(()=>setSnapshot(initialState(),{},'other'),/未知数据来源/);
});
