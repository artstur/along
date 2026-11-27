import test from 'node:test';
import assert from 'node:assert/strict';

// 固定设备时区，跨日和「当天」的判断才有确定的期望值。
process.env.TZ='Asia/Shanghai';

import {installDomStub} from './dom-stub.mjs';
import {chatTimeline} from '../web/event-workspace.mjs';

const config={baseURL:'https://localhost:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
const at=offset=>new Date(Date.now()+offset).toISOString();

// 期望文案走 Intl，与实现里的 Date 取值是两条独立路径。
function expectedLabel(value,reference=Date.now()) {
  const date=new Date(value);
  const day=formatter=>new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(formatter));
  const clock=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
  if (day(date)===day(reference)) return clock;
  const parts=new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const field=type=>parts.find(part=>part.type===type).value;
  return `${field('year')}年${field('month')}月${field('day')}日 ${clock}`;
}

test('the first timed message opens the timeline and later ones only break after 30 minutes or a local day change',()=>{
  const base=Date.parse('2026-11-27T10:00:00+08:00');
  const iso=seconds=>new Date(base+seconds*1000).toISOString();
  const labels=messages=>chatTimeline(messages,base).map(item=>item?.label??null);

  // 空列表和全部无时间都不出分割线。
  assert.deepEqual(chatTimeline([],base),[]);
  assert.deepEqual(labels([{},{sentAt:''},{sentAt:'2026-02-30T00:00:00Z'}]),[null,null,null]);

  // 首条有时间的消息前出一条；不足 30 分钟不出，达到 30 分钟出一条。
  assert.deepEqual(labels([{sentAt:iso(0)}]),['10:00']);
  assert.deepEqual(labels([{sentAt:iso(0)},{sentAt:iso(29*60+59)}]),['10:00',null]);
  assert.deepEqual(labels([{sentAt:iso(0)},{sentAt:iso(30*60)}]),['10:00','10:30']);

  // 跨日：23:59 → 00:00 相隔 1 分钟也出一条。
  assert.deepEqual(labels([{sentAt:'2026-11-27T23:59:00+08:00'},{sentAt:'2026-11-28T00:00:00+08:00'}]),
    ['23:59','2026年11月28日 00:00']);
  // 两个条件同时成立（跨日且相隔 60 分钟）也只出一条。
  assert.deepEqual(labels([{sentAt:'2026-11-27T23:00:00+08:00'},{sentAt:'2026-11-28T00:00:00+08:00'}]),
    ['23:00','2026年11月28日 00:00']);

  // 同日时间戳倒序按原顺序展示，负间隔不触发门槛。
  assert.deepEqual(labels([{sentAt:iso(60*60)},{sentAt:iso(0)}]),['11:00',null]);
});

test('a missing or invalid time keeps the bubble and never moves the comparison point',()=>{
  const base=Date.parse('2026-11-27T10:00:00+08:00');
  const iso=seconds=>new Date(base+seconds*1000).toISOString();
  const labels=messages=>chatTimeline(messages,base).map(item=>item?.label??null);

  // 中间缺时间：保留气泡，第三条仍跟上一条有效消息（10:00）比。
  assert.deepEqual(labels([{sentAt:iso(0)},{},{sentAt:iso(30*60)}]),['10:00',null,'10:30']);
  // 缺时间的消息不参与门槛：10:10 距 10:00 只有 10 分钟，不出线。
  assert.deepEqual(labels([{sentAt:iso(0)},{sentAt:'2026-02-30T00:00:00Z'},{sentAt:iso(10*60)}]),['10:00',null,null]);
  // 缺时间的消息也不影响下一条的分界点：10:40 距 10:00 正好 30 分钟，出线。
  assert.deepEqual(labels([{sentAt:iso(0)},{},{sentAt:iso(40*60)}]),['10:00',null,'10:40']);
  // 长度不变，缺时间的消息照样占一个位置。
  assert.equal(chatTimeline([{sentAt:iso(0)},{}],base).length,2);
});

test('the divider label follows the device local timezone',()=>{
  const now=Date.now();
  const today=new Date(now);
  const midnight=new Date(today.getFullYear(),today.getMonth(),today.getDate()).getTime();
  const morning=midnight+10*3600_000;
  const dividers=chatTimeline([{sentAt:new Date(morning).toISOString()}],now);
  assert.equal(dividers[0].label,expectedLabel(new Date(morning).toISOString(),now));
  // 今天只显示时分。
  assert.match(dividers[0].label,/^\d\d:\d\d$/);

  // 很久以前的那条同时显示年月日。
  const old=new Date(midnight-40*86400_000+10*3600_000);
  const [past]=chatTimeline([{sentAt:old.toISOString()}],now);
  assert.match(past.label,/^\d{4}年\d\d月\d\d日 \d\d:\d\d$/);
  assert.equal(past.label,expectedLabel(old.toISOString(),now));
});

