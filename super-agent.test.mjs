import test from 'node:test';
import assert from 'node:assert/strict';
import {createFailedGoalSuperAgentRun, createFailedSuperAgentRun, createGoalSuperAgentRequest, createPendingGoalSuperAgentRun,
  createPendingSuperAgentRun, createSuperAgentRequest, safeGoalSuperAgentRun, safeSuperAgentRun} from './super-agent.mjs';

const task={id:'walk-20',when:'今晚',title:'完成 20 分钟快走',detail:'在晚饭后完成一次快走。',state:'planned'};

test('creates a stable request for the real Along Source',()=>{
  const request=createSuperAgentRequest({task,domain:'health',goal:{title:'本周运动 120 分钟',target:120}});
  assert.match(request.requestId,/^along-health-/);
  assert.equal(request.goal.domain,'health');
  assert.equal(request.task.title,'完成 20 分钟快走');
});

test('pending state does not claim that DSH accepted or executed the task',()=>{
  const request=createSuperAgentRequest({task,domain:'health'});
  const run=createPendingSuperAgentRun(request,1000);
  assert.equal(run.actual,false);
  assert.equal(run.eval,null);
  assert.equal(run.ticket,null);
  assert.equal(run.progress,2);
});

test('records connection failures and rejects legacy simulated runs',()=>{
  const request=createSuperAgentRequest({task:{...task,state:'deferred'},domain:'finance'});
  assert.equal(createFailedSuperAgentRun(request,'setup incomplete').status,'blocked');
  assert.equal(safeSuperAgentRun({version:1,runtime:'local'}),null);
});

test('creates and validates a real full-goal orchestration request',()=>{
  const request=createGoalSuperAgentRequest({domain:'custom',goal:{title:'定义目标',target:null},message:'半年完成一部长篇小说',
    requestId:'along-goal-custom-novel',history:[{role:'user',text:'我只有周末有空'}]});
  assert.equal(request.requestId,'along-goal-custom-novel');
  assert.equal(request.goal.domain,'custom');
  assert.equal(request.history[0].role,'user');
  const pending=createPendingGoalSuperAgentRun(request,1000);
  assert.equal(pending.actual,false);
  assert.equal(pending.kind,'goal');
  assert.equal(pending.progress,2);
  assert.equal(safeGoalSuperAgentRun({...pending,actual:true,agents:[],events:[]}).requestId,request.requestId);
  assert.equal(createFailedGoalSuperAgentRun(request,'offline').status,'blocked');
});
