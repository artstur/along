import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {request as tlsRequest} from 'node:https';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadUsers,loadPairings,findPairing,issuePairingCode,consumeUserCode,recordPairingFailure,clearPairingFailures,failLimitFromEnv,CODE_TTL_MS} from '../host/pairing.mjs';

// 多用户配对（docs/cloud-deploy-multi-user.md §4 M1，验收 #1）：
// - pairings.json 多绑定表 + 旧单对象 pairing.json 幂等升级；users.json 静态用户表；
//   host/pair-code.mjs CLI 每用户一次性码（CLI 进程 ↔ server 文件交接）；
// - authorized() 按表鉴权：两个 token 同时有效，A 再配对只覆盖 A；
// - 防枚举（SD-7）：未命中计入全局失败滑动窗口（默认 15 分钟 10 次，ALONG_PAIR_FAIL_LIMIT 只许调严），
//   公网窗口满时拒绝所有码；配对成功或管理员发码时清空窗口。

const USER_A='u_aaaa1111',DEVICE_A='d_aaaa1111';
const USER_B='u_bbbb2222',DEVICE_B='d_bbbb2222';
const HOST_FILE=fileURLToPath(new URL('../host/agent-host.mjs',import.meta.url));
const PAIR_CODE_FILE=fileURLToPath(new URL('../host/pair-code.mjs',import.meta.url));
const sha256hex=value=>createHash('sha256').update(value).digest('hex');

function tempDir(prefix) {
  const dir=mkdtempSync(join(tmpdir(),prefix));
  const cleanup=()=>rmSync(dir,{recursive:true,force:true});
  return {dir,cleanup};
}
function writeUsers(dir,users) {
  writeFileSync(join(dir,'users.json'),JSON.stringify(users),{mode:0o600});
}
const readCodes=dir=>JSON.parse(readFileSync(join(dir,'pairing-codes.json'),'utf8'));

// ---- host/pairing.mjs 单元切片 ----

test('loadUsers：缺失返回 null（本地形态），格式无效抛错不静默降级',()=>{
  const {dir,cleanup}=tempDir('along-users-');
  try {
    assert.equal(loadUsers(dir),null,'users.json 不存在 → 本地单用户形态');
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B}]);
    assert.deepEqual(loadUsers(dir),[USER_A,USER_B]);
    for (const bad of [[],'x',[{userId:'nope'}],[{userId:USER_A},{userId:USER_A}],[{}],['not json']]) {
      writeFileSync(join(dir,'users.json'),typeof bad==='string'?bad:JSON.stringify(bad),{mode:0o600});
      assert.throws(()=>loadUsers(dir),'格式无效必须抛错，不能降级成单用户模式往日志打通用码');
    }
  } finally {cleanup();}
});

test('loadPairings：旧 pairing.json（仅 hash）幂等升级为一元数组并补齐身份，配对 token 不变',()=>{
  const {dir,cleanup}=tempDir('along-pairings-');
  try {
    writeFileSync(join(dir,'pairing.json'),JSON.stringify({hash:'ab'.repeat(32)}),{mode:0o600});
    const first=loadPairings(dir);
    assert.deepEqual(first.map(entry=>entry.hash),['ab'.repeat(32)],'配对 token 不变、手机无感');
    assert.match(first[0].user_id,/^u_[0-9a-f]{8}$/);
    assert.match(first[0].device_id,/^d_[0-9a-f]{8}$/);
    assert.equal(existsSync(join(dir,'pairing.json')),false,'升级后移除旧单对象文件');
    assert.deepEqual(loadPairings(dir),first,'幂等：第二次启动不换号');
  } finally {cleanup();}
});