function installEventBridge(pages) {
  window.AlongAgentBridge={request:async input=>{
    if(input.path==='/connection/status')return {along:true,ready:true,runtime:'dsh-superagent',eventProtocol:1,userId:'u_app_b'};
    if(input.path==='/events')return {status:'accepted',event_id:input.body.event_id};
    if(input.path==='/sync/ack')return {acked:input.body.seqs.length};
    if(input.path==='/sync') {
      const after=Number(input.body.after_seq??0);
      const page=pages.find(item=>after>=item.from&&after<item.to);
      if(!page)return {items:[]};
      return {items:page.items,...(page.nextCursor===undefined?{}:{nextCursor:String(page.nextCursor)})};
    }
    throw Error(`Unexpected endpoint: ${input.path}`);
  }};
}
const goalSnapshot={goal:{id:'g_td',domain:'custom',status:'active',currentRevision:1},
  revision:{goalId:'g_td',revision:1,title:'时间分割线目标',status:'active'},tasks:[]};
const goal={id:'g_td',domain:'custom',status:'active',revision:1,title:'时间分割线目标',metric:null,context:[],tasks:[]};
const dividersIn=html=>[...html.matchAll(/<time class="agent-time-divider"[^>]*>([^<]*)<\/time>/g)].map(match=>match[1]);
const dividersBefore=(html,text)=>(html.slice(0,html.indexOf(text)).match(/<time class="agent-time-divider"/g)||[]).length;

test('the chat renders one centred time divider per break and keeps every bubble',async()=>{
  const first=at(-60*60_000),second=at(-50*60_000),third=at(-20*60_000);
  const messages=[
    {eventId:'m_one',role:'user',text:'第一条原话',goalId:goal.id,audience:'conversation',status:'received',sentAt:first},
    {eventId:'m_two',role:'assistant',text:'第二条回复',goalId:goal.id,audience:'conversation',status:'received',sentAt:second},
    {eventId:'m_three',role:'user',text:'第三条原话',goalId:goal.id,audience:'conversation',status:'received',sentAt:third},
  ];
  const saved={version:1,conversationVersion:1,recommendationsVersion:1,userId:'u_app_b',cursor:1,activeGoalId:goal.id,conversationId:null,
    goals:{[goal.id]:goal},messages:Object.fromEntries(messages.map(message=>[message.eventId,message])),drafts:{}};
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:u_app_b':JSON.stringify(saved)}});
  installEventBridge([{from:0,to:1e12,items:[]}]);document.visibilityState='visible';
  await import(`../web/app.mjs?chat-divider=${Date.now()}`);await settle();
  await dom.click({action:'event-chat'});await settle();
  const html=dom.app.innerHTML;
  assert.match(html,/第一条原话/);assert.match(html,/第二条回复/);assert.match(html,/第三条原话/);
  // 第一条前、第二条前、第三条前分别是 1、1、2 条分割线。
  assert.equal(dividersBefore(html,'第一条原话'),1);
  assert.equal(dividersBefore(html,'第二条回复'),1);
  assert.equal(dividersBefore(html,'第三条原话'),2);
  assert.deepEqual(dividersIn(html),[expectedLabel(first),expectedLabel(third)]);
});

