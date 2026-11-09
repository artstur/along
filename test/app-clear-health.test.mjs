import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const HEALTH_KEY='along.health.v1';
const TICKET_KEY='along.goal-ticket.v1';

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

test('the clear entry shows even when a real summary only survives in the experiment backup',async()=>{
  const backupOnly={...healthkitState,source:null,snapshot:null,
    loop:{experiment:'weekly-workout-120-v1',previousState:healthkitState,currentTask:'本周安排一次 45 分钟健身',changes:[]}};
  const dom=installDomStub({storage:{[HEALTH_KEY]:JSON.stringify(backupOnly)}});
  await import('../web/app.mjs?clear-health-backup-only');
  assert.match(dom.app.innerHTML,/清除本机健康摘要/,'实验备份里还留着真实摘要时，清除入口必须在');
  await dom.click({action:'clear-health-data'});
  const saved=JSON.parse(dom.storage.get(HEALTH_KEY));
  assert.equal(saved.loop.previousState.source,null);
});

test('clearing also removes a real proposal even while the demo data is on screen',async()=>{
  const demoState={...healthkitState,source:'demo',snapshot:{...healthkitState.snapshot,selectedTypes:null}};
  const ticket={id:'ticket-2',source:'healthkit',trigger:{from:75,to:110},eval:'replan',
    mandate:'仅提出任务，用户确认后才采用',reason:'本周新增 35 分钟',status:'assigned'};
  const dom=installDomStub({storage:{[HEALTH_KEY]:JSON.stringify(demoState),[TICKET_KEY]:JSON.stringify(ticket)}});
  globalThis.window.AlongHealthBridge={clear:()=>Promise.resolve()};
  await import('../web/app.mjs?clear-health-demo-ticket');
  await dom.click({action:'clear-health-data'});
  assert.equal(dom.storage.get(TICKET_KEY),null,'任务票里存着真实分钟数，任何一次清除健康数据都要一起清掉');
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

test('clearing also removes the real summary kept in the experiment backup',async()=>{
  const demoState={...healthkitState,source:'demo',snapshot:{...healthkitState.snapshot,selectedTypes:null},
    loop:{experiment:'weekly-workout-120-v1',previousState:healthkitState,currentTask:'本周安排一次 45 分钟健身',changes:[]}};
  const dom=installDomStub({storage:{[HEALTH_KEY]:JSON.stringify(demoState)}});
  let cleared=0;
  globalThis.window.AlongHealthBridge={clear:()=>{cleared++;return Promise.resolve();}};
  await import('../web/app.mjs?clear-health-backup');
  await dom.click({action:'clear-health-data'});
  assert.equal(cleared,1,'实验里存着真实摘要时，必须让原生侧停读');
  const saved=JSON.parse(dom.storage.get(HEALTH_KEY));
  assert.equal(saved.source,null);
  assert.equal(saved.snapshot,null);
  assert.equal(saved.loop.previousState.source,null,'实验备份里的真实摘要也要清掉');
  assert.equal(saved.loop.previousState.snapshot,null);
});

test('clearing removes the pending proposal that carries real minutes',async()=>{
  const ticket={id:'ticket-1',source:'healthkit',trigger:{from:45,to:75},eval:'replan',
    mandate:'仅提出任务，用户确认后才采用',reason:'本周新增 30 分钟，距目标从 75 分钟变为 45 分钟',status:'assigned'};
  const dom=installDomStub({storage:{[HEALTH_KEY]:JSON.stringify(healthkitState),[TICKET_KEY]:JSON.stringify(ticket)}});
  globalThis.window.AlongHealthBridge={clear:()=>Promise.resolve()};
  await import('../web/app.mjs?clear-health-ticket');
  await dom.click({action:'clear-health-data'});
  assert.equal(dom.storage.get(TICKET_KEY),null,'待处理任务票里存着真实健身分钟数，要一起清掉');
});
