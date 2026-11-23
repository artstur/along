import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createServer, request as httpRequest} from 'node:http';
import {request as tlsRequest} from 'node:https';
import net from 'node:net';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DSH_RUNTIME, KIMI_RUNTIME, safeGoalSuperAgentRun, AGENT_RUN_TIMEOUT_MS} from '../web/super-agent.mjs';
import {GOAL_OUTPUT_INSTRUCTIONS} from '../web/goal-agent-core.mjs';
import {REASSESSMENT_INSTRUCTIONS} from '../web/contextual-planning.mjs';
import {issuePairingCode} from '../host/pairing.mjs';
import {provideCloudCa} from './cloud-ca-fixture.mjs';

// M3 云端 agent 适配层（docs/cloud-deploy-multi-user.md §3.5/§4-M3）的配对测试。
// 与 test/host-runner-agreement.test.mjs 互补，这里覆盖设计验收标准里对方未覆盖的面：
// - 回执守卫：runner 返回的 run.requestId 与本次请求不符 → 502（§3.5 M3 拍板）
// - runner 故障语义：进程不可达 / 5xx / 非 JSON 响应 → 502；runner 自身 blocked 终态原样交付不重试
// - 开关语义不变：ALONG_EVENT_INGEST=on 时 DSH 分支先 409，不触达 runner（§3.5 末条）
// - Kimi 运行时不受 ALONG_DSH_RUNNER_URL 影响（不误走 runner）
// - runner 日志红线：dsh stdout/stderr 与请求体只解析不落日志；token 不落日志；/health 匿名（§3.7/§3.3）
// - runner 解析与失败面：围栏 JSON 提取、输出超限、dsh 拉起失败 → blocked 终态
// - 缓存语义：同键并发 POST 合并为一次拉起；跨用户同 requestId 各自拉起；LRU 上限 200（§3.5）
// - prompt 契约真实生效：goal / 情境评估 / task 三种 prompt 用共享层常量（§3.5 契约归一）
// - 超时对齐 AGENT_RUN_TIMEOUT_MS（形状断言：30 分钟无法在测试里行为级验证）
// - SD-5 版本联动：index.html ?v= 与 sw.js CACHE 同步 ≥81，goal-agent-core.mjs 登记在产物白名单

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

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function freePort() {
  return new Promise(resolve=>{
    const server=net.createServer();
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port; server.close(()=>resolve(port));});
  });
}
function plainRequest(port,path,{method='GET',body,chunks,headers={}}={}) {
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const req=httpRequest({host:'127.0.0.1',port,path,method,agent:false,
      headers:{...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...headers}},
    res=>{
      res.setEncoding('utf8');
      let text=''; res.on('data',chunk=>text+=chunk);
      res.on('end',()=>{let json=null; try{json=text?JSON.parse(text):null;}catch{json=null;} resolve({status:res.statusCode,text,json});});
    });
    req.on('error',reject);
    if (chunks) {
      req.write(chunks[0]);
      setTimeout(()=>req.end(chunks[1]),40);
    } else req.end(payload);
  });
}
function phoneCall(port,path,{method='GET',body,headers={}}={}) {
  const attempt=()=>new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const req=tlsRequest({host:'127.0.0.1',port,path,method,rejectUnauthorized:false,agent:false,
      headers:{...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...headers}},
    res=>{
      let text=''; res.on('data',chunk=>text+=chunk);
      res.on('end',()=>{let json=null; try{json=text?JSON.parse(text):null;}catch{json=null;} resolve({status:res.statusCode,text,json});});
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
async function waitReady(port,label,probe) {
  const deadline=Date.now()+15_000;
  while (Date.now()<deadline) {
    try { const response=await (probe??(path=>plainRequest(port,path)))('/health'); if (response.status===200) return; } catch { /* 还没起来 */ }
    await sleep(120);
  }
  assert.ok(false,`${label} 没有就绪`);
}

// 测试替身从脚本里取自己的配置，保持对子进程环境白名单的真实检查。
const MODEL_KEY='sk-synthetic-along-runner-fixture';

function nodeFakeDsh({logFile,mode,stdout='',stderr='',promptFile,probeFile}) {
  return `#!/usr/bin/env node
import {appendFileSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const config=${JSON.stringify({logFile,mode,stdout,stderr,promptFile,probeFile})};
appendFileSync(config.logFile,'1');
const prompt=readFileSync(0,'utf8');
if (config.promptFile) writeFileSync(config.promptFile,prompt);
if (config.probeFile) {
  const {HOME,DSH_HOME,TMPDIR,DEEPSEEK_API_KEY}=process.env;
  const profile=join(DSH_HOME,'profiles','along-headless');
  appendFileSync(config.probeFile,JSON.stringify({
    args:process.argv.slice(2),
    cwd:process.cwd(),home:HOME,dshHome:DSH_HOME,tempDir:TMPDIR,
    modes:[process.cwd(),HOME,DSH_HOME,TMPDIR].map(path=>statSync(path).mode&0o777),
    envKeys:Object.keys(process.env).sort(),
    modelKeyMatches:DEEPSEEK_API_KEY===${JSON.stringify(MODEL_KEY)},
    manifest:JSON.parse(readFileSync(join(profile,'package.json'),'utf8')),
    patch:JSON.parse(readFileSync(join(profile,'cordis.patch.yml'),'utf8')),
  })+'\\n');
}
if (config.stderr) process.stderr.write(config.stderr);
if (config.mode==='fail') process.stdout.write(config.stdout,()=>process.exit(3));
else if (config.mode==='overflow') process.stdout.write('x'.repeat(1100*1024));
else process.stdout.write(config.stdout);
`;
}

// sh 版：进程拉起开销最小，供并发与 LRU 这类要多次拉起的用例使用。
function shellFakeDsh({logFile,stdout,delay}) {
  const quoted=value=>`'${String(value).replaceAll("'","'\\''")}'`;
  return `#!/bin/sh
printf 1 >> ${quoted(logFile)}
${delay?`sleep ${quoted(delay)}`:''}
printf '%s' ${quoted(stdout)}
`;
}

let fakeSeq=0;
async function spawnMyRunner({dir,script=nodeFakeDsh,fixture={},env={}}) {
  fakeSeq+=1;
  const bin=join(dir,`fake-dsh-${fakeSeq}.mjs`);
  const tokenFile=join(dir,`runner-token-${fakeSeq}`);
  writeFileSync(tokenFile,'ab'.repeat(32),{mode:0o600});
  const modelFile=join(dir,`model-key-${fakeSeq}`);
  writeFileSync(modelFile,`${MODEL_KEY}\n`,{mode:0o600});
  const logFile=join(dir,`dsh-calls-${fakeSeq}`);
  writeFileSync(logFile,'');
  writeFileSync(bin,script({logFile,...fixture}),{mode:0o755});
  const port=await freePort();
  const child=spawn(process.execPath,[RUNNER_FILE],{env:{...process.env,
    ALONG_RUNNER_PORT:String(port),ALONG_RUNNER_HOST:'127.0.0.1',ALONG_RUNNER_TOKEN_FILE:tokenFile,
    ALONG_MODEL_API_KEY_FILE:modelFile,ALONG_DSH_BIN:bin,TMPDIR:realpathSync(dir),...env},stdio:['ignore','pipe','pipe']});
  const output=[];
  child.stdout.on('data',data=>output.push(String(data)));
  child.stderr.on('data',data=>output.push(String(data)));
  await waitReady(port,'agent runner');
  const stop=()=>new Promise(resolve=>{
    child.once('exit',()=>resolve());
    child.kill('SIGINT');
    setTimeout(()=>{try{child.kill('SIGKILL');}catch{}resolve();},3_000).unref();
  });
  return {port,token:'ab'.repeat(32),callCount:()=>readFileSync(logFile,'utf8').length,
    output:()=>output.join(''),stop};
}

async function readCompletedRun(runner,userId,requestId) {
  const deadline=Date.now()+5_000;
  while (Date.now()<deadline) {
    const response=await plainRequest(runner.port,`/run/${requestId}`,{
      headers:{'runner-token':runner.token,'x-along-user':userId},
    });
    assert.equal(response.status,200);
    if (response.json.run.status!=='working') return response;
    await sleep(15);
  }
  assert.fail(`Run ${requestId} did not finish`);
}

async function submitAndRead(runner,body) {
  const submitted=await plainRequest(runner.port,'/run',{method:'POST',body,headers:{'runner-token':runner.token}});
  assert.equal(submitted.status,200);
  return submitted.json.run.status==='working'?readCompletedRun(runner,body.userId,body.requestId):submitted;
}

test('runner acknowledges a split UTF-8 goal before model completion and keeps its original input',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-runner-split-utf8-'));
  const promptFile=join(dir,'prompt');
  const runner=await spawnMyRunner({dir,fixture:{promptFile,stdout:JSON.stringify(goalOutput)}});
  try {
    const message='学习中文，每周练习三次';
    const payload=Buffer.from(JSON.stringify({userId:USER_A,requestId:'split-utf8',kind:'goal',input:{...goalInput,message}}));
    const split=payload.indexOf(Buffer.from(message))+1;
    const response=await plainRequest(runner.port,'/run',{
      method:'POST',chunks:[payload.subarray(0,split),payload.subarray(split)],
      headers:{'runner-token':runner.token,'content-type':'application/json'},
    });
    assert.equal(response.status,200);
    assert.equal(response.json.run.input.message,message);
    assert.equal(response.json.run.status,'working');
    assert.equal(response.json.run.result,null);
    const completed=await readCompletedRun(runner,USER_A,'split-utf8');
    assert.equal(completed.json.run.status,'done');
    assert.equal(completed.json.run.createdAt,response.json.run.createdAt);
    assert.ok(readFileSync(promptFile,'utf8').includes(message));
    const oversized=await plainRequest(runner.port,'/run',{
      method:'POST',body:{...goalInput,message:'中'.repeat(23_000)},headers:{'runner-token':runner.token},
    });
    assert.equal(oversized.status,400);
    assert.match(oversized.json.error,/大小限制/);
  } finally {await runner.stop();rmSync(dir,{recursive:true,force:true});}
});

test('runner：缺失、读取失败或多行模型密钥时拒绝启动',()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-runner-model-key-'));
  const tokenFile=join(dir,'runner-token');
  const blankFile=join(dir,'blank');
  const multilineFile=join(dir,'multiline');
  writeFileSync(tokenFile,'ab'.repeat(32),{mode:0o600});
  writeFileSync(blankFile,' \n',{mode:0o600});
  writeFileSync(multilineFile,`${MODEL_KEY}\nsecond-value`,{mode:0o600});
  try {
    for (const path of ['',join(dir,'missing'),blankFile,multilineFile]) {
      const child=spawnSync(process.execPath,[RUNNER_FILE],{encoding:'utf8',timeout:3_000,env:{
        ...process.env,ALONG_RUNNER_TOKEN_FILE:tokenFile,ALONG_MODEL_API_KEY_FILE:path,
        DEEPSEEK_API_KEY:'inherited-value-must-not-be-used',
      }});
      assert.equal(child.status,1);
      assert.match(child.stderr,/模型密钥/);
      assert.ok(!child.stdout.includes('Along agent runner:'));
      assert.ok(!child.stderr.includes(MODEL_KEY));
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('runner：并发请求从独立目录启动无工具 profile，仅传递模型密钥与运行目录',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-runner-dsh-isolation-'));
  const probeFile=join(dir,'dsh-probes.ndjson');
  const runner=await spawnMyRunner({dir,fixture:{stdout:JSON.stringify(goalOutput),probeFile},env:{
    DEEPSEEK_API_KEY:'inherited-model-key',
    DSH_HOME:join(dir,'shared-dsh-home'),
    ALONG_RUNNER_TOKEN:'unrelated-runner-secret',
    ALONG_APNS_KEY_FILE:join(dir,'unrelated-apns-key'),
  }});
  try {
    const responses=await Promise.all([USER_A,USER_B].map(userId=>submitAndRead(runner,{
      userId,requestId:'isolated-run-1',kind:'goal',input:goalInput,
    })));
    assert.ok(responses.every(response=>response.json?.run?.status==='done'));
    const probes=readFileSync(probeFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(probes.length,2);
    assert.notEqual(probes[0].tempDir,probes[1].tempDir);
    for (const probe of probes) {
      assert.deepEqual(probe.args,['--profile','along-headless']);
      const envKeys=probe.envKeys.filter(key=>process.platform!=='darwin'||key!=='__CF_USER_TEXT_ENCODING');
      assert.deepEqual(envKeys,['DEEPSEEK_API_KEY','DSH_HOME','HOME','PATH','TMPDIR']);
      assert.equal(probe.modelKeyMatches,true);
      assert.equal(probe.cwd,join(probe.tempDir,'workspace'));
      assert.equal(probe.home,join(probe.tempDir,'home'));
      assert.equal(probe.dshHome,join(probe.home,'.dsh'));
      assert.deepEqual(probe.modes,[0o700,0o700,0o700,0o700]);
      assert.deepEqual(probe.manifest.dsh.profile.bundles,[]);
      assert.equal(probe.patch.length,1);
      const rows=probe.patch[0].insert;
      assert.deepEqual(rows.map(row=>row.name),[
        '@deepseek-ai/cordis-plugin-timer','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-llm-deepseek-api-key',
        '@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-projection','@deepseek-ai/dsh-system-prompt',
        '@deepseek-ai/dsh-tools','@deepseek-ai/dsh-tool-executor-native','@deepseek-ai/dsh-agent',
        '@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-agent-default-model','@deepseek-ai/dsh-headless',
      ]);
      assert.deepEqual(rows.find(row=>row.id==='llm-deepseek').config,{apiKeyEnv:'DEEPSEEK_API_KEY'});
    }
    assert.ok(!readdirSync(dir).some(name=>name.startsWith('along-dsh-')));
    assert.ok(!runner.output().includes(MODEL_KEY));
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('runner：子进程非零退出或结果含内部凭证时，丢弃其结果',async()=>{
  for (const fixture of [
    {mode:'fail',stdout:JSON.stringify(goalOutput)},
    {stdout:JSON.stringify({...goalOutput,reply:`key: ${MODEL_KEY}`})},
  ]) {
    const dir=mkdtempSync(join(tmpdir(),'along-runner-output-rejection-'));
    const runner=await spawnMyRunner({dir,fixture});
    try {
      const response=await submitAndRead(runner,{
        userId:USER_A,requestId:'reject-result',kind:'goal',input:goalInput,
      });
      assert.equal(response.json.run.status,'blocked');
      assert.equal(response.json.run.result,null);
      assert.ok(!response.text.includes(MODEL_KEY));
    } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
  }
});

// ---- runner 解析与失败面（§3.5：stdout JSON→运行信封；失败一律 blocked 终态） -----------------------

test('runner：围栏 JSON 也能解析成 done；prompt 真的带共享契约（goal / 情境评估 / task 三种分支）',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-runner-contract-prompt-'));
  const promptFile=join(dir,'last-prompt');
  const fenced=`我已收到。\n\`\`\`json\n${JSON.stringify(goalOutput)}\n\`\`\`\n以上。`;
  const runner=await spawnMyRunner({dir,fixture:{stdout:fenced,promptFile}});
  try {
    // 1) 围栏 + 前后散文：runner 仍解析出最终 JSON（dsh 的最终答案是文本里嵌 JSON）。
    const goal=await submitAndRead(runner,{userId:USER_A,requestId:'contract-goal-1',kind:'goal',
      input:{...goalInput,message:'RUNNER-MSG-MARK-7f3a9'}});
    assert.equal(goal.status,200);
    const run=goal.json.run;
    assert.equal(run.status,'done');
    assert.equal(run.result.reply,goalOutput.reply);
    assert.equal(safeGoalSuperAgentRun(run)?.requestId,'contract-goal-1');
    // 目标 prompt 内嵌共享契约全文与本次输入（契约归一要在运行时真实生效，不只是 import）。
    let prompt=readFileSync(promptFile,'utf8');
    assert.ok(prompt.includes('RUNNER-MSG-MARK-7f3a9'),'prompt 必须携带本次消息');
    assert.ok(prompt.includes('Required JSON shape:'),'目标 prompt 必须带 GOAL_OUTPUT_INSTRUCTIONS');
    assert.ok(prompt.includes('Return one final JSON object only'));
    // 2) 带情境评估快照 → 走 REASSESSMENT_INSTRUCTIONS 分支，不再带目标输出契约。
    const review=await submitAndRead(runner,{userId:USER_A,requestId:'contract-goal-2',kind:'goal',
      input:{...goalInput,snapshot:{planning:{revisionId:'rev-1'}}}});
    assert.equal(review.status,200);
    prompt=readFileSync(promptFile,'utf8');
    assert.ok(prompt.includes('contextual review of an existing goal'),
      '情境评估 prompt 必须带 REASSESSMENT_INSTRUCTIONS');
    assert.ok(!prompt.includes('Required JSON shape:'),'情境评估分支不得再混入目标输出契约');
    // 3) kind='task' → 任务 prompt 要求 {"summary","next"} 形状。
    const task=await submitAndRead(runner,{userId:USER_A,requestId:'contract-task-1',kind:'task',
      input:{requestId:'contract-task-1',task:{id:'t1',title:'整理',detail:'清单',when:'今天',state:'temporary'},goal:goalInput.goal,context:{}}});
    assert.equal(task.status,200);
    prompt=readFileSync(promptFile,'utf8');
    assert.ok(prompt.includes('"summary"')&&prompt.includes('Chinese delivery summary'),
      '任务 prompt 必须要求 summary/next 形状');
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('runner：dsh 输出超限 / 二进制拉起失败 → blocked 终态并缓存',async()=>{
  // 输出超过 MAX_STDOUT（1MB）→ SIGKILL 后 blocked，信封仍可渲染。
  const dir=mkdtempSync(join(tmpdir(),'along-runner-contract-overflow-'));
  const runner=await spawnMyRunner({dir,fixture:{mode:'overflow'}});
  try {
    const response=await submitAndRead(runner,{userId:USER_A,requestId:'contract-overflow-1',kind:'goal',input:goalInput});
    assert.equal(response.status,200);
    const run=response.json.run;
    assert.equal(run.status,'blocked');
    assert.match(run.error,/超过大小限制/);
    assert.equal(run.result,null);
    assert.equal(safeGoalSuperAgentRun(run)?.status,'blocked','blocked 终态仍是可渲染信封');
    const read=await plainRequest(runner.port,'/run/contract-overflow-1',
      {headers:{'runner-token':runner.token,'x-along-user':USER_A}});
    assert.deepEqual(read.json.run,run,'失败终态也缓存，宿主轮询拿到同一条');
    assert.ok(!readdirSync(dir).some(name=>name.startsWith('along-dsh-')));
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
  // ALONG_DSH_BIN 指向不存在的路径 → 拉起失败 blocked（不 5xx、不悬挂）。
  const dir2=mkdtempSync(join(tmpdir(),'along-runner-contract-enoent-'));
  const runner2=await spawnMyRunner({dir:dir2,env:{ALONG_DSH_BIN:'/nonexistent/along-no-dsh'}});
  try {
    const response=await submitAndRead(runner2,{userId:USER_A,requestId:'contract-enoent-1',kind:'goal',input:goalInput});
    assert.equal(response.status,200);
    const run=response.json.run;
    assert.equal(run.status,'blocked');
    assert.match(run.error,/DSH 无法启动/);
    assert.equal(run.result,null);
    assert.ok(!readdirSync(dir2).some(name=>name.startsWith('along-dsh-')));
  } finally { await runner2.stop(); rmSync(dir2,{recursive:true,force:true}); }
});

// ---- 缓存语义（§3.5：同键幂等不重复拉起；键 ${userId}:${requestId}；LRU 上限 200） -------------------

test('runner：同键并发 POST 合并为一次拉起；跨用户同 requestId 各自拉起',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-runner-contract-inflight-'));
  const runner=await spawnMyRunner({dir,script:shellFakeDsh,
    fixture:{stdout:JSON.stringify(goalOutput),delay:'0.35'}});
  try {
    const body={userId:USER_A,requestId:'contract-inflight-1',kind:'goal',input:goalInput};
    const headers={'runner-token':runner.token};
    const [first,second]=await Promise.all([
      plainRequest(runner.port,'/run',{method:'POST',body,headers}),
      plainRequest(runner.port,'/run',{method:'POST',body,headers}),
    ]);
    assert.equal(first.status,200);
    assert.equal(second.status,200);
    assert.equal(first.json.run.status,'working');
    assert.deepEqual(second.json.run,first.json.run,'并发同键返回同一条运行');
    const active=await plainRequest(runner.port,`/run/${body.requestId}`,{headers:{...headers,'x-along-user':USER_A}});
    assert.equal(active.status,200,'提交回执中的运行可立即查询');
    assert.equal(active.json.run.requestId,body.requestId);
    await readCompletedRun(runner,USER_A,body.requestId);
    assert.equal(runner.callCount(),1,'并发同键只拉起一个 dsh 进程');
    // 同 requestId 换用户 → 不同缓存键，各自拉起（POST 层的跨用户隔离）。
    const otherUser=await plainRequest(runner.port,'/run',{method:'POST',
      body:{...body,userId:USER_B},headers});
    assert.equal(otherUser.status,200);
    assert.equal(otherUser.json.run.status,'working');
    await readCompletedRun(runner,USER_B,body.requestId);
    assert.equal(runner.callCount(),2,'跨用户同 requestId 必须再拉起一次');
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('runner：LRU 上限 200 —— 第 201 条淘汰最旧记录，被淘汰键重新 POST 会再拉起',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-runner-contract-lru-'));
  const runner=await spawnMyRunner({dir,script:shellFakeDsh,fixture:{stdout:JSON.stringify(goalOutput)}});
  try {
    const headers={'runner-token':runner.token};
    for (let i=0;i<=200;i+=1) {
      const response=await submitAndRead(runner,{userId:USER_A,requestId:`lru-${String(i).padStart(3,'0')}`,kind:'goal',input:goalInput});
      assert.equal(response.status,200);
    }
    assert.equal(runner.callCount(),201,'每个独立键各拉起一次');
    const evicted=await plainRequest(runner.port,'/run/lru-000',{headers:{...headers,'x-along-user':USER_A}});
    assert.equal(evicted.status,404,'最旧记录被 LRU 淘汰');
    const kept=await plainRequest(runner.port,'/run/lru-200',{headers:{...headers,'x-along-user':USER_A}});
    assert.equal(kept.status,200);
    assert.equal(kept.json.run.requestId,'lru-200');
    // 被淘汰的键重新 POST：缓存未命中 → 再拉起一次（结果重新可用，不是永久丢失）。
    const rerun=await submitAndRead(runner,{userId:USER_A,requestId:'lru-000',kind:'goal',input:goalInput});
    assert.equal(rerun.status,200);
    assert.equal(runner.callCount(),202);
    const back=await plainRequest(runner.port,'/run/lru-000',{headers:{...headers,'x-along-user':USER_A}});
    assert.equal(back.status,200);
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

// ---- 鉴权面与日志红线（§3.3：/health 匿名、其余端点必须带令牌；§3.7：运行内容与凭证不落日志） -------

test('runner：/health 匿名可达；运行内容（消息/回答/stderr）与 runner-token 不落 runner 日志',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-runner-contract-redline-'));
  const runner=await spawnMyRunner({dir,fixture:{
    stdout:JSON.stringify({...goalOutput,reply:'SECRET-REPLY-9f3a7'}),
    stderr:'SECRET-ERR-3f9a7'}});
  try {
    const health=await plainRequest(runner.port,'/health');
    assert.equal(health.status,200,'/health 是 compose healthcheck 匿名探测面');
    assert.equal(health.json.ready,true);
    assert.ok(!health.text.includes(runner.token),'health 响应不得携带令牌');
    // 其余端点不带/带错令牌一律 401（§3.3：其余端点必须带令牌）。
    const noToken=await plainRequest(runner.port,'/run',{method:'POST',
      body:{userId:USER_A,requestId:'contract-red-1',kind:'goal',input:goalInput}});
    assert.equal(noToken.status,401);
    const badToken=await plainRequest(runner.port,'/run/contract-red-1',{headers:{'runner-token':'ff'.repeat(32),'x-along-user':USER_A}});
    assert.equal(badToken.status,401);
    // 带令牌但 x-along-user 形状非法 → 400（缓存键来源必须合法）。
    const run=await submitAndRead(runner,{userId:USER_A,requestId:'contract-red-1',kind:'goal',
      input:{...goalInput,message:'SECRET-MSG-7f3a9'}});
    assert.equal(run.status,200);
    const badUser=await plainRequest(runner.port,'/run/contract-red-1',
      {headers:{'runner-token':runner.token,'x-along-user':'bad user!'}});
    assert.equal(badUser.status,400);
    // 日志红线：runner 进程自己的 stdout/stderr 不得出现请求体、dsh 回答、dsh stderr、令牌。
    const log=runner.output();
    assert.ok(log.includes('Along agent runner:'),'要确认 runner 确实有输出可检查');
    for (const secret of ['SECRET-MSG-7f3a9','SECRET-REPLY-9f3a7','SECRET-ERR-3f9a7',runner.token]) {
      assert.ok(!log.includes(secret),`runner 日志不得出现：${secret}`);
    }
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

// ---- host 分流：真实 host 进程 + stub runner（验收 #3 宿主侧） --------------------------------------

function goalEnvelope(requestId,{result=goalOutput,status='done',error=null}={}) {
  const now=Date.now();
  return {version:1,kind:'goal',actual:true,runtime:DSH_RUNTIME,requestId,
    source:{kind:'along',label:'Along 目标'},trigger:{kind:'goal',label:'DSH Headless'},
    eval:{decision:status==='done'?'accept':'blocked'},ticket:null,mandate:'只规划目标与动态任务；不执行外部写操作。',
    events:[{at:now,text:status==='done'?'DSH Headless 已返回编排结果':'DSH Headless 运行已停止'}],
    status,statusLabel:status==='done'?'DSH 已完成':'输出需要重试',progress:status==='done'?100:12,
    createdAt:now,updatedAt:now,input:{goal:goalInput.goal,message:goalInput.message,snapshot:{planning:null}},
    assignments:[],agents:[],result:status==='done'?result:null,...(error?{error}:{})};
}

// stub runner：按请求编号切换行为，记录 host 发来的每一次调用。
async function scenarioStubRunner() {
  const calls=[];
  const server=createServer(async(req,res)=>{
    let raw=''; for await (const chunk of req) raw+=chunk;
    const record={method:req.method,path:new URL(req.url,'http://x').pathname,
      headers:req.headers,body:raw?JSON.parse(raw):null,raw};
    calls.push(record);
    const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(typeof value==='string'?value:JSON.stringify(value));};
    if (record.method==='POST'&&record.path==='/run') {
      const id=record.body?.requestId;
      if (id==='sc-mismatch') return reply(200,{run:goalEnvelope('sc-someone-else')});
      if (id==='sc-http500') return reply(500,{error:'模型额度已用尽'});
      if (id==='sc-badjson') return reply(200,'not-json{{');
      if (id==='sc-blocked') return reply(200,{run:goalEnvelope('sc-blocked',{status:'blocked',error:'DSH 长时间没有返回结果，已停止等待'})});
      return reply(200,{run:goalEnvelope(id)});
    }
    const match=record.method==='GET'&&record.path.match(/^\/run\/([^/]+)$/);
    if (match) {
      const id=decodeURIComponent(match[1]);
      if (id==='sc-mismatch-get') return reply(200,{run:goalEnvelope('sc-someone-else-2')});
      return reply(200,{run:goalEnvelope(id)});
    }
    reply(404,{error:'未找到接口'});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {calls,port:server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}

async function spawnHost({dir,runnerPort,extraEnv={}}) {
  const tokenFile=join(dir,'runner-token');
  writeFileSync(tokenFile,'cd'.repeat(32),{mode:0o600});
  writeFileSync(join(dir,'users.json'),JSON.stringify([USER_A,USER_B].map(userId=>({userId}))),{mode:0o600});
  // 云端形态必须加载预签发的 CA 叶证书（docs/iphone-ca-profile-design.md §3.1），
  // 否则 Host 在监听前拒启。这里铺一套隔离测试 CA。
  provideCloudCa(dir,{host:'along.test.local'});
  const caEnv={ALONG_TLS_CN:'along.test.local'};
  const code=await issuePairingCode(dir,USER_A);
  const port=await freePort();
  const child=spawn(process.execPath,[HOST_FILE],{env:{
    ...process.env,
    ALONG_AGENT_STATE_DIR:dir,
    ALONG_AGENT_HOST:'127.0.0.1',
    ALONG_AGENT_PORT:String(port),
    ALONG_DSH_RUNNER_URL:`http://127.0.0.1:${runnerPort}`,
    ALONG_RUNNER_TOKEN_FILE:tokenFile,
    ...caEnv,
    ...extraEnv,
  },stdio:['ignore','pipe','pipe']});
  const output=[];
  child.stdout.on('data',data=>output.push(String(data)));
  child.stderr.on('data',data=>output.push(String(data)));
  const text=()=>output.join('');
  await waitReady(port,'host',path=>phoneCall(port,path));
  assert.doesNotMatch(text(),/一次性配对码/);
  const paired=await phoneCall(port,'/pair',{method:'POST',body:{code}});
  assert.equal(paired.status,200);
  const stop=()=>new Promise(resolve=>{
    child.once('exit',()=>resolve());
    child.kill('SIGINT');
    setTimeout(()=>{try{child.kill('SIGKILL');}catch{}resolve();},3_000).unref();
  });
  return {port,token:paired.json.token,
    userId:()=>JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8'))[0].user_id,text,stop};
}

test('host：runner 回执 requestId 不符 → 502；runner 5xx/坏 JSON → 502 且文案透传；runner 自身 blocked 原样交付',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-host-contract-mismatch-'));
  const runner=await scenarioStubRunner();
  const host=await spawnHost({dir,runnerPort:runner.port});
  try {
    const auth={authorization:`Bearer ${host.token}`};
    const goals=(requestId,extra={})=>phoneCall(host.port,'/super-agent/goals',{method:'POST',
      body:{requestId,...goalInput,runtime:DSH_RUNTIME,...extra},headers:auth});
    // 正常回执：过 normalizeGoalRun + 前端白名单，runtime 固定 dsh-superagent。
    const ok=await goals('sc-ok');
    assert.equal(ok.status,200);
    assert.equal(ok.json.run.status,'done');
    assert.equal(ok.json.run.runtime,DSH_RUNTIME);
    assert.notEqual(ok.json.run.runtime,KIMI_RUNTIME);
    assert.equal(safeGoalSuperAgentRun(ok.json.run)?.requestId,'sc-ok');
    // 回执守卫：POST /run 返回别人的 requestId → 502，不当成本次结果。
    const mismatchPost=await goals('sc-mismatch');
    assert.equal(mismatchPost.status,502);
    assert.match(mismatchPost.json.error,/不匹配的运行记录/);
    // 回执守卫：GET /run/:id 返回的 requestId 与请求编号不符 → 502。
    const mismatchGet=await phoneCall(host.port,'/super-agent/goals/status',{method:'POST',
      body:{requestId:'sc-mismatch-get',runtime:DSH_RUNTIME},headers:auth});
    assert.equal(mismatchGet.status,502);
    assert.match(mismatchGet.json.error,/不匹配的运行记录/);
    // runner 5xx：状态码语义沿用 HostError 502，上游错误文案透传。
    const http500=await goals('sc-http500');
    assert.equal(http500.status,502);
    assert.match(http500.json.error,/模型额度已用尽/);
    // runner 返回非 JSON → 502 无效响应。
    const badjson=await goals('sc-badjson');
    assert.equal(badjson.status,502);
    assert.match(badjson.json.error,/无效响应/);
    // runner 自身失败（dsh 超时落 blocked）→ 原样交付为终态，不是 5xx、不再重试。
    const blocked=await goals('sc-blocked');
    assert.equal(blocked.status,200,'runner 的 blocked 终态是正常回执，不是传输故障');
    assert.equal(blocked.json.run.status,'blocked');
    assert.match(blocked.json.run.error,/长时间没有返回结果/);
    assert.equal(blocked.json.run.result,null);
    assert.equal(safeGoalSuperAgentRun(blocked.json.run)?.status,'blocked');
  } finally { await host.stop(); await runner.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('host：runner 进程不可达 → 502「云端 DSH runner 暂不可用」',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-host-contract-dead-'));
  const deadPort=await freePort();
  const host=await spawnHost({dir,runnerPort:deadPort});
  try {
    const response=await phoneCall(host.port,'/super-agent/goals',{method:'POST',
      body:{requestId:'sc-dead-1',...goalInput,runtime:DSH_RUNTIME},
      headers:{authorization:`Bearer ${host.token}`}});
    assert.equal(response.status,502);
    assert.match(response.json.error,/云端 DSH runner 暂不可用/);
  } finally { await host.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('host：ALONG_EVENT_INGEST=on 时 DSH 分支先 409「已切换新链路」，不触达 runner（开关语义不变）',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-host-contract-409-'));
  const runner=await scenarioStubRunner();
  const host=await spawnHost({dir,runnerPort:runner.port,extraEnv:{ALONG_EVENT_INGEST:'on'}});
  try {
    const auth={authorization:`Bearer ${host.token}`};
    for (const path of ['/super-agent/goals','/super-agent/tasks']) {
      const response=await phoneCall(host.port,path,{method:'POST',
        body:{requestId:'sc-409-1',runtime:DSH_RUNTIME,...goalInput},headers:auth});
      assert.equal(response.status,409,`${path} 必须按既有开关语义 409`);
      assert.match(response.json.error,/已切换新链路/);
    }
    assert.equal(runner.calls.length,0,'409 必须发生在触达 runner 之前');
  } finally { await host.stop(); await runner.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('host：设置 ALONG_DSH_RUNNER_URL 后 Kimi 运行时仍走 Kimi 路径，不误触 runner',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-host-contract-kimi-'));
  const runner=await scenarioStubRunner();
  // ALONG_KIMI_CODE_URL/TOKEN 指向死端口与哑令牌：Kimi 失败是确定性的，且不读真实本机 Kimi 凭证。
  const host=await spawnHost({dir,runnerPort:runner.port,
    extraEnv:{ALONG_KIMI_CODE_URL:'http://127.0.0.1:9',ALONG_KIMI_CODE_TOKEN:'test-dummy'}});
  try {
    const response=await phoneCall(host.port,'/super-agent/goals',{method:'POST',
      body:{requestId:'sc-kimi-1',...goalInput,runtime:KIMI_RUNTIME},
      headers:{authorization:`Bearer ${host.token}`}});
    assert.equal(response.status,502);
    assert.match(response.json.error,/Kimi Code Web Server/,'失败必须来自 Kimi 路径本身');
    assert.equal(runner.calls.length,0,'runner 分流不得劫持 Kimi 运行时的请求');
  } finally { await host.stop(); await runner.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('host：ALONG_RUNNER_TOKEN_FILE 存在但内容不是 64hex → 拒绝启动',()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-host-contract-badtoken-'));
  try {
    writeFileSync(join(dir,'users.json'),JSON.stringify([USER_A,USER_B].map(userId=>({userId}))),{mode:0o600});
    const tokenFile=join(dir,'runner-token');
    writeFileSync(tokenFile,'not-a-hex-token',{mode:0o600});
    const result=spawnSync(process.execPath,[HOST_FILE],{env:{...process.env,
      ALONG_AGENT_STATE_DIR:dir,ALONG_AGENT_HOST:'127.0.0.1',
      ALONG_DSH_RUNNER_URL:'http://127.0.0.1:3088',ALONG_RUNNER_TOKEN_FILE:tokenFile},encoding:'utf8'});
    assert.notEqual(result.status,0,'无效凭证不能静默起服务');
    assert.match(String(result.stderr),/runner-token/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

// ---- 形状与联动（30 分钟超时无法行为级验证，只锁代码形状；版本联动是设计 §4-M3 的硬性交付） --------

test('runner 内部用 AGENT_RUN_TIMEOUT_MS 杀 dsh，Host 只等待快速回执',()=>{
  assert.equal(AGENT_RUN_TIMEOUT_MS,30*60_000);
  const runnerSrc=readFileSync(RUNNER_FILE,'utf8');
  assert.match(runnerSrc,/const RUN_TIMEOUT_MS=AGENT_RUN_TIMEOUT_MS;/,
    'runner 超时必须 import 共享常量，不得另立数值');
  assert.match(runnerSrc,/,RUN_TIMEOUT_MS\)/);
  const hostSrc=readFileSync(HOST_FILE,'utf8');
  assert.match(hostSrc,/user=null,timeout=15_000/);
  assert.doesNotMatch(hostSrc,/AGENT_RUN_TIMEOUT_MS/);
});

test('SD-5 版本联动：index.html ?v= 与 sw.js CACHE 同步提高且 ≥81；goal-agent-core.mjs 登记在产物白名单',()=>{
  const indexHtml=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const versions=[...indexHtml.matchAll(/\?v=(\d+)/g)].map(item=>Number(item[1]));
  assert.ok(versions.length>0,'index.html 必须带 ?v= 版本参数');
  assert.equal(new Set(versions).size,1,'index.html 里所有 ?v= 必须是同一个版本');
  const version=versions[0];
  assert.ok(version>=81,'M3 改了 web/goal-agent-core.mjs，版本必须从 80 提起（SD-5）');
  const sw=readFileSync(new URL('../web/sw.js',import.meta.url),'utf8');
  const cache=sw.match(/const CACHE='along-shell-v(\d+)'/);
  assert.ok(cache,'sw.js 必须声明 along-shell-vN 缓存名');
  assert.equal(Number(cache[1]),version,'sw.js CACHE 必须与 index.html ?v= 同步（AGENTS.md §2）');
  const files=sw.match(/const FILES=\[([^\]]*)\]/);
  assert.ok(files?.[1]?.includes("'./goal-agent-core.mjs'"),'goal-agent-core.mjs 必须登记进 Service Worker FILES');
  const build=readFileSync(new URL('../tools/build.mjs',import.meta.url),'utf8');
  assert.ok(build.includes("'goal-agent-core.mjs'"),'goal-agent-core.mjs 必须登记进构建白名单');
  assert.ok(typeof GOAL_OUTPUT_INSTRUCTIONS==='string'&&GOAL_OUTPUT_INSTRUCTIONS.length>200,
    '共享契约常量必须是导出的非空文本');
  assert.ok(REASSESSMENT_INSTRUCTIONS.includes('contextual review of an existing goal'),
    '情境评估契约片段存在（供 runner 分支断言用）');
});
