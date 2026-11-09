import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const GOAL_RUNS_KEY='along.goal-super-agent-runs.v1';

function hostileRun() {
  return {
    version:1,actual:true,runtime:'kimi-code-swarm',kind:'goal',requestId:'req-hostile',
    input:{goal:{domain:'health',title:'运动',target:120},message:'做一个计划'},
    source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'Kimi Code Web Server'},
    agents:[{id:'a1',name:'目标策略师',role:'Subagent',status:'done" onmouseover="alert(1)',objective:'拆解目标',work:'完成',progress:'<img src=x onerror=alert(1)>'}],
    events:[],result:null,status:'done" onmouseover="alert(1)',statusLabel:'已完成',
    progress:'<img src=x onerror=alert(1)>',createdAt:Date.now(),updatedAt:Date.now(),
  };
}

test('the run card never lets the agent write markup into the page',async()=>{
  const dom=installDomStub({storage:{[GOAL_RUNS_KEY]:JSON.stringify({'health:kimi-code-swarm':hostileRun()})}});
  await import('../web/app.mjs?run-escape');
  await dom.click({action:'edit-goal'});
  assert.doesNotMatch(dom.app.innerHTML,/onmouseover="/,'运行状态不能原样插进 class 属性');
  assert.doesNotMatch(dom.app.innerHTML,/<img src=x/,'运行进度不能原样插进 HTML');
  assert.doesNotMatch(dom.app.innerHTML,/worker-card done"/,'子 Agent 状态同样要过白名单');
});
