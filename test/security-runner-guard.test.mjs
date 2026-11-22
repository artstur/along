import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import net from 'node:net';
import {chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// 安全加固配对测试：M2 runner-guard（docs/cloud-security-hardening.md §3.2 机制、§4-M2 验收标准）。
// 与 test/agent-runner-contract.test.mjs 互补：该文件保留全部既有断言（回归验收 5 不改动、
// 随 npm run check 一并实跑），本文件只按 §4-M2 验收标准逐条新增断言，不迁就实现：
// - 验收 1（并发上限，G-1 runner 侧）：stub dsh 挂起时同用户第 3 个 /run → 429；
//   两用户各 2 成功、全新用户的全局第 5 个 → 429；上限满时同键重提交仍返回原记录
//   （幂等优先于上限）；GET 轮询不受影响；完成释放后可再提交（重新真实拉起 dsh）。
// - 验收 2（最小特权降权，G-6）：以 --require 预载观测桩模拟 getuid()===0（setgid/setuid
//   只记录不真正改权限）→ 必须先 setgid('node') 后 setuid('node')，且发生在 listen 与任何
//   dsh spawn 之前；非 root 环境（桩记录的真实 uid≠0）不调用、正常启动；setuid 失败 →
//   非零退出、提示含「降权」、listen 未发生。容器内真实 uid 由 §6 冒烟核实（docker top），
//   本地不断言。
// - 验收 3（secret 文件权限）：token/model-key 均 0600 → 启动成功；任一 0644/0666 →
//   主动非零退出、输出含「权限过宽」、不含 secret 内容、无启动横幅。
// - 验收 4（回显检查维持现状）：JSON 转义形态（含引号/反斜杠的密钥经 JSON.stringify 进入
//   dsh 输出）仍被 blocked，且响应不含逐字/转义任一形态；逐字回显（与既有用例同形态）仍
//   blocked；编码变形集不进代码（评审砍项负断言：源码无 base64/btoa/atob/fromCharCode）。
// - 验收 5（回归）：DEEPSEEK_API_KEY 不继承、prompt 契约、LRU、body 上限等既有断言全部
//   不变通过——由既有 test/agent-runner-contract.test.mjs / test/host-runner-agreement.test.mjs
//   随 npm run check 一并实跑覆盖（本文件就是 npm run check 的一部分；node:test 不自递归
//   再跑全套件，故不在本文件内重复断言）；本文件的 0600 用例附带一次端到端 done 运行作为
//   新护栏下的回归冒烟。npm run check 全绿由编排脚本统一实跑判定。
//
// 降权观测桩只补丁进程内可观测面（process.getuid/setgid/setuid、net.Server.prototype.listen），
// dsh 桩把拉起事件写进同一 trace 文件，因此不依赖实现内部钩子即可断言调用顺序。

const RUNNER_FILE=fileURLToPath(new URL('../deploy/agent-runner.mjs',import.meta.url));
const USER_A='u_guardaaaa',USER_B='u_guardbbbb',USER_C='u_guardcccc';
const TOKEN_SECRET='ab'.repeat(32);                 // runner-token 文件内容（64 hex 形态）
const KEY_PLAIN='sk-plain-guard-fixture-key';       // 无 JSON 特殊字符的模型密钥
const KEY_SPECIAL='sk-guard"quote\\backslash';      // 含引号与反斜杠的模型密钥（转义形态≠逐字形态）
// 设计 §3.2-(1) 指定的 429 文案，客户端可见性由 M1 的 runnerCall 429 透传保证。
const CAP_ERROR='模型运行并发已达上限，请稍后再试';

const validLayout={
  version:1,title:'方案',badge:'试运行',summary:'先做起来。',
  modules:[{kind:'summary',id:'plan',title:'方案',content:'每周三次。'}],
  tasks:[{id:'guard-check',when:'今晚',title:'记录一次运动',detail:'记录真实运动。',state:'temporary'}],
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
function plainRequest(port,path,{method='GET',body,headers={}}={}) {
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
    req.end(payload);
  });
}
async function waitReady(port,label) {
  const deadline=Date.now()+15_000;
  while (Date.now()<deadline) {
    try { const response=await plainRequest(port,'/health'); if (response.status===200) return; } catch { /* 还没起来 */ }
    await sleep(120);
  }
  assert.ok(false,`${label} 没有就绪`);
}

