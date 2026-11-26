import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const config={baseURL:'https://localhost:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};

function installEventBridge(state={syncItems:[]}) {
  const requests=[];
  window.AlongAgentBridge={request:async input=>{
    requests.push(input);
    if(input.path==='/connection/status')return {along:true,ready:true,runtime:'dsh-superagent',eventProtocol:1,userId:'u_app_b'};
    if(input.path==='/events')return {status:'accepted',event_id:input.body.event_id};
    if(input.path==='/sync')return {status:'ok',items:state.syncItems.filter(item=>item.seq>input.body.after_seq)};
    if(input.path==='/sync/ack')return {status:'ok',acked:input.body.seqs.length};
    throw Error(`Unexpected old endpoint: ${input.path}`);
  }};
  return requests;
}

const settle=()=>new Promise(resolve=>setTimeout(resolve,30));

// 目标下拉框里那个空值选项就是「新建目标」的入口：它把用户带进新目标的对话流程，
// 所以文案必须说「新目标」，不能还说「新对话」——那会把人引向一条没有目标的普通对话。
test('the empty goal option in the goal picker is labelled 新目标, not 新对话',async()=>{
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  document.visibilityState='visible';
  installEventBridge();
  await import(`../web/app.mjs?new-goal-label=${Date.now()}`);
  await settle();
  const html=dom.app.innerHTML;
  assert.match(html,/<option value=""[^>]*>新目标<\/option>/,'目标下拉框的空值项必须显示「新目标」');
  assert.doesNotMatch(html,/新对话/,'这一处不该再出现「新对话」');
});

test('picking the empty goal option still starts the new-goal conversation flow',async()=>{
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  document.visibilityState='visible';
  installEventBridge();
  await import(`../web/app.mjs?new-goal-flow=${Date.now()}`);
  await settle();
  await dom.click({action:'new-goal'});
  await settle();
  // 改了文案不能改行为：点「新建」仍然要进入现有的新建对话流程。
  assert.match(dom.app.innerHTML,/agent-composer/,'点「新建」后仍要进入新建对话流程');
  assert.match(dom.app.innerHTML,/data-action="agent-back"/,'新建对话仍要有返回入口');
});
