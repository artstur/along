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
    if(input.path==='/sync')return {items:state.syncItems.filter(item=>item.seq>input.body.after_seq)};
    if(input.path==='/sync/ack')return {acked:input.body.seqs.length};
    throw Error(`Unexpected old endpoint: ${input.path}`);
  }};
  return requests;
}

const settle=()=>new Promise(resolve=>setTimeout(resolve,30));

test('a new-goal conversation always has a standard way back',async()=>{
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  document.visibilityState='visible';
  const bridge={syncItems:[]};
  const requests=installEventBridge(bridge);
  await import(`../web/app.mjs?event-back=${Date.now()}`);
  await settle();
  assert.match(dom.app.innerHTML,/data-action="agent-back"/,'空白新对话也必须有返回入口');
  assert.match(dom.app.innerHTML,/class="back-button icon-only"/,'要复用全局的标准返回组件');
  await dom.app.dispatch('input',{target:{matches:selector=>selector==='#agent-form textarea',value:'一条未发送的合成草稿',style:{},scrollHeight:48}});
  assert.match(dom.app.innerHTML,/data-action="agent-back"/,'输入草稿时返回入口不得消失');
  await dom.click({action:'agent-back'});
  assert.doesNotMatch(dom.app.innerHTML,/agent-composer/,'没有已存目标时要回到简洁首页，不能留在同一个对话页');
  await dom.click({action:'new-goal'});
  assert.match(dom.app.innerHTML,/一条未发送的合成草稿/,'返回再重开新对话时，未发送文字必须恢复');
  const submit=message=>dom.app.dispatch('submit',{target:{id:'agent-form',fields:{message},querySelector:()=>null,reset(){},setAttribute(){}},preventDefault(){}});
  await submit('一条合成目标');await settle();
  const eventId=requests.find(item=>item.path==='/events').body.event_id;
  assert.match(dom.app.innerHTML,/data-action="agent-back"/,'本地队列已保存时返回入口不得消失');
  await dom.app.dispatch('input',{target:{matches:selector=>selector==='#agent-form textarea',value:'首句发送后的合成补充',style:{},scrollHeight:48}});
  await dom.click({action:'agent-back'});
  assert.doesNotMatch(dom.app.innerHTML,/agent-composer/);
  await dom.click({action:'new-goal'});
  assert.match(dom.app.innerHTML,/一条合成目标/,'重开时要恢复已发送的原会话');
  assert.match(dom.app.innerHTML,/首句发送后的合成补充/,'重开时要恢复首句后的未发送补充');
  bridge.syncItems=[{seq:1,userId:'u_app_b',kind:'delivery_failed',payload:{event_id:eventId}}];
  await dom.tick(3000);await settle();
  assert.match(dom.app.innerHTML,/发送未完成/);
  assert.match(dom.app.innerHTML,/data-action="agent-back"/,'发送失败时返回入口不得消失');
  bridge.syncItems.push({seq:2,userId:'u_app_b',kind:'message',payload:{conversation_id:eventId,
    message:{id:'msg_reply',eventId:'evt_reply',role:'assistant',direction:'outbound',text:'这是脱敏的合成回复',seq:2,causationId:eventId}}});
  await dom.tick(3000);await settle();
  assert.match(dom.app.innerHTML,/这是脱敏的合成回复/);
  assert.match(dom.app.innerHTML,/data-action="agent-back"/,'已有回复时返回入口不得消失');
  await dom.click({action:'agent-back'});
  assert.doesNotMatch(dom.app.innerHTML,/agent-composer/);
  assert.match(dom.app.innerHTML,/当前目标/);
});