test('loadPairings：带齐身份的旧文件原样保留；缺 hash 的旧文件没有绑定身份；坏条目丢弃',()=>{
  const {dir,cleanup}=tempDir('along-pairings-');
  try {
    const complete={hash:'cd'.repeat(32),user_id:USER_A,device_id:DEVICE_A};
    writeFileSync(join(dir,'pairing.json'),JSON.stringify(complete),{mode:0o600});
    assert.deepEqual(loadPairings(dir),[complete]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8')),[complete],'升级结果落盘为 pairings.json');
    assert.deepEqual(loadPairings(dir),[complete],'已升级过的文件不再重写');
    writeFileSync(join(dir,'pairings.json'),JSON.stringify({}),{mode:0o600});
    assert.deepEqual(loadPairings(dir),[],'没有有效配对就没有绑定身份，等下一次 /pair 生成');
    writeFileSync(join(dir,'pairings.json'),JSON.stringify([
      {hash:'zz'},{hash:'ef'.repeat(32),user_id:USER_B,device_id:DEVICE_B},complete]),{mode:0o600});
    assert.deepEqual(loadPairings(dir),[{hash:'ef'.repeat(32),user_id:USER_B,device_id:DEVICE_B},complete],'坏 hash 条目丢弃、有效条目保留');
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8')),
      [{hash:'ef'.repeat(32),user_id:USER_B,device_id:DEVICE_B},complete],'清理结果落盘，重复启动结果一致');
  } finally {cleanup();}
});

test('findPairing：按绑定表 SHA-256 查找，命中返回该请求自己的绑定，未命中 null',()=>{
  const token='e'.repeat(64);
  const entries=[{hash:sha256hex(token),user_id:USER_A,device_id:DEVICE_A},
    {hash:sha256hex('f'.repeat(64)),user_id:USER_B,device_id:DEVICE_B}];
  assert.deepEqual(findPairing(entries,token),entries[0]);
  assert.deepEqual(findPairing(entries,'f'.repeat(64)),entries[1]);
  assert.equal(findPairing(entries,'9'.repeat(64)),null);
});

test('issuePairingCode：需要 users.json 且用户在表内；码 8 位、15 分钟有效、文件 0600、防撞码',()=>{
  const {dir,cleanup}=tempDir('along-issue-');
  try {
    assert.throws(()=>issuePairingCode(dir,USER_A),/users\.json 不存在/);
    writeUsers(dir,[{userId:USER_A},{userId:USER_B}]);
    assert.throws(()=>issuePairingCode(dir,'u_nope0000'),/没有用户/,'非 users.json 用户不发码');
    const t0=1_000_000_000_000;
    const code=issuePairingCode(dir,USER_A,t0);
    assert.match(code,/^\d{8}$/);
    assert.deepEqual(readCodes(dir),{failures:[],codes:[[code,USER_A,t0+CODE_TTL_MS]]});
    assert.equal(statSync(join(dir,'pairing-codes.json')).mode&0o777,0o600,'码文件 0600');
    const second=issuePairingCode(dir,USER_B,t0+1);
    assert.notEqual(second,code);
    assert.equal(readCodes(dir).codes.length,2,'不同用户各持一码');
    // 过期码在发码时顺带清理
    writeFileSync(join(dir,'pairing-codes.json'),JSON.stringify(
      {failures:[],codes:[...readCodes(dir).codes,['11111111',USER_B,t0-1]]}),{mode:0o600});
    issuePairingCode(dir,USER_A,t0+2);
    const codes=readCodes(dir).codes;
    assert.equal(codes.some(item=>item[0]==='11111111'),false,'过期码已清理');
    assert.equal(codes.length,3,'未过期码全部保留');
  } finally {cleanup();}
});

test('consumeUserCode：公网失败窗口满时拒绝有效码，保留原码和失败次数',()=>{
  const {dir,cleanup}=tempDir('along-consume-');
  try {
    writeUsers(dir,[{userId:USER_A}]);
    const t0=1_000_000_000_000;
    const code=issuePairingCode(dir,USER_A,t0);
    const limit=2;
    assert.deepEqual(consumeUserCode(dir,'00000000',t0+1,limit,[USER_A]),{ok:false});
    assert.deepEqual(consumeUserCode(dir,'00000000',t0+2,limit,[USER_A]),{ok:false});
    const full=readCodes(dir);
    assert.equal(full.failures.length,limit);
    assert.deepEqual(consumeUserCode(dir,code,t0+3,limit,[USER_A]),{ok:false});
    assert.deepEqual(readCodes(dir),full,'窗口满时保留原码和失败次数');
    assert.deepEqual(consumeUserCode(dir,'00000000',t0+4,limit,[USER_A]),{ok:false});
    assert.deepEqual(readCodes(dir),full,'窗口满时也不追加失败时间');
  } finally {cleanup();}
});

