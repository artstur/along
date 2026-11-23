import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readBridgeToken} from '../host/along-bridge.mjs';
import {KimiCodeAgent} from '../host/kimi-code-agent.mjs';

// M4 credential-hygiene（docs/cloud-security-hardening.md §3.4/§4-M4）：凭证读取 0600 校验与输出卫生。
// 本文件承载验收 1/2/4；验收 3（codex env 与错误卫生，CODEX_BIN 假脚本注入）在 test/codex-agent.test.mjs；
// 验收 5（回归与 npm run check 全绿）由统一实跑判定——本文件只保证既有断言不因加严而失真。

const TOKEN='a'.repeat(64);

// ---- 验收 1：readBridgeToken 只认 0600，权限过宽 fail-closed 等同未配置 ---------------------------------------------

test('readBridgeToken：0600 返回 token；0644/0666 等同未配置返回 null；无文件 null',()=>{
  const directory=mkdtempSync(join(tmpdir(),'cred-hygiene-bridge-'));
  try {
    const file=join(directory,'bridge-token');
    writeFileSync(file,`${TOKEN}\n`);
    chmodSync(file,0o600);
    assert.equal(readBridgeToken(file),TOKEN,'0600 是唯一可用形态，末尾换行照旧裁掉');
    chmodSync(file,0o644);
    assert.equal(readBridgeToken(file),null,'0644 fail-closed：等同未配置');
    chmodSync(file,0o666);
    assert.equal(readBridgeToken(file),null,'0666 fail-closed：等同未配置');
    assert.equal(readBridgeToken(join(directory,'no-such-file')),null,'无文件返回 null');
    // 「等同未配置」⇒ 云端启动拒绝路径不变：启动门只看 token 是否为 null（ALONG_DSH_RUNNER_URL + null 拒启），
    // 权限过宽与「env 没指向任何文件」在门上是同一个值——这里锁定两者的返回值逐字节一致。
    assert.equal(readBridgeToken(file),readBridgeToken(join(directory,'no-such-file')),'权限过宽的返回值必须与未配置完全一致');
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

// ---- 验收 2：Kimi token 文件 0600 正常；过宽显式报错（Mac 功能性凭证，静默不可用好过报错） -------------------------

const layout={
  version:1,title:'日语阅读 60 天',badge:'试运行',summary:'每天用碎片时间阅读。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'以读为主。',facts:[],chips:[],source:null,target:null,unit:'',note:''}],
  tasks:[{id:'read-10',when:'今天',title:'阅读 10 分钟',detail:'选一段入门材料。',state:'planned'}],questions:[],
};
const result={reply:'已拆成一个可持续的 60 天方案。',proposal:{active:true,title:'60 天学会基础日语',target:120,task:'今天阅读 10 分钟',reason:'符合每天 30 分钟的限制'},layout};

function json(data,code=0,status=200) { return new Response(JSON.stringify({code,msg:code===0?'success':'failed',data,request_id:'test'}),{status,headers:{'content-type':'application/json'}}); }

// 完整 swarm 会话替身（与既有 kimi-code-agent.test.mjs 同款端点），记录每个请求的 Authorization 头。
function swarmFetchStub(calls,modelResult) {
  return async(url,options={})=>{
    const path=new URL(url).pathname;
    calls.push({path,authorization:options.headers?.authorization});
    if (path==='/api/v1/meta') return json({server_version:'2.5.0',features:[{name:'swarm',state:'Active'}]});
    if (path==='/api/v1/auth') return json({models_ready:true});
    if (path==='/api/v1/oauth/userinfo') return json({kind:'ok',userInfo:{userLevelName:'Pro'}});
    if (path==='/api/v1/sessions'&&options.method==='POST') return json({id:'session-main'});
    if (path==='/api/v1/sessions/session-main/profile') return json({id:'session-main',agent_config:{swarm_mode:true}});
    if (path==='/api/v1/sessions/session-main/prompts') return json({accepted:true});
    if (path==='/api/v1/sessions/session-main') return json({id:'session-main',busy:false,last_turn_reason:'completed',pending_interaction:'none',updated_at:'2026-11-05T08:00:00Z'});
    if (path==='/api/v1/sessions/session-main/messages') return json({items:[{id:'m1',session_id:'session-main',role:'assistant',created_at:'2026-11-05T08:00:00Z',content:[{type:'text',text:JSON.stringify(modelResult)}]}]});
    if (path==='/api/v1/sessions/session-main/children') return json({items:[]});
    if (path==='/api/v1/sessions/session-main/transcript') return json({items:[{kind:'turn',steps:[{frames:[{kind:'tool',name:'AgentSwarm',input:{items:['目标策略师：设计分阶段路径','风险评审：检查约束','任务设计师：生成动态任务']},output:'<agent_swarm_result><summary>completed: 3</summary><subagent agent_id="agent-0" item="目标策略师：设计分阶段路径" outcome="completed">路径已完成</subagent><subagent agent_id="agent-1" item="风险评审：检查约束" outcome="completed">风险已完成</subagent><subagent agent_id="agent-2" item="任务设计师：生成动态任务" outcome="completed">任务已完成</subagent></agent_swarm_result>'}]}]}]});
    throw Error(`unexpected ${path}`);
  };
}

// 构造器在未显式传 token 时默认从 ALONG_KIMI_CODE_TOKEN 取值——文件读取语义必须在无 env 凭证时验证。
function withoutKimiTokenEnv(run) {
  const saved=process.env.ALONG_KIMI_CODE_TOKEN;
  delete process.env.ALONG_KIMI_CODE_TOKEN;
  return run().finally(()=>{ if (saved!==undefined) process.env.ALONG_KIMI_CODE_TOKEN=saved; });
}

test('Kimi token 文件 0600 正常：token 取自文件并随每个请求携带',async()=>{
  await withoutKimiTokenEnv(async()=>{
    const calls=[];
    const statePath=join(tmpdir(),`along-kimi-${crypto.randomUUID()}.json`);
    const directory=mkdtempSync(join(tmpdir(),'cred-hygiene-kimi-'));
    try {
      const tokenFile=join(directory,'server.token');
      writeFileSync(tokenFile,TOKEN); // 不带换行：锁定「内容即凭证」，不把 trim 行为卷进本断言
      chmodSync(tokenFile,0o600);
      const agent=new KimiCodeAgent({tokenPath:tokenFile,statePath,workspace:'/along',fetchImpl:swarmFetchStub(calls,result)});
      const response=await agent.startGoal({requestId:'cred-hygiene-token-0600',goal:{domain:'health',title:'运动',target:120},snapshot:{},message:'做一个计划',history:[]},'u_aaaa1111');
      assert.equal(response.run.status,'done');
      assert.ok(calls.length>0,'至少发起了一次 API 调用');
      assert.ok(calls.every(call=>call.authorization===`Bearer ${TOKEN}`),'每个请求都带 0600 文件里的 token');
    } finally { rmSync(statePath,{force:true}); rmSync(directory,{recursive:true,force:true}); }
  });
});

test('Kimi token 文件 0644 抛「权限过宽（须 0600）」，不静默降级、不发任何请求',async()=>{
  await withoutKimiTokenEnv(async()=>{
    const directory=mkdtempSync(join(tmpdir(),'cred-hygiene-kimi-wide-'));
    try {
      const tokenFile=join(directory,'server.token');
      writeFileSync(tokenFile,TOKEN);
      chmodSync(tokenFile,0o644);
      const agent=new KimiCodeAgent({tokenPath:tokenFile,statePath:join(directory,'state.json'),workspace:'/along',
        fetchImpl:async()=>{ throw Error('过宽凭证不应走到任何 API 调用'); }});
      await assert.rejects(()=>agent.startGoal({requestId:'cred-hygiene-token-0644',goal:{domain:'health',title:'运动',target:120},snapshot:{},message:'做一个计划',history:[]},'u_aaaa1111'),
        /权限过宽（须 0600）/);
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });
});

// ---- 验收 4：Kimi 输出无凭证扫描（评审砍项负断言：扫描代码不进 host/kimi-code-agent.mjs） -------------------------
// 行为级负断言：模型输出里混入 64 位 hex 的 token 形态文本时，运行照常完成、文本原样出现在回复与运行记录里，
// 不被拦、不脱敏。若日后有人给 Kimi 输出加凭证扫描（违反评审拍板的残差决策），本测试即红。

const TOKEN_SHAPED='5f2b9c8d4e7a1f3b6c0d9e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c';

test('Kimi 输出无凭证扫描：含 token 形态文本的模型输出原样透传、不被拦',async()=>{
  const calls=[];
  const statePath=join(tmpdir(),`along-kimi-${crypto.randomUUID()}.json`);
  const scanned={
    reply:`方案已生成，校验串 ${TOKEN_SHAPED} 保持原样。`,
    proposal:{active:true,title:'60 天学会基础日语',target:120,task:'今天阅读 10 分钟',reason:'符合每天 30 分钟的限制'},
    layout:{...layout,modules:[{...layout.modules[0],content:`附注 ${TOKEN_SHAPED}`}]},
  };
  try {
    const agent=new KimiCodeAgent({token:'secret-token',statePath,workspace:'/along',fetchImpl:swarmFetchStub(calls,scanned)});
    const response=await agent.startGoal({requestId:'cred-hygiene-no-scan',goal:{domain:'health',title:'运动',target:120},snapshot:{},message:'做一个计划',history:[]},'u_aaaa1111');
    assert.equal(response.run.status,'done','token 形态文本不得触发任何拦截');
    assert.ok(response.run.result.reply.includes(TOKEN_SHAPED),'回复文本原样透传');
    assert.ok(JSON.stringify(response).includes(TOKEN_SHAPED),'运行记录保留原文，没有脱敏或剥除');
  } finally { rmSync(statePath,{force:true}); }
});
