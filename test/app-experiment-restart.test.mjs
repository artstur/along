import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const HEALTH_KEY='along.health.v1';
const EXPERIMENT='weekly-workout-120-v1';

// 用户自己的真实摘要：42 分钟健身，来自 Apple Health。
const realState={
  version:1,source:'healthkit',
  snapshot:{steps:9000,workoutMinutes:42,workoutCount:1,weightKg:64,sleepMinutes:400,selectedTypes:['workout'],updatedAt:'2026-11-09T00:00:00.000Z'},
  goals:[{id:'health',type:'workout',target:120}],
  loop:{currentTask:'本周安排一次 45 分钟健身',changes:[]},
};

// 实验开着的样子：演示快照写在同一把钥匙里，真实摘要塞进 loop.previousState。
const experimentState={
  version:1,source:'demo',
  snapshot:{steps:6842,workoutMinutes:75,workoutCount:2,weightKg:64.2,sleepMinutes:437,selectedTypes:null,updatedAt:'2026-11-09T00:00:00.000Z'},
  goals:[{id:EXPERIMENT,type:'workout',target:120}],
  loop:{experiment:EXPERIMENT,previousState:realState,currentTask:'本周安排一次 45 分钟健身',changes:[]},
};

test('a restart does not leave the experiment demo data on top of the real health summary',async()=>{
  const dom=installDomStub({storage:{[HEALTH_KEY]:JSON.stringify(experimentState)}});
  await import('../web/app.mjs?experiment-restart');
  const html=dom.app.innerHTML;
  // 实验是沙盒：重启后用户该看到自己的真实摘要，不是演示数据顶在上面。
  assert.match(html,/根据你选择导入的 Apple Health 摘要计算/,`重启后首页要回到真实摘要：${html.slice(0,400)}`);
  assert.doesNotMatch(html,/当前使用演示健康数据/,'演示数据不该在重启后继续占着首页');
  assert.match(html,/已选 1 项/,'真实的连接状态要回到首页');
  // 存储里也要真的退掉实验，不然下次启动还会读到同一份演示数据。
  const saved=JSON.parse(dom.store.get(HEALTH_KEY));
  assert.notEqual(saved.loop?.experiment,EXPERIMENT,'存储里不该还留着实验状态');
  assert.equal(saved.source,'healthkit','真实来源要回到存储里');
  assert.equal(saved.snapshot.workoutMinutes,42,'真实摘要不能丢');
});

test('a corrupted experiment backup does not stop the app from starting',async()=>{
  const broken={...experimentState,loop:{experiment:EXPERIMENT,previousState:'这不是一个状态'}};
  const dom=installDomStub({storage:{[HEALTH_KEY]:JSON.stringify(broken)}});
  await import('../web/app.mjs?experiment-broken-backup');
  assert.match(dom.app.innerHTML,/健康目标|本周累计运动/,'备份坏了也要能画出首页，不能让整个 App 起不来');
  const saved=JSON.parse(dom.store.get(HEALTH_KEY));
  assert.notEqual(saved.loop?.experiment,EXPERIMENT,'坏掉的实验状态要清掉');
});
