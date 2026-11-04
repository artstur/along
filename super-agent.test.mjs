import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceSuperAgentRun, createSuperAgentRun, safeSuperAgentRun} from './super-agent.mjs';

const task={id:'walk-20',when:'今晚',title:'完成 20 分钟快走',detail:'在晚饭后完成一次快走。',state:'planned'};

test('creates a ticket with explicit super-agent domain concepts',()=>{
  const run=createSuperAgentRun({task,domain:'health',goal:{title:'本周运动 120 分钟',target:120},createdAt:1000});
  assert.match(run.id,/^ticket-health-/);
  assert.equal(run.source.kind,'along.dynamic-task');
  assert.equal(run.eval.decision,'accept');
  assert.equal(run.agents.length,4);
  assert.deepEqual(run.agents.map(agent=>agent.role),['Orchestrator','Context','Planner','Guardian']);
  assert.equal(run.progress,68);
});

test('advances agent work without changing the mandate',()=>{
  const run=createSuperAgentRun({task,domain:'health',createdAt:1000});
  const next=advanceSuperAgentRun(run,2000);
  assert.equal(next.step,run.step+1);
  assert.ok(next.progress>run.progress);
  assert.equal(next.mandate,run.mandate);
  assert.equal(next.updatedAt,2000);
});

test('deferred work begins in observe mode and invalid records fail closed',()=>{
  const run=createSuperAgentRun({task:{...task,state:'deferred'},domain:'finance',createdAt:1000});
  assert.equal(run.eval.decision,'observe');
  assert.equal(run.progress,18);
  assert.equal(safeSuperAgentRun({version:9}),null);
});
