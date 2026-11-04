import test from 'node:test';
import assert from 'node:assert/strict';
import {createFailedSuperAgentRun, createPendingSuperAgentRun, createSuperAgentRequest, safeSuperAgentRun} from './super-agent.mjs';

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
