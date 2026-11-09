import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const ACTIVE_GOAL_KEY='along.active-goal.v1';
const CONVERSATIONS_KEY='along.goal-conversations.v1';
const GOAL_RUNS_KEY='along.goal-super-agent-runs.v1';

const pendingRun={
  version:1,actual:false,runtime:'dsh-superagent',kind:'goal',requestId:'req-draft-1',
  input:{goal:{domain:'custom',title:'定义我的新目标',target:null},message:'我想在今年跑完一个半马'},
  source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'正在提交给 DSH'},
  agents:[],events:[],assignments:[],result:null,status:'working',statusLabel:'正在提交给 DSH',progress:2,
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
  const dom=installDomStub({storage:{
    [ACTIVE_GOAL_KEY]:'custom:goal-abc',
    [CONVERSATIONS_KEY]:JSON.stringify({health:[],finance:[],custom:[],'custom:goal-abc':[{role:'user',text:'我想在今年跑完一个半马'}]}),
  }});
  await import('../web/app.mjs?new-goal-restart');
  const html=dom.app.innerHTML;
  // 用户写下的那句话不能因为重启就消失。
  assert.match(html,/我想在今年跑完一个半马/,`重启后要回到新目标那一页：${html.slice(0,400)}`);
  assert.match(html,/agent-composer/,'重启后要回到新目标那一页');
  assert.doesNotMatch(html,/goal-switch/,'重启后不该停在首页');
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
  assert.match(dom.app.innerHTML,/goal-switch/,'空草稿没什么可恢复的，重启后照常停在首页');
});
