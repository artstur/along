import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createServer, request as httpRequest} from 'node:http';
import {request as tlsRequest} from 'node:https';
import net from 'node:net';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GOAL_OUTPUT_INSTRUCTIONS} from '../web/goal-agent-core.mjs';
import {issuePairingCode} from '../host/pairing.mjs';
import {REASSESSMENT_INSTRUCTIONS} from '../web/contextual-planning.mjs';
import {safeGoalSuperAgentRun, safeSuperAgentRun, DSH_RUNTIME, KIMI_RUNTIME} from '../web/super-agent.mjs';
import {provideCloudCa} from './cloud-ca-fixture.mjs';

// 云端 agent 适配层（docs/cloud-deploy-multi-user.md §4 M3，验收 #3）：
// - runner 契约：deploy/agent-runner.mjs 拉起 dsh headless，stdout JSON → 运行信封，
//   信封通过 safeGoalSuperAgentRun / safeSuperAgentRun 白名单且 runtime 固定 'dsh-superagent'
//   （不得误标 kimi-code-swarm）；按 userId+requestId 缓存；runner-token 鉴权。
// - host 分流：ALONG_DSH_RUNNER_URL 设置时四个 DSH 分支走 runner，返回一律过 normalizeGoalRun，
//   校验失败落终态 blocked；未设置时走既有 bridge（字节不变）。
// - 契约归一：GOAL_OUTPUT_INSTRUCTIONS 只在共享层（web/goal-agent-core.mjs）一份，Kimi 与 runner 共用。

const RUNNER_FILE=fileURLToPath(new URL('../deploy/agent-runner.mjs',import.meta.url));
const HOST_FILE=fileURLToPath(new URL('../host/agent-host.mjs',import.meta.url));
const USER_A='u_aaaa1111',USER_B='u_bbbb2222';

const validLayout={
  version:1,title:'方案',badge:'试运行',summary:'先做起来。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'每周三次。'}],
  tasks:[{id:'run-check',when:'今晚',title:'记录一次运动',detail:'记录真实运动。',state:'temporary'}],
  questions:[],
};
const goalOutput={reply:'好的，先从记录开始。',proposal:null,layout:validLayout};
const goalInput={goal:{domain:'health',title:'运动',target:120},snapshot:{},message:'做一个计划',history:[]};
const MANDATE='只规划目标与动态任务；不执行外部写操作。';

