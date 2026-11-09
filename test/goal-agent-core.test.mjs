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

test('a change verb counts as an assignment only when a goal word qualifies it',()=>{
  assert.equal(requestedTargetFromMessage('目标调整为 200 分钟','health'),200);
  assert.equal(requestedTargetFromMessage('目标提高到 200 分钟','health'),200);
  assert.equal(requestedTargetFromMessage('把目标减到 100 分钟','health'),100);
  assert.equal(requestedTargetFromMessage('把目标调到 120 分钟','health'),120);
  assert.equal(requestedTargetFromMessage('把目标调成 130 分钟','health'),130);
  assert.equal(requestedTargetFromMessage('把目标改到 140 分钟','health'),140);
  assert.equal(requestedTargetFromMessage('今天运动量提高到 150 分钟','health'),null);
  assert.equal(requestedTargetFromMessage('今天运动量调整为 150 分钟','health'),null);
});

test('a money amount is only read when the text carries a currency marker',()=>{
  assert.equal(requestedTargetFromMessage('目标改为 3 万元','finance'),30000);
  assert.equal(requestedTargetFromMessage('目标改为 1.5 万元','finance'),15000);
  assert.equal(requestedTargetFromMessage('目标改为 ¥3万','finance'),30000);
  assert.equal(requestedTargetFromMessage('存钱目标改成 30000','finance'),null);
  assert.equal(requestedTargetFromMessage('目标改成 3 万','finance'),null);
  assert.equal(requestedTargetFromMessage('目标改成 3 万 5','finance'),null);
  assert.equal(requestedTargetFromMessage('还款目标改成 3 期','finance'),null);
});

test('a bare 分 is only read as minutes when it does not start another word',()=>{
  assert.equal(requestedTargetFromMessage('目标改为 3 分期','health'),null);
  assert.equal(requestedTargetFromMessage('目标改为 150 分','health'),150);
  assert.equal(requestedTargetFromMessage('目标改为 2 小时 30 分','health'),150);
});

