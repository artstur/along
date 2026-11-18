import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
const config={baseURL:'https://localhost:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};
const RESULT='已读取合成历史：手续费 -1.25 USDT；策略规则仍待补充。';
let instance=0;
async function fixture(patch={}) {
 const event='followup_due_private_history',goal={id:'g_private_detail',domain:'custom',status:'active',revision:1,title:'交易复盘',metric:null,context:[],dataSources:[],tasks:[{id:'t_private_detail',goalId:'g_private_detail',content:'读取历史账单',status:'done',revision:3,execution:{version:1,count:1,records:[{id:'exec_private',kind:'research',outcome:'researched',executedAt:'2026-11-18T08:04:03Z',summary:'已保存授权历史分析',recommendationEventId:event}]}}]};
 const message={eventId:event,role:'assistant',goalId:goal.id,taskId:goal.tasks[0].id,text:RESULT,audience:'background',status:'received',notificationEventId:event,notificationRevision:3,resultEvidence:{kind:'research',id:event},...patch};
 const cache={version:1,recommendationsVersion:1,conversationVersion:1,dataSourcesVersion:1,executionVersion:1,taskCapabilityVersion:1,userId:'u_private_detail',cursor:109,activeGoalId:goal.id,conversationId:null,goals:{[goal.id]:goal},messages:{[event]:message},drafts:{}};
 const dom=installDomStub({storage:{'along.agent.v1':JSON.stringify(config),'along.event-workspace.v1:u_private_detail':JSON.stringify(cache)}});const calls=[];
 window.AlongAgentBridge={request:async r=>{calls.push(r);if(r.path==='/connection/status')return {along:true,ready:true,eventProtocol:1,userId:cache.userId};if(r.path==='/sync')return {items:[]};if(r.path==='/sync/ack')return {acked:0};throw Error(r.path);},notification:async()=>({})};
 await import('../web/app.mjs?private-history-detail='+ ++instance);await new Promise(r=>setTimeout(r,30));return {dom,calls};
}
test('an acknowledged private-history result without web recommendation is visible only inside its evidenced task detail',async()=>{
 const {dom,calls}=await fixture();assert.doesNotMatch(dom.app.innerHTML,/手续费 -1.25/);await dom.click({action:'event-task-detail',taskId:'t_private_detail'});assert.match(dom.app.innerHTML,/已记录 1 次执行/);assert.match(dom.app.innerHTML,/手续费 -1.25 USDT/);assert.match(dom.app.innerHTML,/策略规则仍待补充/);assert.doesNotMatch(dom.app.innerHTML,/recommendation-card|agent-composer/);assert.equal(calls.some(r=>r.path==='/events'),false);
});
