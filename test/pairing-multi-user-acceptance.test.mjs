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
import {CODE_TTL_MS} from '../host/pairing.mjs';

// M1「配对多绑定与用户表」独立验收（docs/cloud-deploy-multi-user.md §5 验收 #1、§3.2、§4 M1）。
// 与 test/host-multi-user-pairing.test.mjs（实现者测试）互补，不重复其单元切片；这里从文档验收标准
// 独立推导，覆盖其未覆盖的面：
// - host/pair-code.mjs CLI 的失败路径（缺表/缺用户/缺参数 → exit 1）与「明文码只进 stdout」；
// - ALONG_PAIR_FAIL_LIMIT 在真实进程里生效（单元函数测过，服务端链路没测过）；
// - users.json 格式无效 → host 拒绝启动（fail-closed，不静默降级成单用户模式往日志打通用码，§3.2/§3.7）；
// - pairings.json / pairing-codes.json 落盘 0600（§3.3）；
// - authorized() 未命中 401 文案不变（§3.2）；403 不回显提交值、host 日志不出现提交值（SD-7）；
// - users.json 运行期「新增用户即刻生效」（§3.2 实现回写只测了移除方向）；
// - 多绑定重启后保持（pairings.json 是持久事实，重启不丢 B）。
// 未命中码一律用 0 开头的 8 位串：randomInt(10000000,99999999) 生成不了它们，保证与真实码零碰撞。

const USER_A='u_aaaa1111';
const USER_B='u_bbbb2222';
const HOST_FILE=fileURLToPath(new URL('../host/agent-host.mjs',import.meta.url));
const PAIR_CODE_FILE=fileURLToPath(new URL('../host/pair-code.mjs',import.meta.url));
const sha256hex=value=>createHash('sha256').update(value).digest('hex');
const dead=seed=>String(seed).padStart(8,'0');   // 保证未命中的提交值

function tempDir(prefix) {
  const dir=mkdtempSync(join(tmpdir(),prefix));
  const cleanup=()=>rmSync(dir,{recursive:true,force:true});
  return {dir,cleanup};
}
function writeUsers(dir,users) {
  writeFileSync(join(dir,'users.json'),JSON.stringify(users),{mode:0o600});
}
const readCodes=dir=>JSON.parse(readFileSync(join(dir,'pairing-codes.json'),'utf8'));
const readPairings=dir=>JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8'));
const pairingEntry=(dir,userId)=>readPairings(dir).find(item=>item.user_id===userId);

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
  const retryable=error=>['ECONNRESET','ECONNREFUSED','EPIPE'].includes(error.code);
  return (async()=>{
    try { return await attempt(); }
    catch (error) {
      if (!retryable(error)) throw new Error(`phoneCall 失败：${method} ${path} @${port}（${error.code||error.message}）`,{cause:error});
    }
    try { return await attempt(); }
    catch (error) {
      throw new Error(`phoneCall 失败（重试后）：${method} ${path} @${port}（${error.code||error.message}）`,{cause:error});
    }
  })();
}

