import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {recommendation} from './recommendation-fixture.mjs';
const config={baseURL:'https://localhost:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};
let instance=0;
async function fixture({records=true}={}) {
  const goal={id:'goal_detail',domain:'custom',status:'active',revision:1,title:'周末安排',metric:null,context:[],
    dataSources:[{provider:'apple-health',status:'recommended',reason:'使用活动摘要安排周末运动'}],tasks:[
    {id:'research_task',goalId:'goal_detail',status:'open',content:'查天气后推荐周末路线',revision:1,scheduledAt:'2099-01-02T11:00:00Z',
      reminderPlan:{state:'scheduled',source:'agent',repeat:'weekly',weekday:5,timezone:'Asia/Shanghai',explanation:'周五晚准备'},
      ...(records?{execution:{version:1,count:2,records:[{id:'business_run_one',kind:'research',executedAt:'2098-12-26T11:02:00Z',outcome:'researched',summary:'已整理路线方案'}]}}:{})},
    {id:'outing_task',goalId:'goal_detail',status:'open',content:'实际去徒步',revision:1},
    {id:'dated_task',goalId:'goal_detail',status:'open',content:'有日期的实际行动',revision:1,scheduledAt:'2099-01-03T01:00:00Z'},
  ]};
  const r=recommendation(),other=recommendation();other.title='不属于这项任务的方案';
  const messages={bound:{eventId:'bound',role:'assistant',goalId:goal.id,taskId:'research_task',text:'后台结果',audience:'background',status:'received',recommendation:r,notificationEventId:'bound'},
    other:{eventId:'other',role:'assistant',goalId:goal.id,taskId:'outing_task',text:'另一项结果',audience:'background',status:'received',recommendation:other}};
  const saved={version:1,recommendationsVersion:1,conversationVersion:1,userId:'detail_user',cursor:2,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages,drafts:{'goal:goal_detail':'我的草稿'}};
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:detail_user':JSON.stringify(saved)}});
  const calls=[];
  window.AlongAgentBridge={request:async r=>{calls.push(r);if(r.path==='/connection/status')return {along:true,ready:true,eventProtocol:1,userId:'detail_user'};if(r.path==='/sync')return {items:[]};if(r.path==='/sync/ack')return {acked:0};throw Error(r.path);},notification:async()=>({})};
  await import('../web/app.mjs?task-details='+ ++instance);await new Promise(r=>setTimeout(r,30));
  return {dom,calls,goal};
}
test('the three home modules keep sources last and put plans only inside the bound task detail',async()=>{
  const {dom,calls}=await fixture();
  const html=dom.app.innerHTML;
  assert.ok(html.indexOf('周末安排')<html.indexOf('动态任务'));
  assert.ok(html.indexOf('动态任务')<html.indexOf('连接数据源'));
  assert.doesNotMatch(html,/recommendation-card|依据来源|已记录 2 次执行/);
  assert.match(html,/执行时间/);assert.match(html,/定时任务/);assert.match(html,/data-action="event-task-detail" data-task-id="research_task"/);
  await dom.click({action:'event-task-detail',taskId:'research_task'});
  assert.match(dom.app.innerHTML,/已记录 2 次执行/);assert.match(dom.app.innerHTML,/已整理路线方案/);
  assert.match(dom.app.innerHTML,/周末徒步方案/);assert.match(dom.app.innerHTML,/依据来源/);
  assert.doesNotMatch(dom.app.innerHTML,/不属于这项任务的方案|连接数据源|agent-composer/);
  await dom.click({action:'event-task-back'});
  assert.match(dom.app.innerHTML,/动态任务/);assert.doesNotMatch(dom.app.innerHTML,/recommendation-card/);
  assert.equal(calls.some(r=>r.path==='/events'),false,'read-only details never send a user event');
});
test('untimed life tasks are not scheduled tasks and no execution evidence is not completion',async()=>{
  const {dom}=await fixture({records:false});
  const row=dom.app.innerHTML.split('id="event-task-outing_task"')[1].split('</article>')[0];
  assert.match(row,/执行时间.*待安排/);assert.doesNotMatch(row,/定时任务/);
  const dated=dom.app.innerHTML.split('id="event-task-dated_task"')[1].split('</article>')[0];
  assert.doesNotMatch(dated,/定时任务/);
  await dom.click({action:'event-task-detail',taskId:'outing_task'});
  assert.match(dom.app.innerHTML,/已记录 0 次执行/);assert.match(dom.app.innerHTML,/暂无可核实的执行记录/);
  assert.doesNotMatch(dom.app.innerHTML,/已完成徒步|周末徒步方案/);
});
test('recommendation notifications open the exact task detail and retain its source and feedback',async()=>{
  const {dom,goal}=await fixture();const opened=[];
  window.AlongAgentBridge.notification=async(name,value)=>{if(name==='eventTaskOpened')opened.push(value);return {};};
  document.getElementById=id=>dom.app.innerHTML.includes('id="'+id+'"')?{focus(){},scrollIntoView(){}}:null;
  await dom.fireWindow('along-notification-open',{detail:{userId:'detail_user',goalId:goal.id,taskId:'research_task',eventId:'bound',kind:'recommendation_ready'}});
  assert.match(dom.app.innerHTML,/已记录 2 次执行/);assert.match(dom.app.innerHTML,/周末徒步方案/);
  assert.match(dom.app.innerHTML,/event-task-back/);assert.doesNotMatch(dom.app.innerHTML,/agent-composer/);
  assert.equal(opened[0].taskId,'research_task');
  await dom.click({action:'event-recommendation-feedback',eventId:'bound'});
  assert.match(dom.app.innerHTML,/agent-composer/);assert.match(dom.app.innerHTML,/我的草稿/);
  assert.doesNotMatch(dom.app.innerHTML,/后台结果/);
});

test('independent: mismatched recommendation route cannot navigate to another goal before being rejected',async()=>{
 const goal=id=>({id,domain:'custom',status:'active',revision:1,title:'目标'+id,metric:null,context:[],tasks:[{id:'a_'+id,goalId:id,status:'open',content:'研究甲',revision:1},{id:'b_'+id,goalId:id,status:'open',content:'研究乙',revision:1}]});
 const one=goal('one'),two=goal('two');const m={eventId:'rec_result',role:'assistant',text:'后台方案',goalId:'two',taskId:'a_two',audience:'background',recommendation:recommendation(),notificationEventId:'rec_result'};
 const cache={version:1,recommendationsVersion:1,conversationVersion:1,executionVersion:1,userId:'ui_independent',cursor:1,activeGoalId:'one',conversationId:null,goals:{one,two},messages:{rec_result:m},drafts:{}};
 const config={baseURL:'https://localhost:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};
 const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:ui_independent':JSON.stringify(cache)}});
 const receipts=[];window.AlongAgentBridge={request:async r=>r.path==='/connection/status'?{along:true,ready:true,eventProtocol:1,userId:'ui_independent'}:r.path==='/sync'?{items:[]}:{acked:0},notification:async(n,v)=>{if(n==='eventTaskOpened')receipts.push(v);return {};}};
 await import('../web/app.mjs?independent-route');await new Promise(r=>setTimeout(r,30));
 assert.match(dom.app.innerHTML,/<h1>目标one<\/h1>/);
 await dom.fireWindow('along-notification-open',{detail:{userId:'ui_independent',goalId:'two',taskId:'b_two',eventId:'rec_result',kind:'recommendation_ready'}});
 assert.equal(receipts.length,0);assert.match(dom.app.innerHTML,/<h1>目标one<\/h1>/);
});
