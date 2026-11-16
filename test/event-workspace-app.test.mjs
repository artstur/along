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

function localNoticeSeed() {
  const localKey='custom:legacy';
  const layouts={[localKey]:{version:1,title:'本机原目标',summary:'旧记录',modules:[],questions:[],connections:[],
    tasks:[{id:'task_old',title:'原任务',detail:'原来保存的行动细节',when:'今天',state:'planned'}]}};
  return {'along.agent.v1':JSON.stringify(config),'along.event-connection.v1':JSON.stringify({userId:'u_app_b',fingerprint:config.fingerprint}),
    'along.adaptive-layouts.v1':JSON.stringify(layouts),'along.goal-custom.v1':JSON.stringify({[localKey]:{title:'本机原目标'}}),
    'along.active-goal.v1':localKey};
}
test('legacy notification reopens exactly its own saved task offline and returns to the event workspace',async()=>{
  const seed=localNoticeSeed(),dom=installDomStub({storage:seed});
  document.visibilityState='visible';
  const calls=[];window.AlongAgentBridge={request:async input=>{calls.push(input.path);throw Error('offline');}};
  await import(`../web/app.mjs?legacy-notice=${Date.now()}`);await settle();
  await dom.fireWindow('along-notification-open',{detail:{kind:'task',goalKey:'custom:legacy',taskId:'task_old',requestId:'old_run'}});
  assert.match(dom.app.innerHTML,/<h1>原任务<\/h1>/);
  assert.match(dom.app.innerHTML,/原来保存的行动细节/);
  assert.doesNotMatch(dom.app.innerHTML,/agent-composer|retry-task/);
  await dom.click({action:'local-task-back'});assert.match(dom.app.innerHTML,/<h1>本机原目标<\/h1>/);
  await dom.click({action:'new-goal'});assert.match(dom.app.innerHTML,/agent-composer/);
  for(const key of ['along.adaptive-layouts.v1','along.goal-custom.v1','along.active-goal.v1'])assert.equal(dom.storage.get(key),seed[key]);
  assert.ok(!calls.some(p=>p.startsWith('/super-agent')||p==='/events'));
});
test('already-saved event goals recover on launch without losing access to independent local records',async()=>{
  const seed=localNoticeSeed(),eventKey='along.event-workspace.v1:u_app_b';
  seed[eventKey]=JSON.stringify({version:1,userId:'u_app_b',cursor:1,activeGoalId:null,returnGoalId:null,conversationId:null,drafts:{},messages:{},
    goals:{g_saved:{id:'g_saved',domain:'custom',status:'active',revision:1,title:'服务端已存目标',metric:null,context:[],tasks:[]}}});
  const dom=installDomStub({storage:seed});installEventBridge();
  await import(`../web/app.mjs?restore-saved-event=${Date.now()}`);await settle();
  assert.match(dom.app.innerHTML,/<h1>服务端已存目标<\/h1>/);
  assert.match(dom.app.innerHTML,/本机原目标/);
  await dom.fireWindow('along-notification-open',{detail:{kind:'task',goalKey:'custom:legacy',taskId:'old_gone',reminderTitle:'调整前的原提醒'}});
  assert.match(dom.app.innerHTML,/<h1>本机原目标<\/h1>/);assert.match(dom.app.innerHTML,/调整前的原提醒/);
  await dom.click({action:'local-exit'});assert.match(dom.app.innerHTML,/<h1>服务端已存目标<\/h1>/);
});
test('cold legacy tap survives late pairing and live sync without stealing the view; new selection sees synced tasks',async()=>{
  const seed=localNoticeSeed();delete seed['along.event-connection.v1'];
  const dom=installDomStub({storage:seed});document.visibilityState='visible';
  let connect;const calls=[],ack=[];
  const snapshot={goal:{id:'legacy',domain:'custom',status:'active',currentRevision:1},revision:{goalId:'legacy',revision:1,title:'同名服务端目标',status:'active'},
    tasks:[{id:'task_old',goalId:'legacy',status:'open',content:'另一份服务端任务',currentRevision:1}]};
  window.AlongAgentBridge={
    request:async input=>{
      calls.push(input.path);
      if(input.path==='/connection/status')return new Promise(resolve=>{connect=resolve;});
      if(input.path==='/sync')return {items:input.body.after_seq?[]:[{seq:1,userId:'u_app_b',goalId:'legacy',kind:'task_updated',payload:{snapshot}}]};
      return {};
    },notification:async (name,value)=>{
      if(name==='pendingLegacyNotification')return {route:{legacyOpenId:'open_old',kind:'task',goalKey:'custom:legacy',taskId:'daily-sleep-day',
        planTaskId:'task_old',dailyTopic:'sleep',reminderTitle:'已预约的睡前提醒',reminderBody:'未授权睡眠摘要应隐藏'}};
      if(name==='legacyNotificationOpened')ack.push(value.id);
      return {};
    }};
  await import(`../web/app.mjs?late-local=${Date.now()}`);await settle();
  connect({along:true,ready:true,runtime:'dsh-superagent',eventProtocol:1,userId:'u_app_b'});await settle();
  await dom.tick(3000);await settle();assert.match(dom.app.innerHTML,/<h1>原任务<\/h1>/);
  assert.match(dom.app.innerHTML,/已预约的睡前提醒/);assert.doesNotMatch(dom.app.innerHTML,/另一份服务端任务|未授权睡眠摘要应隐藏/);
  assert.match(dom.app.innerHTML,/<option value="legacy"/);assert.deepEqual(ack,['open_old']);
  await dom.app.dispatch('change',{target:{id:'event-goal-select',value:'legacy'}});
  assert.match(dom.app.innerHTML,/<h1>同名服务端目标<\/h1>/);assert.match(dom.app.innerHTML,/另一份服务端任务/);
  assert.ok(!calls.some(p=>p==='/events'||p.startsWith('/super-agent')));
});
test('initial network sync opens the saved goal; user can intentionally return to an empty new chat through reconnect',async()=>{
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  const state={syncItems:[]};installEventBridge(state);
  await import(`../web/app.mjs?new-choice=${Date.now()}`);await settle();
  const snapshot={goal:{id:'g_server',domain:'custom',status:'active',currentRevision:1},revision:{goalId:'g_server',revision:1,title:'已有目标',status:'active'},tasks:[]};
  state.syncItems=[{seq:1,userId:'u_app_b',kind:'goal_updated',goalId:'g_server',payload:{snapshot}}];
  await dom.tick(3000);await settle();assert.match(dom.app.innerHTML,/<h1>已有目标<\/h1>/);assert.doesNotMatch(dom.app.innerHTML,/agent-composer/);
  await dom.click({action:'new-goal'});await dom.tick(3000);await settle();assert.match(dom.app.innerHTML,/agent-composer/);
  const cache=Object.fromEntries(dom.store);const restored=installDomStub({storage:cache});installEventBridge(state);
  await import(`../web/app.mjs?preserve-choice=${Date.now()}`);await settle();
  assert.match(restored.app.innerHTML,/说说你想做什么/);await restored.click({action:'agent-back'});
  assert.match(restored.app.innerHTML,/<h1>已有目标<\/h1>/);
});

