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

test('task reminder text preserves the Agent timezone, cadence and escaped explanation in the existing task row',async()=>{
  const goal={id:'g_plan_ui',domain:'custom',status:'active',revision:1,title:'有提醒的目标',metric:null,context:[],tasks:[
    {id:'t_plan_ui',goalId:'g_plan_ui',status:'open',content:'准备休息',revision:1,scheduledAt:'2099-01-01T17:30:00Z',
      reminderPlan:{state:'scheduled',source:'agent',repeat:'daily',timezone:'Asia/Shanghai',explanation:'留出准备时间 <script>bad()</script>'}},
    {id:'t_ask',goalId:'g_plan_ui',status:'open',content:'等待必要信息',revision:1,reminderPlan:{state:'needs_time',question:'哪一天有空？'}},
    {id:'t_off',goalId:'g_plan_ui',status:'open',content:'已退出的提醒',revision:1,reminderPlan:{state:'off',reason:'opt_out'}},
  ]};
  const saved={version:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{},drafts:{}};
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:u_app_b':JSON.stringify(saved)}});
  installEventBridge();await import(`../web/app.mjs?reminder-timezone=${Date.now()}`);await settle();
  const expected=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Asia/Shanghai'}).format(new Date('2099-01-01T17:30:00Z'));
  assert.ok(dom.app.innerHTML.includes(expected));
  await dom.click({action:'event-task-detail',taskId:'t_plan_ui'});
  assert.match(dom.app.innerHTML,/Agent 安排 · 下次 .* · 每天/);
  assert.match(dom.app.innerHTML,/留出准备时间 &lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(dom.app.innerHTML,/<script>bad/);
  await dom.click({action:'event-task-back'});await dom.click({action:'event-task-detail',taskId:'t_ask'});
  assert.match(dom.app.innerHTML,/提醒时间待补 · 哪一天有空？/);
  await dom.click({action:'event-task-back'});await dom.click({action:'event-task-detail',taskId:'t_off'});
  assert.match(dom.app.innerHTML,/已关闭提醒/);
});

test('offline recurring task never labels an elapsed anchor as its next reminder',async()=>{
  const goal={id:'g_elapsed_ui',domain:'custom',status:'active',revision:1,title:'离线重复目标',metric:null,context:[],tasks:[
    {id:'t_elapsed_ui',goalId:'g_elapsed_ui',status:'open',content:'整理物品',revision:1,scheduledAt:'2020-01-01T17:30:00Z',
      reminderPlan:{state:'scheduled',source:'agent',repeat:'daily',timezone:'Asia/Shanghai',explanation:'提前留出准备时间'}}]};
  const saved={version:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{},drafts:{}};
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:u_app_b':JSON.stringify(saved)}});
  installEventBridge();await import(`../web/app.mjs?elapsed-reminder-review=${Date.now()}`);await settle();
  assert.doesNotMatch(dom.app.innerHTML,/下次 2020/);
  assert.match(dom.app.innerHTML,/每天 .*01:30/);
});

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
    dataSources:[{provider:'apple-health',status:'recommended',reason:'用睡眠摘要评估这个目标'}],
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
  await settle();assert.match(dom.app.innerHTML,/<h1>测试任务 goal_two<\/h1>/);
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
function savedEventWorkspace() {
  const goal={id:'g_saved',domain:'custom',status:'active',revision:1,title:'已设定的目标',metric:null,context:[],
    tasks:[{id:'t_saved',goalId:'g_saved',status:'open',content:'已设定的任务',revision:1}]};
  return JSON.stringify({version:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{},drafts:{}});
}
const healthStateKey='along.health.v1';
const defaultWorkout={id:'along-health-weekly-workout',type:'workout',target:120};
test('bound health storage removes only the exact legacy default and keeps imports, observations and offline data',async()=>{
  const seed=localNoticeSeed(),customWorkout={...defaultWorkout,target:135},annotated={...defaultWorkout,origin:'user'};
  const kept=[customWorkout,annotated,{id:'independent',type:'workout',target:120}];
  seed[healthStateKey]=JSON.stringify({version:1,source:'healthkit',snapshot:{steps:10,selectedTypes:['steps']},goals:[defaultWorkout,...kept]});
  seed['along.event-workspace.v1:u_app_b']=savedEventWorkspace();
  const dom=installDomStub({storage:seed});installEventBridge();document.visibilityState='visible';
  const summary=steps=>({steps,selectedTypes:['steps'],contextReviewAllowed:true});
  window.AlongHealthBridge={connect:async()=>summary(30),healthEvents:async()=>({enabled:true})};
  await import(`../web/app.mjs?bound-health-store=${Date.now()}`);await settle();
  const read=()=>JSON.parse(localStorage.getItem(healthStateKey));
  assert.deepEqual(read().goals,kept);assert.equal(read().snapshot.steps,10);
  await dom.fireWindow('along-health-update',{detail:summary(20)});
  assert.equal(read().snapshot.steps,20);assert.deepEqual(read().goals,kept);
  await dom.click({action:'event-health-connect'});await settle();
  assert.equal(read().snapshot.steps,30);assert.deepEqual(read().goals,kept);
  const again=installDomStub({storage:Object.fromEntries(dom.store)});window.AlongAgentBridge={request:async()=>{throw Error('offline');}};
  let writes=0;const set=localStorage.setItem;
  localStorage.setItem=(k,v)=>{if (k===healthStateKey) writes++;set(k,v);};
  await import(`../web/app.mjs?clean-health-restart=${Date.now()}`);await settle();
  assert.equal(writes,0);assert.deepEqual(read().goals,kept);
  assert.match(again.app.innerHTML,/<h1>已设定的目标<\/h1>/);
});
test('bound health storage stays empty on fresh observation and manual import even when pairing is discovered late',async()=>{
  const seed=localNoticeSeed();delete seed['along.event-connection.v1'];
  const dom=installDomStub({storage:seed});document.visibilityState='visible';installEventBridge();
  window.AlongHealthBridge={connect:async()=>({steps:42,selectedTypes:['steps']}),healthEvents:async()=>({enabled:true})};
  await import(`../web/app.mjs?later-bound-health=${Date.now()}`);await settle();
  const read=()=>JSON.parse(localStorage.getItem(healthStateKey));
  assert.deepEqual(read().goals,[]);
  await dom.fireWindow('along-health-update',{detail:{steps:15,selectedTypes:['steps']}});
  assert.deepEqual(read().goals,[]);assert.equal(read().snapshot.steps,15);
  await dom.click({action:'event-health-connect'});await settle();
  assert.deepEqual(read().goals,[]);assert.equal(read().snapshot.steps,42);
});
test('bound health storage preserves a saved legacy health plan or task matching the default workout target',async()=>{
  for (const [source,record] of [['along.goal-custom.v1',{health:{task:'已采用的任务'}}],['along.adaptive-layouts.v1',{
    health:JSON.parse(localNoticeSeed()['along.adaptive-layouts.v1'])['custom:legacy']} ]]) {
    const seed=localNoticeSeed();seed[source]=JSON.stringify(record);
    seed[healthStateKey]=JSON.stringify({version:1,source:null,snapshot:null,goals:[defaultWorkout]});
    const dom=installDomStub({storage:seed});installEventBridge();document.visibilityState='visible';
    await import(`../web/app.mjs?keep-health-plan=${source}`);await settle();
    await dom.fireWindow('along-health-update',{detail:{steps:12,selectedTypes:['steps']}});
    assert.deepEqual(JSON.parse(localStorage.getItem(healthStateKey)).goals,[defaultWorkout]);
    assert.match(dom.app.innerHTML,/value="local:health"/);
  }
});
test('task reminder plans render source, time, frequency or question and survive an offline restart',async()=>{
  const seed=localNoticeSeed(),dom=installDomStub({storage:seed}),when='2099-11-23T02:00:00Z';
  const timed=(source,repeat,fields={})=>({scheduledAt:when,reminderPlan:{state:'scheduled',source,repeat,explanation:'提前安排准备',...fields}});
  const cases={weekly:timed('agent','weekly',{weekday:1}),daily:timed('agent','daily'),once:timed('agent','once'),
    user:timed('user','once'),question:{reminderPlan:{state:'needs_time',question:'何时提醒你 <准备>？'}},
    off:{reminderPlan:{state:'off',reason:'opt_out'}},untimed:{reminderPlan:{state:'off',reason:'untimed'}},old:{scheduledAt:when}};
  const tasks=Object.entries(cases).map(([id,plan])=>({id,goalId:'g_plans',status:'open',content:'任务 '+id,currentRevision:1,...plan}));
  const snapshot={goal:{id:'g_plans',domain:'custom',status:'active',currentRevision:1},
    revision:{goalId:'g_plans',revision:1,title:'测试提醒',status:'active'},tasks};
  installEventBridge({syncItems:[{seq:1,userId:'u_app_b',goalId:'g_plans',kind:'task_updated',payload:{snapshot}}]});
  const projections=[];window.AlongAgentBridge.notification=async(name,value)=>{if (name==='eventTaskSync') projections.push(value);return {};};
  await import(`../web/app.mjs?reminder-plan-rows=${Date.now()}`);await settle();
  const check=async dom=>{
    for (const [id,freq] of [['weekly','每周一'],['daily','每天'],['once','一次']]) {
      await dom.click({action:'event-task-detail',taskId:id});
      for (const expected of ['Agent 安排','下次',freq,'提前安排准备',new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(when))]) assert.ok(dom.app.innerHTML.includes(expected),expected);
      await dom.click({action:'event-task-back'});
    }
    for (const [id,pattern] of [['user',/一次/],['question',/何时提醒你 &lt;准备&gt;？/],['off',/关闭提醒/],['old',/执行时间/]]) {
      await dom.click({action:'event-task-detail',taskId:id});assert.match(dom.app.innerHTML,pattern);
      await dom.click({action:'event-task-back'});
    }
  };
  await check(dom);
  assert.deepEqual(projections.at(-1).reminders.map(r=>r.taskId).sort(),['daily','old','once','user','weekly']);
  assert.ok(projections.at(-1).reminders.every(r=>r.scheduledAt===new Date(when).toISOString()));
  const reopened=installDomStub({storage:Object.fromEntries(dom.store)});window.AlongAgentBridge={request:async()=>{throw Error('offline');}};
  await import(`../web/app.mjs?reminder-plan-offline=${Date.now()}`);await settle();await check(reopened);
});
test('saved goal inventory excludes source data, demo records, drafts and stale selections after restart',async()=>{
  const seed=localNoticeSeed(),key='along.event-workspace.v1:u_app_b';
  seed[key]=savedEventWorkspace();
  Object.assign(seed,{
    'along.health.v1':JSON.stringify({version:1,source:'healthkit',goals:[],snapshot:{contextReviewAllowed:true,selectedTypes:[]}}),
    'along.finance-demo.v1':JSON.stringify({version:1,connected:true,saved:4000,recordCount:1}),
    'along.active-goal.v1':'finance',
    'along.goal-conversations.v1':JSON.stringify({health:[{role:'user',text:'尚未设定'}]}),
  });
  const before=installDomStub({storage:seed});installEventBridge();
  await import(`../web/app.mjs?before-removal=${Date.now()}`);await settle();
  assert.match(before.app.innerHTML,/value="local:custom:legacy"/);
  const restored=Object.fromEntries(before.store);
  restored['along.goal-custom.v1']=JSON.stringify({health:{healthTypes:['steps']},finance:{},custom:{title:'  '}});
  restored['along.adaptive-layouts.v1']='{}';
  const after=installDomStub({storage:restored});installEventBridge();
  await import(`../web/app.mjs?removed-records=${Date.now()}`);await settle();
  assert.doesNotMatch(after.app.innerHTML,/<optgroup label="本机已存目标"|value="local:/);
  assert.match(after.app.innerHTML,/<h1>已设定的目标<\/h1>/);
  assert.match(after.app.innerHTML,/已设定的任务/);
  assert.doesNotMatch(after.app.innerHTML,/Apple Health|event-health-connect/,'独立保存的健康摘要不能把无关联目标变成健康目标');
  assert.equal(after.storage.get('along.health.v1'),seed['along.health.v1']);
});
test('saved goal inventory preserves an accepted task or validated layout even without a goal proposal',async()=>{
  const seed=localNoticeSeed(),layout=JSON.parse(seed['along.adaptive-layouts.v1'])['custom:legacy'];
  seed['along.adaptive-layouts.v1']=JSON.stringify({health:layout});
  seed['along.goal-custom.v1']=JSON.stringify({'custom:taskonly':{task:'已确认的行动',reason:'已保存的详情'},finance:{task:'已确认的演示行动',reason:'已存演示任务详情'}});
  const dom=installDomStub({storage:seed});installEventBridge();
  await import(`../web/app.mjs?saved-task-only=${Date.now()}`);await settle();
  for (const key of ['health','finance','custom:taskonly']) assert.ok(dom.app.innerHTML.includes('value="local:'+key+'"'));
  await dom.fireWindow('along-notification-open',{detail:{kind:'task',goalKey:'custom:taskonly',taskId:'primary'}});
  assert.match(dom.app.innerHTML,/<h1>已确认的行动<\/h1>/);
  assert.match(dom.app.innerHTML,/已保存的详情/);
  await dom.fireWindow('along-notification-open',{detail:{kind:'task',goalKey:'finance',taskId:'primary'}});
  assert.match(dom.app.innerHTML,/<h1>已确认的演示行动<\/h1>/);
  assert.match(dom.app.innerHTML,/已存演示任务详情/);
});
test('obsolete legacy notification preserves the visible saved goal and acknowledges only its legacy queue entry',async()=>{
  const seed=localNoticeSeed();seed['along.event-workspace.v1:u_app_b']=savedEventWorkspace();
  const dom=installDomStub({storage:seed});installEventBridge();
  const acks=[];
  window.AlongAgentBridge.notification=async (name,value)=>{if (name==='legacyNotificationOpened') acks.push(value.id);return {};};
  await import(`../web/app.mjs?obsolete-notification=${Date.now()}`);await settle();
  const route={kind:'task',goalKey:'custom:removed',taskId:'old',reminderTitle:'已移除的提醒',legacyOpenId:'queued-first'};
  await dom.fireWindow('along-notification-open',{detail:route});
  assert.match(dom.app.innerHTML,/<h1>已设定的目标<\/h1>/);
  assert.doesNotMatch(dom.app.innerHTML,/local:custom:removed|已移除的提醒/);
  await dom.app.dispatch('change',{target:{id:'event-goal-select',value:'local:custom:legacy'}});
  await dom.fireWindow('along-notification-open',{detail:{...route,legacyOpenId:'queued-next'}});
  assert.match(dom.app.innerHTML,/<h1>本机原目标<\/h1>/);
  assert.deepEqual(acks,['queued-first','queued-next']);
  await dom.fireWindow('along-notification-open',{detail:{userId:'wrong',eventId:'e',goalKey:'custom:legacy',legacyOpenId:'unrelated'}});
  assert.deepEqual(acks,['queued-first','queued-next']);
});
test('obsolete legacy notification from the cold queue allows a subsequently discovered real goal to open',async()=>{
  const seed=localNoticeSeed();
  delete seed['along.event-connection.v1'];
  const dom=installDomStub({storage:seed}),acks=[];
  let connect;
  const snapshot={goal:{id:'g_real',domain:'custom',status:'active',currentRevision:1},
    revision:{goalId:'g_real',revision:1,title:'同步的目标',status:'active'},tasks:[]};
  window.AlongAgentBridge={request:async input=>{
    if (input.path==='/connection/status') return new Promise(resolve=>{connect=resolve;});
    if (input.path==='/sync') return {items:input.body.after_seq?[]:[{seq:1,userId:'u_app_b',goalId:'g_real',kind:'goal_updated',payload:{snapshot}}]};
    return {};
  },notification:async (name,value)=>{
    if (name==='pendingLegacyNotification') return {route:{kind:'goal',goalKey:'custom:removed',legacyOpenId:'queued-cold'}};
    if (name==='legacyNotificationOpened') acks.push(value.id);
    return {};
  }};
  await import(`../web/app.mjs?obsolete-cold=${Date.now()}`);await settle();
  assert.equal(dom.storage.get('along.active-goal.v1'),'custom:legacy');
  connect({along:true,ready:true,runtime:'dsh-superagent',eventProtocol:1,userId:'u_app_b'});await settle();
  await dom.tick(3000);await settle();
  assert.match(dom.app.innerHTML,/<h1>同步的目标<\/h1>/);
  assert.doesNotMatch(dom.app.innerHTML,/local:custom:removed/);
  assert.deepEqual(acks,['queued-cold']);
});
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
test('a v1 event connection with only a leaf fingerprint is migrated once to the binding scope and stops using the fingerprint as identity',async()=>{
  const seed=localNoticeSeed();
  // 旧记录只有叶指纹（docs/iphone-ca-profile-design.md §2.2 迁移期双读）。
  assert.deepEqual(JSON.parse(seed['along.event-connection.v1']),{userId:'u_app_b',fingerprint:config.fingerprint});
  const dom=installDomStub({storage:seed});document.visibilityState='visible';
  installEventBridge();
  await import(`../web/app.mjs?event-connection-migrate=${Date.now()}`);await settle();
  const migrated=JSON.parse(dom.storage.get('along.event-connection.v1'));
  assert.equal(migrated.userId,'u_app_b');
  assert.equal(migrated.bindingScopeId,config.token,'迁移后的归属身份是绑定作用域，不是叶指纹');
  assert.equal(migrated.fingerprint,undefined,'迁移后不再保留叶指纹作为身份');
  // 迁移只做一次：再次启动读到 v2 记录时不再重写，也不丢用户身份。
  const before=dom.storage.get('along.event-connection.v1');
  const again=installDomStub({storage:Object.fromEntries(dom.store)});installEventBridge();
  await import(`../web/app.mjs?event-connection-migrate-again=${Date.now()}`);await settle();
  assert.equal(again.storage.get('along.event-connection.v1'),before,'v2 记录不应被反复改写');
});
test('a legacy event connection whose fingerprint does not match the current connection is not adopted',async()=>{
  const seed=localNoticeSeed();
  seed['along.event-connection.v1']=JSON.stringify({userId:'u_app_b',fingerprint:'Z'.repeat(64)});
  const dom=installDomStub({storage:seed});document.visibilityState='visible';
  installEventBridge();
  await import(`../web/app.mjs?event-connection-mismatch=${Date.now()}`);await settle();
  const after=JSON.parse(dom.storage.get('along.event-connection.v1'));
  assert.equal(after.fingerprint,undefined,'指纹对不上的旧记录不得被沿用为归属身份');
  assert.equal(after.bindingScopeId,config.token,'归属身份必须来自当前连接，而不是旧记录的叶指纹');
});
test('an offline stale event connection is not adopted as the current user',async()=>{
  const seed=localNoticeSeed();
  seed['along.event-connection.v1']=JSON.stringify({userId:'u_app_b',fingerprint:'Z'.repeat(64)});
  const dom=installDomStub({storage:seed});document.visibilityState='visible';
  // 离线：没有 /connection/status 可用来重新确认身份。
  window.AlongAgentBridge={request:async()=>{throw Error('offline');},notification:async()=>({})};
  await import(`../web/app.mjs?event-connection-stale-offline=${Date.now()}`);await settle();
  assert.deepEqual(JSON.parse(dom.storage.get('along.event-connection.v1')),{userId:'u_app_b',fingerprint:'Z'.repeat(64)},
    '离线且指纹对不上的旧记录既不得被采用，也不得被改写成当前绑定');
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

import {recommendation} from './recommendation-fixture.mjs';

test('a recommendation is visible in its original goal and its notification opens evidence rather than the old task row',async()=>{
  const goal={id:'g_source_ui',domain:'custom',status:'active',revision:1,title:'原运动目标',metric:null,context:[],tasks:[
    {id:'t_source_ui',goalId:'g_source_ui',status:'open',content:'周五安排徒步',revision:1}]};
  const result={eventId:'reply_source_ui',id:'msg_source_ui',role:'assistant',text:'已检索路线',seq:1,goalId:goal.id,taskId:'t_source_ui',
    recommendation:recommendation(),notificationEventId:'reply_source_ui',status:'received'};
  const saved={version:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{[result.eventId]:result},drafts:{}};
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:u_app_b':JSON.stringify(saved)}});
  const requests=installEventBridge(),receipts=[],scrolled=[];
  window.AlongAgentBridge.notification=async(name,value)=>{if(name==='eventTaskOpened')receipts.push(value);return {};};
  document.getElementById=id=>dom.app.innerHTML.includes('id="'+id+'"')?{focus(){},scrollIntoView:()=>scrolled.push(id)}:null;
  await import(`../web/app.mjs?recommendation-ui=${Date.now()}`);await settle();
  assert.match(dom.app.innerHTML,/原运动目标/);assert.doesNotMatch(dom.app.innerHTML,/recommendation-card/);
  await dom.click({action:'event-task-detail',taskId:'t_source_ui'});assert.match(dom.app.innerHTML,/周末徒步方案/);assert.match(dom.app.innerHTML,/依据来源/);
  await dom.fireWindow('along-notification-open',{detail:{userId:'u_app_b',goalId:goal.id,taskId:'t_source_ui',eventId:result.eventId,kind:'recommendation_ready'}});
  assert.ok(scrolled.includes('event-message-'+result.eventId));assert.doesNotMatch(dom.app.innerHTML,/agent-composer/);
  assert.equal(receipts.at(-1).taskId,'t_source_ui');
  await dom.click({action:'event-recommendation-feedback',eventId:result.eventId});
  assert.match(dom.app.innerHTML,/关于「周末徒步方案」/);
  await dom.app.dispatch('submit',{target:{id:'agent-form',fields:{message:'更想要短一点的路线'},querySelector:()=>null,reset(){},setAttribute(){}},preventDefault(){}});await settle();
  const sent=requests.find(r=>r.path==='/events').body;
  assert.equal(sent.goal_id,goal.id);assert.equal(sent.task_id,'t_source_ui');assert.equal(sent.event_type,'along.user_message');
});

test('visible and resumed recommendation cards re-evaluate expiry even when sync is empty or offline',async()=>{
  const realNow=Date.now;let now=realNow();Date.now=()=>now;
  try {
    const goal={id:'g_expiry',domain:'custom',status:'active',revision:1,title:'原目标',metric:null,context:[],tasks:[{id:'t_g_expiry',goalId:'g_expiry',status:'open',content:'研究方案',revision:1}]};
    const r=recommendation();r.retrievedAt=new Date(now-1000).toISOString();r.validUntil=new Date(now+1000).toISOString();
    r.sources=r.sources.map(s=>({...s,retrievedAt:r.retrievedAt,expiresAt:r.validUntil}));
    const m={eventId:'reply_expiry',taskId:'t_g_expiry',role:'assistant',text:'结果',goalId:goal.id,status:'received',recommendation:r};
    const saved={version:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{[m.eventId]:m},drafts:{'goal:g_expiry':'保留未发送的补充'}};
    const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:u_app_b':JSON.stringify(saved)}});
    document.visibilityState='visible';installEventBridge();
    await import(`../web/app.mjs?recommendation-expiry=${realNow()}`);await settle();await dom.click({action:'event-task-detail',taskId:'t_g_expiry'});assert.match(dom.app.innerHTML,/推荐已就绪/);
    now+=2000;await dom.tick(3000);await settle();assert.match(dom.app.innerHTML,/资料已过期/);
    assert.doesNotMatch(dom.app.innerHTML,/>适合考虑</);
    now-=2000;await dom.tick(3000);await settle();assert.match(dom.app.innerHTML,/推荐已就绪/);
    now+=2000;window.AlongAgentBridge.request=async()=>{throw Error('offline');};
    await dom.fireWindow('pageshow');await settle();assert.match(dom.app.innerHTML,/资料已过期/);
    assert.equal(JSON.parse(localStorage.getItem('along.event-workspace.v1:u_app_b')).drafts['goal:g_expiry'],'保留未发送的补充');
  } finally {Date.now=realNow;}
});


test('a recommendation notification waits for its own message through offline and delayed sync before acknowledging',async()=>{
  const goal={id:'g_race',domain:'custom',status:'active',revision:1,title:'原目标',metric:null,context:[],tasks:[
    {id:'t_race',goalId:'g_race',status:'open',content:'原徒步研究任务',revision:1}]};
  const saved={version:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{},drafts:{}};
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:u_app_b':JSON.stringify(saved)}});
  document.visibilityState='visible';const state={syncItems:[]},requests=installEventBridge(state),receipts=[],scrolled=[];
  window.AlongAgentBridge.notification=async(name,value)=>{if(name==='eventTaskOpened')receipts.push(value);return {};};
  document.getElementById=id=>dom.app.innerHTML.includes('id="'+id+'"')?{focus(){},scrollIntoView:()=>scrolled.push(id)}:null;
  await import(`../web/app.mjs?recommendation-race=${Date.now()}`);await settle();
  const online=window.AlongAgentBridge.request;window.AlongAgentBridge.request=async()=>{throw Error('offline');};
  await dom.fireWindow('along-notification-open',{detail:{userId:'u_app_b',goalId:goal.id,taskId:'t_race',eventId:'reply_race',kind:'recommendation_ready'}});await settle();
  assert.equal(receipts.length,0);assert.equal(scrolled.includes('event-task-t_race'),false);
  window.AlongAgentBridge.request=online;await dom.tick(3000);await settle();assert.equal(receipts.length,0);
  state.syncItems=[{seq:2,userId:'u_app_b',kind:'message',goalId:goal.id,taskId:'t_race',payload:{recommendation:recommendation(),
    snapshot:{goal:{...goal,currentRevision:1},revision:{goalId:goal.id,revision:1,title:goal.title,status:'active'},tasks:goal.tasks.map(t=>({...t,currentRevision:t.revision}))},
    notification:{event_id:'reply_race',kind:'recommendation_ready',revision:1},
    message:{id:'msg_race',eventId:'reply_race',role:'assistant',direction:'outbound',text:'结果已就绪',seq:2}}}];
  await dom.tick(3000);await settle();
  assert.match(dom.app.innerHTML,/周末徒步方案/);assert.doesNotMatch(dom.app.innerHTML,/agent-composer/);
  assert.ok(scrolled.includes('event-message-reply_race'));assert.equal(receipts.length,1);assert.equal(receipts[0].eventId,'reply_race');
  assert.ok(requests.some(r=>r.path==='/sync'));
});


test('a completed research task result opens the matching sourced recommendation without completing an outing',async()=>{
  const goal={id:'g_research_done',domain:'custom',status:'active',revision:1,title:'原运动目标',metric:null,context:[],tasks:[
    {id:'t_research_done',goalId:'g_research_done',status:'done',content:'联网比较徒步方案',revision:2},
    {id:'t_outing',goalId:'g_research_done',status:'open',content:'周末完成徒步',revision:1}]};
  const result={eventId:'reply_research_done',role:'assistant',text:'研究结果',goalId:goal.id,taskId:'t_research_done',status:'received',recommendation:recommendation(),notificationEventId:'reply_research_done'};
  const saved={version:1,recommendationsVersion:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{[result.eventId]:result},drafts:{}};
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:u_app_b':JSON.stringify(saved)}});
  installEventBridge();const receipts=[],scrolled=[];
  window.AlongAgentBridge.notification=async(name,value)=>{if(name==='eventTaskOpened')receipts.push(value);return {};};
  document.getElementById=id=>dom.app.innerHTML.includes('id="'+id+'"')?{focus(){},scrollIntoView:()=>scrolled.push(id)}:null;
  await import(`../web/app.mjs?completed-research-result=${Date.now()}`);await settle();
  await dom.fireWindow('along-notification-open',{detail:{userId:'u_app_b',goalId:goal.id,taskId:'t_research_done',eventId:result.eventId,kind:'task_result',revision:2}});
  assert.match(dom.app.innerHTML,/周末徒步方案/);assert.doesNotMatch(dom.app.innerHTML,/agent-composer/);assert.ok(scrolled.includes('event-message-'+result.eventId));
  assert.equal(receipts.length,1);assert.equal(receipts[0].taskId,'t_research_done');
  assert.equal(JSON.parse(localStorage.getItem('along.event-workspace.v1:u_app_b')).goals[goal.id].tasks.find(t=>t.id==='t_outing').status,'open');
});


test('goal chat contains direct dialogue while background recommendations stay in the goal and notification target',async()=>{
  const goal={id:'g_private_chat',domain:'custom',status:'active',revision:1,title:'真实目标',metric:null,context:[],tasks:[
    {id:'t_private_chat',goalId:'g_private_chat',status:'open',content:'周五安排徒步',revision:1}]};
  const direct={eventId:'direct_user',role:'user',text:'请补齐提醒计划，这是我本人发的消息',goalId:goal.id,audience:'conversation',status:'received'};
  const answer={eventId:'direct_answer',role:'assistant',text:'这是给你的直接答复',goalId:goal.id,audience:'conversation',status:'received'};
  const internal={eventId:'internal_run',role:'assistant',text:'内部验收补排完成流水',goalId:goal.id,audience:'background',status:'received'};
  const result={eventId:'background_recommendation',role:'assistant',text:'后台推荐任务完成',goalId:goal.id,taskId:'t_private_chat',
    audience:'background',recommendation:recommendation(),notificationEventId:'background_recommendation',status:'received'};
  const saved={version:1,conversationVersion:1,recommendationsVersion:1,userId:'u_app_b',cursor:4,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:Object.fromEntries([direct,answer,internal,result].map(m=>[m.eventId,m])),drafts:{}};
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:u_app_b':JSON.stringify(saved)}});
  installEventBridge();const receipts=[],scrolled=[];
  window.AlongAgentBridge.notification=async(name,value)=>{if(name==='eventTaskOpened')receipts.push(value);return {};};
  document.getElementById=id=>dom.app.innerHTML.includes('id="'+id+'"')?{focus(){},scrollIntoView:()=>scrolled.push(id)}:null;
  await import(`../web/app.mjs?direct-chat-boundary=${Date.now()}`);await settle();
  assert.doesNotMatch(dom.app.innerHTML,/recommendation-card/);
  await dom.click({action:'event-chat'});
  assert.match(dom.app.innerHTML,/这是我本人发的消息/);assert.match(dom.app.innerHTML,/这是给你的直接答复/);
  assert.doesNotMatch(dom.app.innerHTML,/内部验收补排完成流水|后台推荐任务完成|周末徒步方案/);
  await dom.fireWindow('along-notification-open',{detail:{userId:'u_app_b',goalId:goal.id,taskId:'t_private_chat',eventId:result.eventId,kind:'recommendation_ready'}});
  assert.match(dom.app.innerHTML,/周末徒步方案/);assert.doesNotMatch(dom.app.innerHTML,/agent-composer/);
  assert.ok(scrolled.includes('event-message-'+result.eventId));assert.equal(receipts.length,1);
  await dom.click({action:'event-recommendation-feedback',eventId:result.eventId});
  assert.match(dom.app.innerHTML,/关于「周末徒步方案」/);assert.doesNotMatch(dom.app.innerHTML,/内部验收补排完成流水/);
});


test('leaving an opened notification lets the goal show a newer background recommendation',async()=>{
  const goal={id:'g_focus',domain:'custom',status:'active',revision:1,title:'原目标',metric:null,context:[],tasks:[{id:'t_g_focus',goalId:'g_focus',status:'open',content:'研究方案',revision:1}]};
  const r=recommendation();r.title='旧方案';
  const m={eventId:'reply_old',taskId:'t_g_focus',role:'assistant',text:'旧结果',goalId:goal.id,audience:'background',status:'received',recommendation:r,notificationEventId:'reply_old'};
  const saved={version:1,conversationVersion:1,recommendationsVersion:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{reply_old:m},drafts:{}};
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:u_app_b':JSON.stringify(saved)}});
  document.visibilityState='visible';const state={syncItems:[]};installEventBridge(state);
  window.AlongAgentBridge.notification=async()=>({});
  document.getElementById=id=>dom.app.innerHTML.includes('id="'+id+'"')?{focus(){},scrollIntoView(){}}:null;
  await import(`../web/app.mjs?focus-review=${Date.now()}`);await settle();
  await dom.fireWindow('along-notification-open',{detail:{userId:'u_app_b',goalId:goal.id,eventId:'reply_old',kind:'recommendation_ready'}});
  assert.match(dom.app.innerHTML,/旧方案/);
  const newer=recommendation();newer.title='新方案';
  state.syncItems=[{seq:2,userId:'u_app_b',kind:'message',goalId:goal.id,taskId:'t_g_focus',payload:{audience:'background',recommendation:newer,snapshot:{goal:{...goal,currentRevision:1},revision:{goalId:goal.id,revision:1,title:goal.title,status:'active'},tasks:goal.tasks.map(t=>({...t,currentRevision:t.revision}))},message:{id:'msg_new',eventId:'reply_new',role:'assistant',direction:'outbound',text:'新结果',seq:2,audience:'background'}}}];
  await dom.tick(3000);await settle();
  await dom.click({action:'event-chat'});await dom.click({action:'agent-back'});
  assert.doesNotMatch(dom.app.innerHTML,/recommendation-card/);
  await dom.click({action:'event-task-detail',taskId:'t_g_focus'});
  assert.match(dom.app.innerHTML,/新方案/);assert.doesNotMatch(dom.app.innerHTML,/旧方案/);
});


test('weather then access expiry updates offline cards independently and retains the draft',async()=>{
  const realNow=Date.now;let now=realNow();Date.now=()=>now;
  try {
    const goal={id:'g_weather',domain:'custom',status:'active',revision:1,title:'原目标',metric:null,context:[],tasks:[{id:'t_g_weather',goalId:'g_weather',status:'open',content:'研究方案',revision:1}]};
    const r=recommendation();r.retrievedAt=new Date(now-1000).toISOString();
    r.validUntil=new Date(now+1000).toISOString();
    r.sources=r.sources.map(s=>({...s,retrievedAt:r.retrievedAt,expiresAt:new Date(now+(s.id==='source_weather'?1000:5000)).toISOString()}));
    const m={eventId:'reply_weather',taskId:'t_g_weather',role:'assistant',text:'结果',goalId:goal.id,status:'received',recommendation:r};
    const saved={version:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{[m.eventId]:m},drafts:{'goal:g_weather':'保留我的路线偏好'}};
    const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:u_app_b':JSON.stringify(saved)}});
    document.visibilityState='visible';installEventBridge();
    await import(`../web/app.mjs?weather-expiry=${realNow()}`);await settle();await dom.click({action:'event-task-detail',taskId:'t_g_weather'});
    assert.match(dom.app.innerHTML,/推荐已就绪/);
    window.AlongAgentBridge.request=async()=>{throw Error('offline');};
    now+=2000;await dom.tick(3000);await settle();
    assert.match(dom.app.innerHTML,/天气待更新/);assert.match(dom.app.innerHTML,/路线候选保留/);
    assert.doesNotMatch(dom.app.innerHTML,/资料已过期|>适合考虑</);
    now+=4000;await dom.tick(3000);await settle();
    assert.match(dom.app.innerHTML,/资料已过期/);assert.match(dom.app.innerHTML,/需重新核实/);
    now-=4000;await dom.fireWindow('pageshow');await settle();
    assert.match(dom.app.innerHTML,/天气待更新/);assert.doesNotMatch(dom.app.innerHTML,/资料已过期/);
    assert.equal(JSON.parse(localStorage.getItem('along.event-workspace.v1:u_app_b')).drafts['goal:g_weather'],'保留我的路线偏好');
  } finally {Date.now=realNow;}
});

test('a quiet Agent time task shows execution arrangement rather than claiming an advance reminder',async()=>{
  const goal={id:'g_execute_ui',domain:'custom',status:'active',revision:1,title:'定时研究目标',metric:null,context:[],tasks:[
    {id:'t_execute_ui',goalId:'g_execute_ui',status:'open',content:'研究周末路线',revision:1,scheduledAt:'2099-01-01T11:00:00Z',
      trigger:{version:1,kind:'time',actor:'agent',capability:'research',state:'scheduled',label:'按指定时间执行',conditions:[],notifyBefore:false},
      reminderPlan:{state:'scheduled',source:'user',repeat:'once',timezone:'Asia/Shanghai',explanation:'按照指定时刻执行研究'}},
    {id:'t_execute_waiting',goalId:'g_execute_ui',status:'open',content:'等待研究窗口',revision:1,
      trigger:{version:1,kind:'waiting',actor:'agent',capability:'research',state:'waiting',label:'等待执行窗口',conditions:[],notifyBefore:false},
      reminderPlan:{state:'needs_time',question:'哪一段时间适合执行？'}},
  ]};
  const saved={version:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{},drafts:{}};
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:u_app_b':JSON.stringify(saved)}});
  installEventBridge();await import(`../web/app.mjs?execution-arrangement=${Date.now()}`);await settle();
  await dom.click({action:'event-task-detail',taskId:'t_execute_ui'});
  assert.match(dom.app.innerHTML,/执行安排 · 下次/);
  assert.match(dom.app.innerHTML,/结果保存在任务详情/);
  assert.doesNotMatch(dom.app.innerHTML,/你指定的提醒/);
  await dom.click({action:'event-task-back'});await dom.click({action:'event-task-detail',taskId:'t_execute_waiting'});
  assert.match(dom.app.innerHTML,/执行时间待补/);assert.doesNotMatch(dom.app.innerHTML,/提醒时间待补/);
});

const waitingGoal={id:'g_wait_ui',domain:'custom',status:'active',revision:1,title:'等待目标',metric:null,context:[],tasks:[]};
const waitingSnapshot={goal:{id:waitingGoal.id,domain:'custom',status:'active',currentRevision:1},
  revision:{goalId:waitingGoal.id,revision:1,title:waitingGoal.title,status:'active'},tasks:[]};
function waitingApp(storage={}) {
  const saved={version:1,userId:'u_app_b',cursor:0,activeGoalId:waitingGoal.id,conversationId:null,returnGoalId:waitingGoal.id,
    goals:{[waitingGoal.id]:waitingGoal},messages:{},drafts:{}};
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),
    [`along.event-workspace.v1:u_app_b`]:JSON.stringify(saved),...storage}});
  document.visibilityState='visible';
  const bridge={syncItems:[]};
  const requests=installEventBridge(bridge);
  return {dom,bridge,requests};
}
const submitChat=(dom,message)=>dom.app.dispatch('submit',{target:{id:'agent-form',fields:{message},
  querySelector:()=>null,reset(){},setAttribute(){}},preventDefault(){}});

