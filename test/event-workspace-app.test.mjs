import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

test('the real app discovers the new protocol, uses events during ongoing work, and renders synced goals without adoption or direct mutation',async()=>{
  const config={baseURL:'https://localhost:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};
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
  const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
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