async function spawnHost(t,{dir,env={}}={}) {
  const port=await freePort();
  const child=spawn(process.execPath,[HOST_FILE],{env:{
    ...process.env,
    ALONG_AGENT_STATE_DIR:dir,
    ALONG_AGENT_HOST:'127.0.0.1',
    ALONG_AGENT_PORT:String(port),
    ...env,
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
  const stop=()=>new Promise(resolve=>{
    if (stopped||child.exitCode!==null||child.signalCode!==null) {stopped=true; return resolve();}
    stopped=true;
    child.once('exit',()=>resolve());
    child.kill('SIGINT');
    setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},3_000).unref?.();
  });
  if (t) t.after(()=>stop());
  return {port,text,stop,pairingCode:()=>/一次性配对码: (\d{8})/.exec(text())?.[1]??null};
}

function issueCodeViaCli(dir,userId) {
  return spawnSync(process.execPath,[PAIR_CODE_FILE,...(userId?[userId]:[])],
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

// ---- CLI：host/pair-code.mjs 的交接契约（§3.2 发码、§4 M1）--------------------------------------

test('pair-code CLI：缺 users.json/缺用户/缺参数 → exit 1 不产码；成功码只进 stdout、绑定 userId、0600、15 分钟',()=>{
  const {dir,cleanup}=tempDir('along-pair-cli-');
  try {
    // users.json 不存在：不发码、不产码文件
    let run=issueCodeViaCli(dir,USER_A);
    assert.equal(run.status,1,'缺 users.json → exit 1');
    assert.equal(run.stdout,'','失败路径 stdout 无码（明文码只进成功路径的 stdout）');
    assert.match(run.stderr,/users\.json 不存在/);
    assert.equal(existsSync(join(dir,'pairing-codes.json')),false,'失败路径不产生码文件');

    // 用户不在表内：不发码
    writeUsers(dir,[{userId:USER_A,label:'A'}]);
    run=issueCodeViaCli(dir,USER_B);
    assert.equal(run.status,1,'非 users.json 用户 → exit 1');
    assert.equal(run.stdout,'');
    assert.match(run.stderr,/没有用户/);

    // 缺参数：用法报错
    run=issueCodeViaCli(dir);
    assert.equal(run.status,1,'缺 <userId> 参数 → exit 1');
    assert.match(run.stderr,/用法/);

    // 成功：stdout 恰好一个 8 位码，stderr 干净，码与 userId 绑定落盘 0600、15 分钟有效
    const t0=Date.now();
    run=issueCodeViaCli(dir,USER_A);
    assert.equal(run.status,0);
    assert.match(run.stdout,/^\d{8}\n$/,'stdout 恰好一行 8 位码');
    assert.equal(run.stderr,'','成功路径 stderr 干净（码只进 stdout）');
    const codeA=run.stdout.trim();
    assert.equal(statSync(join(dir,'pairing-codes.json')).mode&0o777,0o600,'码文件 0600');
    const state=readCodes(dir);
    assert.deepEqual(state.failures,[]);
    assert.equal(state.codes.length,1);
    const [stored,owner,expiresAt]=state.codes[0];
    assert.equal(stored,codeA);
    assert.equal(owner,USER_A,'码与 userId 绑定写入 pairing-codes.json');
    assert.ok(expiresAt>t0+CODE_TTL_MS-1000&&expiresAt<=Date.now()+CODE_TTL_MS,'码 15 分钟有效');

    // 第二个用户各持一码，绑定关系不串
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B,label:'B'}]);
    run=issueCodeViaCli(dir,USER_B);
    assert.equal(run.status,0);
    const codeB=run.stdout.trim();
    assert.notEqual(codeB,codeA);
    const entries=readCodes(dir).codes;
    assert.deepEqual(entries.map(item=>item[0]).sort(),[codeA,codeB].sort(),'两码都在场');
    assert.deepEqual(entries.map(item=>item[1]).sort(),[USER_A,USER_B].sort(),'各码绑定各自的 userId');
  } finally {cleanup();}
});

// ---- 真实进程：多用户全链路（验收 #1 主链）------------------------------------------------------

