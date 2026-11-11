import test from 'node:test';
import assert from 'node:assert/strict';
import {goalRunNotification, taskRunNotification, healthProposalNotification, notificationWasDelivered, recordNotificationDelivered, readNotificationLedger} from '../web/agent-notifications.mjs';

test('a completed goal run notifies only when it contains an actionable next step', () => {
  const run={actual:true,status:'done',requestId:'req-1',result:{proposal:{task:'今晚 23:30 开始收尾并准备休息'}}};
  assert.deepEqual(goalRunNotification('health',run),{
    id:'goal:req-1',kind:'goal',goalKey:'health',requestId:'req-1',title:'Along 已整理好下一步',body:'下一步：今晚 23:30 开始收尾并准备休息',
  });
  assert.equal(goalRunNotification('health',{...run,status:'working'}),null);
  assert.equal(goalRunNotification('health',{...run,result:{proposal:null,layout:{tasks:[]}}}),null);
});

test('a completed task run points the notification back to the exact task', () => {
  const value=taskRunNotification('custom:abc',{id:'walk',title:'周日去火炉山',detail:'出发前检查降雨和路面'},
    {actual:true,status:'done',requestId:'req-2'});
  assert.equal(value.id,'task:req-2');
  assert.equal(value.taskId,'walk');
  assert.match(value.body,/检查降雨/);
});

test('a health replan notifies only after a concrete proposal exists', () => {
  const proposal=healthProposalNotification({id:'ticket-1',status:'proposed',suggestion:{task:'今天做 20 分钟轻量瑜伽'}});
  assert.equal(proposal.id,'proposal:ticket-1');
  assert.match(proposal.body,/轻量瑜伽/);
  assert.equal(healthProposalNotification({id:'ticket-1',status:'waiting'}),null);
});

test('a health proposal opens the goal that owns the proposed tasks',()=>{
  const ticket={id:'review-1',status:'proposed',suggestion:{task:'保留明天的收工提醒'}};
  assert.equal(healthProposalNotification({...ticket,goalKey:'custom:my-sleep'}).goalKey,'custom:my-sleep');
  assert.equal(healthProposalNotification({...ticket,goalKey:'finance'}),null);
  assert.equal(healthProposalNotification(ticket).goalKey,'health');
});

test('the delivered ledger deduplicates notifications and drops stale or malformed records', () => {
  const now=2_000_000_000_000;
  const saved=recordNotificationDelivered('{"bad":"no"}','goal:req-1',now);
  assert.equal(notificationWasDelivered(saved,'goal:req-1',now),true);
  assert.deepEqual(readNotificationLedger(JSON.stringify({old:now-31*24*60*60_000,fresh:now-1}),now),{fresh:now-1});
});
