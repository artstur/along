import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {rmSync} from 'node:fs';
import {KimiCodeAgent} from './kimi-code-agent.mjs';

const layout={
  version:1,title:'日语阅读 60 天',badge:'试运行',summary:'每天用碎片时间阅读。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'以读为主。',facts:[],chips:[],source:null,target:null,unit:'',note:''}],
  tasks:[{id:'read-10',when:'今天',title:'阅读 10 分钟',detail:'选一段入门材料。',state:'planned'}],questions:[],
};
const result={reply:'已拆成一个可持续的 60 天方案。',proposal:{active:true,title:'60 天学会基础日语',target:120,task:'今天阅读 10 分钟',reason:'符合每天 30 分钟的限制'},layout};

function json(data,code=0,status=200) { return new Response(JSON.stringify({code,msg:code===0?'success':'failed',data,request_id:'test'}),{status,headers:{'content-type':'application/json'}}); }

test('starts a real swarm session and maps child sessions into Along agents',async()=>{
  const calls=[];
  const statePath=join(tmpdir(),`along-kimi-${crypto.randomUUID()}.json`);
  const fetchImpl=async(url,options={})=>{
    const path=new URL(url).pathname;calls.push({path,method:options.method||'GET',body:options.body?JSON.parse(options.body):null,authorization:options.headers?.authorization});
    if (path==='/api/v1/meta') return json({server_version:'2.5.0',features:[{name:'swarm',state:'Active'}]});
    if (path==='/api/v1/auth') return json({models_ready:true});
    if (path==='/api/v1/oauth/userinfo') return json({kind:'ok',userInfo:{userLevelName:'Pro'}});
    if (path==='/api/v1/sessions'&&options.method==='POST') return json({id:'session-main'});
    if (path==='/api/v1/sessions/session-main/profile') return json({id:'session-main',agent_config:{swarm_mode:true}});
    if (path==='/api/v1/sessions/session-main/prompts') return json({accepted:true});
    if (path==='/api/v1/sessions/session-main') return json({id:'session-main',busy:false,last_turn_reason:'completed',pending_interaction:'none',updated_at:'2026-11-05T08:00:00Z'});
    if (path==='/api/v1/sessions/session-main/messages') return json({items:[{id:'m1',session_id:'session-main',role:'assistant',created_at:'2026-11-05T08:00:00Z',content:[{type:'text',text:JSON.stringify(result)}]}]});
    if (path==='/api/v1/sessions/session-main/children') return json({items:[{id:'child-1',title:'目标策略',busy:false,last_turn_reason:'completed',updated_at:'2026-11-05T07:59:00Z'}]});
    throw Error(`unexpected ${path}`);
  };
  try {
    const agent=new KimiCodeAgent({token:'secret-token',statePath,workspace:'/along',fetchImpl});
    const response=await agent.startGoal({requestId:'along-goal-health-test',goal:{domain:'health',title:'运动',target:120},snapshot:{},message:'做一个计划',history:[]});
    assert.equal(response.run.runtime,'kimi-code-swarm');
    assert.equal(response.run.status,'done');
    assert.equal(response.run.agents[0].name,'目标策略');
    assert.equal(response.run.result.layout.title,layout.title);
    const profile=calls.find(call=>call.path.endsWith('/profile'));
    assert.equal(profile.body.agent_config.swarm_mode,true);
    assert.equal(calls.find(call=>call.path.endsWith('/prompts')).body.swarm_mode,true);
    assert.ok(calls.every(call=>call.authorization==='Bearer secret-token'));
    assert.doesNotMatch(JSON.stringify(response),/secret-token/);
  } finally { rmSync(statePath,{force:true}); }
});

test('reports login as a readiness requirement',async()=>{
  const agent=new KimiCodeAgent({token:'token',statePath:join(tmpdir(),`along-kimi-${crypto.randomUUID()}.json`),fetchImpl:async url=>{
    const path=new URL(url).pathname;
    if (path.endsWith('/meta')) return json({features:[{name:'swarm',state:'Active'}]});
    if (path.endsWith('/userinfo')) return json({kind:'ok',userInfo:{userLevelName:'Pro'}});
    return json({models_ready:false});
  }});
  await assert.rejects(()=>agent.ready(),/login/);
});

test('does not claim a Free account can execute Kimi Code',async()=>{
  const agent=new KimiCodeAgent({token:'token',statePath:join(tmpdir(),`along-kimi-${crypto.randomUUID()}.json`),fetchImpl:async url=>{
    const path=new URL(url).pathname;
    if (path.endsWith('/meta')) return json({features:[{name:'swarm',state:'Active'}]});
    if (path.endsWith('/userinfo')) return json({kind:'ok',userInfo:{userLevelName:'Free'}});
    return json({models_ready:true});
  }});
  await assert.rejects(()=>agent.ready(),/Free/);
});