// 语料基线：每一条都是「用户是否真的指派了目标数值」的判断，任何一条变化都要有意识地改。
const PHRASE_CORPUS=[
  ['目标改为 150 分钟','health',150],
  ['把每周运动目标改成 150 分钟','health',150],
  ['这周运动目标改为 150 分钟，但每天只有 20 分钟','health',150],
  ['目标设为 2 小时','health',120],
  ['目标改成 90 分钟','health',90],
  ['运动目标定为 180 分钟','health',180],
  ['运动目标 150 分钟','health',150],
  ['每周目标改成 150 分钟','health',150],
  ['目标改为 1.5 小时','health',90],
  ['目标改成 150分钟','health',150],
  ['目标改为 150 分','health',150],
  ['目标改为 2 小时 30 分钟','health',150],
  ['目标改为 1 小时 45 分钟','health',105],
  ['目标改为 2 小时，每天 30 分钟','health',120],
  ['设定成 150 分钟','health',150],
  ['目标调整为 200 分钟','health',200],
  ['目标提高到 200 分钟','health',200],
  ['把目标减到 100 分钟','health',100],
  ['把目标调到 120 分钟','health',120],
  ['把每天上限改成 30 分钟','health',null],
  ['每天运动改成 20 分钟','health',null],
  ['把单次上限设为 45 分钟','health',null],
  ['上限改成 40 分钟','health',null],
  ['每次 30 分钟','health',null],
  ['我每天最多运动 30 分钟','health',null],
  ['每周不超过 200 分钟','health',null],
  ['每天最多 30 分钟','health',null],
  ['目标改为 30 分钟以内','health',null],
  ['目标改成 30 分钟封顶','health',null],
  ['目标改为 30 分钟，每天 3 次','health',30],
  ['目标改为 30 分钟每天 3 次','health',30],
  ['目标改成 150 分钟（每天 3 次）','health',150],
  ['目标改成 150 分钟，每天最多 45 分钟','health',150],
  ['每周运动 120 分钟','health',null],
  ['我上周运动了 120 分钟','health',null],
  ['今天运动量达到 150 分钟','health',null],
  ['先达到 150 分钟','health',null],
  ['目标达到 150 分钟','health',150],
  ['目标改为 150 分钟，第一阶段先做 50 分钟','health',150],
  ['第一阶段先做 50 分钟，目标改为 150 分钟','health',150],
  ['目标改成 150 分钟，这周已经做了 60 分钟','health',150],
  ['预算改为 500 元','finance',null],
  ['每月预算改成 3000 元','finance',null],
  ['把预算设为 20000 元','finance',null],
  ['预算改成 ¥500','finance',null],
  ['每天最多花 100 元','finance',null],
  ['餐饮预算 800 元','finance',null],
  ['允许额度 500 元','finance',null],
  ['每月可支配 5000 元','finance',null],
  ['预算改为 500 元，目标改为 12000 元','finance',12000],
  ['目标改为 ¥12,000','finance',12000],
  ['目标改为 12000 元','finance',12000],
  ['目标改为 12,000 元','finance',12000],
  ['目标改为 ¥12,000 元','finance',12000],
  ['目标改成 30000 人民币','finance',30000],
  ['每月目标改为 ¥12,000 元','finance',12000],
  ['目标改成 5000 块','finance',5000],
  ['设定为 ¥500','finance',500],
  ['存钱目标改成 30000','finance',null],
  ['目标改为 3 万元','finance',30000],
  ['目标改为 1.5 万元','finance',15000],
  ['目标改为 0 分钟','health',null],
  ['目标改为 10081 分钟','health',null],
  ['目标改为 0 元','finance',null],
  ['不要把目标改成 150 分钟','health',null],
  ['先别把目标改成 150 分钟','health',null],
  ['如果目标改成 150 分钟就好了','health',null],
  ['不要把目标改成 30000 元','finance',null],
  ['如果目标改成 30000 元就好了','finance',null],
  ['每月房租设为 2500 元','finance',null],
  ['评分目标改为 3 分','health',null],
  ['目标改成 150 分钟，目标改成 180 分钟','health',180],
  ['目标改成 30000 元，目标改成 12000 元','finance',12000],
  ['目标别忘了改成 150 分钟','health',150],
  ['不要忘记目标改成 150 分钟','health',150],
  ['交完房租把目标改成 12000 元','finance',12000],
  ['保险买完后目标改成 3 万元','finance',30000],
  ['水电费交完后目标改成 12000 元','finance',12000],
  ['目标改成 150 分钟，改成 200 分钟更好','health',150],
  ['目标改成 150 分钟，改成 200 分钟如果天气好','health',150],
  ['目标改成 150 分钟，下次改成 200 分钟','health',150],
  ['指标调整为 200 分钟','health',200],
  ['指标提高到 200 分钟','health',200],
  ['餐费改成 500 元','finance',null],
  ['煤气费改成 300 元','finance',null],
  ['宽带费改成 200 元','finance',null],
  ['评分目标改成 3 分','health',null],
  ['得分目标改成 3 分','health',null],
  ['评分指标改成 3 分','health',null],
  ['保险目标改成 3 万元','finance',null],
  ['房租目标改成 2500 元','finance',null],
  ['保费目标改成 3 万元','finance',null],
  ['水电费指标改成 100 元','finance',null],
  ['目标改成 150 分钟，睡眠改成 8 小时','health',150],
  ['目标改成 12000 元，存款改成 5000 元','finance',12000],
  ['目标改成 150 分钟，评分指标改成 3 分','health',150],
  ['今天运动量改成 150 分钟','health',null],
  ['这周运动量改成 150 分钟','health',null],
  ['睡眠改成 8 小时','health',null],
  ['本月开销改成 500 元','finance',null],
  ['存款改成 5000 元','finance',null],
  ['目标改成 150 分钟，更好','health',null],
  ['目标改成 150 分钟，如果天气好','health',150],
  ['目标改成 150 分钟，如果完成就奖励我','health',150],
  ['改成 200 分钟如果天气好','health',null],
  ['改成 200 分钟，更好','health',null],
  ['未来半年完成一部长篇小说','custom',null],
];

test('the phrase corpus keeps every expected target',()=>{
  for (const [message,domain,expected] of PHRASE_CORPUS) {
    assert.equal(requestedTargetFromMessage(message,domain),expected,message);
  }
});

test('the proposal preview states no change when there is no proposal',()=>{
  assert.equal(goalChangeText({target:120},null,'health'),'');
  assert.equal(goalChangeText({target:10000},null,'finance'),'');
  assert.equal(goalChangeText({target:120},{target:150},'health'),'120 → 150 分钟 / 周');
  assert.equal(goalChangeText({target:10000},{target:12000},'finance'),'¥10,000 → ¥12,000');
  assert.equal(goalChangeText({target:null},{target:null},'custom'),'建立新的自定义目标');
});
