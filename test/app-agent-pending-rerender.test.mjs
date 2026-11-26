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

// 请求在途时重新配对会换掉 agentConfig：等待态的清理只认「我这条还是当前的那一条」，
// 不能挂在配置守卫下，否则旧请求结束后留下一条永久的假等待（转圈的界面）。
test('the legacy chat drops its connecting row when the binding changes mid-request',async()=>{
  const dom=installDomStub({storage:{[AGENT_KEY]:JSON.stringify({token:'token-a',baseURL:'https://along.test',runtime:'kimi-code-swarm'})}});
  const pending=[];
  window.AlongAgentBridge={request:input=>{
    if (input.path==='/super-agent/goals') return new Promise((resolve,reject)=>{pending.push(reject);});
    if (input.path==='/pair') return Promise.resolve({token:'b'.repeat(64)});
    return Promise.resolve({});
  }};
  await import(`../web/app.mjs?legacy-rebind=${Date.now()}`);
  await dom.click({action:'edit-goal'});
  const submitted=dom.submit();
  await Promise.resolve();
  assert.match(dom.app.innerHTML,/正在连接/,'请求在途时显示等待');
  // 请求在途时重新配对：agentConfig 换成新对象，旧请求的清理必须照样发生。
  await dom.app.dispatch('submit',{target:{id:'pair-form',fields:{code:'123456',baseURL:'https://along.test'},
    querySelector:()=>null,reset(){},setAttribute(){}},preventDefault(){}});
  for (const reject of pending) reject(Error('宿主暂时不可用'));
  await submitted;
  await dom.click({action:'agent-back'});
  await dom.click({action:'edit-goal'});
  assert.doesNotMatch(dom.app.innerHTML,/正在连接/,'重新配对后不留永久的假等待');
});
