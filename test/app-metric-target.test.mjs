import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const HEALTH_KEY='along.health.v1';
const LAYOUTS_KEY='along.adaptive-layouts.v1';

const layout={
  version:1,title:'本周运动',badge:'试运行',summary:'按周推进。',
  modules:[{kind:'metric',id:'exercise',title:'本周运动',source:'workoutMinutes',target:120,unit:'分钟',note:'由 Apple Health 摘要提供'}],
  tasks:[],questions:[],
};

const state={
  version:1,source:'healthkit',
  snapshot:{steps:6000,workoutMinutes:120,workoutCount:2,weightKg:64.2,sleepMinutes:437,activeEnergyKcal:340,
    restingHeartRate:58,wristTemperatureC:36.5,selectedTypes:['workout'],updatedAt:'2026-11-09T00:00:00.000Z'},
  goals:[{id:'along-health-weekly-workout',type:'workout',target:180}],
};

test('the metric in the generated space follows the current goal target',async()=>{
  const dom=installDomStub({storage:{
    [HEALTH_KEY]:JSON.stringify(state),
    [LAYOUTS_KEY]:JSON.stringify({health:layout,finance:null,custom:null}),
  }});
  await import('../web/app.mjs?metric-target');
  assert.match(dom.app.innerHTML,/\/ 180 分钟/,'指标目标要跟着当前目标数值走，不能用布局里的旧值');
  assert.match(dom.app.innerHTML,/aria-valuenow="67"/,'进度要按 120/180 算，不能显示已达成');
  assert.doesNotMatch(dom.app.innerHTML,/aria-valuenow="100"/,'目标没达成时不能显示 100%');
});
