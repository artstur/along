import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {safeGoalSuperAgentRun, safeSuperAgentRun} from '../web/super-agent.mjs';

const RUNS_KEY='along.super-agent-runs.v2';
const GOAL_RUNS_KEY='along.goal-super-agent-runs.v1';
const ADAPTIVE_LAYOUTS_KEY='along.adaptive-layouts.v1';
const RUNTIME_KEY='along.agent-runtime.v1';
const ACTIVE_GOAL_KEY='along.active-goal.v1';
const AGENT_KEY='along.agent.v1';

const agentConfig={baseURL:'https://192.168.1.2:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};

const layout={
  version:1,title:'在晚班作息里保持健康',badge:'试运行',summary:'先验证真实作息。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'以读为主。'}],
  tasks:[{id:'sleep-check',when:'今晚',title:'记录真实作息',detail:'先记录实际离开工作地点、上床和起床时间。',state:'temporary'}],
  questions:[],
};

// 宿主返回的记录里，文本字段的类型不对：对象、数组、布尔都不是文本。
// 用 String() 兜底会得到 "[object Object]"，那种脏文本会直接显示在用户界面上。
const dirtyTaskRun={
  actual:true,version:2,runtime:'dsh-superagent',requestId:'req-dirty-1',
  source:{kind:'along',label:{oops:true}},trigger:{kind:'dynamic-task',label:'正在提交给 DSH'},
  assignments:[{id:'a1',status:'working',objective:{summary:'拆解目标'},work:['并行工作'],progress:30}],
  events:[{at:1,text:{summary:'开始拆解'}},{at:2,text:'真实的一条工作记录'}],
  status:'working',statusLabel:{oops:true},progress:30,
};

test('the run whitelist refuses text that is not text',()=>{
  const run=safeSuperAgentRun(dirtyTaskRun);
  assert.ok(run,'结构没问题就不该整条作废');
  assert.equal(run.events.length,1,'没有可读文本的工作记录不该出现在时间线上');
  assert.equal(run.events[0].text,'真实的一条工作记录');
  assert.equal(run.assignments.length,1);
  assert.equal(run.assignments[0].objective,'未提供说明','脏文本不能冒充协作单元的说明');
  assert.equal(run.assignments[0].work,'');
  assert.equal(run.statusLabel,'状态未知');
  assert.equal(run.source.label,'未提供说明');
  assert.doesNotMatch(JSON.stringify(run),/\[object Object\]/,'整条记录里不能出现脏文本');
});

test('the goal run whitelist refuses text that is not text',()=>{
  const dirtyGoalRun={
    actual:true,version:1,kind:'goal',runtime:'dsh-superagent',requestId:'req-dirty-2',
    source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'正在提交给 DSH'},
    agents:[{id:'g1',status:'done',objective:{summary:'拆解目标'},progress:100}],
    events:[{at:1,text:true},{at:2,text:'真实的一条工作记录'}],
    status:'done',statusLabel:'编排完成',progress:100,
  };
  const run=safeGoalSuperAgentRun(dirtyGoalRun);
  assert.ok(run);
  assert.equal(run.events.length,1,'布尔值不是文本，不能出现在工作记录里');
  assert.equal(run.agents[0].objective,'未提供说明');
  assert.doesNotMatch(JSON.stringify(run),/\[object Object\]/);
});

test('a clean run record is passed through untouched',()=>{
  const cleanRun={
    actual:true,version:2,runtime:'dsh-superagent',requestId:'req-clean-1',
    source:{kind:'along',label:'Along 动态任务'},trigger:{kind:'dynamic-task',label:'正在提交给 DSH'},
    assignments:[{id:'a1',status:'done',objective:'拆解目标',work:'已回传结果',progress:100}],
    events:[{at:1,text:'开始拆解'}],
    status:'done',statusLabel:'编排完成',progress:100,
  };
  assert.equal(safeSuperAgentRun(cleanRun),cleanRun,'干净的记录不该被换掉');
});

test('the run whitelist also covers the state badge and the mandate',()=>{
  // 渲染层直接读 agent.status 与 mandate.actor.id / mandate.scope：
  // 白名单漏掉它们，用户就能在卡片上看到 "[object Object]"。
  const dirty={
    actual:true,version:2,runtime:'dsh-superagent',requestId:'req-dirty-3',
    source:{kind:'along',label:'Along 动态任务'},trigger:{kind:'dynamic-task',label:'正在提交给 DSH'},
    assignments:[{id:'a1',status:{code:'working'},objective:'拆解目标',progress:30}],
    events:[{at:1,text:'开始拆解'}],
    mandate:{strength:'explicit',actor:{id:{oops:true}},policyVersion:'v1'},
    status:'working',statusLabel:'编排中',progress:30,
  };
  const run=safeSuperAgentRun(dirty);
  assert.doesNotMatch(JSON.stringify(run),/\[object Object\]/,'整条记录里不能出现脏文本');
  assert.equal(run.assignments[0].status,'','状态标签不是文本就不能当状态显示');
  assert.equal(run.mandate.actor.id,undefined,'请求者不是文本就交给渲染层的兜底');
});

test('a dirty run record never shows dirty text on the task page',async()=>{
  const dom=installDomStub({storage:{
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:layout,finance:null,custom:null}),
    [AGENT_KEY]:JSON.stringify(agentConfig),
    [RUNTIME_KEY]:'dsh-superagent',
    [RUNS_KEY]:JSON.stringify({'health:dsh-superagent:sleep-check':dirtyTaskRun}),
  }});
  // 打开任务页会真的向宿主要一次运行记录：宿主给回来的就是这份脏记录。
  globalThis.window.AlongAgentBridge={request:async({path})=>path==='/super-agent/tasks'?{run:dirtyTaskRun}:{}};
  await import('../web/app.mjs?dirty-run-text');
  await dom.click({action:'open-task',taskId:'sleep-check'});
  await new Promise(resolve=>setTimeout(resolve,0));
  await new Promise(resolve=>setTimeout(resolve,0));
  const html=dom.app.innerHTML;
  assert.match(html,/任务协作/,'任务页要画得出来');
  assert.doesNotMatch(html,/\[object Object\]/,'任务协作页不能出现脏文本');
  assert.match(html,/真实的一条工作记录/,'真实的工作记录要照常显示');
});

test('a dirty goal run record never shows dirty text on the goal page',async()=>{
  const dirtyGoalRun={
    actual:true,version:1,kind:'goal',runtime:'dsh-superagent',requestId:'req-dirty-goal',
    source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'正在提交给 DSH'},
    agents:[{id:'g1',status:{code:'done'},objective:'拆解目标',progress:100}],
    events:[{at:1,text:'开始拆解'}],
    mandate:{scope:{oops:true},strength:'explicit',actor:{id:{oops:true}}},
    status:'done',statusLabel:'编排完成',progress:100,
  };
  const dom=installDomStub({storage:{
    [AGENT_KEY]:JSON.stringify(agentConfig),
    [RUNTIME_KEY]:'dsh-superagent',
    [ACTIVE_GOAL_KEY]:'custom:goal-abc',
    [GOAL_RUNS_KEY]:JSON.stringify({'custom:goal-abc:dsh-superagent':dirtyGoalRun}),
  }});
  await import('../web/app.mjs?dirty-goal-run-text');
  const html=dom.app.innerHTML;
  assert.match(html,/agent-composer/,'目标页要画得出来');
  assert.doesNotMatch(html,/\[object Object\]/,'目标编排面板不能出现脏文本');
  assert.match(html,/仅围绕本次目标进行拆解/,'授权边界的兜底文案要接上');
});