test('多用户全链路：CLI 发码、用户表热更新、公网限流、单次有效、重启保持绑定',async t=>{
  const {dir,cleanup}=tempDir('along-multi-accept-');
  try {
    // 启动时用户表只有 A：先验证单用户可配对，运行期再加 B（§3.2 users.json 每次 /pair 重读）。
    writeUsers(dir,[{userId:USER_A,label:'A'}]);
    const host=await spawnHost(t,{dir,env:{ALONG_PAIR_FAIL_LIMIT:'3'}});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    assert.equal(host.pairingCode(),null,'users.json 存在 → 不生成、不打印通用码（§3.2/§3.7）');
    assert.equal(existsSync(join(dir,'pairings.json')),false,'空绑定表不落盘');
    const verifyOn=port=>token=>phoneCall(port,'/connection/verify',{method:'POST',headers:{authorization:`Bearer ${token}`}});
    const verify=verifyOn(host.port);
    const pairWith=code=>phoneCall(host.port,'/pair',{method:'POST',body:{code}});

    // A 配对：CLI 发码（跨进程文件交接）→ /pair 换 64hex token
    const codeA1=issueCodeViaCli(dir,USER_A).stdout.trim();
    assert.match(codeA1,/^\d{8}$/);
    const pairA=await pairWith(codeA1);
    assert.equal(pairA.status,200);
    assert.deepEqual(Object.keys(pairA.json),['token'],'/pair 响应只有配对 token');
    assert.match(pairA.json.token,/^[a-f0-9]{64}$/);
    const tokenA1=pairA.json.token;
    assert.equal(statSync(join(dir,'pairings.json')).mode&0o777,0o600,'pairings.json 0600（§3.3）');
    assert.equal(readCodes(dir).failures.length,0,'成功清空失败窗口');

    // 运行期新增用户 B 即刻生效（无需重启）：写入用户表 → CLI 发码 → 直接配对成功
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B,label:'B'}]);
    const codeB1=issueCodeViaCli(dir,USER_B).stdout.trim();
    const pairB=await pairWith(codeB1);
    assert.equal(pairB.status,200,'运行期加入用户表的成员立即可配对');
    const tokenB1=pairB.json.token;

    // 验收 #1 核心：两个 token **同时**通过 authorized()（交替验证）
    assert.deepEqual((await verify(tokenA1)).json,{paired:true});
    assert.deepEqual((await verify(tokenB1)).json,{paired:true});
    assert.deepEqual((await verify(tokenA1)).json,{paired:true},'A 的 token 在 B 配对后仍然有效');
    const stranger=await phoneCall(host.port,'/connection/verify',{method:'POST',headers:{authorization:`Bearer ${'9'.repeat(64)}`}});
    assert.equal(stranger.status,401,'表外 token → 401');
    assert.deepEqual(stranger.json,{error:'请先配对这台 Mac'},'401 文案不变（§3.2）');

    // pairings.json：数组、每用户一条、字段恰为 {hash,user_id,device_id}
    const table=readPairings(dir);
    assert.equal(table.length,2,'pairings.json 每用户一条');
    for (const entry of table) assert.deepEqual(Object.keys(entry).sort(),['device_id','hash','user_id']);
    assert.equal(pairingEntry(dir,USER_A).hash,sha256hex(tokenA1));
    assert.equal(pairingEntry(dir,USER_B).hash,sha256hex(tokenB1));
    assert.match(pairingEntry(dir,USER_A).device_id,/^d_[0-9a-f]{8}$/);

    // 错误码 → 403 文案统一、不回显提交值（SD-7 防存在性泄露）
    const wrong=await pairWith(dead(0));
    assert.equal(wrong.status,403);
    assert.deepEqual(wrong.json,{error:'配对码无效或已过期'});
    assert.equal(wrong.text.includes(dead(0)),false,'响应不回显提交值');
    assert.equal(readCodes(dir).failures.length,1,'未命中计入全局失败窗口');

    // 请求体没有 code 字段 → 同一 403 文案
    const noCode=await phoneCall(host.port,'/pair',{method:'POST',body:{}});
    assert.equal(noCode.status,403);
    assert.deepEqual(noCode.json,{error:'配对码无效或已过期'});
    assert.equal(readCodes(dir).failures.length,2);

    // 过期码 → 按未命中计（先注入一条已过期的码；0 开头串不可能与真实码撞）
    const state=readCodes(dir);
    state.codes.push([dead(9),USER_B,Date.now()-1000]);
    writeFileSync(join(dir,'pairing-codes.json'),JSON.stringify(state),{mode:0o600});
    const expired=await pairWith(dead(9));
    assert.equal(expired.status,403,'过期码 → 403');
    assert.equal(readCodes(dir).failures.length,3,'过期码按未命中计入失败窗口');
    assert.equal(readCodes(dir).codes.some(item=>item[0]===dead(9)),false,'过期码已被清理');

    // 码有效但用户已移出表 → 403 且不消费码、不计失败；改回后同一码仍可用（§3.2 实现回写）
    const codeB2=issueCodeViaCli(dir,USER_B).stdout.trim();
    assert.equal((await pairWith(dead(1))).status,403);
    writeUsers(dir,[{userId:USER_A,label:'A'}]);
    const removed=await pairWith(codeB2);
    assert.equal(removed.status,403,'非 users.json 用户 → 403');
    assert.equal(readCodes(dir).failures.length,1,'有效码不计入失败窗口');
    assert.equal(readCodes(dir).codes.some(item=>item[0]===codeB2),true,'码未被消费');
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B,label:'B'}]);
    const restored=await pairWith(codeB2);
    assert.equal(restored.status,200,'用户改回后同一码仍可配对');
    const tokenB2=restored.json.token;
    assert.deepEqual(readCodes(dir).failures,[],'成功清空窗口');
    assert.equal(readCodes(dir).codes.length,0,'码已消费（单次有效）');

    // B 重配对只覆盖 B：旧 B token 失效，A 不受影响
    assert.equal((await verify(tokenB1)).status,401,'B 的旧 token 立即失效');
    assert.deepEqual((await verify(tokenA1)).json,{paired:true},'A 的绑定不受 B 重配对影响');
    assert.equal(pairingEntry(dir,USER_B).hash,sha256hex(tokenB2));

    // A 再配对只覆盖 A（验收 #1：A 再配对只覆盖 A 的绑定，B 不受影响）
    const codeA2=issueCodeViaCli(dir,USER_A).stdout.trim();
    const repaired=await pairWith(codeA2);
    assert.equal(repaired.status,200);
    const tokenA2=repaired.json.token;
    assert.notEqual(tokenA2,tokenA1);
    assert.equal(pairingEntry(dir,USER_A).hash,sha256hex(tokenA2),'A 换新 token');
    assert.equal(pairingEntry(dir,USER_A).user_id,USER_A,'user_id 不变');
    assert.notEqual(pairingEntry(dir,USER_A).device_id,pairingEntry(dir,USER_B).device_id,'device_id 各自独立');
    assert.equal(pairingEntry(dir,USER_B).hash,sha256hex(tokenB2),'B 的绑定不受影响');
    assert.equal((await verify(tokenA1)).status,401,'A 的旧 token 立即失效');
    assert.deepEqual((await verify(tokenB2)).json,{paired:true});

    // 公网窗口使用更严的环境变量限额；限流前后三种失败不暴露提交值或码是否存在。
    const codeB3=issueCodeViaCli(dir,USER_B).stdout.trim();
    for (let seed=1;seed<=3;seed++) {
      const miss=await pairWith(dead(seed));
      assert.equal(miss.status,403,`未知码 #${seed} → 403`);
      assert.deepEqual(miss.json,{error:'配对码无效或已过期'},'限速后文案不变');
    }
    const full=readCodes(dir);
    assert.equal(full.failures.length,3);
    for (const candidate of [dead(4),codeB3]) {
      const blocked=await pairWith(candidate);
      assert.equal(blocked.status,403);
      assert.deepEqual(blocked.json,wrong.json);
      assert.equal(blocked.text.includes(candidate),false);
    }
    assert.deepEqual(readCodes(dir),full,'限流后失败计数和未使用的有效码保持原样');
    assert.equal(issueCodeViaCli(dir,USER_B).status,0,'管理员发码，窗口重开');
    const rescued=await pairWith(codeB3);
    assert.equal(rescued.status,200,'原来的有效码仍可配对');
    const tokenB3=rescued.json.token;
    assert.deepEqual(readCodes(dir).failures,[],'成功后 failures 清空');
    assert.deepEqual((await verify(tokenB3)).json,{paired:true});

    // 单次有效（E2E）：刚消费过的码再提交 → 403
    assert.equal((await pairWith(codeA2)).status,403,'已消费的码不能再用');
    assert.equal(readCodes(dir).failures.length,1,'再未命中重新计数');

    // 日志纪律（SD-7/§3.7）：提交值与通用码横幅都不进 host 输出
    for (let seed=0;seed<=4;seed++) {
      assert.equal(host.text().includes(dead(seed)),false,`提交值 ${dead(seed)} 不落日志`);
    }
    assert.equal(host.text().includes(codeB3),false,'被限流的有效码也不落日志');
    assert.doesNotMatch(host.text(),/一次性配对码/,'多用户形态任何时刻都不打通用码');

    // 重启：多绑定是持久事实，两个 token 都仍有效（pairings.json 支持多用户绑定）
    await host.stop();
    const second=await spawnHost(t,{dir});
    await waitFor(()=>second.text().includes('证书指纹'),'第二次启动横幅');
    assert.equal(second.pairingCode(),null,'重启后 users.json 仍在场 → 仍无通用码');
    const verify2=verifyOn(second.port);
    assert.deepEqual((await verify2(tokenA2)).json,{paired:true},'重启后 A 的 token 仍有效');
    assert.deepEqual((await verify2(tokenB3)).json,{paired:true},'重启后 B 的 token 仍有效');
    assert.equal(readPairings(dir).length,2,'重启不丢绑定');
  } finally {cleanup();}
});

