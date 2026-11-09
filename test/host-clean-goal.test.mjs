import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const hostSource=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');

// 从真实发布的宿主源码里取出目标清洗这段，拿到独立上下文里跑：
// 断言的是宿主里真正在跑的那份清洗逻辑，不是照抄一份。
function loadCleanGoal() {
  const start=hostSource.indexOf('function cleanGoalTitle');
  const end=hostSource.indexOf('function cleanSnapshot');
  assert.ok(start>0&&end>start,'找不到宿主的目标清洗函数');
  const context=vm.createContext({});
  vm.runInContext(`${hostSource.slice(start,end)}\nglobalThis.cleanGoal=cleanGoal;`,context);
  return context.cleanGoal;
}

test('the host rejects a goal title that is not really a string',()=>{
  const cleanGoal=loadCleanGoal();
  assert.deepEqual({...cleanGoal({domain:'custom',title:'60 天日语阅读入门'})},{domain:'custom',target:null,title:'60 天日语阅读入门'});
  // String() 会把对象变成 "[object Object]"，这样的假标题不该被当成用户目标。
  assert.throws(()=>cleanGoal({domain:'custom',title:{text:'目标'}}),/目标名称无效/);
  assert.throws(()=>cleanGoal({domain:'health',title:['目标'],target:120}),/目标名称无效/);
  assert.throws(()=>cleanGoal({domain:'health',title:120,target:120}),/目标名称无效/);
  assert.throws(()=>cleanGoal({domain:'health',title:'  ',target:120}),/目标名称无效/);
  assert.throws(()=>cleanGoal({domain:'health',title:'x'.repeat(81),target:120}),/目标名称无效/);
});

test('the host still accepts a well formed goal',()=>{
  const cleanGoal=loadCleanGoal();
  assert.deepEqual({...cleanGoal({domain:'health',title:'本周累计运动 120 分钟',target:120})},{domain:'health',target:120,title:'本周累计运动 120 分钟'});
  assert.throws(()=>cleanGoal({domain:'health',title:'目标',target:0}),/目标数值无效/);
  assert.throws(()=>cleanGoal({domain:'health',title:'目标',target:1.5}),/目标数值无效/);
});