function goalRunEnvelope(requestId,result,status='done',error=null) {
  const now=Date.now();
  return {version:1,kind:'goal',actual:true,runtime:DSH_RUNTIME,requestId,
    source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'DSH Headless'},
    eval:{decision:status==='done'?'accept':'blocked'},ticket:null,mandate:MANDATE,
    events:[{at:now,text:status==='done'?'DSH Headless 已返回编排结果':'DSH Headless 运行已停止'}],
    status,statusLabel:status==='done'?'DSH 已完成':'输出需要重试',progress:status==='done'?100:12,
    createdAt:now,updatedAt:now,input:{goal:goalInput.goal,message:goalInput.message,snapshot:{planning:null}},
    assignments:[],agents:[],result:status==='done'?result:null,...(error?{error}:{})};
}
function taskRunEnvelope(requestId) {
  const now=Date.now();
  const task={id:'t1',title:'整理健康推荐',detail:'给出本周清单。',when:'今天',state:'temporary'};
  return {version:2,actual:true,runtime:DSH_RUNTIME,requestId,
    source:{kind:'along',label:'Along 动态任务'},trigger:{kind:'task',label:'DSH Headless'},
    eval:{decision:'accept'},ticket:null,mandate:MANDATE,
    events:[{at:now,text:'DSH Headless 已完成任务规划'}],
    status:'done',statusLabel:'DSH 已完成',progress:100,createdAt:now,updatedAt:now,task,
    assignments:[{id:`dsh-${requestId}`,name:'DSH Headless',role:'Subagent',status:'done',
      objective:'规划该动态任务。',work:'已完成规划',progress:100,report:{summary:'已生成清单'}}]};
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function freePort() {
  return new Promise(resolve=>{
    const server=net.createServer();
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port; server.close(()=>resolve(port));});
  });
}
function plainRequest(port,path,{method='GET',body,headers={}}={}) {
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const req=httpRequest({host:'127.0.0.1',port,path,method,agent:false,
      headers:{...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...headers}},
    res=>{
      let text=''; res.on('data',chunk=>text+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,text,json:text?JSON.parse(text):null}));
    });
    req.on('error',reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function stopChild(child) {
  if (child.exitCode!==null||child.signalCode!==null) return Promise.resolve();
  return new Promise(resolve=>{
    let timer;
    child.once('exit',()=>{clearTimeout(timer);resolve();});
    child.kill('SIGINT');
    timer=setTimeout(()=>child.kill('SIGKILL'),3_000);
  });
}
async function waitReady(port,label,probe=path=>plainRequest(port,path),child) {
  const deadline=Date.now()+15_000;
  while (Date.now()<deadline) {
    if (child&&(child.exitCode!==null||child.signalCode!==null)) {
      throw new Error(`${label} exited before ready (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    try { const response=await probe('/health'); if (response.status===200) return; } catch { /* 还没起来 */ }
    await sleep(120);
  }
  assert.ok(false,`${label} 没有就绪`);
}

// ---- deploy/agent-runner.mjs 真实进程：契约、缓存、鉴权、失败语义 ----------------------------------

// 测试替身：模拟 `dsh headless "<prompt>"` 的一次性形态（提交 → stdout 输出 → exit）。
// 把替身自己的输入写进脚本，避免让生产 runner 向子进程继承测试环境。
function fakeDshScript({stdout,mode,logFile}) {
  return `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(logFile)},'1');
if (${JSON.stringify(mode)}==='fail') process.exit(3);
process.stdout.write(${JSON.stringify(stdout??'')});
`;
}
async function spawnRunner({dir,stdout,mode='ok',token='ab'.repeat(32)}) {
  const bin=join(dir,'fake-dsh.mjs');
  const tokenFile=join(dir,'runner-token');
  writeFileSync(tokenFile,token,{mode:0o600});
  const modelFile=join(dir,'model-credentials');
  writeFileSync(modelFile,'local-test-key',{mode:0o600});
  const logFile=join(dir,'dsh-calls');
  writeFileSync(logFile,'');
  writeFileSync(bin,fakeDshScript({stdout,mode,logFile}),{mode:0o755});
  const port=await freePort();
  const child=spawn(process.execPath,[RUNNER_FILE],{env:{...process.env,
    ALONG_RUNNER_PORT:String(port),ALONG_RUNNER_HOST:'127.0.0.1',ALONG_RUNNER_TOKEN_FILE:tokenFile,
    ALONG_MODEL_API_KEY_FILE:modelFile,ALONG_DSH_BIN:bin},stdio:['ignore','pipe','pipe']});
  const output=[];
  child.stderr.on('data',data=>output.push(String(data)));
  const stop=()=>stopChild(child);
  try { await waitReady(port,'agent runner',undefined,child); }
  catch(error) { await stop(); throw error; }
  return {port,token,callCount:()=>readFileSync(logFile,'utf8').length,
    errors:()=>output.join(''),stop};
}
const runRequest=(port,path,args={})=>plainRequest(port,path,args);

async function waitForCompletion(readRun,extract=response=>response.json.run) {
  const deadline=Date.now()+5_000;
  while (Date.now()<deadline) {
    const response=await readRun();
    assert.equal(response.status,200);
    if (extract(response).status!=='working') return response;
    await sleep(15);
  }
  assert.fail('Runner did not reach a terminal state');
}
function readCompletedRun(runner,userId,requestId) {
  return waitForCompletion(()=>runRequest(runner.port,`/run/${requestId}`,{
    headers:{'runner-token':runner.token,'x-along-user':userId},
  }));
}

test('runner：合法目标输出 → 信封过 safeGoalSuperAgentRun，runtime 固定 dsh-superagent，缓存按 userId+requestId 隔离',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-runner-goal-'));
  const runner=await spawnRunner({dir,stdout:JSON.stringify(goalOutput)});
  try {
    const body={userId:USER_A,requestId:'along-goal-health-1',kind:'goal',input:goalInput};
    const first=await runRequest(runner.port,'/run',{method:'POST',body,headers:{'runner-token':runner.token}});
    assert.equal(first.status,200);
    assert.equal(first.json.run.status,'working');
    const {json:{run}}=await readCompletedRun(runner,body.userId,body.requestId);
    assert.equal(run.status,'done');
    // runtime 固定 'dsh-superagent'：不得照抄 Kimi 信封误标 kimi-code-swarm（验收 #3）。
    assert.equal(run.runtime,DSH_RUNTIME);
    assert.notEqual(run.runtime,KIMI_RUNTIME);
    // 信封形状以 Kimi 运行时的 run 为准：必须通过前端白名单。
    assert.equal(safeGoalSuperAgentRun(run)?.requestId,'along-goal-health-1');
    assert.equal(run.result.reply,goalOutput.reply);
    assert.equal(run.result.layout.title,validLayout.title);
    assert.deepEqual(run.input,{goal:goalInput.goal,message:goalInput.message,snapshot:{planning:null}});
    // GET /run/:id 带自己的 x-along-user 读到同一条运行。
    const read=await runRequest(runner.port,'/run/along-goal-health-1',
      {headers:{'runner-token':runner.token,'x-along-user':USER_A}});
    assert.equal(read.status,200);
    assert.deepEqual(read.json.run,run);
    // 别的用户查同一个 requestId：404，不泄露别人的运行。
    const stranger=await runRequest(runner.port,'/run/along-goal-health-1',
      {headers:{'runner-token':runner.token,'x-along-user':USER_B}});
    assert.equal(stranger.status,404);
    // 同一 userId+requestId 的 POST 幂等命中缓存，不重复拉起 dsh。
    const again=await runRequest(runner.port,'/run',{method:'POST',body,headers:{'runner-token':runner.token}});
    assert.equal(again.status,200);
    assert.deepEqual(again.json.run,run);
    assert.equal(runner.callCount(),1,'缓存命中不再拉起第二个 dsh 进程');
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('runner：任务输出 → 信封过 safeSuperAgentRun（version 2）',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-runner-task-'));
  const runner=await spawnRunner({dir,stdout:JSON.stringify({summary:'已生成清单',next:'打开推荐页确认'})});
  try {
    const response=await runRequest(runner.port,'/run',{method:'POST',
      body:{userId:USER_A,requestId:'along-health-task1',kind:'task',
        input:{requestId:'along-health-task1',task:{id:'t1',title:'整理健康推荐',detail:'给出本周清单。',when:'今天',state:'temporary'},goal:goalInput.goal,context:{}}},
      headers:{'runner-token':runner.token}});
    assert.equal(response.status,200);
    assert.equal(response.json.run.status,'working');
    const {json:{run}}=await readCompletedRun(runner,USER_A,'along-health-task1');
    assert.equal(run.runtime,DSH_RUNTIME);
    assert.equal(safeSuperAgentRun(run)?.requestId,'along-health-task1','任务信封必须通过任务白名单');
    assert.equal(safeGoalSuperAgentRun(run),null,'goal 白名单不收 version 2 的任务信封');
    assert.equal(run.status,'done');
    assert.equal(run.task.title,'整理健康推荐');
    assert.equal(run.assignments[0].report.summary,'已生成清单');
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('runner：dsh 失败（退出码非零 / 无输出 / 输出不是 JSON）一律落 blocked 终态',async()=>{
  for (const [label,mode,stdout,pattern] of [
    ['退出码非零','fail','',/DSH 没有返回结果/],
    ['无输出','ok','',/DSH 没有返回结果/],
    ['不是 JSON','ok','这是纯文本回答',/没有返回可用结果/],
  ]) {
    const dir=mkdtempSync(join(tmpdir(),`along-runner-fail-${label}-`));
    const runner=await spawnRunner({dir,stdout,mode});
    try {
      const response=await runRequest(runner.port,'/run',{method:'POST',
        body:{userId:USER_A,requestId:`along-goal-health-fail-${label.length}`,kind:'goal',input:goalInput},
        headers:{'runner-token':runner.token}});
      assert.equal(response.status,200);
      assert.equal(response.json.run.status,'working');
      const {json:{run}}=await readCompletedRun(runner,USER_A,`along-goal-health-fail-${label.length}`);
      assert.equal(run.status,'blocked',`${label} 必须落终态`);
      assert.match(run.error,pattern);
      assert.equal(run.result,null);
      assert.equal(safeGoalSuperAgentRun(run)?.status,'blocked','blocked 终态仍是可渲染的信封');
      // 失败也缓存：宿主轮询/重发拿到同一条终态，不悬挂。
      const read=await runRequest(runner.port,`/run/along-goal-health-fail-${label.length}`,
        {headers:{'runner-token':runner.token,'x-along-user':USER_A}});
      assert.deepEqual(read.json.run,run);
    } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
  }
});

test('runner：鉴权与请求校验',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-runner-auth-'));
  const runner=await spawnRunner({dir,stdout:JSON.stringify(goalOutput)});
  try {
    const unauthorized=await runRequest(runner.port,'/run',{method:'POST',
      body:{userId:USER_A,requestId:'along-goal-health-2',kind:'goal',input:goalInput}});
    assert.equal(unauthorized.status,401,'没有 runner-token 一律拒绝');
    const wrong=await runRequest(runner.port,'/run',{method:'POST',
      body:{userId:USER_A,requestId:'along-goal-health-2',kind:'goal',input:goalInput},
      headers:{'runner-token':'ff'.repeat(32)}});
    assert.equal(wrong.status,401,'错误的 runner-token 拒绝');
    for (const [label,body] of [
      ['userId 形状',{userId:'../etc',requestId:'along-goal-health-3',kind:'goal',input:goalInput}],
      ['requestId 形状',{userId:USER_A,requestId:'bad id!',kind:'goal',input:goalInput}],
      ['kind',{userId:USER_A,requestId:'along-goal-health-3',kind:'chat',input:goalInput}],
      ['input 缺失',{userId:USER_A,requestId:'along-goal-health-3',kind:'goal'}],
    ]) {
      const bad=await runRequest(runner.port,'/run',{method:'POST',body,headers:{'runner-token':runner.token}});
      assert.equal(bad.status,400,`${label} 要 400`);
    }
    const unknown=await runRequest(runner.port,'/run/along-goal-health-none',
      {headers:{'runner-token':runner.token,'x-along-user':USER_A}});
    assert.equal(unknown.status,404,'没有运行过的 requestId 查不到');
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

// ---- host 分流：真实 host 进程 + stub runner（验收 #3 的宿主侧断言）-------------------------------

function phoneCall(port,path,{method='GET',body,headers={}}={}) {
  const attempt=()=>new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const req=tlsRequest({host:'127.0.0.1',port,path,method,rejectUnauthorized:false,agent:false,
      headers:{...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...headers}},
    res=>{
      let text=''; res.on('data',chunk=>text+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,text,json:text?JSON.parse(text):null}));
    });
    req.setTimeout(15_000,()=>{ req.destroy(new Error(`phoneCall 超时（15s）：${method} ${path} @${port}`)); });
    req.on('error',reject);
    if (payload) req.write(payload);
    req.end();
  });
  return attempt().catch(error=>{
    if (['ECONNRESET','ECONNREFUSED','EPIPE'].includes(error.code)) return attempt();
    throw error;
  });
}

// stub runner：只实现 runner 契约的最小面，记录 host 发来的头与体。
// storedRun 为 null 时对 GET 按 404 应答（宿主应把「运行记录不存在」按上游故障上抛）。
async function stubRunner({postRun=null,getStatus=null,expectedUser=null,expectedToken=null}={}) {
  const calls=[];
  const server=createServer(async(req,res)=>{
    let raw=''; for await (const chunk of req) raw+=chunk;
    const record={path:new URL(req.url,'http://x').pathname,method:req.method,headers:req.headers,body:raw?JSON.parse(raw):null};
    calls.push(record);
    const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if (record.method==='GET'&&record.path==='/health') return reply(200,{ready:true});
    if (record.method==='POST'&&record.path==='/run') {
      if (expectedToken!==null&&record.headers['runner-token']!==expectedToken) return reply(401,{error:'runner-token 无效'});
      return reply(200,{run:{...postRun(record.body),requestId:record.body.requestId}});
    }
    const match=record.method==='GET'&&record.path.match(/^\/run\/([^/]+)$/);
    if (match) {
      const requestId=decodeURIComponent(match[1]);
      const value=getStatus?.(requestId,record.headers['x-along-user']);
      if (expectedUser!==null&&record.headers['x-along-user']!==expectedUser) return reply(404,{error:'运行记录不存在'});
      if (!value) return reply(404,{error:'运行记录不存在'});
      return reply(200,{run:{...value,requestId}});
    }
    reply(404,{error:'未找到接口'});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {calls,port:server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}

async function spawnHostWithRunner(dir,runnerPort) {
  const tokenFile=join(dir,'runner-token');
  writeFileSync(tokenFile,'cd'.repeat(32),{mode:0o600});
  writeFileSync(join(dir,'users.json'),JSON.stringify([USER_A,USER_B].map(userId=>({userId}))),{mode:0o600});
  // 云端形态必须加载预签发的 CA 叶证书（docs/iphone-ca-profile-design.md §3.1）。
  provideCloudCa(dir,{host:'along.test.local'});
  const code=await issuePairingCode(dir,USER_A);
  const port=await freePort();
  const child=spawn(process.execPath,[HOST_FILE],{env:{
    ...process.env,
    ALONG_AGENT_STATE_DIR:dir,
    ALONG_AGENT_HOST:'127.0.0.1',
    ALONG_AGENT_PORT:String(port),
    ALONG_DSH_RUNNER_URL:`http://127.0.0.1:${runnerPort}`,
    ALONG_RUNNER_TOKEN_FILE:tokenFile,
    ALONG_TLS_CN:'along.test.local',
  },stdio:['ignore','pipe','pipe']});
  const output=[];
  child.stdout.on('data',data=>output.push(String(data)));
  child.stderr.on('data',data=>output.push(String(data)));
  const text=()=>output.join('');
  const stop=()=>stopChild(child);
  try {
    await waitReady(port,'host',path=>phoneCall(port,path),child);
    assert.doesNotMatch(text(),/一次性配对码/);
    const paired=await phoneCall(port,'/pair',{method:'POST',body:{code}});
    assert.equal(paired.status,200);
    const token=paired.json.token;
    return {port,token,pairing:paired.json,userId:()=>JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8'))[0].user_id,text,stop};
  } catch(error) { await stop(); throw error; }
}

