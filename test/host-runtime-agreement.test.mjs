import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {KimiCodeAgent} from '../host/kimi-code-agent.mjs';
import {validateGoalReply, normalizeGoalReply} from '../web/goal-agent-core.mjs';
import {safeAdaptiveLayout, normalizeQuestions, normalizeAdaptiveLayout} from '../web/adaptive-ui.mjs';

const layout={
  version:1,title:'日语阅读 60 天',badge:'试运行',summary:'每天用碎片时间阅读。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'以读为主。'}],
  tasks:[{id:'read-10',when:'今天',title:'阅读 10 分钟',detail:'选一段入门材料。',state:'planned'}],questions:[],
};
const result={reply:'已拆成一个可持续的 60 天方案。',proposal:{active:true,title:'60 天学会基础日语',target:120,task:'今天阅读 10 分钟',reason:'符合每天 30 分钟的限制'},layout};

function json(data,code=0,status=200) { return new Response(JSON.stringify({code,msg:code===0?'success':'failed',data,request_id:'test'}),{status,headers:{'content-type':'application/json'}}); }

// 一个可配置的 Kimi Code Web Server 替身：任何会话都回同一份输出。
function kimiServer(output) {
  const statePath=join(tmpdir(),`along-kimi-agree-${crypto.randomUUID()}.json`);
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
      if (rest==='/profile') return json({id,agent_config:{swarm_mode:true}});
      if (rest==='/prompts') return json({accepted:true});
      if (rest==='') return json({id,busy:false,last_turn_reason:'completed',pending_interaction:'none',updated_at:'2026-11-05T08:00:00Z'});
      if (rest==='/messages') return json({items:[{id:'m1',session_id:id,role:'assistant',created_at:'2026-11-05T08:00:00Z',content:[{type:'text',text:JSON.stringify(output)}]}]});
      if (rest==='/children') return json({items:[]});
      if (rest==='/transcript') return json({items:[{kind:'turn',steps:[{frames:[{kind:'tool',name:'AgentSwarm',input:{items:['目标策略师','风险评审','任务设计师']},output:'<subagent agent_id="agent-0" item="目标策略师" outcome="completed">ok</subagent>'}]}]}]});
    }
    throw Error(`unexpected ${path}`);
  };
  return {statePath,fetchImpl};
}

// 从真实发布的宿主源码里取出目标运行的归一，拿到独立上下文里跑。
function loadHostNormalizer() {
  const source=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');
  const start=source.indexOf('function normalizeGoalRun');
  const end=source.indexOf('const server=createServer');
  assert.ok(start>0&&end>start,'找不到宿主的运行归一');
  const context=vm.createContext({validateGoalReply,normalizeGoalReply,safeAdaptiveLayout,normalizeQuestions,normalizeAdaptiveLayout});
  vm.runInContext(`${source.slice(start,end)}\nglobalThis.normalizeGoalRun=normalizeGoalRun;`,context);
  return context.normalizeGoalRun;
}

test('pending questions are normalised the same way on both runtimes',async()=>{
  assert.deepEqual(normalizeQuestions(undefined),[],'没给就是没有');
  assert.deepEqual(normalizeQuestions('还有问题吗？'),[],'不是列表就当没有');
  assert.deepEqual(normalizeQuestions([123]),['123'],'每一项都要变成文字');
  assert.deepEqual(normalizeQuestions(Array.from({length:9},(_,i)=>`问题 ${i}`)),Array.from({length:6},(_,i)=>`问题 ${i}`),'最多取 6 条');
  assert.equal(normalizeQuestions(['x'.repeat(300)])[0].length,240,'每条最多 240 字');

  // DSH 运行时：同一份畸形布局不再作废整份目标空间。
  const normalizeGoalRun=loadHostNormalizer();
  const dsh=normalizeGoalRun({
    input:{goal:{domain:'health'},message:'做一个计划'},
    result:{reply:'好',proposal:null,layout:{...layout,questions:'还有问题吗？'}},
  });
  assert.deepEqual(dsh.result.layout.questions,[],'DSH 运行时也要按同一套口径归一');

  // Kimi 运行时：同样的结论。
  const {statePath,fetchImpl}=kimiServer({...result,layout:{...layout,questions:'还有问题吗？'}});
  try {
    const agent=new KimiCodeAgent({token:'secret-token',statePath,workspace:'/along',fetchImpl});
    const response=await agent.startGoal({requestId:'along-goal-questions',goal:{domain:'health',title:'运动',target:120},snapshot:{},message:'做一个计划',history:[]});
    assert.equal(response.run.status,'done','同一份模型输出在两条运行时上都要有结果');
    assert.deepEqual(response.run.result.layout.questions,[]);
  } finally { rmSync(statePath,{force:true}); }
});

test('a fake proposal title never becomes the goal title',async()=>{
  const fake={reply:'好',proposal:{active:true,title:{text:'本周运动'},target:120,task:'今天动一动',reason:'按 120 分钟分配'},layout};
  const {statePath,fetchImpl}=kimiServer(fake);
  try {
    const agent=new KimiCodeAgent({token:'secret-token',statePath,workspace:'/along',fetchImpl});
    const response=await agent.startGoal({requestId:'along-goal-fake-title',goal:{domain:'health',title:'运动',target:120},snapshot:{},message:'做一个计划',history:[]});
    assert.notEqual(response.run.result?.proposal?.title,'[object Object]','假标题不能变成用户的目标标题');
    assert.equal(response.run.status,'blocked','非字符串标题要和 DSH 运行时一样被拒绝');
    assert.equal(response.run.result,null);
  } finally { rmSync(statePath,{force:true}); }
});
