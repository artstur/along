import test from 'node:test';
import assert from 'node:assert/strict';
import {customGoalEntries,findInitialCustomGoalCandidate,goalDomain,isCustomGoalKey,validateAdaptiveLayout,safeAdaptiveLayout} from '../web/adaptive-ui.mjs';

const valid={
  version:1,title:'在晚班作息里保持健康',badge:'试运行 · 第 1 周',summary:'先验证真实作息，再逐步调整。',
  modules:[
    {kind:'fact_list',id:'known',title:'已知事实',items:[{label:'工作节奏',value:'大部分工作日 14:00 上班、00:00 下班'}]},
    {kind:'chips',id:'preferences',title:'偏好',items:['瑜伽','普拉提','游泳']},
    {kind:'metric',id:'exercise',title:'本周运动',source:'workoutMinutes',target:120,unit:'分钟',note:'由 Apple Health 摘要提供'},
  ],
  tasks:[{id:'sleep-check',when:'今晚',title:'记录真实作息',detail:'先记录实际离开工作地点、上床和起床时间。',state:'temporary'}],
  questions:['通常通勤需要多久？'],
};

test('adaptive layout keeps only the whitelisted declarative UI schema',()=>{
  const value=validateAdaptiveLayout({...valid,html:'<script>alert(1)</script>'},'health');
  assert.equal(value.title,valid.title);
  assert.equal(value.html,undefined);
  assert.equal(value.modules[2].source,'workoutMinutes');
});

test('an empty optional field does not throw away the whole layout',()=>{
  const empty=structuredClone(valid);
  empty.badge='';
  empty.modules[2].unit='';
  empty.modules[2].note='';
  const value=safeAdaptiveLayout(empty,'health');
  assert.ok(value,'可选字段为空不该让整份布局作废');
  assert.equal(value.badge,'');
  assert.equal(value.modules[2].unit,'');
  assert.equal(value.modules[2].note,'');
  // 必填字段为空仍然要拒绝。
  assert.equal(safeAdaptiveLayout({...valid,summary:''},'health'),null);
});

test('a layout without pending questions is still a usable goal space',()=>{
  const noQuestions=structuredClone(valid);
  delete noQuestions.questions;
  const value=safeAdaptiveLayout(noQuestions,'health');
  assert.ok(value,'少一个可选列表不该让整份目标空间作废');
  assert.deepEqual(value.questions,[]);
  // 真的不是列表仍然要拒绝：缺失可以，畸形不行。
  assert.equal(safeAdaptiveLayout({...noQuestions,questions:'还有问题吗？'},'health'),null);
});

test('adaptive layout rejects invented metric sources and executable module kinds',()=>{
  const badMetric=structuredClone(valid);badMetric.modules[2].source='agentEstimatedMinutes';
  assert.throws(()=>validateAdaptiveLayout(badMetric,'health'),/指标来源不受信任/);
  const badModule=structuredClone(valid);badModule.modules[0].kind='html';
  assert.throws(()=>validateAdaptiveLayout(badModule,'health'),/未允许/);
});

test('adaptive layout caps growth and safely ignores broken stored data',()=>{
  const tooMany=structuredClone(valid);tooMany.tasks=Array.from({length:7},(_,i)=>({...valid.tasks[0],id:`task-${i}`}));
  assert.throws(()=>validateAdaptiveLayout(tooMany,'health'),/动态任务格式不正确/);
  assert.equal(safeAdaptiveLayout({version:99},'health'),null);
});

test('custom goals support generated text modules but no invented metrics',()=>{
  const custom=structuredClone(valid);custom.modules=custom.modules.filter(item=>item.kind!=='metric');
  assert.equal(validateAdaptiveLayout(custom,'custom').modules.length,2);
  assert.throws(()=>validateAdaptiveLayout(valid,'custom'),/指标来源不受信任/);
});

test('a complete first custom goal can be adopted without a hidden confirmation step',()=>{
  const layout=structuredClone(valid);layout.modules=layout.modules.filter(item=>item.kind!=='metric');
  const history=[
    {role:'user',text:'60 天学会基础日语'},
    {role:'assistant',text:'先从 N5 阅读入门',proposal:{title:'60 天日语阅读入门',target:null,task:'从五十音开始',reason:'目标明确'},layout},
  ];
  const candidate=findInitialCustomGoalCandidate(history);
  assert.equal(candidate.index,1);
  assert.equal(candidate.item.proposal.title,'60 天日语阅读入门');
  assert.equal(findInitialCustomGoalCandidate(history,{title:'已有目标'},null),null);
  assert.equal(findInitialCustomGoalCandidate([{...history[1],layout:{...layout,tasks:[]}}]),null);
});

test('multiple custom goals keep independent keys and labels',()=>{
  assert.equal(isCustomGoalKey('custom'),true);
  assert.equal(isCustomGoalKey('custom:second-goal'),true);
  assert.equal(goalDomain('custom:second-goal'),'custom');
  assert.deepEqual(customGoalEntries(
    {custom:{title:'60 天日语阅读入门'},'custom:second-goal':{title:'学会吉他'},health:{title:'健康'}},
    {},
  ),[
    {key:'custom',title:'60 天日语阅读入门'},
    {key:'custom:second-goal',title:'学会吉他'},
  ]);
});

test('a metric target must be a usable number inside the domain range',()=>{
  const metric=target=>structuredClone({...valid,modules:[{kind:'metric',id:'m',title:'本周运动',source:'workoutMinutes',target,unit:'分钟'}]});
  assert.throws(()=>validateAdaptiveLayout(metric(-5),'health'),/指标目标/);
  assert.throws(()=>validateAdaptiveLayout(metric(0),'health'),/指标目标/);
  assert.throws(()=>validateAdaptiveLayout(metric(1e9),'health'),/指标目标/);
  assert.equal(validateAdaptiveLayout(metric(120),'health').modules[0].target,120);
});

test('Japanese learning plans carry a Duolingo connection recommendation',()=>{
  const japanese={...structuredClone(valid),title:'60 天日语阅读入门',summary:'从五十音到 N5 短文',modules:valid.modules.filter(item=>item.kind!=='metric')};
  const migrated=validateAdaptiveLayout(japanese,'custom');
  assert.equal(migrated.connections[0].id,'duolingo');
  assert.equal(migrated.connections[0].status,'recommended');
  const planned=validateAdaptiveLayout({...japanese,connections:[{id:'duolingo',name:'Duolingo',reason:'每日练习',capability:'课程入口',status:'recommended'}]},'custom');
  assert.equal(planned.connections[0].name,'Duolingo');
});