// 两个 secret 文件：内容按 runner 既有形态（token 无换行、模型密钥带换行），显式 chmod 免受 umask 影响。
function writeGuardSecrets(dir,tag,{keySecret=KEY_PLAIN}={}) {
  const tokenFile=join(dir,`guard-token-${tag}`);
  const keyFile=join(dir,`guard-key-${tag}`);
  writeFileSync(tokenFile,TOKEN_SECRET,{mode:0o600});
  writeFileSync(keyFile,`${keySecret}\n`,{mode:0o600});
  chmodSync(tokenFile,0o600);
  chmodSync(keyFile,0o600);
  return {tokenFile,keyFile};
}

// sh 版 dsh 桩：进程拉起开销最小，供并发上限这类要在窗口期内多次拉起的用例使用。
// （calls 路径与 stdout 均来自本文件常量，不含单引号；test 1 内有前置断言保证。）
function shellGuardDsh({calls,delay,stdout}) {
  return `#!/bin/sh
printf 1 >> '${calls}'
${delay?`sleep '${delay}'`:''}
printf '%s' '${stdout}'
`;
}
// node 版 dsh 桩：可携带 trace（把拉起事件写进与降权观测桩同一个 trace 文件，形成全序）。
function nodeGuardDsh({calls,traceFile,stdout}) {
  const traceLine=traceFile
    ?`appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({event:'dsh-start'})+'\\n');`:'';
  return `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(calls)},'1');
${traceLine}
process.stdout.write(${JSON.stringify(stdout)});
`;
}

// 降权观测桩（CJS，以 --require 预载进 runner 进程，先于主模块执行）：
// - 总是先记录真实 boot-uid（打补丁前取）；
// - 记录 net.Server.prototype.listen 调用（含端口）；
// - setgid/setuid 改为「先记录、不真正改权限」；root-fail 模式下 setuid 抛错（模拟镜像缺 node 用户）；
//   root-ok 模式下同时把 getuid 补丁成 0（模拟 root）；native 模式不打 getuid 补丁（非 root 环境）。
function guardPreload({mode}) {
  return `'use strict';
const {appendFileSync}=require('node:fs');
const net=require('node:net');
const trace=process.env.RUNNER_GUARD_TRACE||'';
const mode=${JSON.stringify(mode)};
if (trace) {
  const rec=event=>{ try{appendFileSync(trace,JSON.stringify(event)+'\\n');}catch{} };
  rec({event:'boot-uid',uid:process.getuid()});
  const realListen=net.Server.prototype.listen;
  net.Server.prototype.listen=function(...args){
    const first=args[0];
    rec({event:'listen',port:typeof first==='number'?first:(first&&typeof first==='object'?first.port:first)});
    return realListen.apply(this,args);
  };
  if (mode!=='native') process.getuid=()=>0;
  process.setgid=group=>{ rec({event:'setgid',arg:String(group)}); };
  process.setuid=user=>{
    rec({event:'setuid',arg:String(user)});
    if (mode==='root-fail') throw new Error('simulated setuid failure EPERM');
  };
}
`;
}

