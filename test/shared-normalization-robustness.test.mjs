import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAdaptiveLayout, safeAdaptiveLayout, normalizeQuestions} from '../web/adaptive-ui.mjs';
import {normalizeGoalReply, validateGoalReply, numberLikeTarget} from '../web/goal-agent-core.mjs';

// 共享校验层的健壮性：一条脏数据不该把整份结果吞掉。
// 目标空间与回复一样，用户要的是「给我一个能用的方案」，不是一句「格式不正确」。

const baseLayout={
  version:1,title:'方案',badge:'试运行',summary:'摘要',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'内容'}],
  tasks:[{id:'t1',when:'今天',title:'任务',detail:'说明',state:'temporary'}],
  questions:[],
};

test('one malformed recommendation does not void the whole goal space',()=>{
  const cases=[
    ['缺 capability',{id:'duolingo',name:'Duolingo',reason:'理由'}],
    ['名称超长',{id:'d',name:'名'.repeat(61),reason:'理由',capability:'能力'}],
    ['id 带空格',{id:'Duolingo Course',name:'课程',reason:'理由',capability:'能力'}],
    ['理由超长',{id:'d',name:'名',reason:'理'.repeat(241),capability:'能力'}],
    ['名称是对象',{id:'d',name:{a:1},reason:'理由',capability:'能力'}],
  ];
  for (const [label,connection] of cases) {
    const normalized=normalizeAdaptiveLayout({...baseLayout,connections:[connection]},'health');
    const layout=safeAdaptiveLayout(normalized,'health');
    assert.ok(layout,`「${label}」不该把整份目标空间带崩——回复和任务都还在`);
    assert.equal(layout.modules.length,1,`「${label}」不该动到模块`);
    assert.equal(layout.tasks.length,1,`「${label}」不该动到任务`);
  }
});

test('a goal proposal whose target is a number like string becomes that number',()=>{
  // 模型把 120 写成 "120" 是常见失误：同一个数字在布局里已经会归一，
  // 提案这里不该整份拒收。
  const normalized=normalizeGoalReply({reply:'好',proposal:{active:true,title:'本周运动',target:'120',task:'动一动',reason:'按 120 分钟'}});
  assert.equal(normalized.proposal.target,120,'数字字符串要归一成数字');
  assert.equal(typeof normalized.proposal.target,'number');
  const validated=validateGoalReply(normalized,'health','把目标改成 120 分钟');
  assert.equal(validated.proposal.target,120);
});

test('a number like target with a thousands separator becomes that number',()=>{
  assert.equal(numberLikeTarget('10,000'),10000);
  assert.equal(numberLikeTarget('120'),120);
  assert.equal(numberLikeTarget('不是数字'),'不是数字','不是数字的说明文字原样留着');
  assert.equal(numberLikeTarget(120),120);
});

test('a pending question that is not text is dropped instead of shown as an object',()=>{
  // 待确认问题会显示在首页上：兜底成 "[object Object]" 会直接出现在用户眼前。
  assert.deepEqual(normalizeQuestions([{q:'x'},'真的问题']),['真的问题'],'算不出文本的那一条要丢掉');
  assert.deepEqual(normalizeQuestions(['真的问题']),['真的问题']);
  assert.ok(!JSON.stringify(normalizeQuestions([{q:'x'}])).includes('[object Object]'),'不能兜底成 [object Object]');
  assert.deepEqual(normalizeQuestions([123]),['123'],'数字算文本');
});