test('the sync seam between two pages breaks on the adjacent pair and duplicates never repeat a bubble or a divider',async()=>{
  const first=at(-90*60_000);
  const message=(seq,eventId,sentAt,text)=>({seq,userId:'u_app_b',kind:'message',goalId:goal.id,payload:{snapshot:goalSnapshot,conversation_id:'conv_td',
    message:{id:`msg_${eventId}`,eventId,role:'user',direction:'inbound',text,seq,occurredAt:sentAt}}});
  const build=seam=>{
    const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
    document.visibilityState='visible';
    installEventBridge([
      {from:0,to:2,items:[{seq:1,userId:'u_app_b',kind:'goal_updated',goalId:goal.id,payload:{snapshot:goalSnapshot}},
        message(2,'evt_first',first,'第一条原话')],nextCursor:2},
      {from:2,to:1e12,items:[message(3,'evt_second',seam,'第二条原话')]},
    ]);
    return dom;
  };

  // 接缝处相隔 30 分钟：接缝出一条分割线。
  const exact=build(at(-60*60_000));
  await import(`../web/app.mjs?chat-divider-seam=${Date.now()}`);await settle();
  await exact.tick(3000);await settle();
  await exact.click({action:'event-chat'});await settle();
  let html=exact.app.innerHTML;
  assert.match(html,/第一条原话/);assert.match(html,/第二条原话/);
  assert.equal(dividersBefore(html,'第一条原话'),1);
  assert.equal(dividersBefore(html,'第二条原话'),2);

  // 接缝处相隔 29 分 59 秒：接缝不出分割线。
  const close=build(at(-60*60_000-1_000));
  await import(`../web/app.mjs?chat-divider-seam-close=${Date.now()}`);await settle();
  await close.tick(3000);await settle();
  await close.click({action:'event-chat'});await settle();
  html=close.app.innerHTML;
  assert.equal(dividersBefore(html,'第一条原话'),1);
  assert.equal(dividersBefore(html,'第二条原话'),1);

  // 重复同步同一个 eventId 不产生重复气泡或重复分割线。
  const repeated=build(at(-60*60_000));
  await import(`../web/app.mjs?chat-divider-repeat=${Date.now()}`);await settle();
  await repeated.tick(3000);await settle();
  await repeated.tick(3000);await settle();
  await repeated.click({action:'event-chat'});await settle();
  html=repeated.app.innerHTML;
  assert.equal((html.match(/第一条原话/g)||[]).length,1);
  assert.equal((html.match(/第二条原话/g)||[]).length,1);
  assert.equal(dividersIn(html).length,2);
});

test('a pending original keeps its enqueue time across an offline reopen and the receipt never duplicates it',async()=>{
  const bridge=()=>window.AlongAgentBridge={request:async input=>{
    if(input.path==='/connection/status')return {along:true,ready:true,runtime:'dsh-superagent',eventProtocol:1,userId:'u_app_b'};
    if(input.path==='/events'){ if(offline) throw Error('offline'); return {status:'accepted',event_id:input.body.event_id}; }
    if(input.path==='/sync/ack')return {acked:input.body.seqs.length};
    if(input.path==='/sync')return {items:syncItems.filter(item=>item.seq>Number(input.body.after_seq??0))};
    throw Error(`Unexpected endpoint: ${input.path}`);
  }};
  let offline=true,syncItems=[];
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  document.visibilityState='visible';bridge();
  await import(`../web/app.mjs?chat-divider-pending=${Date.now()}`);await settle();
  await dom.click({action:'event-chat'});await settle();
  await dom.app.dispatch('submit',{target:{id:'agent-form',fields:{message:'待同步的原话'},querySelector:()=>null,reset(){},setAttribute(){}},preventDefault(){}});
  await settle();

  // 待发原话按入队时间出线，气泡只有一条。
  const cached=JSON.parse(localStorage.getItem('along.event-workspace.v1:u_app_b'));
  const [pending]=Object.values(cached.messages);
  assert.ok(pending?.sentAt,'the queued original must keep its enqueue time');
  let html=dom.app.innerHTML;
  assert.equal((html.match(/待同步的原话/g)||[]).length,1);
  assert.deepEqual(dividersIn(html),[expectedLabel(pending.sentAt)]);

  // 断网重开：原话、时间和分割线都还在。
  const reopened=installDomStub({storage:Object.fromEntries(dom.store)});
  document.visibilityState='visible';bridge();
  await import(`../web/app.mjs?chat-divider-pending-reopen=${Date.now()}`);await settle();
  await reopened.click({action:'event-chat'});await settle();
  html=reopened.app.innerHTML;
  assert.equal((html.match(/待同步的原话/g)||[]).length,1);
  assert.deepEqual(dividersIn(html),[expectedLabel(pending.sentAt)]);

  // 重连后同一个 eventId 的回执只留一份气泡、一条分割线。
  offline=false;
  syncItems=[{seq:1,userId:'u_app_b',kind:'message',payload:{conversation_id:pending.eventId,
    message:{id:'msg_pending',eventId:pending.eventId,role:'user',direction:'inbound',text:'待同步的原话',seq:1,occurredAt:pending.sentAt}}}];
  await reopened.tick(3000);await settle();
  await reopened.click({action:'event-chat'});await settle();
  html=reopened.app.innerHTML;
  assert.equal((html.match(/待同步的原话/g)||[]).length,1);
  assert.deepEqual(dividersIn(html),[expectedLabel(pending.sentAt)]);
});