test('issuePairingCode：管理员重开窗口、保留未过期码，两用户各自配对且码单次有效',()=>{
  const {dir,cleanup}=tempDir('along-reopen-');
  try {
    const users=[USER_A,USER_B];
    writeUsers(dir,users.map(userId=>({userId})));
    const t0=1_000_000_000_000,limit=2;
    const codeA=issuePairingCode(dir,USER_A,t0);
    assert.deepEqual(consumeUserCode(dir,'00000000',t0+1,limit,users),{ok:false});
    assert.deepEqual(consumeUserCode(dir,'00000000',t0+2,limit,users),{ok:false});

    const codeB=issuePairingCode(dir,USER_B,t0+3);
    assert.deepEqual(readCodes(dir),{failures:[],codes:[[codeA,USER_A,t0+CODE_TTL_MS],[codeB,USER_B,t0+3+CODE_TTL_MS]]});
    assert.deepEqual(consumeUserCode(dir,'00000000',t0+4,limit,users),{ok:false});
    assert.equal(readCodes(dir).failures.length,1);
    assert.deepEqual(consumeUserCode(dir,codeA,t0+5,limit,users),{ok:true,userId:USER_A});
    assert.deepEqual(readCodes(dir),{failures:[],codes:[[codeB,USER_B,t0+3+CODE_TTL_MS]]});
    assert.deepEqual(consumeUserCode(dir,codeB,t0+6,limit,users),{ok:true,userId:USER_B});
    assert.deepEqual(readCodes(dir).codes,[]);
    assert.deepEqual(consumeUserCode(dir,codeA,t0+7,limit,users),{ok:false},'同一码第二次无效');
  } finally {cleanup();}
});

test('consumeUserCode：满窗自然恢复时，过期配对码仍然无效',()=>{
  const {dir,cleanup}=tempDir('along-expired-code-');
  try {
    const users=[USER_A];
    writeUsers(dir,[{userId:USER_A}]);
    const t0=1_000_000_000_000,limit=1,expires=t0+CODE_TTL_MS;
    const code=issuePairingCode(dir,USER_A,t0);
    assert.deepEqual(consumeUserCode(dir,'00000000',t0,limit,users),{ok:false});
    assert.deepEqual(consumeUserCode(dir,code,expires-1,limit,users),{ok:false},'窗口尚未恢复时拒绝尚未过期的码');
    assert.deepEqual(consumeUserCode(dir,code,expires,limit,users),{ok:false},'原失败恰满 15 分钟，过期码仍按未命中处理');
    assert.deepEqual(readCodes(dir),{failures:[new Date(expires).toISOString()],codes:[]});
  } finally {cleanup();}
});

test('consumeUserCode：码有效但用户已不在 users.json → 403 语义、不消费、不计失败',()=>{
  const {dir,cleanup}=tempDir('along-consume-user-');
  try {
    writeUsers(dir,[{userId:USER_A}]);
    const t0=1_000_000_000_000;
    const code=issuePairingCode(dir,USER_A,t0);
    assert.deepEqual(consumeUserCode(dir,code,t0+1,10,[USER_B]),{ok:false});
    const state=readCodes(dir);
    assert.deepEqual(state.codes,[[code,USER_A,t0+CODE_TTL_MS]],'码未被消费，改表后同一码仍可用');
    assert.deepEqual(state.failures,[],'有效码不计入失败窗口');
    writeUsers(dir,[{userId:USER_A},{userId:USER_B}]);
    assert.deepEqual(consumeUserCode(dir,code,t0+2,10,[USER_A,USER_B]),{ok:true,userId:USER_A},'用户恢复后原码仍可配对');
  } finally {cleanup();}
});

