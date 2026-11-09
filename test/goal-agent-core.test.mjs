import test from 'node:test';
import assert from 'node:assert/strict';
import {routeHealthChange,requestedTargetFromMessage,validateGoalReply,validateTaskReply,goalChangeText} from '../web/goal-agent-core.mjs';

test('health router stays quiet for unrelated or small changes and replans a meaningful change',()=>{
  assert.equal(routeHealthChange({workoutMinutes:75},{workoutMinutes:75,steps:12000},120).decision,'quiet');
  assert.equal(routeHealthChange({workoutMinutes:75},{workoutMinutes:76},120).decision,'quiet');
  assert.deepEqual(routeHealthChange({workoutMinutes:75},{workoutMinutes:110},120),{
    decision:'replan',reason:'本周新增 35 分钟，距目标从 45 分钟变为 10 分钟',oldRemaining:45,remaining:10,delta:35,
  });
});

test('agent proposals must preserve the deterministic goal domain and remaining progress',()=>{
  assert.equal(validateGoalReply('{"reply":"建议先试一周","proposal":{"title":"每周运动 150 分钟","target":150,"task":"安排 20 分钟活动","reason":"符合约束"}}','health').proposal.target,150);
  assert.throws(()=>validateGoalReply('{"reply":"好","proposal":{"title":"过量","target":10081,"task":"跑步","reason":"超限"}}','health'));
  assert.throws(()=>validateTaskReply('{"task":"活动 20 分钟","reason":"变化","remaining":20}',10));
});

test('explicit numeric targets are recognized without interpreting a daily limit as the goal',()=>{
  assert.equal(requestedTargetFromMessage('这周运动目标改为 150 分钟，但每天只有 20 分钟','health'),150);
  assert.equal(requestedTargetFromMessage('目标设为 2 小时','health'),120);
  assert.equal(requestedTargetFromMessage('每月目标改为 ¥12,000 元','finance'),12000);
});

test('custom goals can produce a title and task without inventing a numeric target',()=>{
  const value=validateGoalReply({reply:'先建立试运行方案',proposal:{title:'完成第一部长篇小说',target:null,task:'整理故事主线',reason:'先明确范围'},layout:{}},'custom');
  assert.equal(value.proposal.target,null);
  assert.equal(requestedTargetFromMessage('未来半年完成一部长篇小说','custom'),null);
});

test('a daily cap or a budget is not the goal target',()=>{
  assert.equal(requestedTargetFromMessage('把每天上限改成 30 分钟','health'),null);
  assert.equal(requestedTargetFromMessage('每天运动改成 20 分钟','health'),null);
  assert.equal(requestedTargetFromMessage('预算改为 500 元','finance'),null);
  assert.equal(requestedTargetFromMessage('这周运动目标改为 150 分钟，但每天只有 20 分钟','health'),150);
  assert.equal(requestedTargetFromMessage('每周运动 120 分钟','health'),null);
});

test('a compound duration and a bare yen amount are read as one number',()=>{
  assert.equal(requestedTargetFromMessage('目标改为 2 小时 30 分钟','health'),150);
  assert.equal(requestedTargetFromMessage('目标改为 ¥12,000','finance'),12000);
  assert.equal(requestedTargetFromMessage('设定成 150 分钟','health'),150);
});

test('only a goal-scoped assignment counts as the goal target',()=>{
  assert.equal(requestedTargetFromMessage('目标达到 150 分钟','health'),150);
  assert.equal(requestedTargetFromMessage('今天运动量达到 150 分钟','health'),null);
  assert.equal(requestedTargetFromMessage('目标改为 30 分钟以内','health'),null);
  assert.equal(requestedTargetFromMessage('目标改成 150 分钟（每天 3 次）','health'),150);
  assert.equal(requestedTargetFromMessage('预算改为 500 元，目标改为 12000 元','finance'),12000);
});

test('a reply without a proposal is kept even when the user named a number',()=>{
  const value=validateGoalReply({reply:'这是纯文字回答'},'health','这周运动目标改为 150 分钟');
  assert.equal(value.reply,'这是纯文字回答');
  assert.equal(value.proposal,null);
});

test('the proposal preview states no change when there is no proposal',()=>{
  assert.equal(goalChangeText({target:120},null,'health'),'');
  assert.equal(goalChangeText({target:10000},null,'finance'),'');
  assert.equal(goalChangeText({target:120},{target:150},'health'),'120 → 150 分钟 / 周');
  assert.equal(goalChangeText({target:10000},{target:12000},'finance'),'¥10,000 → ¥12,000');
  assert.equal(goalChangeText({target:null},{target:null},'custom'),'建立新的自定义目标');
});