test('archiving a goal while chatting still lets the user return to the goal home',async()=>{
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  document.visibilityState='visible';
  const snapshot={goal:{id:'g_archive',domain:'custom',status:'active',currentRevision:1},
    revision:{goalId:'g_archive',revision:1,title:'一项合成目标',status:'active'},tasks:[]};
  const bridge={syncItems:[{seq:1,userId:'u_app_b',kind:'goal_updated',goalId:'g_archive',payload:{snapshot}}]};
  installEventBridge(bridge);
  await import(`../web/app.mjs?event-archive=${Date.now()}`);await settle();
  await dom.app.dispatch('change',{target:{id:'event-goal-select',value:'g_archive'}});
  await dom.click({action:'event-chat'});
  assert.match(dom.app.innerHTML,/agent-composer/);
  const archived=structuredClone(snapshot);
  Object.assign(archived.goal,{status:'archived',currentRevision:2});
  Object.assign(archived.revision,{status:'archived',revision:2});
  bridge.syncItems.push({seq:2,userId:'u_app_b',kind:'goal_updated',goalId:'g_archive',payload:{snapshot:archived}});
  await dom.tick(3000);await settle();
  await dom.click({action:'agent-back'});
  assert.doesNotMatch(dom.app.innerHTML,/agent-composer/,'return must leave the archived goal conversation');
  assert.doesNotMatch(dom.app.innerHTML,/一项合成目标/,'archived goals must not remain on the active home');
  assert.match(dom.app.innerHTML,/当前目标/);
});