test('失败窗口滑动：恰好 15 分钟前的失败不再计入（窗口与码 TTL 同步）',()=>{
  const {dir,cleanup}=tempDir('along-window-');
  try {
    const t0=1_000_000_000_000,windowMs=15*60_000;
    recordPairingFailure(dir,t0,10);
    recordPairingFailure(dir,t0+1,10);
    assert.equal(readCodes(dir).failures.length,2);
    assert.deepEqual(recordPairingFailure(dir,t0+windowMs,10),{ok:false});
    assert.deepEqual(readCodes(dir).failures,
      [new Date(t0+1).toISOString(),new Date(t0+windowMs).toISOString()],
      'now=t0+窗口：恰好 15 分钟前（t0）的失败已滑出，窗口内的保留并追加新失败');
    assert.deepEqual(recordPairingFailure(dir,t0+1+windowMs,10),{ok:false});
    assert.deepEqual(readCodes(dir).failures,
      [new Date(t0+windowMs).toISOString(),new Date(t0+1+windowMs).toISOString()],
      'now=t0+1+窗口：t0+1 的失败随之滑出，15 分钟前的失败一律不再计入');
  } finally {cleanup();}
});

test('clearPairingFailures：本地通用码成功后清空失败窗口，保留未过期的每用户码',()=>{
  const {dir,cleanup}=tempDir('along-clear-');
  try {
    writeUsers(dir,[{userId:USER_A}]);
    const t0=1_000_000_000_000;
    const code=issuePairingCode(dir,USER_A,t0+1);
    recordPairingFailure(dir,t0+1,10);
    writeFileSync(join(dir,'pairing-codes.json'),JSON.stringify(
      {failures:readCodes(dir).failures,codes:[...readCodes(dir).codes,['99999999',USER_A,t0-1]]}),{mode:0o600});
    assert.deepEqual(clearPairingFailures(dir,t0+2),{ok:true});
    const after=readCodes(dir);
    assert.deepEqual(after.failures,[],'失败窗口清空');
    assert.deepEqual(after.codes,[[code,USER_A,t0+1+CODE_TTL_MS]],'未过期码保留、过期码清掉');
    assert.deepEqual(clearPairingFailures(dir,t0+3),{ok:true},'幂等');
  } finally {cleanup();}
});

test('failLimitFromEnv：默认 10，ALONG_PAIR_FAIL_LIMIT 只许调严',()=>{
  assert.equal(failLimitFromEnv({}),10);
  assert.equal(failLimitFromEnv({ALONG_PAIR_FAIL_LIMIT:'3'}),3);
  assert.equal(failLimitFromEnv({ALONG_PAIR_FAIL_LIMIT:'50'}),10,'放宽的值一律按默认');
  assert.equal(failLimitFromEnv({ALONG_PAIR_FAIL_LIMIT:'abc'}),10);
  assert.equal(failLimitFromEnv({ALONG_PAIR_FAIL_LIMIT:'0'}),10);
  assert.equal(failLimitFromEnv({ALONG_PAIR_FAIL_LIMIT:'-1'}),10);
});

// ---- 真实进程：HTTPS 全链路（CLI 发码 → /pair → authorized 门） ----

function freePort() {
  return new Promise(resolve=>{
    const server=net.createServer();
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port; server.close(()=>resolve(port));});
  });
}

function phoneCall(port,path,{method='GET',body,headers={}}={}) {
  const attempt=()=>new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const req=tlsRequest({host:'127.0.0.1',port,path,method,rejectUnauthorized:false,agent:false,
      headers:{...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...headers}},
    res=>{
      let text=''; res.on('data',chunk=>text+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,text,json:text?JSON.parse(text):null}));
    });
    req.setTimeout(10_000,()=>{ req.destroy(new Error(`phoneCall 超时（10s）：${method} ${path} @${port}`)); });
    req.on('error',reject);
    if (payload) req.write(payload);
    req.end();
  });
  return attempt().catch(error=>{
    if (['ECONNRESET','ECONNREFUSED','EPIPE'].includes(error.code)) return attempt();
    throw error;
  });
}

