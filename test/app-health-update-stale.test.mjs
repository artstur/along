import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const HEALTH_KEY='along.health.v1';
const TICKET_KEY='along.goal-ticket.v1';
const AGENT_KEY='along.agent.v1';

const healthState={
  version:1,source:'healthkit',
  snapshot:{steps:6000,workoutMinutes:75,workoutCount:2,weightKg:64.2,sleepMinutes:437,selectedTypes:['workout'],updatedAt:'2026-11-09T00:00:00.000Z'},
  goals:[{id:'along-health-weekly-workout',type:'workout',target:120}],
};

const agentConfig={baseURL:'https://192.168.1.2:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};

function snapshot(minutes) {
  return {steps:6000,workoutMinutes:minutes,workoutCount:2,weightKg:64.2,sleepMinutes:437,selectedTypes:['workout']};
}

test('a stale health change reply does not overwrite a newer proposal',async()=>{
  const dom=installDomStub({storage:{[HEALTH_KEY]:JSON.stringify(healthState),[AGENT_KEY]:JSON.stringify(agentConfig)}});
  // 两次健康变化都在途：第一次的回答比第二次晚到（宿主串行处理，两次必然撞上）。
  const calls=[];
  globalThis.window.AlongAgentBridge={
    request:({path})=>{
      if (path!=='/goal/event') return Promise.resolve({});
      return new Promise(resolve=>calls.push({resolve}));
    },
  };
  await import('../web/app.mjs?health-update-stale');
  assert.equal(calls.length,0,'还没发生健康变化');

  dom.fireWindow('along-health-update',{detail:snapshot(110)});
  assert.equal(calls.length,1,'第一次变化已经去问宿主了');
  dom.fireWindow('along-health-update',{detail:snapshot(120)});
  assert.equal(calls.length,2,'第二次变化也去问了宿主');

  // 第二次（较新）的回答先到。
  calls[1].resolve({decision:'replan',reason:'还差 0 分钟',suggestion:{task:'收工前拉伸 10 分钟',reason:'本周目标已达成',remaining:0}});
  await new Promise(resolve=>setTimeout(resolve,0));
  const current=JSON.parse(dom.storage.get(TICKET_KEY));
  assert.equal(current.trigger.to,120,'当前提案要对应第二次变化');
  assert.equal(current.suggestion.task,'收工前拉伸 10 分钟');

  // 第一次（较旧）的回答后到：不能盖掉更新的提案。
  calls[0].resolve({decision:'replan',reason:'还差 10 分钟',suggestion:{task:'安排 45 分钟健身',reason:'本周还差 10 分钟',remaining:10}});
  await new Promise(resolve=>setTimeout(resolve,0));
  const after=JSON.parse(dom.storage.get(TICKET_KEY));
  assert.equal(after.trigger.to,120,'旧回复不能把提案退回上一次变化');
  assert.equal(after.suggestion.task,'收工前拉伸 10 分钟','旧回复不能盖掉更新的提案');
  assert.doesNotMatch(dom.app.innerHTML,/安排 45 分钟健身/,'界面上不能出现对不上进度的旧提案');
});

test('a dismissed proposal is not resurrected by a late reply',async()=>{
  const dom=installDomStub({storage:{[HEALTH_KEY]:JSON.stringify(healthState),[AGENT_KEY]:JSON.stringify(agentConfig)}});
  const calls=[];
  globalThis.window.AlongAgentBridge={
    request:({path})=>{
      if (path!=='/goal/event') return Promise.resolve({});
      return new Promise(resolve=>calls.push({resolve}));
    },
  };
  await import('../web/app.mjs?health-update-dismissed');
  dom.fireWindow('along-health-update',{detail:snapshot(110)});
  assert.equal(calls.length,1);
  await dom.click({action:'dismiss-task'});
  assert.equal(dom.storage.get(TICKET_KEY),null,'用户已经保留原任务了');
  calls[0].resolve({decision:'replan',reason:'还差 10 分钟',suggestion:{task:'安排 45 分钟健身',reason:'本周还差 10 分钟',remaining:10}});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(dom.storage.get(TICKET_KEY),null,'用户已经处理掉的提案不能被迟到的回复重新挂回来');
});
