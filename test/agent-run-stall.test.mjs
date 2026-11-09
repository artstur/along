import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {AGENT_RUN_TIMEOUT_MS, GOAL_SUPER_AGENT_RUNS_KEY, KIMI_RUNTIME, withRunError} from '../web/super-agent.mjs';

const AGENT_KEY='along.agent.v1';

function workingGoalRun(createdAt=Date.now()) {
  return {
    version:1,actual:true,runtime:KIMI_RUNTIME,kind:'goal',requestId:'along-goal-health-req-1',
    input:{goal:{domain:'health',title:'运动',target:120},message:'做一个计划'},
    source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'Kimi Code Web Server'},
    agents:[],events:[],result:null,status:'working',statusLabel:'Kimi Main Session 正在拆解',progress:20,createdAt,updatedAt:createdAt,
  };
}

test('a transient status failure keeps the run working so it can still recover',()=>{
  const failed=withRunError(workingGoalRun(),'Kimi Code Web Server 未运行：fetch failed');
  assert.equal(failed.status,'working','只是偶发读不到状态时不该掐断运行');
  assert.match(failed.error,/Kimi Code Web Server/);
});

test('a run whose status can no longer be read stops working instead of spinning forever',()=>{
  const failed=withRunError(workingGoalRun(Date.now()-AGENT_RUN_TIMEOUT_MS-1_000),'Kimi Code Web Server 未运行：fetch failed');
  assert.equal(failed.status,'blocked','一直读不到状态必须是终态');
  assert.match(failed.error,/Kimi Code Web Server/);
});

test('the goal run gives up instead of polling forever when the Mac host stops answering',async()=>{
  const run=workingGoalRun(Date.now()-AGENT_RUN_TIMEOUT_MS-1_000);
  const dom=installDomStub({storage:{
    [AGENT_KEY]:JSON.stringify({baseURL:'https://along.local',fingerprint:'AA',token:'token'}),
    [GOAL_SUPER_AGENT_RUNS_KEY]:JSON.stringify({[`health:${KIMI_RUNTIME}`]:run}),
  }});
  await import('../web/app.mjs?run-stall');
  await dom.click({action:'edit-goal'});
  await dom.tick(3_000);
  const runs=JSON.parse(dom.storage.get(GOAL_SUPER_AGENT_RUNS_KEY));
  assert.equal(runs[`health:${KIMI_RUNTIME}`].status,'blocked','宿主读不到时目标运行必须停住');
  assert.match(dom.app.innerHTML,/状态读取失败/,'界面要能看到运行已经停住');
});
