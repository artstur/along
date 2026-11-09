import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const HEALTH_KEY='along.health.v1';

const healthkitState={
  version:1,source:'healthkit',
  snapshot:{steps:6000,workoutMinutes:75,workoutCount:2,weightKg:64.2,sleepMinutes:437,activeEnergyKcal:340,
    restingHeartRate:58,wristTemperatureC:36.5,selectedTypes:['steps','workout'],updatedAt:'2026-11-09T00:00:00.000Z'},
  goals:[{id:'along-health-weekly-workout',type:'workout',target:120}],
};

test('the real HealthKit summary can be cleared from the app',async()=>{
  const dom=installDomStub({storage:{[HEALTH_KEY]:JSON.stringify(healthkitState)}});
  let cleared=0;
  globalThis.window.AlongHealthBridge={clear:()=>{cleared++;return Promise.resolve();}};
  await import('../web/app.mjs?clear-health');
  assert.match(dom.app.innerHTML,/清除本机健康摘要/,'真实来源也要有清除入口');
  await dom.click({action:'clear-health-data'});
  assert.equal(cleared,1,'清掉真实摘要要同时让原生侧停掉读取，否则下一轮刷新会把摘要读回来');
  const saved=JSON.parse(dom.storage.get(HEALTH_KEY));
  assert.equal(saved.snapshot,null);
  assert.equal(saved.source,null);
});

test('the demo data can still be left without touching the native bridge',async()=>{
  const demoState={...healthkitState,source:'demo',snapshot:{...healthkitState.snapshot,selectedTypes:null}};
  const dom=installDomStub({storage:{[HEALTH_KEY]:JSON.stringify(demoState)}});
  let cleared=0;
  globalThis.window.AlongHealthBridge={clear:()=>{cleared++;return Promise.resolve();}};
  await import('../web/app.mjs?clear-health-demo');
  await dom.click({action:'clear-health-data'});
  assert.equal(cleared,0,'演示数据不走原生侧');
  assert.equal(JSON.parse(dom.storage.get(HEALTH_KEY)).source,null);
});
