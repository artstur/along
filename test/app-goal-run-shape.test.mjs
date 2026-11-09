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
