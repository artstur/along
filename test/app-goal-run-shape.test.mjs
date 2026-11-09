import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const GOAL_RUNS_KEY='along.goal-super-agent-runs.v1';
const AGENT_KEY='along.agent.v1';
const RUNTIME_KEY='along.agent-runtime.v1';

const agentConfig={baseURL:'https://192.168.1.2:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};

// 目标编排记录由仓库外的 DSH 服务给出：ticket.id 不保证是字符串。
const goalRunWithNumericTicket={
  actual:true,version:1,kind:'goal',runtime:'dsh-superagent',requestId:'req-goal-1',
  source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'正在提交给 DSH'},
  assignments:[],agents:[],events:[],ticket:{id:12345},status:'done',statusLabel:'编排完成',progress:100,
};

test('a goal run with a non-string ticket id does not freeze the agent page',async()=>{
  const dom=installDomStub({storage:{
    [GOAL_RUNS_KEY]:JSON.stringify({'health:dsh-superagent':goalRunWithNumericTicket}),
    [AGENT_KEY]:JSON.stringify(agentConfig),
    [RUNTIME_KEY]:JSON.stringify('dsh-superagent'),
  }});
  await import('../web/app.mjs?goal-numeric-ticket');
  // 目标编排面板会显示 ticket.id 的前八位。ticket.id 不是字符串时不能对它调用
  // .slice()——那会在 render() 里抛 TypeError，整个界面停在旧页面上。
  await dom.click({action:'edit-goal'});
  assert.match(dom.app.innerHTML,/编排完成/,'目标编排面板要画得出来，不能让 render() 抛错');
  assert.doesNotMatch(dom.app.innerHTML,/12345/,'脏的 ticket.id 不该被当成可显示的工单号');
});

// 宿主返回了过不了本地白名单的目标编排记录：缺 kind / agents / events。
const untrustedGoalRun={
  actual:true,runtime:'dsh-superagent',requestId:'req-goal-2',status:'done',statusLabel:'编排完成',
  error:'宿主说这条记录不可信',
};

test('an untrusted goal run record shows the host reason instead of vanishing',async()=>{
  const dom=installDomStub({storage:{
    [GOAL_RUNS_KEY]:JSON.stringify({'health:dsh-superagent':untrustedGoalRun}),
    [AGENT_KEY]:JSON.stringify(agentConfig),
    [RUNTIME_KEY]:JSON.stringify('dsh-superagent'),
  }});
  await import('../web/app.mjs?untrusted-goal-run');
  // 记录存在却过不了白名单时，不能当作「没有记录」：那会让整个编排面板
  // 静默消失，宿主给的原因用户永远看不到。
  await dom.click({action:'edit-goal'});
  assert.match(dom.app.innerHTML,/goal-orchestration/,'不可信的目标编排记录也要有明确的落点，不能静默消失');
  assert.match(dom.app.innerHTML,/宿主说这条记录不可信/,'宿主给的原因要能被看到');
});

test('an untrusted goal run in the legacy key is cleared once the connection is ready',async()=>{
  const dom=installDomStub({storage:{
    [GOAL_RUNS_KEY]:JSON.stringify({health:untrustedGoalRun}),
    [AGENT_KEY]:JSON.stringify(agentConfig),
    [RUNTIME_KEY]:JSON.stringify('dsh-superagent'),
  }});
  globalThis.window.AlongAgentBridge={
    request:({path})=>Promise.resolve(path==='/connection/status'?{along:true,ready:true,runtime:'dsh-superagent'}:{}),
  };
  await import('../web/app.mjs?legacy-untrusted-goal-run');
  await dom.click({action:'edit-goal'});
  await new Promise(resolve=>setTimeout(resolve,0));
  await new Promise(resolve=>setTimeout(resolve,0));
  const stored=JSON.parse(dom.storage.get(GOAL_RUNS_KEY));
  // 旧键里存着的坏记录要能被清掉：否则那条失败状态会一直挂在存储里，
  // 用户每次打开都看到同一个坏状态，却没有任何出路。
  assert.equal(stored.health,undefined,'旧键里过不了白名单的记录要一起清掉');
});
