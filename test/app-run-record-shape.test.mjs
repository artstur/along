import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {safeGoalSuperAgentRun, safeSuperAgentRun} from '../web/super-agent.mjs';

const ADAPTIVE_LAYOUTS_KEY='along.adaptive-layouts.v1';
const RUNS_KEY='along.super-agent-runs.v2';
const GOAL_RUNS_KEY='along.goal-super-agent-runs.v1';
const AGENT_KEY='along.agent.v1';
const RUNTIME_KEY='along.agent-runtime.v1';

const layout={
  version:1,title:'在晚班作息里保持健康',badge:'试运行',summary:'先验证真实作息。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'以读为主。'}],
  tasks:[{id:'sleep-check',when:'今晚',title:'记录真实作息',detail:'先记录实际离开工作地点、上床和起床时间。',state:'temporary'}],
  questions:[],
};

const agentConfig={baseURL:'https://192.168.1.2:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};

// 宿主给出的记录形状我们不认：缺 assignments / events。
// 注意 actual 不是 true —— 白名单的结构校验曾经被 actual===true 门控，
// 于是这种记录能混过白名单，渲染时 run.assignments 直接抛 TypeError。
const malformedTaskRun={
  version:2,actual:false,runtime:'kimi-code-swarm',requestId:'req-bad-1',
  status:'working',statusLabel:'Kimi Main Session 正在拆解',progress:20,
};

const malformedGoalRun={
  version:1,kind:'goal',actual:false,runtime:'dsh-superagent',requestId:'req-bad-2',
  status:'working',statusLabel:'正在提交给 DSH',progress:20,
};

test('a run record without the fields the renderer needs never passes the whitelist',()=>{
  assert.equal(safeSuperAgentRun(malformedTaskRun),null,'缺 assignments / events 的任务记录不能过白名单');
  assert.equal(safeGoalSuperAgentRun(malformedGoalRun),null,'缺 agents / events 的目标记录不能过白名单');
});

test('a malformed run record does not freeze the task page',async()=>{
  const dom=installDomStub({storage:{
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:layout,finance:null,custom:null}),
    [RUNS_KEY]:JSON.stringify({'health:kimi-code-swarm:sleep-check':malformedTaskRun}),
  }});
  await import('../web/app.mjs?malformed-task-run');
  // 白名单与渲染层对「一条记录有哪些字段」的假设必须一致：
  // 白名单放行的记录，渲染层就不能在它身上抛错。
  await dom.click({action:'open-task',taskId:'sleep-check'});
  assert.match(dom.app.innerHTML,/任务协作/,'任务页要画得出来，不能让 render() 抛错');
  assert.doesNotMatch(dom.app.innerHTML,/连接 Kimi Code Swarm/,'过不了白名单的记录不能被换成假的「正在连接」');
});

// 白名单只检查数组本身是数组，不检查里面的元素：数组里有 null 时，
// 渲染层直接读 event.at / agent.status 会抛 TypeError，整个界面卡住。
const runWithNullElements={
  actual:true,version:2,runtime:'kimi-code-swarm',requestId:'req-null-1',
  source:{kind:'along',label:'Along 动态任务'},trigger:{kind:'dynamic-task',label:'正在提交给 Kimi'},
  assignments:[null],events:[null],status:'working',statusLabel:'Kimi Main Session 正在拆解',progress:20,
  mandate:{strength:'explicit',actor:{id:'a1'},policyVersion:12345},
};

test('a run record with null elements or a non-string policy version does not freeze the task page',async()=>{
  const dom=installDomStub({storage:{
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:layout,finance:null,custom:null}),
    [RUNS_KEY]:JSON.stringify({'health:kimi-code-swarm:sleep-check':runWithNullElements}),
  }});
  await import('../web/app.mjs?null-run-elements');
  await dom.click({action:'open-task',taskId:'sleep-check'});
  assert.match(dom.app.innerHTML,/任务协作/,'任务页要画得出来，不能让 render() 抛错');
  assert.doesNotMatch(dom.app.innerHTML,/12345/,'非字符串的策略版本号不该被当成可显示的文本');
});