let stubSeq=0;
async function spawnGuardRunner({dir,dsh,preloadMode=null,keySecret=KEY_PLAIN,extraEnv={}}) {
  stubSeq+=1;
  const tag=String(stubSeq);
  const {tokenFile,keyFile}=writeGuardSecrets(dir,tag,{keySecret});
  const bin=join(dir,`guard-dsh-${tag}`);
  const calls=join(dir,`guard-dsh-calls-${tag}`);
  writeFileSync(calls,'');
  const traceFile=preloadMode?join(dir,`guard-trace-${tag}.ndjson`):null;
  const dshSource=preloadMode
    ?nodeGuardDsh({calls,traceFile,stdout:dsh.stdout})
    :(dsh.delay?shellGuardDsh({calls,delay:dsh.delay,stdout:dsh.stdout})
      :nodeGuardDsh({calls,stdout:dsh.stdout}));
  writeFileSync(bin,dshSource,{mode:0o755});
  const port=await freePort();
  const preloadFile=preloadMode?join(dir,`guard-preload-${tag}.cjs`):null;
  if (preloadFile) writeFileSync(preloadFile,guardPreload({mode:preloadMode}));
  const child=spawn(process.execPath,[...(preloadFile?['--require',preloadFile]:[]),RUNNER_FILE],{
    env:{...process.env,ALONG_RUNNER_PORT:String(port),ALONG_RUNNER_HOST:'127.0.0.1',
      ALONG_RUNNER_TOKEN_FILE:tokenFile,ALONG_MODEL_API_KEY_FILE:keyFile,ALONG_DSH_BIN:bin,
      TMPDIR:realpathSync(dir),...(traceFile?{RUNNER_GUARD_TRACE:traceFile}:{}),...extraEnv},
    stdio:['ignore','pipe','pipe']});
  const output=[];
  child.stdout.on('data',data=>output.push(String(data)));
  child.stderr.on('data',data=>output.push(String(data)));
  await waitReady(port,'guard runner');
  const stop=()=>new Promise(resolve=>{
    child.once('exit',()=>resolve());
    child.kill('SIGINT');
    setTimeout(()=>{try{child.kill('SIGKILL');}catch{}resolve();},3_000).unref();
  });
  return {port,token:TOKEN_SECRET,traceFile,
    callCount:()=>readFileSync(calls,'utf8').length,
    output:()=>output.join(''),stop};
}

