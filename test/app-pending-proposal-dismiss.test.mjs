import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const TICKET_KEY='along.goal-ticket.v1';

const waitingTicket={
  id:'ticket-2',source:'healthkit',trigger:{from:75,to:110},eval:'replan',
  mandate:'仅提出任务，用户确认后才采用',reason:'本周新增 35 分钟，距目标从 45 分钟变为 10 分钟',
  status:'waiting',error:'Along 正在处理上一条请求，请稍后再试',
};

test('a pending proposal without a suggestion can still be dismissed',async()=>{
  const dom=installDomStub({storage:{[TICKET_KEY]:JSON.stringify(waitingTicket)}});
  await import('../web/app.mjs?pending-proposal-dismiss');
  assert.match(dom.app.innerHTML,/保留原任务/,'还没有建议时也要能保留原任务，否则这条提示永远留在首页');
  assert.doesNotMatch(dom.app.innerHTML,/采用这一步/,'还没有建议，不能出现采用按钮');
  await dom.click({action:'dismiss-task'});
  assert.equal(dom.storage.get(TICKET_KEY),null,'提示要能被移除');
  assert.doesNotMatch(dom.app.innerHTML,/保留原任务/,'移除后不能再显示这条提示');
});

test('a proposal with a suggestion still offers both choices',async()=>{
  const dom=installDomStub({storage:{[TICKET_KEY]:JSON.stringify({
    ...waitingTicket,status:'proposed',error:undefined,
    suggestion:{task:'安排 20 分钟拉伸',reason:'先把落下的部分补上'},
  })}});
  await import('../web/app.mjs?pending-proposal-both');
  assert.match(dom.app.innerHTML,/采用这一步/);
  assert.match(dom.app.innerHTML,/保留原任务/);
});