// ---- 真实进程：Mac 本地启动码、失败计数上限 ----------------------------------------------------

test('本地形态：通用码配对；ALONG_PAIR_FAIL_LIMIT=3 限制失败计数；403 文案与多用户一致',async t=>{
  const {dir,cleanup}=tempDir('along-local-limit-');
  try {
    const host=await spawnHost(t,{dir,env:{ALONG_PAIR_FAIL_LIMIT:'3'}});
    await waitFor(()=>host.pairingCode(),'启动横幅出现通用码');
    const universal=host.pairingCode();
    assert.match(universal,/^\d{8}$/);

    // 3 次未命中打满 env 限额
    for (const candidate of [dead(1),dead(2),dead(3)]) {
      const miss=await phoneCall(host.port,'/pair',{method:'POST',body:{code:candidate}});
      assert.equal(miss.status,403);
      assert.deepEqual(miss.json,{error:'配对码无效或已过期'},'本地形态 403 文案与多用户一致');
      assert.equal(miss.text.includes(candidate),false,'不回显提交值');
    }
    assert.equal(readCodes(dir).failures.length,3);
    assert.equal((await phoneCall(host.port,'/pair',{method:'POST',body:{code:dead(4)}})).status,403);
    assert.equal(readCodes(dir).failures.length,3,'ALONG_PAIR_FAIL_LIMIT=3 在服务端生效：第 4 次未命中不再追加');

    // 通用码（有效码）不受限速影响，仍然配对成功；成功清空窗口
    const paired=await phoneCall(host.port,'/pair',{method:'POST',body:{code:universal}});
    assert.equal(paired.status,200,'有效码不受限速影响（现状 5 次失败会锁死到重启）');
    assert.deepEqual(Object.keys(paired.json),['token']);
    const token1=paired.json.token;
    assert.equal(readCodes(dir).failures.length,0,'成功清空窗口');
    const table1=readPairings(dir);
    assert.equal(table1.length,1,'本地整表一条');
    assert.match(table1[0].user_id,/^u_[0-9a-f]{8}$/,'配对即建号');
    assert.match(table1[0].device_id,/^d_[0-9a-f]{8}$/);
    assert.equal(table1[0].hash,sha256hex(token1));

    // 同一通用码在 TTL 内可再次配对：这是 SD-7 移除「成功后置 5 锁死」的直接结果
    // （旧行为：host/agent-host.mjs HEAD:305 成功后 pairFailures=5 → 直至重启任何 /pair 都 403）。
    const repaired=await phoneCall(host.port,'/pair',{method:'POST',body:{code:universal}});
    assert.equal(repaired.status,200,'通用码 TTL 内可复用（SD-7 移除成功后锁死的直接结果）');
    const token2=repaired.json.token;
    assert.notEqual(token2,token1);
    const table2=readPairings(dir);
    assert.equal(table2.length,1,'本地重配对仍整表一条');
    assert.equal(table2[0].user_id,table1[0].user_id,'本地重配对 user_id 沿用');
    assert.notEqual(table2[0].device_id,table1[0].device_id,'device_id 换新');
    assert.equal(table2[0].hash,sha256hex(token2),'配对 token 换新');
    assert.equal((await phoneCall(host.port,'/connection/verify',{method:'POST',headers:{authorization:`Bearer ${token1}`}})).status,401,'旧 token 失效');
    assert.deepEqual((await phoneCall(host.port,'/connection/verify',{method:'POST',headers:{authorization:`Bearer ${token2}`}})).json,{paired:true});

    // 窗口清空后重新计数
    assert.equal((await phoneCall(host.port,'/pair',{method:'POST',body:{code:dead(5)}})).status,403);
    assert.equal(readCodes(dir).failures.length,1);
    assert.equal(host.text().includes(dead(5)),false,'提交值不落日志');
  } finally {cleanup();}
});