function readTrace(traceFile) {
  return readFileSync(traceFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
}

async function postRun(runner,body) {
  return plainRequest(runner.port,'/run',{method:'POST',body,headers:{'runner-token':runner.token}});
}
async function readCompletedRun(runner,userId,requestId) {
  const deadline=Date.now()+12_000;
  while (Date.now()<deadline) {
    const response=await plainRequest(runner.port,`/run/${requestId}`,{
      headers:{'runner-token':runner.token,'x-along-user':userId}});
    assert.equal(response.status,200);
    if (response.json.run.status!=='working') return response;
    await sleep(15);
  }
  assert.fail(`Run ${requestId} did not finish`);
}
async function submitAndRead(runner,body) {
  const submitted=await postRun(runner,body);
  assert.equal(submitted.status,200);
  return submitted.json.run.status==='working'?readCompletedRun(runner,body.userId,body.requestId):submitted;
}
// POST /run 的 200 回执先于 dsh spawn（runner 的既有契约：先受理、后完成——见
// test/agent-runner-contract.test.mjs 的「acknowledges before model completion」）：
// 拉起发生在回执之后的异步准备（mkdtemp/mkdir/writeFile→spawn）里，因此「真实拉起数」
// 必须轮询等待到位后再断言，不能在 POST 返回瞬间读计数。
async function waitCallCount(runner,expected,label) {
  const deadline=Date.now()+8_000;
  while (Date.now()<deadline&&runner.callCount()<expected) await sleep(15);
  assert.equal(runner.callCount(),expected,`${label}（等待真实拉起后计数）`);
}

// ---- 验收 1：并发硬上限（G-1 runner 侧） ---------------------------------------------------------

test('runner-guard：并发上限——同用户第 3 个 429、全局第 5 个 429、同键重提交幂等优先、完成释放后可再提交',async()=>{
  const stdout=JSON.stringify(goalOutput);
  assert.ok(!stdout.includes("'"),'shell 桩以单引号内插 stdout，fixture 不得含单引号');
  const dir=mkdtempSync(join(tmpdir(),'along-guard-cap-'));
  const runner=await spawnGuardRunner({dir,dsh:{delay:'5',stdout}});
  try {
    const body=(userId,requestId)=>({userId,requestId,kind:'goal',input:goalInput});
    // 同用户前 2 个成功并真实拉起。
    const a1=await postRun(runner,body(USER_A,'guard-cap-a1'));
    const a2=await postRun(runner,body(USER_A,'guard-cap-a2'));
    assert.equal(a1.status,200);
    assert.equal(a1.json.run.status,'working');
    assert.equal(a2.status,200);
    assert.equal(a2.json.run.status,'working');
    await waitCallCount(runner,2,'同用户前 2 个 /run 各真实拉起一次');
    // 同用户第 3 个 → 429（全局总量仅 2，命中的必然是每用户上限），且不得拉起 dsh。
    const a3=await postRun(runner,body(USER_A,'guard-cap-a3'));
    assert.equal(a3.status,429);
    assert.equal(a3.json.error,CAP_ERROR);
    assert.equal(runner.callCount(),2,'429 不得拉起 dsh');
    // 第二个用户各 2 个成功。
    const b1=await postRun(runner,body(USER_B,'guard-cap-b1'));
    const b2=await postRun(runner,body(USER_B,'guard-cap-b2'));
    assert.equal(b1.status,200);
    assert.equal(b2.status,200);
    await waitCallCount(runner,4,'两用户各 2 个真实拉起');
    // 全局第 5 个：USER_C 每用户在途为 0，429 只能来自全局上限。
    const fifth=await postRun(runner,body(USER_C,'guard-cap-c1'));
    assert.equal(fifth.status,429);
    assert.equal(fifth.json.error,CAP_ERROR);
    assert.equal(runner.callCount(),4);
    // 上限满时 GET 轮询不受影响。
    const poll=await plainRequest(runner.port,'/run/guard-cap-a1',
      {headers:{'runner-token':runner.token,'x-along-user':USER_A}});
    assert.equal(poll.status,200);
    assert.equal(poll.json.run.requestId,'guard-cap-a1');
    // 上限满时同键重提交：幂等优先于上限，返回原记录（而非 429），也不再次拉起。
    const againA1=await postRun(runner,body(USER_A,'guard-cap-a1'));
    assert.equal(againA1.status,200);
    assert.deepEqual(againA1.json.run,a1.json.run,'同键重提交返回同一条原记录');
    const againB1=await postRun(runner,body(USER_B,'guard-cap-b1'));
    assert.equal(againB1.status,200);
    assert.deepEqual(againB1.json.run,b1.json.run);
    assert.equal(runner.callCount(),4,'幂等重提交不拉起 dsh');
    // 完成释放：四个在途运行全部终态 done。
    for (const [userId,requestId] of [
      [USER_A,'guard-cap-a1'],[USER_A,'guard-cap-a2'],[USER_B,'guard-cap-b1'],[USER_B,'guard-cap-b2'],
    ]) {
      const done=await readCompletedRun(runner,userId,requestId);
      assert.equal(done.json.run.status,'done');
    }
    assert.equal(runner.callCount(),4);
    // 释放后可再提交：新键重新真实拉起并进入 working。
    const a4=await postRun(runner,body(USER_A,'guard-cap-a4'));
    assert.equal(a4.status,200);
    assert.equal(a4.json.run.status,'working');
    await waitCallCount(runner,5,'释放后再提交会重新拉起 dsh');
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

// ---- 验收 2：最小特权降权（G-6） ----------------------------------------------------------------

test('runner-guard：root 模拟降权——先 setgid("node") 后 setuid("node")，先于 listen 与 dsh spawn',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-guard-drop-'));
  const runner=await spawnGuardRunner({dir,preloadMode:'root-ok',
    dsh:{stdout:JSON.stringify(goalOutput)}});
  try {
    const done=await submitAndRead(runner,{userId:USER_A,requestId:'guard-drop-1',kind:'goal',input:goalInput});
    assert.equal(done.status,200);
    assert.equal(done.json.run.status,'done','降权观测桩（setgid/setuid 只记录）下运行照常完成');
    const events=readTrace(runner.traceFile);
    const firstIndex=name=>events.findIndex(event=>event.event===name);
    const setgid=events.find(event=>event.event==='setgid');
    const setuid=events.find(event=>event.event==='setuid');
    const listen=events.find(event=>event.event==='listen');
    assert.ok(setgid&&setuid&&listen,'必须记录到 setgid/setuid/listen 调用');
    assert.equal(setgid.arg,'node');
    assert.equal(setuid.arg,'node');
    assert.equal(events.filter(event=>event.event==='setgid').length,1,'setgid 恰好一次');
    assert.equal(events.filter(event=>event.event==='setuid').length,1,'setuid 恰好一次');
    assert.equal(String(listen.port),String(runner.port),'记录到的 listen 是 runner 自己的端口');
    const dshStarts=events.map((event,index)=>({event,index})).filter(item=>item.event.event==='dsh-start');
    assert.ok(dshStarts.length>=1,'至少一次 dsh 拉起被记录');
    assert.ok(firstIndex('setgid')<firstIndex('setuid'),'必须先 setgid 后 setuid（setuid 后无权限再改组）');
    assert.ok(firstIndex('setuid')<firstIndex('listen'),'降权发生在 listen 之前');
    assert.ok(firstIndex('listen')<dshStarts[0].index,'listen 先于 dsh spawn → 降权先于任何 spawn');
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('runner-guard：非 root 环境（getuid≠0）不调用降权，正常启动并完成运行',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-guard-native-'));
  const runner=await spawnGuardRunner({dir,preloadMode:'native',
    dsh:{stdout:JSON.stringify(goalOutput)}});
  try {
    const done=await submitAndRead(runner,{userId:USER_A,requestId:'guard-native-1',kind:'goal',input:goalInput});
    assert.equal(done.json.run.status,'done','非 root 环境正常启动且运行完成');
    const events=readTrace(runner.traceFile);
    const boot=events.find(event=>event.event==='boot-uid');
    assert.ok(boot,'观测桩必须记录真实启动 uid');
    if (boot.uid!==0) {
      assert.ok(!events.some(event=>event.event==='setgid'||event.event==='setuid'),
        `真实 uid=${boot.uid}（非 root）时不得调用 setgid/setuid`);
    }
    assert.ok(events.some(event=>event.event==='listen'),'runner 正常 listen');
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('runner-guard：setuid 失败 → 非零退出、提示含「降权」、listen 未发生',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-guard-setuid-fail-'));
  try {
    const {tokenFile,keyFile}=writeGuardSecrets(dir,'fail');
    const traceFile=join(dir,'guard-trace-fail.ndjson');
    const preloadFile=join(dir,'guard-preload-fail.cjs');
    writeFileSync(preloadFile,guardPreload({mode:'root-fail'}));
    const port=await freePort();
    const child=spawnSync(process.execPath,['--require',preloadFile,RUNNER_FILE],{encoding:'utf8',
      timeout:8_000,env:{...process.env,ALONG_RUNNER_PORT:String(port),ALONG_RUNNER_HOST:'127.0.0.1',
        ALONG_RUNNER_TOKEN_FILE:tokenFile,ALONG_MODEL_API_KEY_FILE:keyFile,
        TMPDIR:realpathSync(dir),RUNNER_GUARD_TRACE:traceFile}});
    assert.ok(Number.isInteger(child.status)&&child.status!==0,
      `必须主动以非零退出码拒绝启动（status=${child.status}，null 表示挂着不退）`);
    const output=`${child.stdout||''}${child.stderr||''}`;
    assert.match(output,/降权/,'失败提示必须含「降权」');
    assert.ok(!output.includes(TOKEN_SECRET)&&!output.includes(KEY_PLAIN),'失败输出不得含 secret 内容');
    const events=readTrace(traceFile);
    assert.ok(events.some(event=>event.event==='setgid'),'降权序列先执行 setgid');
    assert.ok(events.some(event=>event.event==='setuid'),'setuid 被调用后抛错');
    assert.ok(!events.some(event=>event.event==='listen'),'降权失败必须发生在 listen 之前（不得带端口上线）');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

// ---- 验收 3：secret 文件权限（G-6 配套） --------------------------------------------------------

test('runner-guard：secret 0600 → 启动成功并完成一次端到端运行（新护栏下的回归冒烟）',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-guard-mode-ok-'));
  const runner=await spawnGuardRunner({dir,dsh:{stdout:JSON.stringify(goalOutput)}});
  try {
    assert.ok(runner.output().includes('Along agent runner:'),'0600 时启动横幅出现');
    const done=await submitAndRead(runner,{userId:USER_A,requestId:'guard-mode-ok-1',kind:'goal',input:goalInput});
    assert.equal(done.json.run.status,'done');
    assert.ok(!runner.output().includes(TOKEN_SECRET)&&!runner.output().includes(KEY_PLAIN),
      'runner 日志不得出现 secret 内容');
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('runner-guard：secret 0644/0666 → 非零退出、输出含「权限过宽」且不含 secret 内容',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'along-guard-mode-bad-'));
  try {
    for (const target of ['token','key']) {
      for (const mode of [0o644,0o666]) {
        const label=`${target} 权限 ${mode.toString(8)}`;
        const {tokenFile,keyFile}=writeGuardSecrets(dir,`${target}-${mode.toString(8)}`);
        chmodSync(target==='token'?tokenFile:keyFile,mode);
        const child=spawnSync(process.execPath,[RUNNER_FILE],{encoding:'utf8',timeout:8_000,env:{
          ...process.env,ALONG_RUNNER_HOST:'127.0.0.1',ALONG_RUNNER_PORT:String(await freePort()),
          ALONG_RUNNER_TOKEN_FILE:tokenFile,ALONG_MODEL_API_KEY_FILE:keyFile,TMPDIR:realpathSync(dir)}});
        assert.ok(Number.isInteger(child.status)&&child.status!==0,
          `${label}：必须主动非零退出（status=${child.status}，null 表示挂着不退）`);
        const output=`${child.stdout||''}${child.stderr||''}`;
        assert.match(output,/权限过宽/,`${label}：失败提示必须含「权限过宽」`);
        assert.ok(!output.includes(TOKEN_SECRET),`${label}：失败输出不得含 runner-token 内容`);
        assert.ok(!output.includes(KEY_PLAIN),`${label}：失败输出不得含模型密钥内容`);
        assert.ok(!output.includes('Along agent runner:'),`${label}：拒绝启动时不得出现启动横幅`);
      }
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

// ---- 验收 4：回显检查维持现状（逐字 + JSON 转义仍 blocked；变形集不进代码） ----------------------

test('runner-guard：JSON 转义形态的模型密钥回显仍被 blocked，响应两种形态都不含',async()=>{
  const escaped=JSON.stringify(KEY_SPECIAL).slice(1,-1);
  const stdout=JSON.stringify({...goalOutput,reply:`答案 ${KEY_SPECIAL} 结束`});
  assert.ok(stdout.includes(escaped),'前置：dsh 原始输出里确实是 JSON 转义形态');
  assert.ok(!stdout.includes(KEY_SPECIAL),'前置：dsh 原始输出里没有逐字形态');
  const dir=mkdtempSync(join(tmpdir(),'along-guard-echo-esc-'));
  const runner=await spawnGuardRunner({dir,dsh:{stdout},keySecret:KEY_SPECIAL});
  try {
    const done=await submitAndRead(runner,{userId:USER_A,requestId:'guard-echo-esc-1',kind:'goal',input:goalInput});
    assert.equal(done.status,200);
    assert.equal(done.json.run.status,'blocked','JSON 转义形态的密钥回显必须被拦');
    assert.equal(done.json.run.result,null);
    assert.ok(!done.text.includes(KEY_SPECIAL),'响应不得含逐字密钥');
    assert.ok(!done.text.includes(escaped),'响应不得含转义形态密钥');
    assert.ok(!runner.output().includes(KEY_SPECIAL)&&!runner.output().includes(escaped),
      'runner 日志不得含两种形态的密钥');
    assert.equal(runner.callCount(),1);
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('runner-guard：逐字回显维持 blocked（与既有用例同形态）',async()=>{
  const stdout=JSON.stringify({...goalOutput,reply:`key: ${KEY_PLAIN}`});
  assert.ok(stdout.includes(KEY_PLAIN),'前置：无特殊字符密钥逐字出现在 dsh 原始输出');
  const dir=mkdtempSync(join(tmpdir(),'along-guard-echo-plain-'));
  const runner=await spawnGuardRunner({dir,dsh:{stdout},keySecret:KEY_PLAIN});
  try {
    const done=await submitAndRead(runner,{userId:USER_A,requestId:'guard-echo-plain-1',kind:'goal',input:goalInput});
    assert.equal(done.json.run.status,'blocked','逐字回显必须被拦');
    assert.equal(done.json.run.result,null);
    assert.ok(!done.text.includes(KEY_PLAIN),'响应不得含密钥');
  } finally { await runner.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('runner-guard：编码变形集不进代码（评审砍项负断言）',()=>{
  const src=readFileSync(RUNNER_FILE,'utf8');
  for (const marker of [/base64/i,/\bbtoa\b/,/\batob\b/,/fromCharCode/i]) {
    assert.doesNotMatch(src,marker,`runner 不得出现编码变形集（${marker}）：评审砍项，变形集不进代码`);
  }
});
