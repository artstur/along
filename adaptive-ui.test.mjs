import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAdaptiveLayout,safeAdaptiveLayout} from './adaptive-ui.mjs';

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
