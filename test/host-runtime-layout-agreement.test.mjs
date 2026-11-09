import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {KimiCodeAgent} from '../host/kimi-code-agent.mjs';
import {validateGoalReply} from '../web/goal-agent-core.mjs';
import {safeAdaptiveLayout, normalizeQuestions, normalizeAdaptiveLayout} from '../web/adaptive-ui.mjs';

// 两条运行时对同一份模型输出必须给出同一个结论：要么都收下同样的目标空间，
// 要么都明确失败。同一份输出在一边被作废、在另一边照单全收，用户看到的
// 就是两条运行时结论相反。

const baseLayout={
  version:1,title:'日语阅读 60 天',badge:'试运行',summary:'每天用碎片时间阅读。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'以读为主。'}],
  tasks:[{id:'read-10',when:'今天',title:'阅读 10 分钟',detail:'选一段入门材料。',state:'planned'}],
  questions:[],
};

function json(data,code=0,status=200) { return new Response(JSON.stringify({code,msg:code===0?'success':'failed',data,request_id:'test'}),{status,headers:{'content-type':'application/json'}}); }

// 一个可配置的 Kimi Code Web Server 替身：任何会话都回同一份输出。
function kimiServer(output) {
  const statePath=join(tmpdir(),`along-kimi-layout-${crypto.randomUUID()}.json`);
  let sessionCount=0;
  const fetchImpl=async(url,options={})=>{
    const path=new URL(url).pathname;
    if (path==='/api/v1/meta') return json({server_version:'2.5.0',features:[{name:'swarm',state:'Active'}]});
    if (path==='/api/v1/auth') return json({models_ready:true});
    if (path==='/api/v1/oauth/userinfo') return json({kind:'ok',userInfo:{userLevelName:'Pro'}});
    if (path==='/api/v1/sessions'&&options.method==='POST') return json({id:`session-${++sessionCount}`});
    const session=path.match(/^\/api\/v1\/sessions\/([^/]+)(\/.*)?$/);
    if (session) {
      const id=decodeURIComponent(session[1]),rest=session[2]||'';
      if (rest==='/profile') return json({id,agent_config:{swarm_mode:'manual'}});
      if (rest==='/prompts') return json({accepted:true});
      if (rest==='') return json({id,busy:false,last_turn_reason:'completed',pending_interaction:'none',updated_at:'2026-11-05T08:00:00Z'});
      if (rest==='/messages') return json({items:[{id:'m1',session_id:id,role:'assistant',created_at:'2026-11-05T08:00:00Z',content:[{type:'text',text:JSON.stringify(output)}]}]});
      if (rest==='/children') return json({items:[]});
      if (rest==='/transcript') return json({items:[{kind:'turn',steps:[{frames:[{kind:'tool',name:'AgentSwarm',input:{items:['子 Agent']},output:'<subagent agent_id="agent-0" item="子 Agent" outcome="completed">ok</subagent>'}]}]}]});
    }
    throw Error(`unexpected ${path}`);
  };
  return {statePath,fetchImpl};
}

// 从真实发布的宿主源码里取出 DSH 那条路径的归一，拿到独立上下文里跑。
function loadDshNormalizer() {
  const source=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');
  const start=source.indexOf('function normalizeGoalRun');
  const end=source.indexOf('const server=createServer');
  assert.ok(start>0&&end>start,'找不到宿主的运行归一');
  const context=vm.createContext({validateGoalReply,safeAdaptiveLayout,normalizeQuestions,normalizeAdaptiveLayout});
  vm.runInContext(`${source.slice(start,end)}\nglobalThis.normalizeGoalRun=normalizeGoalRun;`,context);
  return context.normalizeGoalRun;
}

async function kimiVerdict(layout) {
  const output={reply:'好',proposal:null,layout};
  const {statePath,fetchImpl}=kimiServer(output);
  try {
    const agent=new KimiCodeAgent({token:'secret-token',statePath,workspace:'/along',fetchImpl});
    const response=await agent.startGoal({requestId:'along-goal-layout',goal:{domain:'health',title:'运动',target:120},snapshot:{},message:'做一个计划',history:[]});
    return response.run;
  } finally { rmSync(statePath,{force:true}); }
}

function dshVerdict(layout) {
  const normalizeGoalRun=loadDshNormalizer();
  return normalizeGoalRun({
    kind:'goal',runtime:'dsh-superagent',requestId:'along-goal-layout',actual:true,
    source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'正在提交给 DSH'},
    agents:[],events:[],assignments:[],status:'working',statusLabel:'DSH 正在处理',progress:40,
    input:{goal:{domain:'health',title:'运动',target:120},message:'做一个计划'},
    result:{reply:'好',proposal:null,layout},
  });
}

const malformedLayouts=[
  {name:'模块类型不被允许',layout:{...baseLayout,modules:[{kind:'timeline',id:'x',title:'时间线',content:'x'}]}},
  {name:'模块标题是对象',layout:{...baseLayout,modules:[{kind:'summary',id:'x',title:{text:'标题'},content:'内容'}]}},
  {name:'任务标题是对象',layout:{...baseLayout,tasks:[{id:'t',when:'今天',title:{text:'标题'},detail:'说明',state:'temporary'}]}},
  {name:'事实标签是对象',layout:{...baseLayout,modules:[{kind:'fact_list',id:'x',title:'事实',items:[{label:{a:1},value:'值'}]}]}},
  {name:'标签项是对象',layout:{...baseLayout,modules:[{kind:'chips',id:'x',title:'标签',items:[{a:1}]}]}},
  {name:'模块 id 重复',layout:{...baseLayout,modules:[{kind:'summary',id:'same',title:'一',content:'一'},{kind:'summary',id:'same',title:'二',content:'二'}]}},
  {name:'给了 7 个模块',layout:{...baseLayout,modules:Array.from({length:7},(_,i)=>({kind:'summary',id:`m${i}`,title:`模块 ${i}`,content:'内容'}))}},
  {name:'标题超长',layout:{...baseLayout,title:'标'.repeat(200)}},
];

test('both runtimes reach the same verdict on the same model output',async()=>{
  const normalizeGoalRun=loadDshNormalizer();
  for (const item of malformedLayouts) {
    const dsh=normalizeGoalRun({
      kind:'goal',runtime:'dsh-superagent',requestId:'along-goal-layout',actual:true,
      source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'正在提交给 DSH'},
      agents:[],events:[],assignments:[],status:'working',statusLabel:'DSH 正在处理',progress:40,
      input:{goal:{domain:'health',title:'运动',target:120},message:'做一个计划'},
      result:{reply:'好',proposal:null,layout:item.layout},
    });
    const kimi=await kimiVerdict(item.layout);
    const dshOk=dsh.status!=='blocked'&&!!dsh.result?.layout;
    const kimiOk=kimi.status!=='blocked'&&!!kimi.result?.layout;
    assert.equal(dshOk,kimiOk,`「${item.name}」在两条运行时上的结论相反`);
    if (dshOk) assert.deepEqual(dsh.result.layout,kimi.result.layout,`「${item.name}」交付的目标空间不一样`);
  }
});

test('no runtime delivers a made-up object as user facing text',async()=>{
  for (const item of malformedLayouts) {
    const dsh=dshVerdict(item.layout);
    const kimi=await kimiVerdict(item.layout);
    const text=JSON.stringify([dsh.result,kimi.result]);
    assert.ok(!text.includes('[object Object]'),`「${item.name}」把对象兜底成了 [object Object]`);
  }
});