// Unlike the default lightweight stub, this rebuilds a composing element on every render.
// That makes stale .value restoration observable instead of testing only the HTML string.
function trackComposingTextarea(dom) {
  let html=dom.app.innerHTML,input=null;
  const query=dom.app.querySelector.bind(dom.app);
  Object.defineProperty(dom.app,'innerHTML',{get:()=>html,set:value=>{
    html=value;
    const match=html.match(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/);
    input=match?{value:match[2],dataset:{draftScope:match[1].match(/data-draft-scope="([^"]*)"/)?.[1]},
      style:{},scrollHeight:48,selectionStart:0,matches:selector=>selector==='#agent-form textarea',
      focus(){document.activeElement=this;},setSelectionRange(){}}:null;
  }});
  dom.app.querySelector=selector=>selector==='#agent-form textarea'?input:query(selector);
  return ()=>input;
}

test('a draft in the real composing element never migrates from an archived goal to a fresh conversation',async()=>{
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  const composing=trackComposingTextarea(dom);
  document.visibilityState='visible';
  const snapshot={goal:{id:'g_draft',domain:'custom',status:'active',currentRevision:1},
    revision:{goalId:'g_draft',revision:1,title:'Old synthetic goal',status:'active'},tasks:[]};
  const bridge={syncItems:[{seq:1,userId:'u_app_b',kind:'goal_updated',goalId:'g_draft',payload:{snapshot}}]};
  const requests=installEventBridge(bridge);
  await import(`../web/app.mjs?event-draft-scope=${Date.now()}`);await settle();
  await dom.app.dispatch('change',{target:{id:'event-goal-select',value:'g_draft'}});
  await dom.click({action:'event-chat'});
  const submit=async()=>{
    await dom.app.dispatch('submit',{target:{id:'agent-form',fields:{message:composing().value},querySelector:()=>composing(),reset(){},setAttribute(){}},preventDefault(){}});
    await settle();
  };
  composing().value='Archive this synthetic goal';await submit();
  composing().value='Supplement intended for old goal';
  await dom.app.dispatch('input',{target:composing()});
  // A same-scope poll must retain the actual input and its focused selection.
  await dom.tick(3000);await settle();
  assert.equal(composing().value,'Supplement intended for old goal');
  const archived=structuredClone(snapshot);
  Object.assign(archived.goal,{status:'archived',currentRevision:2});
  Object.assign(archived.revision,{status:'archived',revision:2});
  bridge.syncItems.push({seq:2,userId:'u_app_b',kind:'goal_updated',goalId:'g_draft',payload:{snapshot:archived}});
  await dom.tick(3000);await settle();
  assert.equal(composing().value,'','the new conversation must not inherit another goal’s text');
  const cache=JSON.parse(localStorage.getItem('along.event-workspace.v1:u_app_b'));
  assert.equal(cache.drafts['goal:g_draft'],'Supplement intended for old goal');
  composing().value='A fresh synthetic goal';await submit();
  const sent=requests.filter(item=>item.path==='/events').at(-1).body;
  assert.equal(sent.payload.text,'A fresh synthetic goal');
  assert.equal(sent.goal_id,undefined);assert.equal(sent.causation_id,undefined);
});

test('binding a live conversation to a goal preserves the unsent follow-up through return and reopening',async()=>{
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  const composing=trackComposingTextarea(dom);
  document.visibilityState='visible';
  const bridge={syncItems:[]};
  const requests=installEventBridge(bridge);
  await import(`../web/app.mjs?event-bound-draft=${Date.now()}`);await settle();
  composing().value='Start a synthetic goal';
  await dom.app.dispatch('submit',{target:{id:'agent-form',fields:{message:composing().value},querySelector:()=>composing(),reset(){},setAttribute(){}},preventDefault(){}});
  await settle();
  const root=requests.find(item=>item.path==='/events').body.event_id;
  composing().value='Second sentence intended for the same conversation';
  await dom.app.dispatch('input',{target:composing()});
  const snapshot={goal:{id:'g_bound',domain:'custom',status:'active',currentRevision:1},
    revision:{goalId:'g_bound',revision:1,title:'Bound synthetic goal',status:'active'},tasks:[]};
  bridge.syncItems.push({seq:1,userId:'u_app_b',kind:'message',goalId:'g_bound',payload:{snapshot,conversation_id:root,
    message:{id:'msg_bound',eventId:'evt_bound',role:'assistant',direction:'outbound',text:'已建立合成目标',seq:1,causationId:root}}});
  await dom.tick(3000);await settle();
  if (!composing()) await dom.click({action:'event-chat'});
  assert.equal(composing().value,'Second sentence intended for the same conversation');
  assert.equal(composing().dataset.draftScope,`conversation:${root}`);
  await dom.click({action:'agent-back'});await dom.click({action:'event-chat'});
  assert.equal(composing().value,'Second sentence intended for the same conversation');
});
