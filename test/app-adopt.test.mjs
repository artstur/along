import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const CONVERSATIONS_KEY='along.goal-conversations.v1';
const GOALS_KEY='along.goal-custom.v1';

function proposal(title,target) {
  return {title,target,task:`${title}的任务`,reason:`${title}的理由`};
}

// 提案卡片上的句柄：渲染里可能带下标，也可能带稳定 id，测试只关心点它会落到哪个提案。
function handleOf(html,label) {
  const chunk=html.split('<div class="agent-message').find(part=>part.includes(label));
  assert.ok(chunk,`渲染结果里找不到「${label}」`);
  return {
    index:chunk.match(/data-index="(\d+)"/)?.[1],
    requestId:chunk.match(/data-request-id="([^"]*)"/)?.[1],
  };
}

test('the adopt button applies the proposal it was rendered for, even after the conversation rolls over',async()=>{
  const entries=[];
  for (let index=0;index<18;index++) entries.push({role:index%2?'assistant':'user',text:`第 ${index} 条`});
  entries.push({role:'assistant',text:'提案A',proposal:proposal('提案A',150),requestId:'along-goal-health-a'});
  entries.push({role:'assistant',text:'提案B',proposal:proposal('提案B',180),requestId:'along-goal-health-b'});
  const dom=installDomStub({storage:{[CONVERSATIONS_KEY]:JSON.stringify({health:entries,finance:[],custom:[]})}});
  await import('../web/app.mjs');
  await dom.click({action:'edit-goal'});
  const handle=handleOf(dom.app.innerHTML,'提案A');
  await dom.submit();
  await dom.click({action:'accept-goal',index:handle.index,requestId:handle.requestId});
  const goals=JSON.parse(dom.storage.get(GOALS_KEY)||'{}');
  assert.equal(goals.health?.title,'提案A');
});
