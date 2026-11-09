import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const ADAPTIVE_LAYOUTS_KEY='along.adaptive-layouts.v1';
const TICKET_KEY='along.goal-ticket.v1';
const GOALS_KEY='along.goal-custom.v1';

const layout={
  version:1,title:'在晚班作息里保持健康',badge:'试运行 · 第 1 周',summary:'先验证真实作息，再逐步调整。',
  modules:[
    {kind:'fact_list',id:'known',title:'已知事实',items:[{label:'工作节奏',value:'大部分工作日 14:00 上班、00:00 下班'}]},
    {kind:'metric',id:'exercise',title:'本周运动',source:'workoutMinutes',target:120,unit:'分钟',note:'由 Apple Health 摘要提供'},
  ],
  tasks:[{id:'sleep-check',when:'今晚',title:'记录真实作息',detail:'先记录实际离开工作地点、上床和起床时间。',state:'temporary'}],
  questions:[],
};

function ticket() {
  return {id:'ticket-1',source:'healthkit',trigger:{from:75,to:110},eval:'replan',mandate:'仅提出任务，用户确认后才采用',reason:'本周新增 35 分钟，距目标从 45 分钟变为 10 分钟',status:'proposed',suggestion:{task:'安排 20 分钟拉伸',reason:'先把落下的部分补上'}};
}

test('the health proposal stays adoptable when the goal already has an adaptive layout',async()=>{
  const dom=installDomStub({storage:{
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:layout,finance:null,custom:null}),
    [TICKET_KEY]:JSON.stringify(ticket()),
  }});
  await import('../web/app.mjs');
  assert.match(dom.app.innerHTML,/采用这一步/,'有自适应布局时，HealthKit 提案也必须能看见并采用');
  await dom.click({action:'accept-task'});
  const goals=JSON.parse(dom.storage.get(GOALS_KEY)||'{}');
  assert.equal(goals.health?.task,'安排 20 分钟拉伸');
  assert.equal(dom.storage.get(TICKET_KEY),null);
});