test('the real app discovers the new protocol, uses events during ongoing work, and renders synced goals without adoption or direct mutation',async()=>{
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  document.visibilityState='visible';
  let current=[],seq=0;
  const requests=[];
  let healthImports=0,healthEventBindings=0;
  window.AlongHealthBridge={healthEvents:async()=>{healthEventBindings++;return {enabled:true};},connect:async()=>{
    healthImports++;return {contextReviewAllowed:true,selectedTypes:['steps'],steps:1200,capturedAt:new Date().toISOString()};
  }};
  window.AlongAgentBridge={request:async input=>{
    requests.push(input);
    if(input.path==='/connection/status')return {along:true,ready:true,runtime:'dsh-superagent',eventProtocol:1,userId:'u_app_b'};
    if(input.path==='/events')return {status:'accepted',event_id:input.body.event_id};
    if(input.path==='/sync')return {items:current.filter(item=>item.seq>input.body.after_seq)};
    if(input.path==='/sync/ack')return {acked:input.body.seqs.length};
    throw Error(`Unexpected old endpoint: ${input.path}`);
  }};
  await import(`../web/app.mjs?event-app=${Date.now()}`);
  await settle();
  assert.match(dom.app.innerHTML,/说说你想做什么/);
  const submit=message=>dom.app.dispatch('submit',{target:{id:'agent-form',fields:{message},querySelector:()=>null,reset(){},setAttribute(){}},preventDefault(){}});
  await submit('我想改善睡眠');await settle();
  await submit('先从睡前放下手机开始');await settle();
  const sent=requests.filter(item=>item.path==='/events');
  assert.equal(sent.length,2,'a second message is allowed while the agent is still working');
  assert.equal(sent[1].body.causation_id,sent[0].body.event_id);
  const snapshot={goal:{id:'g_app_b',domain:'custom',status:'active',currentRevision:1},revision:{goalId:'g_app_b',revision:1,title:'改善睡眠',status:'active'},
    tasks:[{id:'t_app_b',goalId:'g_app_b',content:'睡前放下手机',status:'open',currentRevision:1}]};
  current=[{seq:++seq,userId:'u_app_b',kind:'message',goalId:'g_app_b',payload:{snapshot,conversation_id:sent[0].body.event_id,
    message:{id:'msg:u_app_b:'+sent[0].body.event_id,eventId:sent[0].body.event_id,role:'user',direction:'inbound',text:'我想改善睡眠',seq:1}}}];
  await dom.tick(3000);await settle();
  assert.match(dom.app.innerHTML,/改善睡眠/);
  await dom.click({action:'agent-back'});
  assert.match(dom.app.innerHTML,/睡前放下手机/);
  assert.match(dom.app.innerHTML,/event-health-connect/);
  await dom.click({action:'event-health-connect'});await settle();
  assert.equal(healthImports,1);
  assert.ok(healthEventBindings>=2,'protocol discovery and import both configure native event delivery');
  assert.match(dom.app.innerHTML,/所选健康摘要变化后/);
  assert.equal(requests.filter(item=>item.path==='/events').length,2,'the native outbox owns health uploads; the web app sends only chat');
  assert.doesNotMatch(dom.app.innerHTML,/accept-goal|accept-task|edit-goal|delete-goal|select-runtime|采用/);
  await dom.click({action:'accept-goal',requestId:'forged'});
  assert.equal(requests.some(item=>item.path.startsWith('/super-agent/')),false);
});

test('a system notification opens its bound goal and focuses the exact task before acknowledging',async()=>{
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  document.visibilityState='visible';
  const item=(id,seq)=>({seq,userId:'u_app_b',kind:'goal_updated',goalId:id,payload:{snapshot:{
    goal:{id,domain:'custom',status:'active',currentRevision:1},revision:{goalId:id,revision:1,title:id,status:'active'},
    tasks:[{id:'t_'+id,goalId:id,status:'open',content:'测试任务 '+id,currentRevision:1}]}}});
  installEventBridge({syncItems:[item('goal_one',1),item('goal_two',2)]});
  const receipts=[],focused=[];
  window.AlongAgentBridge.notification=async (name,value)=>{if(name==='eventTaskOpened')receipts.push(value);return {};};
  document.getElementById=id=>dom.app.innerHTML.includes('id="'+id+'"')?{focus:()=>focused.push(id),scrollIntoView(){}}:null;
  await import(`../web/app.mjs?event-click=${Date.now()}`);await settle();
  await dom.fireWindow('along-notification-open',{detail:{userId:'u_other',goalId:'goal_two',taskId:'t_goal_two',eventId:'e_one'}});
  assert.equal(receipts.length,0);
  await dom.fireWindow('along-notification-open',{detail:{userId:'u_app_b',goalId:'goal_two',taskId:'t_goal_two',eventId:'e_two'}});
  await settle();assert.match(dom.app.innerHTML,/<h1>goal_two<\/h1>/);
  assert.deepEqual(focused,['event-task-t_goal_two']);assert.equal(receipts.at(-1).taskId,'t_goal_two');
});