async function spawnHost(t,{dir}) {
  const port=await freePort();
  const child=spawn(process.execPath,[HOST_FILE],{env:{
    ...process.env,
    ALONG_AGENT_STATE_DIR:dir,
    ALONG_AGENT_HOST:'127.0.0.1',
    ALONG_AGENT_PORT:String(port),
    ALONG_PAIR_FAIL_LIMIT:'10',
  },stdio:['ignore','pipe','pipe']});
  const output=[];
  child.stdout.on('data',data=>output.push(String(data)));
  child.stderr.on('data',data=>output.push(String(data)));
  const deadline=Date.now()+20_000;
  let ready=false;
  while (Date.now()<deadline) {
    try { const health=await phoneCall(port,'/health'); if (health.status===200) {ready=true; break;} } catch { /* 还没起来 */ }
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  const text=()=>output.join('');
  if (!ready && child.exitCode===null && !child.killed) child.kill('SIGKILL');
  assert.match(text(),/Along 服务: https:\/\/127\.0\.0\.1/,`Host 进程要起来：${text().slice(0,400)}`);
  let stopped=false;
  t.after(()=>new Promise(resolve=>{
    if (stopped||child.exitCode!==null||child.signalCode!==null) {stopped=true; return resolve();}
    stopped=true;
    child.once('exit',()=>resolve());
    child.kill('SIGINT');
    setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},3_000).unref?.();
  }));
  return {port,text,pairingCode:()=>/一次性配对码: (\d+)/.exec(text())?.[1]??null};
}

function issueCodeViaCli(dir,userId) {
  return spawnSync(process.execPath,[PAIR_CODE_FILE,userId],
    {env:{...process.env,ALONG_AGENT_STATE_DIR:dir},encoding:'utf8'});
}

