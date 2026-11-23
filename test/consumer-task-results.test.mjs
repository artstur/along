import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {createEventWorkspace} from '../web/event-workspace.mjs';
import {taskResultBodyRelevant} from '../web/task-results.mjs';

const config={userId:'u_readable',baseURL:'https://localhost:4176',fingerprint:'a'.repeat(64),token:'b'.repeat(64)};
const key='along.event-workspace.v1:'+config.userId;
const receipt='calc_'+'a'.repeat(40);
const resultId='followup_readable';
const presentation={version:1,title:'今晚的安排',summary:'保留原有安排，先完成睡前准备。',
  actions:[{text:'收起手机',when:'睡前'}],sections:[{heading:'安排依据',body:'只使用已确认的数据。'}]};
const snapshot=()=>({goal:{id:'g_readable',domain:'custom',status:'active',currentRevision:1},
  revision:{goalId:'g_readable',revision:1,title:'持续改善作息',status:'active'},tasks:[{
    id:'t_readable',goalId:'g_readable',content:'核算安排',status:'done',currentRevision:2,
    execution:{version:1,count:1,records:[{id:'exec_readable',kind:'calculation',outcome:'calculated',
      executedAt:'2026-11-24T00:00:00Z',calculationReceiptId:receipt,summary:'已完成核算'}]}}]});
const wire=(text,extra={})=>({seq:3,userId:config.userId,kind:'message',goalId:'g_readable',taskId:'t_readable',payload:{
  snapshot:snapshot(),presentation:'execution',calculation_receipt_id:receipt,task_execution_revision:1,
  notification:{kind:'task_result',event_id:resultId,revision:2},
  message:{id:'msg_readable',eventId:resultId,role:'assistant',direction:'outbound',audience:'background',text,seq:3},...extra}});
function bridge(items) {
  window.AlongAgentBridge={request:async input=>{
    if(input.path==='/connection/status')return {along:true,ready:true,runtime:'dsh-superagent',eventProtocol:1,userId:config.userId};
    if(input.path==='/sync')return {items:input.body.after_seq?[]:items};
    if(input.path==='/sync/ack')return {acked:input.body.seqs.length};
    throw Error(input.path);
  }};
}

test('a scoped long execution body survives sync and offline reopen without clipping the final instruction',async()=>{
  installDomStub();
  const body='## 已核算的结果\n\n'+('这段说明保持完整，不代表新的用户指令。'.repeat(140))+'\n\n最后一步：保留原来的任务。';
  assert.ok(body.length>2000&&body.length<16000);bridge([wire(body)]);
  const workspace=createEventWorkspace({config});await workspace.sync();
  assert.equal(workspace.view().messages[0]?.text,body);
  assert.equal(workspace.view().goals.g_readable.tasks[0].execution.count,1);
  window.AlongAgentBridge.request=async()=>{throw Error('offline');};
  const reopened=createEventWorkspace({config});await reopened.sync();
  assert.equal(reopened.view().messages[0]?.text,body);
  assert.equal(reopened.view().messages[0]?.audience,'background');
});

test('the display extension is saved separately from execution classification and restored offline',async()=>{
  installDomStub();bridge([wire('完整结果。',{result_presentation:presentation})]);
  const workspace=createEventWorkspace({config});await workspace.sync();
  assert.equal(workspace.view().messages[0].presentation,'execution');
  assert.deepEqual(workspace.view().messages[0].resultPresentation,presentation);
  const reopened=createEventWorkspace({config});
  assert.deepEqual(reopened.view().messages[0].resultPresentation,presentation);
});

test('legacy task results render headings and steps and keep the complete tail in the task detail',async()=>{
  const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config)}});
  const body='## 今晚的安排\n\n这是合成数据的说明。\n\n1. 保留原有任务\n2. 留出准备时间\n\n'+
    '说明内容。'.repeat(110)+'\n\n最后一行也必须能读到。';
  bridge([wire(body)]);
  await import(`../web/app.mjs?readable-results=${Date.now()}`);
  await new Promise(resolve=>setTimeout(resolve,30));
  await dom.click({action:'event-task-detail',taskId:'t_readable'});
  assert.match(dom.app.innerHTML,/<h3>今晚的安排<\/h3>/);
  assert.match(dom.app.innerHTML,/<ol[^>]*><li>保留原有任务<\/li><li>留出准备时间<\/li><\/ol>/);
  assert.match(dom.app.innerHTML,/最后一行也必须能读到。/);
  assert.match(dom.app.innerHTML,/<summary>阅读完整结果<\/summary>/);
  assert.doesNotMatch(dom.app.innerHTML,/<p>## 今晚的安排/);
  await dom.click({action:'event-task-back'});
  await dom.click({action:'event-chat'});
  assert.doesNotMatch(dom.app.innerHTML,/最后一行也必须能读到。/,'execution results cannot enter direct chat');
});

test('ordinary chat and mismatched task evidence cannot acquire the longer result allowance',async()=>{
  for(const mutate of [
    item=>{item.payload.message.audience='conversation';},
    item=>{item.payload.calculation_receipt_id='calc_'+'b'.repeat(40);},
    item=>{item.taskId='t_foreign';},
    item=>{item.payload.notification.revision=3;},
    item=>{item.payload.task_execution_revision=3;},
    item=>{delete item.payload.task_execution_revision;},
    item=>{delete item.payload.calculation_receipt_id;},
    item=>{item.payload.message.text='字'.repeat(16001);},
  ]){
    installDomStub();const item=wire('字'.repeat(2100),{result_presentation:presentation});mutate(item);bridge([item]);
    const workspace=createEventWorkspace({config});await workspace.sync();
    assert.equal(workspace.view().cursor,0);assert.equal(workspace.view().messages.length,0);
    assert.match(workspace.view().error,/对话同步格式不正确/);
  }
});

