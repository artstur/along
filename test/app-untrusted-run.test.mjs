import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const ADAPTIVE_LAYOUTS_KEY='along.adaptive-layouts.v1';
const RUNS_KEY='along.super-agent-runs.v2';
const AGENT_KEY='along.agent.v1';

const layout={
  version:1,title:'在晚班作息里保持健康',badge:'试运行',summary:'先验证真实作息。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'以读为主。'}],
  tasks:[{id:'sleep-check',when:'今晚',title:'记录真实作息',detail:'先记录实际离开工作地点、上床和起床时间。',state:'temporary'}],
  questions:[],
};

const agentConfig={baseURL:'https://192.168.1.2:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};
const runKey='health:kimi-code-swarm:sleep-check';

// 宿主返回了过不了本地白名单的真实记录：缺 assignments / events。
const untrustedRun={
  actual:true,runtime:'kimi-code-swarm',requestId:'req-1',status:'done',
  statusLabel:'已完成',error:'Kimi 长时间没有返回结果',
};

const compliantRun={
  actual:true,version:2,runtime:'kimi-code-swarm',requestId:'req-2',
  source:{kind:'along',label:'Along 动态任务'},trigger:{kind:'dynamic-task',label:'正在提交给 Kimi'},
  assignments:[],events:[],status:'working',statusLabel:'Kimi Main Session 正在拆解',progress:20,
};

test('an untrusted run record is not replaced by a fake connecting run',async()=>{
  const dom=installDomStub({storage:{
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:layout,finance:null,custom:null}),
    [AGENT_KEY]:JSON.stringify(agentConfig),
  }});
  let submittedId;
  globalThis.window.AlongAgentBridge={
    request:async({path,body})=>{
      if (path==='/super-agent/tasks') {
        submittedId=body.requestId;
        return {run:{...compliantRun,requestId:submittedId}};
      }
      if (path==='/super-agent/tasks/status') return {...untrustedRun,requestId:submittedId};
      return {};
    },
  };
  await import('../web/app.mjs?untrusted-run');
  await dom.click({action:'open-task',taskId:'sleep-check'});
  await new Promise(resolve=>setTimeout(resolve,0));
  await dom.tick(4_000);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(dom.app.innerHTML,/Kimi 长时间没有返回结果/,'宿主给的原因要能被看到');
  assert.doesNotMatch(dom.app.innerHTML,/连接 Kimi Code Swarm/,'不能拿一个假的「正在连接」盖住真实记录');
  const stored=JSON.parse(dom.storage.get(RUNS_KEY));
  assert.equal(stored[runKey]?.actual,true,'渲染不能把真实记录换成假记录');
  assert.equal(stored[runKey]?.requestId,submittedId,'真实记录的标识不能被换掉');
});

test('a valid run record is shown as it is',async()=>{
  const dom=installDomStub({storage:{
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:layout,finance:null,custom:null}),
    [AGENT_KEY]:JSON.stringify(agentConfig),
  }});
  let submittedId;
  globalThis.window.AlongAgentBridge={
    request:async({path,body})=>{
      if (path!=='/super-agent/tasks') return {};
      submittedId=body.requestId;
      return {run:{...compliantRun,requestId:submittedId}};
    },
  };
  await import('../web/app.mjs?trusted-run');
  await dom.click({action:'open-task',taskId:'sleep-check'});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(dom.app.innerHTML,/Kimi Main Session 正在拆解/,'宿主给的真实运行状态要照原样显示');
  const stored=JSON.parse(dom.storage.get(RUNS_KEY));
  assert.equal(stored[runKey]?.requestId,submittedId);
});