async function waitFor(predicate,label,timeout=6_000) {
  const deadline=Date.now()+timeout;
  while (Date.now()<deadline) {
    if (predicate()) return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(false,`等待超时：${label}`);
}

const unknownCode=seed=>String(seed).padStart(8,'0');   // 发码不会生成前导零

test('多用户配对：CLI 发码 → 各自 /pair → 两 token 同时有效；A 再配对只覆盖 A；防枚举限速',async t=>{
  const {dir,cleanup}=tempDir('along-multi-user-');
  try {
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B,label:'B'}]);
    const host=await spawnHost(t,{dir});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const pairingsFile=()=>existsSync(join(dir,'pairings.json'))?JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8')):null;

    // 多用户形态：启动不生成、不打印通用配对码（码不落容器日志，§3.7）。
    assert.equal(host.pairingCode(),null,'users.json 存在时没有通用码');
    assert.doesNotMatch(host.text(),/一次性配对码/);

    // CLI 生成 A/B 两码（真实子进程，文件交接）。
    const issuedA=issueCodeViaCli(dir,USER_A),issuedB=issueCodeViaCli(dir,USER_B);
    assert.equal(issuedA.status,0,`CLI 发码 A：${issuedA.stderr}`);
    assert.equal(issuedB.status,0,`CLI 发码 B：${issuedB.stderr}`);
    const codeA=issuedA.stdout.trim(),codeB=issuedB.stdout.trim();
    assert.match(codeA,/^\d{8}$/); assert.match(codeB,/^\d{8}$/);
    assert.notEqual(codeA,codeB);
    assert.deepEqual(readCodes(dir).codes.map(item=>item[1]).sort(),[USER_A,USER_B],'码与 userId 绑定写进码文件');

    // 两次 /pair 各自换得 token；两个 token 同时通过 authorized()。
    const pairA=await phoneCall(host.port,'/pair',{method:'POST',body:{code:codeA}});
    const pairB=await phoneCall(host.port,'/pair',{method:'POST',body:{code:codeB}});
    assert.equal(pairA.status,200); assert.equal(pairB.status,200);
    assert.match(pairA.json.token,/^[a-f0-9]{64}$/); assert.match(pairB.json.token,/^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(pairA.json),['token'],'/pair 响应只有配对 token');
    const tokenA1=pairA.json.token,tokenB1=pairB.json.token;
    const verify=token=>phoneCall(host.port,'/connection/verify',{method:'POST',headers:{authorization:`Bearer ${token}`}});
    assert.deepEqual((await verify(tokenA1)).json,{paired:true});
    assert.deepEqual((await verify(tokenB1)).json,{paired:true});
    const table=pairingsFile();
    assert.equal(table.length,2,'pairings.json 每用户一条');
    assert.deepEqual(table.find(item=>item.user_id===USER_A),{hash:sha256hex(tokenA1),user_id:USER_A,device_id:table.find(item=>item.user_id===USER_A).device_id});
    assert.deepEqual(table.find(item=>item.user_id===USER_B),{hash:sha256hex(tokenB1),user_id:USER_B,device_id:table.find(item=>item.user_id===USER_B).device_id});
    assert.match(table.find(item=>item.user_id===USER_A).device_id,/^d_[0-9a-f]{8}$/);

    // 错误码 → 403，文案不变，计入失败窗口。
    const wrong=await phoneCall(host.port,'/pair',{method:'POST',body:{code:'00000000'}});
    assert.equal(wrong.status,403);
    assert.deepEqual(wrong.json,{error:'配对码无效或已过期'});
    assert.equal(readCodes(dir).failures.length,1);

    // 过期码 → 403（直接向码文件注入一条已过期的码）。
    writeFileSync(join(dir,'pairing-codes.json'),JSON.stringify(
      {failures:readCodes(dir).failures,codes:[...readCodes(dir).codes,['11111111',USER_B,Date.now()-1000]]}),{mode:0o600});
    const expired=await phoneCall(host.port,'/pair',{method:'POST',body:{code:'11111111'}});
    assert.equal(expired.status,403);
    assert.equal(readCodes(dir).failures.length,2,'过期码按未命中计入失败窗口');

    // 非 users.json 用户：发码后把该用户移出用户表 → 403，码不消费、不计失败；
    // 恢复用户表后同一码仍可配对（users.json 每次 /pair 重读，增删用户即刻生效）。
    const codeA2=issueCodeViaCli(dir,USER_A).stdout.trim();
    assert.equal((await phoneCall(host.port,'/pair',{method:'POST',body:{code:unknownCode(1)}})).status,403);
    writeUsers(dir,[{userId:USER_B}]);
    const stranger=await phoneCall(host.port,'/pair',{method:'POST',body:{code:codeA2}});
    assert.equal(stranger.status,403,'非 users.json 用户 → 403');
    assert.equal(readCodes(dir).codes.some(item=>item[0]===codeA2),true,'码未被消费');
    assert.equal(readCodes(dir).failures.length,1,'有效码不计入失败窗口');
    writeUsers(dir,[{userId:USER_A},{userId:USER_B}]);

    // A 再配对：只覆盖 A 的绑定，B 不受影响。
    const repair=await phoneCall(host.port,'/pair',{method:'POST',body:{code:codeA2}});
    assert.equal(repair.status,200);
    const tokenA2=repair.json.token;
    assert.equal(readCodes(dir).failures.length,0,'配对成功即清空 failures');
    const rebound=pairingsFile();
    assert.equal(rebound.length,2);
    assert.deepEqual(rebound.find(item=>item.user_id===USER_A),
      {hash:sha256hex(tokenA2),user_id:USER_A,device_id:rebound.find(item=>item.user_id===USER_A).device_id},
      'A 换新 token、user_id 不变、device_id 换新');
    assert.deepEqual(rebound.find(item=>item.user_id===USER_B),
      {hash:sha256hex(tokenB1),user_id:USER_B,device_id:rebound.find(item=>item.user_id===USER_B).device_id},'B 的绑定不受影响');
    assert.deepEqual((await verify(tokenA2)).json,{paired:true});
    assert.equal((await verify(tokenA1)).status,401,'A 的旧 token 立即失效');
    assert.deepEqual((await verify(tokenB1)).json,{paired:true},'B 的 token 仍有效');

    // 防枚举：窗口满后拒绝尚未过期的有效码，管理员发码后两枚码各自可以配对。
    const codeB2=issueCodeViaCli(dir,USER_B).stdout.trim();
    for (let seed=1;seed<=11;seed++) {
      const miss=await phoneCall(host.port,'/pair',{method:'POST',body:{code:unknownCode(seed)}});
      assert.equal(miss.status,403,`未知码 #${seed} 403`);
    }
    assert.equal(readCodes(dir).failures.length,10,'窗口封顶在限额（11 次未命中只记 10 条）');
    assert.equal((await phoneCall(host.port,'/pair',{method:'POST',body:{code:unknownCode(12)}})).status,403,
      '限速后未命中提交一律 403，文案不变');
    assert.equal(readCodes(dir).failures.length,10,'被限速的提交不再追加');
    const blocked=await phoneCall(host.port,'/pair',{method:'POST',body:{code:codeB2}});
    assert.equal(blocked.status,403);
    assert.deepEqual(blocked.json,wrong.json,'窗口满与普通错误使用相同响应');
    assert.equal(readCodes(dir).codes.some(item=>item[0]===codeB2),true,'限流未消费有效码');
    assert.equal(readCodes(dir).failures.length,10);
    assert.equal(pairingsFile().find(item=>item.user_id===USER_B).hash,sha256hex(tokenB1),'限流未改变 B 的绑定');
    const codeA3=issueCodeViaCli(dir,USER_A).stdout.trim();
    assert.equal(readCodes(dir).failures.length,0,'管理员发码重开窗口');
    const rescued=await phoneCall(host.port,'/pair',{method:'POST',body:{code:codeB2}});
    assert.equal(rescued.status,200,'窗口重开后可使用未过期的码');
    assert.deepEqual(readCodes(dir).failures,[],'成功后 failures 清空');
    assert.deepEqual((await verify(rescued.json.token)).json,{paired:true});
    const pairedAgain=await phoneCall(host.port,'/pair',{method:'POST',body:{code:codeA3}});
    assert.equal(pairedAgain.status,200);
    assert.equal(pairingsFile().find(item=>item.user_id===USER_A).hash,sha256hex(pairedAgain.json.token));
    assert.equal(pairingsFile().find(item=>item.user_id===USER_B).hash,sha256hex(rescued.json.token));
    assert.equal((await phoneCall(host.port,'/pair',{method:'POST',body:{code:unknownCode(13)}})).status,403);
    assert.equal(readCodes(dir).failures.length,1,'窗口清空后重新计数');
  } finally {cleanup();}
});

