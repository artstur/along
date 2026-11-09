import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const HEALTH_KEY='along.health.v1';
const EXPERIMENT='weekly-workout-120-v1';

const replay={
  experiment:EXPERIMENT,beforeMinutes:75,eventMinutes:35,source:'recorded-along',
  suggestion:{
    task:'做10分钟轻量健身（如拉伸或快走），完成本周目标。',
    reason:'原任务计划45分钟，但新增35分钟记录后累计110分钟，只剩10分钟，因此原任务应改为10分钟。',
    remaining:10,
  },
};

// 实验跑到一半：用户先点过一次「仅新增 1 分钟」（安静处理），累计变成 76。
const experimentState={
  version:1,source:'demo',
  snapshot:{steps:6842,workoutMinutes:76,workoutCount:3,weightKg:64.2,sleepMinutes:437,selectedTypes:null,updatedAt:'2026-11-09T00:00:00.000Z'},
  goals:[{id:EXPERIMENT,type:'workout',target:120}],
  loop:{
    experiment:EXPERIMENT,
    previousState:{version:1,source:'healthkit',snapshot:{steps:9000,workoutMinutes:42,workoutCount:1,weightKg:64,sleepMinutes:400,selectedTypes:['workout'],updatedAt:'2026-11-09T00:00:00.000Z'},goals:[{id:'health',type:'workout',target:120}],loop:{currentTask:'本周安排一次 45 分钟健身',changes:[]}},
    currentTask:'本周安排一次 45 分钟健身',
    changes:[{id:'quiet-1',type:'workout',amount:1,decision:'quiet',reason:'这次变化较小，暂不打断原有安排。',remainingBefore:45,remainingAfter:44,beforeTask:'本周安排一次 45 分钟健身',status:'quiet'}],
  },
};

test('the public demo keeps its main scenario reachable after a quiet change',async()=>{
  const dom=installDomStub({storage:{[HEALTH_KEY]:JSON.stringify(experimentState)}});
  // 公网演示（不是 localhost）：走录制的回放，不真的请求 Along。
  globalThis.location={hostname:'artstur.github.io'};
  globalThis.fetch=async(url)=>{
    assert.match(String(url),/agent-replay\.json/,'公网演示只读回放夹具');
    return new Response(JSON.stringify(replay),{status:200,headers:{'content-type':'application/json'}});
  };
  await import('../web/app.mjs?public-demo-replay');
  await dom.click({action:'open-lab'});
  await dom.click({action:'event-workout-35'});
  await new Promise(resolve=>setTimeout(resolve,0));
  await new Promise(resolve=>setTimeout(resolve,0));
  const html=dom.app.innerHTML;
  // 录制的回放固定从 75 分钟开始：起点被安静的变化带偏后，主场景也要能用。
  assert.doesNotMatch(html,/公网演示仅提供/,`主场景不该再也点不出来：${html.slice(0,400)}`);
  assert.match(html,/做10分钟轻量健身/,'公网演示要给出录制的那条建议');
  assert.match(html,/Along 建议回放/,'要标明这是录制的运行结果');
});