// ---- users.json 格式无效 → host 拒绝启动（fail-closed，§3.2 不静默降级）------------------------

test('users.json 格式无效 → host 拒绝启动：非零退出、不进入监听、不降级打印通用码',()=>{
  const cases=[['空数组','[]'],['userId 无效',JSON.stringify([{userId:'nope'}])],['非法 JSON','{"users":']];
  for (const [label,bad] of cases) {
    const {dir,cleanup}=tempDir('along-bad-users-');
    try {
      writeFileSync(join(dir,'users.json'),bad,{mode:0o600});
      const run=spawnSync(process.execPath,[HOST_FILE],{env:{
        ...process.env,
        ALONG_AGENT_STATE_DIR:dir,
        ALONG_AGENT_HOST:'127.0.0.1',
      },timeout:30_000,killSignal:'SIGKILL',encoding:'utf8'});
      assert.equal(run.signal,null,`${label}：进程应自行退出，而不是超时被杀（超时=进入监听=静默降级）`);
      assert.equal(run.status,1,`${label}：非零退出，实际 status=${run.status} 输出=${((run.stdout??'')+(run.stderr??'')).slice(0,200)}`);
      const output=String(run.stdout??'')+String(run.stderr??'');
      assert.doesNotMatch(output,/一次性配对码/,`${label}：不得降级成单用户模式打印通用码（§3.7 码不落日志）`);
      assert.doesNotMatch(output,/Along 服务: /,`${label}：不得进入监听`);
      if (label!=='非法 JSON') assert.match(output,/users\.json/,`${label}：报错要能定位到 users.json`);
    } finally {cleanup();}
  }
});