test('an invalid optional display structure falls back to text and preserves task identity on sync and reopen',async()=>{
  installDomStub();bridge([wire('可信旧正文',{result_presentation:{...presentation,sections:[{heading:'说明',body:'内容',raw:'bad'}]}})]);
  const workspace=createEventWorkspace({config});await workspace.sync();
  assert.equal(workspace.view().cursor,3);assert.equal(workspace.view().messages[0].resultPresentation,undefined);
  const saved=JSON.parse(localStorage.getItem(key));saved.messages[resultId].resultPresentation={...presentation,version:9};
  localStorage.setItem(key,JSON.stringify(saved));const reopened=createEventWorkspace({config});
  assert.equal(reopened.view().messages[0].text,'可信旧正文');assert.equal(reopened.view().messages[0].resultPresentation,undefined);
  assert.equal(reopened.view().goals.g_readable.tasks[0].id,'t_readable');
});

test('a later revision or cancellation does not destroy a previously accepted long body or the offline workspace',async()=>{
  installDomStub();const body='保留历史内容。'.repeat(400);bridge([wire(body,{result_presentation:presentation})]);
  const workspace=createEventWorkspace({config});await workspace.sync();
  const saved=JSON.parse(localStorage.getItem(key));saved.goals.g_readable.tasks[0].revision=3;
  saved.goals.g_readable.tasks[0].status='cancelled';localStorage.setItem(key,JSON.stringify(saved));
  const reopened=createEventWorkspace({config}),view=reopened.view();
  assert.equal(view.messages[0].text,body);assert.equal(view.goals.g_readable.tasks[0].status,'cancelled');
  assert.equal(taskResultBodyRelevant(view.messages[0],view.goals.g_readable,view.goals.g_readable.tasks[0]),false);
});

test('already acknowledged results replay their presentation once without duplicate alerts or lost drafts',async()=>{
  installDomStub();bridge([wire('原始正文')]);const workspace=createEventWorkspace({config});await workspace.sync();
  const saved=JSON.parse(localStorage.getItem(key));delete saved.resultPresentationVersion;
  saved.cursor=12;saved.activeGoalId='g_readable';saved.drafts={'goal:g_readable':'保留草稿'};localStorage.setItem(key,JSON.stringify(saved));
  const after=[],notices=[];window.AlongAgentBridge.request=async input=>{
    if(input.path==='/sync'){after.push(input.body.after_seq);return {items:input.body.after_seq===0?[{...wire('完整正文',{result_presentation:presentation}),createdAt:new Date().toISOString(),remoteNotifications:false}]:[]};}
    return {acked:1};
  };
  const upgraded=createEventWorkspace({config,onNotifications:value=>notices.push(value)});await upgraded.sync();await upgraded.sync();
  assert.deepEqual(after,[0,12]);assert.equal(upgraded.view().cursor,12);assert.equal(upgraded.draft(),'保留草稿');
  assert.deepEqual(upgraded.view().messages[0].resultPresentation,presentation);assert.deepEqual(notices.flatMap(item=>item.results),[]);
});

test('an interrupted presentation replay resumes its own cursor after offline reopen',async()=>{
  installDomStub();bridge([wire('旧正文')]);const workspace=createEventWorkspace({config});await workspace.sync();
  const saved=JSON.parse(localStorage.getItem(key));delete saved.resultPresentationVersion;saved.cursor=12;localStorage.setItem(key,JSON.stringify(saved));
  const after=[];let interrupted=true;window.AlongAgentBridge.request=async input=>{
    if(input.path==='/sync'){
      after.push(input.body.after_seq);
      if(input.body.after_seq===0)return {items:[wire('完整正文',{result_presentation:presentation})],nextCursor:'3'};
      if(interrupted)throw Error('offline');return {items:[]};
    }
    return {acked:1};
  };
  const upgrading=createEventWorkspace({config});await upgrading.sync();
  assert.equal(JSON.parse(localStorage.getItem(key)).resultPresentationReplayAfter,3);
  interrupted=false;const reopened=createEventWorkspace({config});await reopened.sync();
  assert.deepEqual(after,[0,3,3]);assert.equal(reopened.view().cursor,12);
  assert.deepEqual(reopened.view().messages[0].resultPresentation,presentation);
  assert.equal(JSON.parse(localStorage.getItem(key)).resultPresentationReplayAfter,undefined);
});

test('old long results replay and reopen after 21 executions without depending on the latest 20 receipts',async()=>{
  installDomStub();const body='这份历史结果需要完整保留。'.repeat(220),item=wire(body,{result_presentation:presentation});
  item.payload.snapshot.tasks[0].currentRevision=24;
  item.payload.snapshot.tasks[0].execution={version:1,count:21,records:Array.from({length:20},(_,i)=>({
    id:'later_exec_'+i,kind:'calculation',outcome:'calculated',executedAt:'2026-11-24T00:00:00Z',
    calculationReceiptId:'calc_'+(i+1).toString(16).padStart(40,'0'),summary:'后续执行'}))};
  bridge([item]);const workspace=createEventWorkspace({config});await workspace.sync();
  assert.equal(workspace.view().messages[0]?.text,body);
  assert.deepEqual(workspace.view().messages[0]?.resultPresentation,presentation);
  assert.equal(workspace.view().goals.g_readable.tasks[0].execution.count,21);
  const reopened=createEventWorkspace({config}),view=reopened.view();
  assert.equal(view.messages[0]?.text,body);assert.equal(view.goals.g_readable.tasks[0].execution.count,21);
  assert.equal(taskResultBodyRelevant(view.messages[0],view.goals.g_readable,view.goals.g_readable.tasks[0]),false);
});
