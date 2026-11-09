import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const ACTIVE_GOAL_KEY='along.active-goal.v1';
const CONVERSATIONS_KEY='along.goal-conversations.v1';
const GOAL_RUNS_KEY='along.goal-super-agent-runs.v1';
const AGENT_KEY='along.agent.v1';
const RUNTIME_KEY='along.agent-runtime.v1';

const agentConfig={baseURL:'https://192.168.1.2:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};

// 本地占位记录：请求刚发出、结果还没回来时写进存储的那一条。
const pendingRun={
  version:1,actual:false,runtime:'dsh-superagent',kind:'goal',requestId:'req-draft-1',
  input:{goal:{domain:'custom',title:'定义我的新目标',target:null},message:'我想在今年跑完一个半马'},
  source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'正在提交给 DSH'},
  agents:[],events:[],assignments:[],result:null,status:'working',statusLabel:'正在提交给 DSH',progress:2,
};

const draftStorage={
  [ACTIVE_GOAL_KEY]:'custom:goal-abc',
  [CONVERSATIONS_KEY]:JSON.stringify({health:[],finance:[],custom:[],'custom:goal-abc':[{role:'user',text:'我想在今年跑完一个半马'}]}),
  [GOAL_RUNS_KEY]:JSON.stringify({'custom:goal-abc:dsh-superagent':pendingRun}),
  [RUNTIME_KEY]:'dsh-superagent',
};

test('a new goal is written to the device before the agent answers',async()=>{
  const dom=installDomStub({});
  await import('../web/app.mjs?new-goal-draft');
  await dom.click({action:'new-goal'});
  const active=dom.storage.get(ACTIVE_GOAL_KEY);
  assert.match(active??'',/^custom:/,'新建目标要落盘成当前目标，重启后才回得来');
  const conversations=JSON.parse(dom.storage.get(CONVERSATIONS_KEY));
  assert.ok(Array.isArray(conversations[active]),'新建目标的对话要落盘');
});

test('a restart brings the unfinished new goal back',async()=>{
  const dom=installDomStub({storage:{...draftStorage}});
  await import('../web/app.mjs?new-goal-restart');
  const html=dom.app.innerHTML;
  // 用户写下的那句话不能因为重启就消失。
  assert.match(html,/我想在今年跑完一个半马/,`重启后要回到新目标那一页：${html.slice(0,400)}`);
  assert.match(html,/agent-composer/,'重启后要回到新目标那一页');
  assert.doesNotMatch(html,/goal-switch/,'重启后不该停在首页');
});

test('a run interrupted by a restart does not lock the composer',async()=>{
  const dom=installDomStub({storage:{...draftStorage,[AGENT_KEY]:JSON.stringify(agentConfig)}});
  await import('../web/app.mjs?interrupted-run');
  const html=dom.app.innerHTML;
  // App 关掉时那次请求就没有下文了：落成明确终态，别把用户锁在一页禁用的输入框上。
  assert.doesNotMatch(html,/Super Agent 编排中/,'被重启打断的运行不该继续显示编排中');
  assert.match(html,/需要重发/,'要告诉用户这次请求没有结果');
  assert.doesNotMatch(html,/<textarea[^>]*disabled/,'输入框不能被锁死');
  assert.doesNotMatch(html,/class="agent-send"[^>]*disabled/,'发送按钮不能被锁死');
});

test('a restart resumes an unfinished run even without a saved message',async()=>{
  const dom=installDomStub({storage:{
    [ACTIVE_GOAL_KEY]:'custom:goal-abc',
    [GOAL_RUNS_KEY]:JSON.stringify({'custom:goal-abc:dsh-superagent':pendingRun}),
  }});
  await import('../web/app.mjs?new-goal-pending-run');
  assert.match(dom.app.innerHTML,/agent-composer/,'还有没跑完的运行时，重启后要回到那一页继续等');
});

test('an empty new goal does not hijack the home page after a restart',async()=>{
  const dom=installDomStub({storage:{
    [ACTIVE_GOAL_KEY]:'custom:goal-abc',
    [CONVERSATIONS_KEY]:JSON.stringify({health:[],finance:[],custom:[],'custom:goal-abc':[]}),
  }});
  await import('../web/app.mjs?new-goal-empty');
  // 空的草稿不是目标：首页要显示真正的健康目标，而不是一个幽灵自定义目标。
  assert.match(dom.app.innerHTML,/健康目标/,'首页不能渲染幽灵自定义目标');
  assert.doesNotMatch(dom.app.innerHTML,/个人目标/);
  assert.equal(dom.storage.get(ACTIVE_GOAL_KEY),'health','当前目标指针要回到真正的目标');
});

test('an abandoned draft is removed from the device for good',async()=>{
  const dom=installDomStub({storage:{...draftStorage}});
  await import('../web/app.mjs?abandon-draft');
  await dom.click({action:'agent-back'});
  // 放弃的草稿：对话、运行记录、当前目标指针都要删掉。
  // 少删一样，它就会在下一次重启时自己复活。
  assert.equal(dom.storage.get(ACTIVE_GOAL_KEY),'health','当前目标指针要指回真正的目标');
  const conversations=JSON.parse(dom.storage.get(CONVERSATIONS_KEY));
  assert.equal(conversations['custom:goal-abc'],undefined,'废弃的对话要删掉');
  const runs=JSON.parse(dom.storage.get(GOAL_RUNS_KEY));
  assert.equal(runs['custom:goal-abc:dsh-superagent'],undefined,'废弃的运行记录要删掉');
});

test('an abandoned draft does not come back after a restart',async()=>{
  const dom=installDomStub({storage:{...draftStorage}});
  await import('../web/app.mjs?abandon-then-restart');
  await dom.click({action:'agent-back'});
  const carried=Object.fromEntries(dom.store);
  const dom2=installDomStub({storage:carried});
  await import('../web/app.mjs?abandon-then-restart-2');
  assert.doesNotMatch(dom2.app.innerHTML,/我想在今年跑完一个半马/,'放弃的草稿不能再复活');
  assert.match(dom2.app.innerHTML,/健康目标/,'重启后要停在真正的目标上');
});
