import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {validateGoalReply} from '../web/goal-agent-core.mjs';
import {safeAdaptiveLayout, normalizeQuestions} from '../web/adaptive-ui.mjs';

const hostSource=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');

// 从真实发布的宿主源码里切出归一函数，放到独立上下文里跑：
// 断言的是宿主里真正在跑的那份逻辑，不是照抄一份。
function loadNormalizeGoalRun() {
  const start=hostSource.indexOf('function normalizeGoalRun');
  const end=hostSource.indexOf('const server=createServer');
  assert.ok(start>0&&end>start,'找不到宿主的归一函数');
  const context=vm.createContext({validateGoalReply,safeAdaptiveLayout,normalizeQuestions});
  vm.runInContext(`${hostSource.slice(start,end)}\nglobalThis.api={normalizeGoalRun};`,context);
  return context.api;
}

const baseRun={
  kind:'goal',runtime:'dsh-superagent',requestId:'req-1',actual:true,
  source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'正在提交给 DSH'},
  agents:[],events:[],assignments:[],status:'working',statusLabel:'DSH 正在处理',progress:40,
  input:{goal:{domain:'health',title:'本周运动 120 分钟',target:120},message:'我想开始运动'},
};

const validLayout={
  version:1,title:'方案',badge:'试运行',summary:'先做起来。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'每周三次。'}],
  tasks:[{id:'run-check',when:'今晚',title:'记录一次运动',detail:'记录真实运动。',state:'temporary'}],
  questions:[],
};

test('a goal layout the shared validator rejects ends the run instead of failing the read',()=>{
  const {normalizeGoalRun}=loadNormalizeGoalRun();
  const run=normalizeGoalRun({
    ...baseRun,
    result:{reply:'好的，先从记录开始。',proposal:null,layout:{...validLayout,modules:[{kind:'timeline',id:'x',title:'时间线',content:'x'}]}},
  });
  // 校验失败是确定性的错误：这一次运行不会再变好。
  // 落成终态，前端才不会继续轮询、把用户锁在转圈里最长 30 分钟。
  assert.equal(run.status,'blocked','校验失败必须落到终态');
  assert.match(run.error,/输出校验失败/,'要说明失败原因');
  assert.equal(run.result,null,'校验失败的目标空间不能被交付出去');
});

test('a goal reply that fails the shared validator also ends the run',()=>{
  const {normalizeGoalRun}=loadNormalizeGoalRun();
  const run=normalizeGoalRun({...baseRun,result:{reply:'',proposal:null,layout:validLayout}});
  assert.equal(run.status,'blocked');
  assert.match(run.error,/输出校验失败/);
});

test('a valid goal run is still delivered as it is',()=>{
  const {normalizeGoalRun}=loadNormalizeGoalRun();
  const run=normalizeGoalRun({...baseRun,result:{reply:'好的，先从记录开始。',proposal:null,layout:validLayout}});
  assert.equal(run.status,'working','正常的运行不能被改成终态');
  assert.equal(run.result.layout.title,'方案');
  assert.ok(Array.isArray(run.result.layout.tasks)&&run.result.layout.tasks.length===1);
});

test('a run without a result is left alone',()=>{
  const {normalizeGoalRun}=loadNormalizeGoalRun();
  const run=normalizeGoalRun({...baseRun,result:null});
  assert.equal(run.status,'working','还没有产出的运行不能被改成终态');
  assert.equal(run.result,null);
});