test('a submitted chat keeps an accessible waiting row until its own visible reply arrives',async()=>{
  const {dom,bridge,requests}=waitingApp();
  await import(`../web/app.mjs?chat-waiting=${Date.now()}`);await settle();
  await dom.click({action:'event-chat'});
  await submitChat(dom,'帮我安排今晚的睡前提醒');await settle();
  const sent=requests.find(item=>item.path==='/events').body.event_id;
  assert.match(dom.app.innerHTML,/Agent 正在回复…/,'提交后立即显示等待');
  assert.match(dom.app.innerHTML,/agent-thinking[\s\S]*role="status"|role="status"[\s\S]*agent-thinking/,'等待提示可被辅助技术读出');
  bridge.syncItems=[
    {seq:1,userId:'u_app_b',kind:'message',goalId:waitingGoal.id,payload:{snapshot:waitingSnapshot,presentation:'execution',
      message:{id:'msg_exec_ui',eventId:'out:wait:worker',role:'assistant',direction:'outbound',text:'后台执行完成',seq:1}}},
    {seq:2,userId:'u_app_b',kind:'message',goalId:waitingGoal.id,payload:{snapshot:waitingSnapshot,conversation_id:'another_chat',
      message:{id:'msg_other_ui',eventId:'reply_other_ui',role:'assistant',direction:'outbound',text:'其他会话的回复',seq:2}}},
  ];
  await dom.tick(3000);await settle();
  assert.match(dom.app.innerHTML,/Agent 正在回复…/,'同步和重渲染后仍在，后台与其他会话的消息不会提前清除');
  bridge.syncItems.push({seq:3,userId:'u_app_b',kind:'message',goalId:waitingGoal.id,payload:{snapshot:waitingSnapshot,
    message:{id:'msg_user_ui',eventId:sent,role:'user',direction:'inbound',text:'帮我安排今晚的睡前提醒',seq:3}}});
  bridge.syncItems.push({seq:4,userId:'u_app_b',kind:'message',goalId:waitingGoal.id,payload:{snapshot:waitingSnapshot,conversation_id:sent,
    message:{id:'msg_reply_ui',eventId:'reply_wait_ui',role:'assistant',direction:'outbound',text:'十一点前放下手机',seq:4,causationId:sent}}});
  await dom.tick(3000);await settle();
  assert.doesNotMatch(dom.app.innerHTML,/Agent 正在回复…/,'当前请求的可见回复结束等待');
  assert.match(dom.app.innerHTML,/十一点前放下手机/);
});

test('a failed chat ends the waiting row and keeps the failure feedback',async()=>{
  const {dom,bridge,requests}=waitingApp();
  await import(`../web/app.mjs?chat-waiting-failed=${Date.now()}`);await settle();
  await dom.click({action:'event-chat'});
  await submitChat(dom,'这条发送会失败');await settle();
  const sent=requests.find(item=>item.path==='/events').body.event_id;
  assert.match(dom.app.innerHTML,/Agent 正在回复…/);
  bridge.syncItems=[{seq:1,userId:'u_app_b',kind:'delivery_failed',payload:{event_id:sent}}];
  await dom.tick(3000);await settle();
  assert.doesNotMatch(dom.app.innerHTML,/Agent 正在回复…/,'失败后结束等待');
  assert.match(dom.app.innerHTML,/发送未完成/,'保留原有的失败反馈');
});