test('本地形态（无 users.json）：启动打印通用码、配对即建号、失败计数有界',async t=>{
  const {dir,cleanup}=tempDir('along-local-pair-');
  try {
    const host=await spawnHost(t,{dir});
    await waitFor(()=>host.pairingCode(),'启动横幅出现通用码');
    const universal=host.pairingCode();
    assert.match(universal,/^\d{8}$/);
    const pairingsFile=()=>existsSync(join(dir,'pairings.json'))?JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8')):null;
    assert.equal(pairingsFile(),null);

    // 窗口内连续 11 次错误码：全部 403，失败窗口封顶（现状 5 次永久锁死被滑动窗口替代）。
    for (let seed=1;seed<=11;seed++) {
      const wrong=await phoneCall(host.port,'/pair',{method:'POST',body:{code:unknownCode(seed*7)}});
      assert.equal(wrong.status,403,`错误码 #${seed} 403`);
    }
    assert.equal(readCodes(dir).failures.length,10,'失败窗口统一写在 pairing-codes.json 并封顶');
    assert.deepEqual(pairingsFile(),null,'配对码错误不产生绑定');

    // 正确的通用码不受限速影响，仍然配对成功（现状下 5 次失败会锁死到重启）。
    const paired=await phoneCall(host.port,'/pair',{method:'POST',body:{code:universal}});
    assert.equal(paired.status,200);
    assert.match(paired.json.token,/^[a-f0-9]{64}$/);
    const table=pairingsFile();
    assert.equal(table.length,1,'本地形态整表一条绑定');
    assert.match(table[0].user_id,/^u_[0-9a-f]{8}$/,'配对即建号');
    assert.match(table[0].device_id,/^d_[0-9a-f]{8}$/);
    assert.equal(table[0].hash,sha256hex(paired.json.token));
    assert.deepEqual(readCodes(dir).failures,[],'成功后失败窗口清空');
    assert.deepEqual((await phoneCall(host.port,'/connection/verify',
      {method:'POST',headers:{authorization:`Bearer ${paired.json.token}`}})).json,{paired:true},'新配对 token 立即可用');
  } finally {cleanup();}
});
