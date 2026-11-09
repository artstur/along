import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

const ADAPTIVE_LAYOUTS_KEY='along.adaptive-layouts.v1';
const RUNS_KEY='along.super-agent-runs.v2';
const RUNTIME_KEY='along.agent-runtime.v1';

const layout={
  version:1,title:'在晚班作息里保持健康',badge:'试运行',summary:'先验证真实作息。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'以读为主。'}],
  tasks:[{id:'sleep-check',when:'今晚',title:'记录真实作息',detail:'先记录实际离开工作地点、上床和起床时间。',state:'temporary'}],
  questions:[],
};

// 旧版本宿主写下的运行记录：事件里没有时间戳。
const oldRun={
  actual:true,version:2,runtime:'kimi-code-swarm',requestId:'req-old',
  source:{kind:'along',label:'Along 动态任务'},trigger:{kind:'dynamic-task',label:'正在提交给 Kimi'},
  assignments:[],events:[{text:'Along 已建立 Kimi Main Session'},{text:'Swarm Mode 已显式开启',at:null}],
  status:'done',statusLabel:'Kimi Swarm 已完成',progress:100,
};

test('a run record with a missing event time does not freeze the page',async()=>{
  const dom=installDomStub({storage:{
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:layout,finance:null,custom:null}),
    [RUNS_KEY]:JSON.stringify({'health:kimi-code-swarm:sleep-check':oldRun}),
  }});
  await import('../web/app.mjs?old-run-event-time');
  // 关键在于 render() 不能抛：Intl 格式化无效日期会抛 RangeError，
  // 界面会停在旧页面上，之后每一次重绘都失败。
  await dom.click({action:'open-task',taskId:'sleep-check'});
  assert.match(dom.app.innerHTML,/任务协作/,'没有时间戳的旧记录也要能把页面画出来，不能让 render() 抛错');
});

test('an untrusted legacy run record is not replaced by a fake connecting run',async()=>{
  const dom=installDomStub({storage:{
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:layout,finance:null,custom:null}),
    [RUNTIME_KEY]:JSON.stringify('dsh-superagent'),
    [RUNS_KEY]:JSON.stringify({'health:sleep-check':{actual:true,runtime:'dsh-superagent',requestId:'req-legacy',status:'done',error:'宿主说这条记录不可信'}}),
  }});
  // 记录每一次渲染：提交路径很快就会用新的运行覆盖这一条，
  // 只有首次渲染才看得到旧键里的记录被怎么处理。
  const renders=[];
  Object.defineProperty(dom.app,'innerHTML',{get(){return renders[renders.length-1]??'';},set(value){renders.push(value);},configurable:true});
  await import('../web/app.mjs?untrusted-legacy-run');
  await dom.click({action:'open-task',taskId:'sleep-check'});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(renders.length>0,'任务页要渲染过');
  assert.ok(!renders.some(html=>/连接 DSH Super Agent/.test(html)),'旧键里的记录也要落到明确的失败，不能造一个假的「正在连接」');
  assert.ok(renders.some(html=>/宿主说这条记录不可信/.test(html)),'宿主给的原因要能被看到');
});
