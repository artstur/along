import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const AGENT_KEY='along.agent.v1';

// 旧 Host 兼容聊天页（没有事件工作区）：提交时把三点提示插进 DOM，之后的任何重渲染
// 都不能把它弄丢。真正结束它的是这次请求本身有了结果，而不是某次页面重绘。
test('the legacy chat keeps its connecting row across a re-render and clears it with the request',async()=>{
  const dom=installDomStub({storage:{[AGENT_KEY]:JSON.stringify({token:'token-a',baseURL:'https://along.test',runtime:'kimi-code-swarm'})}});
  const pending=[];
  window.AlongAgentBridge={request:()=>new Promise((resolve,reject)=>{pending.push(reject);})};
  await import(`../web/app.mjs?legacy-pending=${Date.now()}`);
  await dom.click({action:'edit-goal'});
  const submitted=dom.submit();
  await Promise.resolve();
  await dom.click({action:'agent-back'});
  assert.doesNotMatch(dom.app.innerHTML,/正在连接/,'回到目标页时不再显示原对话的等待');
  await dom.click({action:'edit-goal'});
  assert.match(dom.app.innerHTML,/正在连接/,'重新进入同一对话时，未完成的请求仍然在等待');
  for (const reject of pending) reject(Error('宿主暂时不可用'));
  await submitted;
  assert.doesNotMatch(dom.app.innerHTML,/正在连接/,'请求结束后提示消失，不留下假的等待');
});