test('host：ALONG_DSH_RUNNER_URL 分流 → /super-agent/goals 的 run 过 normalizeGoalRun 且通过白名单',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-host-runner-goal-'));
  let runner,host;
  try {
    runner=await stubRunner({expectedToken:'cd'.repeat(32),
      postRun:body=>goalRunEnvelope(body.requestId,goalOutput)});
    host=await spawnHostWithRunner(dir,runner.port);
    const response=await phoneCall(host.port,'/super-agent/goals',{method:'POST',
      body:{requestId:'along-goal-health-e2e',...goalInput,runtime:DSH_RUNTIME},
      headers:{authorization:`Bearer ${host.token}`}});
    assert.equal(response.status,200);
    const run=response.json.run;
    assert.equal(run.requestId,'along-goal-health-e2e');
    assert.equal(run.status,'done','校验通过的结果原样交付');
    assert.equal(run.applyValidatedGoal,true,'只有通过宿主校验的云端目标对话交给 App 自动生效');
    assert.equal(run.runtime,DSH_RUNTIME,'runtime 固定 dsh-superagent（不得误标 kimi-code-swarm）');
    assert.notEqual(run.runtime,KIMI_RUNTIME);
    assert.equal(safeGoalSuperAgentRun(run)?.requestId,'along-goal-health-e2e','宿主回执必须通过前端白名单');
    assert.equal(run.result.reply,goalOutput.reply);
    assert.deepEqual(run.input,{goal:goalInput.goal,message:goalInput.message});
    assert.ok(run.result.layout&&Array.isArray(run.result.layout.questions),'布局经过 safeAdaptiveLayout 校验链');
    // host 转发给 runner 的是本次请求自己的身份与编号。
    const call=runner.calls.find(item=>item.method==='POST'&&item.path==='/run');
    assert.ok(call,'host 必须调用 runner 的 POST /run');
    assert.equal(call.headers['runner-token'],'cd'.repeat(32),'runner-token 从 secret 文件带上');
    assert.equal(call.body.kind,'goal');
    assert.equal(call.body.userId,host.userId(),'userId 用配对绑定的身份');
    assert.equal(call.body.requestId,'along-goal-health-e2e');
    assert.equal(host.pairing.runtime,DSH_RUNTIME,'云端配对选择其可用运行时');
    const status=await phoneCall(host.port,'/connection/status',{method:'POST',
      body:{runtime:DSH_RUNTIME},headers:{authorization:`Bearer ${host.token}`}});
    assert.equal(status.status,200);
    assert.equal(status.json.ready,true);
    assert.ok(runner.calls.some(item=>item.method==='GET'&&item.path==='/health'));
  } finally { await host?.stop(); await runner?.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('host：runner 返回校验失败的目标输出 → blocked 终态不重试',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-host-runner-blocked-'));
  let runner,host;
  try {
    runner=await stubRunner({postRun:body=>goalRunEnvelope(body.requestId,{reply:'',proposal:null,layout:validLayout})});
    host=await spawnHostWithRunner(dir,runner.port);
    const response=await phoneCall(host.port,'/super-agent/goals',{method:'POST',
      body:{requestId:'along-goal-health-bad',...goalInput,runtime:DSH_RUNTIME},
      headers:{authorization:`Bearer ${host.token}`}});
    assert.equal(response.status,200,'校验失败不是传输故障，运行照常回执');
    const run=response.json.run;
    assert.equal(run.status,'blocked','校验失败必须落到终态，前端不再轮询');
    assert.match(run.error,/输出校验失败/);
    assert.equal(run.result,null,'校验失败的结果不能交付');
    assert.equal(run.applyValidatedGoal,undefined);
    assert.equal(safeGoalSuperAgentRun(run)?.status,'blocked');
  } finally { await host?.stop(); await runner?.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('cloud Host acknowledges before completion and validates the original contextual review at lookup and replay',async t=>{
  const requestId='along-review-cloud-reassessment';
  const reassessment={decision:'keep',basedOnRevision:requestId,reason:'沿用已有计划',changes:[]};
  const input={...goalInput,requestId,runtime:DSH_RUNTIME,
    snapshot:{contextReviewAllowed:true,selectedTypes:['workout'],
      planning:{version:1,revisionId:requestId,now:'2026-11-20T10:00:00.000Z',
        goalIntent:'本人允许本次使用的健康目标说明',weeklyWorkoutMinutes:120}}};
  for (const [name,proposal] of [
    ['keep',null],
    ['attempt to change the goal',{active:true,title:'运动',target:120,task:'记录运动',reason:'回顾当前计划'}],
  ]) await t.test(name,async()=>{
    const dir=mkdtempSync(join(tmpdir(),'along-host-runner-review-'));
    let runner,host;
    try {
      runner=await spawnRunner({dir,token:'cd'.repeat(32),stdout:JSON.stringify({
        reply:'当前任务继续执行。',proposal,layout:null,reassessment,
      })});
      host=await spawnHostWithRunner(dir,runner.port);
      const headers={authorization:`Bearer ${host.token}`};
      const submitted=await phoneCall(host.port,'/super-agent/goals',{method:'POST',body:input,headers});
      assert.equal(submitted.status,200);
      assert.equal(submitted.json.run.status,'working');
      assert.equal(submitted.json.run.applyValidatedGoal,undefined);
      assert.equal(submitted.json.run.input.snapshot,undefined);
      const queried=await waitForCompletion(()=>phoneCall(host.port,'/super-agent/goals/status',{method:'POST',
        body:{requestId,runtime:DSH_RUNTIME,contextReview:true},headers}),response=>response.json);
      const replayed=await phoneCall(host.port,'/super-agent/goals',{method:'POST',body:input,headers});
      const wrongKind=await phoneCall(host.port,'/super-agent/tasks/status',{method:'POST',
        body:{requestId,runtime:DSH_RUNTIME},headers});
      assert.equal(queried.status,200);
      assert.equal(replayed.status,200);
      assert.equal(wrongKind.status,502,'任务查询只接收任务运行');
      assert.equal(wrongKind.json.input,undefined);
      for (const run of [replayed.json.run,queried.json]) {
        assert.equal(run.createdAt,submitted.json.run.createdAt);
        assert.equal(run.applyValidatedGoal,undefined);
        assert.equal(run.input.snapshot,undefined,'仅服务端使用情境上下文做校验');
        if (proposal) {
          assert.equal(run.status,'blocked');
          assert.equal(run.result,null);
          assert.match(run.error,/情境重排不能修改目标/);
        } else {
          assert.equal(run.status,'done');
          assert.equal(run.result.reassessment.decision,'keep');
          assert.equal(run.result.reassessment.basedOnRevision,requestId);
        }
      }
      assert.equal(runner.callCount(),1);
    } finally { await host?.stop(); await runner?.stop(); rmSync(dir,{recursive:true,force:true}); }
  });
});

test('host：goals/status 与 tasks 两个端点同走 runner（x-along-user 用请求者自己的绑定）',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-host-runner-status-'));
  const goalRun=goalRunEnvelope('along-goal-health-st',goalOutput);
  const taskRun=taskRunEnvelope('along-health-task9');
  let runner,host;
  try {
    runner=await stubRunner({
      postRun:body=>body.kind==='goal'?goalRunEnvelope(body.requestId,goalOutput):taskRunEnvelope(body.requestId),
      getStatus:requestId=>requestId==='along-goal-health-st'?goalRun:requestId==='along-health-task9'?taskRun:null});
    host=await spawnHostWithRunner(dir,runner.port);
    const status=await phoneCall(host.port,'/super-agent/goals/status',{method:'POST',
      body:{requestId:'along-goal-health-st',runtime:DSH_RUNTIME,contextReview:true},headers:{authorization:`Bearer ${host.token}`}});
    assert.equal(status.status,200);
    assert.equal(status.json.status,'done');
    assert.equal(status.json.applyValidatedGoal,true,'查询属性不改变原请求的类型');
    assert.equal(status.json.runtime,DSH_RUNTIME);
    assert.equal(safeGoalSuperAgentRun(status.json)?.requestId,'along-goal-health-st');
    const goalCall=runner.calls.find(item=>item.method==='GET'&&item.path==='/run/along-goal-health-st');
    assert.equal(goalCall.headers['x-along-user'],host.userId(),'状态读取带请求者自己的身份');
    const task=await phoneCall(host.port,'/super-agent/tasks',{method:'POST',
      body:{requestId:'along-health-task9',task:{id:'t1',title:'整理健康推荐',detail:'给出本周清单。',when:'今天',state:'temporary'},
        goal:goalInput.goal,context:{},runtime:DSH_RUNTIME},
      headers:{authorization:`Bearer ${host.token}`}});
    assert.equal(task.status,200);
    assert.equal(task.json.run.runtime,DSH_RUNTIME);
    assert.equal(safeSuperAgentRun(task.json.run)?.requestId,'along-health-task9','任务 run 通过任务白名单');
    const taskStatus=await phoneCall(host.port,'/super-agent/tasks/status',{method:'POST',
      body:{requestId:'along-health-task9',runtime:DSH_RUNTIME},headers:{authorization:`Bearer ${host.token}`}});
    assert.equal(taskStatus.status,200);
    assert.equal(taskStatus.json.status,'done');
    // runner 没有的记录按上游故障上抛，不能伪造一条运行。
    const missing=await phoneCall(host.port,'/super-agent/goals/status',{method:'POST',
      body:{requestId:'along-goal-health-none',runtime:DSH_RUNTIME},headers:{authorization:`Bearer ${host.token}`}});
    assert.equal(missing.status,502);
    assert.match(missing.json.error,/运行记录不存在/);
  } finally { await host?.stop(); await runner?.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('host：设置了 ALONG_DSH_RUNNER_URL 但缺 runner-token → 拒绝启动',()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-host-runner-notoken-'));
  try {
    writeFileSync(join(dir,'users.json'),JSON.stringify([USER_A,USER_B].map(userId=>({userId}))),{mode:0o600});
    const result=spawnSync(process.execPath,[HOST_FILE],{env:{...process.env,
      ALONG_AGENT_STATE_DIR:dir,ALONG_AGENT_HOST:'127.0.0.1',ALONG_DSH_RUNNER_URL:'http://127.0.0.1:3088'},
      encoding:'utf8'});
    assert.notEqual(result.status,0,'缺凭证不能静默起服务');
    assert.match(String(result.stderr),/runner-token/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

// ---- 契约归一：两条运行时同一份 GOAL_OUTPUT_INSTRUCTIONS -------------------------------------------

test('Kimi 与云端 runner 共用同一份目标输出契约（GOAL_OUTPUT_INSTRUCTIONS 只在共享层一份）',()=>{
  const kimi=readFileSync(new URL('../host/kimi-code-agent.mjs',import.meta.url),'utf8');
  const runner=readFileSync(new URL('../deploy/agent-runner.mjs',import.meta.url),'utf8');
  // Kimi 不再内嵌副本：契约只有 web/goal-agent-core.mjs 这一份（docs/bugfix-goal-prompt.md §7 纪律）。
  assert.doesNotMatch(kimi,/Required JSON shape:/,'Kimi 不能再自带契约副本');
  assert.match(kimi,/import \{[^}]*GOAL_OUTPUT_INSTRUCTIONS[^}]*\} from '\.\.\/web\/goal-agent-core\.mjs'/);
  assert.match(runner,/import \{[^}]*GOAL_OUTPUT_INSTRUCTIONS[^}]*\} from '\.\.\/web\/goal-agent-core\.mjs'/);
  // 两条运行时在目标与情境评估两条分支读到同一份文本。
  const branch=/input\.snapshot\?\.planning\?REASSESSMENT_INSTRUCTIONS:GOAL_OUTPUT_INSTRUCTIONS/;
  assert.match(kimi,branch);
  assert.match(runner,branch);
  assert.ok(typeof REASSESSMENT_INSTRUCTIONS==='string'&&REASSESSMENT_INSTRUCTIONS.length>50);
  // 共享契约本身仍覆盖形状关键约束。
  for (const fragment of ['"reply"','"proposal"','"layout"',
    'For a custom goal, do not use metric modules and proposal.target must be null',
    'Keep all user-facing text in Chinese']) {
    assert.ok(GOAL_OUTPUT_INSTRUCTIONS.includes(fragment),`共享契约缺少关键约束：${fragment}`);
  }
});

test('host：四个 DSH 分支按 ALONG_DSH_RUNNER_URL 分流，bridge 路径原样保留',()=>{
  const source=readFileSync(new URL('../host/agent-host.mjs',import.meta.url),'utf8');
  assert.match(source,/ALONG_DSH_RUNNER_URL/);
  for (const name of ['runnerGoalStart','runnerGoalStatus','runnerTaskStart','runnerTaskStatus']) {
    assert.match(source,new RegExp(`if \\(dshRunnerURL\\) return respond\\(res,200,await upstream\\(\\(\\)=>${name}`),
      `${name} 分支必须挂在 dshRunnerURL 之后`);
  }
  // 未设置 env 的 Mac 本地模式走 bridge：四条 bridge 调用原样保留，且 runner 返回照旧过 normalizeGoalRun。
  assert.match(source,/superAgentCall\('\/along-source\/api\/goals'/);
  assert.match(source,/superAgentCall\('\/along-source\/api\/tasks'/);
  assert.match(source,/superAgentCall\(`\/along-source\/api\/goals\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(source,/superAgentCall\(`\/along-source\/api\/tasks\/\$\{encodeURIComponent\(id\)\}`/);
});
