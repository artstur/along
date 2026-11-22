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
import {loadUsers,loadPairings,readPairings,revokePairing,findPairing,issuePairingCode,consumeUserCode,failLimitFromEnv,CODE_TTL_MS,BINDING_TTL_MS} from '../host/pairing.mjs';

// 多用户配对（docs/cloud-deploy-multi-user.md §4 M1 + docs/cloud-security-hardening.md §3.1-(4)(5)(6)，M1 验收 #4/#5/#6）：
// - pairings.json 多绑定表（多用户条目带 30 天滑动过期 expiresAt）+ 旧单对象 pairing.json 幂等升级；
//   users.json 静态用户表；host/pair-code.mjs CLI 每用户一次性码（CLI 进程 ↔ server 文件交接）；
// - authorized() 按表鉴权：两个 token 同时有效，A 再配对只覆盖 A；
// - 防枚举（G-4 按来源分桶）：失败滑动窗口从全局数组改为 {<来源IP>:["ISO",…]}，默认 15 分钟 10 次/来源
//   （ALONG_PAIR_FAIL_LIMIT 只许调严）；窗口满只拒绝该来源且不消费码；成功只清本来源桶；窗口过期自然恢复；
// - 发码不清窗（G-12/SD-H2）：issuePairingCode 不再清空失败窗口，也不设清窗命令；
// - consumeUserCode 返回带 reason（unknown/window_full/user_missing）供 /pair 审计区分（G-15）；
// - readPairings 纯读 fail-closed（缺失/损坏按空表 = 全部 401），revokePairing 删除该用户绑定条目。

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
const bucketOf=(dir,source)=>readCodes(dir).failures[source]??[];

// ---- host/pairing.mjs 单元切片 ----

test('loadUsers：缺失返回 null（本地形态），格式无效抛错不静默降级',()=>{
  const {dir,cleanup}=tempDir('along-users-');
  try {
    assert.equal(loadUsers(dir),null,'users.json 不存在 → 本地单用户形态');
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B}]);
    assert.deepEqual(loadUsers(dir),[USER_A,USER_B]);
    for (const bad of [[],'x',[{userId:'nope'}],[{userId:[USER_A]}],[{userId:USER_A},{userId:USER_A}],[{}],['not json']]) {
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

test('loadPairings：带齐身份的旧文件原样保留；缺 hash 的旧文件没有绑定身份；坏条目丢弃；expiresAt 随条目透传（G-5）',()=>{
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
    // G-5：expiresAt 只在合法数值时透传；字段缺失的既有条目永不过期（grandfathered）；
    // 显式给了却不合法 → 整条丢弃，不授权（复核报告：「显式非法的过期字段应拒绝授权」）。
    const expiresAt=Date.now()+BINDING_TTL_MS;
    writeFileSync(join(dir,'pairings.json'),JSON.stringify([
      {hash:'11'.repeat(32),user_id:USER_A,device_id:DEVICE_A,expiresAt},
      {hash:'22'.repeat(32),user_id:USER_B,device_id:DEVICE_B,expiresAt:'soon'}]),{mode:0o600});
    const upgraded=loadPairings(dir);
    assert.deepEqual(upgraded,[{hash:'11'.repeat(32),user_id:USER_A,device_id:DEVICE_A,expiresAt}],
      '合法 expiresAt 透传；显式非法的 expiresAt 整条丢弃，不授权');
    // 字段缺失的既有条目仍然保留（永不过期，历史兼容行为不变）。
    writeFileSync(join(dir,'pairings.json'),JSON.stringify([
      {hash:'33'.repeat(32),user_id:USER_B,device_id:DEVICE_B}]),{mode:0o600});
    assert.deepEqual(loadPairings(dir),[{hash:'33'.repeat(32),user_id:USER_B,device_id:DEVICE_B}],
      '缺少 expiresAt 的既有条目照常保留（永不过期）');
  } finally {cleanup();}
});

test('readPairings：文件即绑定的唯一事实来源（G-5/SD-H15）——缺失/损坏按空表 fail-closed，纯读不回写',()=>{
  const {dir,cleanup}=tempDir('along-read-pairings-');
  try {
    assert.deepEqual(readPairings(dir),[],'pairings.json 不存在 → 空表（fail-closed，全部 401）');
    writeFileSync(join(dir,'pairings.json'),'{"broken":',{mode:0o600});
    assert.deepEqual(readPairings(dir),[],'损坏 JSON → 空表，不做内存兜底');
    writeFileSync(join(dir,'pairings.json'),JSON.stringify({hash:'ab'.repeat(32)}),{mode:0o600});
    assert.deepEqual(readPairings(dir),[],'非数组 → 空表');
    writeFileSync(join(dir,'pairings.json'),JSON.stringify([
      {hash:'zz',user_id:USER_A,device_id:DEVICE_A},
      {hash:'ef'.repeat(32),user_id:'bad',device_id:DEVICE_A},
      {hash:sha256hex('e'.repeat(64)),user_id:USER_A,device_id:DEVICE_A,expiresAt:Date.now()+BINDING_TTL_MS},
      {hash:sha256hex('f'.repeat(64)),user_id:USER_B,device_id:DEVICE_B}]),{mode:0o600});
    const entries=readPairings(dir);
    assert.equal(entries.length,2,'坏条目丢弃（无副作用），合法条目保留');
    assert.ok(Number.isFinite(entries[0].expiresAt),'合法条目的 expiresAt 透传');
    assert.deepEqual(Object.keys(entries[1]).sort(),['device_id','hash','user_id'],'无 expiresAt 的既有条目照常返回（永不过期）');
    assert.equal(existsSync(join(dir,'pairings.json')),true,'纯读不回写');
  } finally {cleanup();}
});

test('readPairings：显式非法的 expiresAt 拒绝授权，缺字段的仍按历史兼容永不过期',()=>{
  // 复核报告实测的旧行为：expiresAt:"not-a-number" 被丢弃成「没有」→ 判定为永不过期 →
  // 绑定继续有效。显式写出的非法值必须拒绝授权；只有「从未有过该字段」才是历史兼容。
  const {dir,cleanup}=tempDir('along-bad-expiry-');
  try {
    const valid={hash:sha256hex('e'.repeat(64)),user_id:USER_A,device_id:DEVICE_A,expiresAt:Date.now()+BINDING_TTL_MS};
    const legacy={hash:sha256hex('f'.repeat(64)),user_id:USER_B,device_id:DEVICE_B};
    for(const bad of ['not-a-number',null,'soon',{},[],Number.NaN,Number.POSITIVE_INFINITY]) {
      writeFileSync(join(dir,'pairings.json'),JSON.stringify([{...valid,expiresAt:bad},legacy]),{mode:0o600});
      const entries=readPairings(dir);
      assert.equal(entries.length,1,'显式非法的 expiresAt 让该条目不进表（不授权）');
      assert.deepEqual(entries[0],legacy,'只有缺字段的既有条目按历史兼容保留');
    }
  } finally {cleanup();}
});

test('revokePairing：删除该用户绑定条目并落盘；没有绑定返回 false（CLI 以此 exit 1）',async()=>{
  const {dir,cleanup}=tempDir('along-revoke-');
  try {
    writeFileSync(join(dir,'pairings.json'),JSON.stringify([
      {hash:sha256hex('e'.repeat(64)),user_id:USER_A,device_id:DEVICE_A,expiresAt:Date.now()+BINDING_TTL_MS},
      {hash:sha256hex('f'.repeat(64)),user_id:USER_B,device_id:DEVICE_B}]),{mode:0o600});
    assert.equal(await revokePairing(dir,USER_A),true,'有绑定 → true');
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8')).map(item=>item.user_id),[USER_B],
      'A 的条目消失，B 的绑定不受影响');
    assert.equal(await revokePairing(dir,USER_A),false,'没有绑定 → false（CLI 报「没有用户的配对绑定」exit 1）');
  } finally {cleanup();}
});

test('revokePairing：吊销同时清掉该用户未消费的配对码（设计 §6 / T18）',async()=>{
  // 复核报告实测：只删绑定表的话，吊销前发给该用户、还没用掉的码仍能换出新 token——
  // 吊销没有真正生效。这里要求吊销把未消费码一起清掉。
  const {dir,cleanup}=tempDir('along-revoke-codes-');
  try {
    writeUsers(dir,[{userId:USER_A},{userId:USER_B}]);
    const t0=1_000_000_000_000,limit=10,source='10.9.9.9';
    const codeA=await issuePairingCode(dir,USER_A,t0);
    const codeB=await issuePairingCode(dir,USER_B,t0+1);
    writeFileSync(join(dir,'pairings.json'),JSON.stringify([
      {hash:sha256hex('e'.repeat(64)),user_id:USER_A,device_id:DEVICE_A,expiresAt:Date.now()+BINDING_TTL_MS},
      {hash:sha256hex('f'.repeat(64)),user_id:USER_B,device_id:DEVICE_B}]),{mode:0o600});

    assert.equal(await revokePairing(dir,USER_A),true,'有绑定 → true');
    assert.deepEqual(readCodes(dir).codes.map(item=>item[0]),[codeB],'A 的未消费码被清掉，B 的码不受影响');
    // 吊销后旧码不能再换出新 token。
    assert.deepEqual(await consumeUserCode(dir,codeA,limit,t0+2,source),{ok:false,reason:'unknown'},
      '吊销后旧码不能再配对');
    // B 的码仍然可用——吊销不波及其他用户。
    assert.deepEqual(await consumeUserCode(dir,codeB,limit,t0+3,source),{ok:true,userId:USER_B},
      '另一用户的码不受影响');
  } finally {cleanup();}
});

test('revokePairing：只有未消费码没有绑定时也算吊销成功',async()=>{
  // 边界：绑定已不存在但旧码还在——那枚码仍然能换出新 token，吊销必须成功。
  const {dir,cleanup}=tempDir('along-revoke-code-only-');
  try {
    writeUsers(dir,[{userId:USER_A}]);
    const t0=1_000_000_000_000;
    await issuePairingCode(dir,USER_A,t0);
    assert.equal(await revokePairing(dir,USER_A),true,'只有未消费码也要算吊销成功');
    assert.deepEqual(readCodes(dir).codes,[],'未消费码被清掉');
    assert.equal(await revokePairing(dir,USER_A),false,'确实什么都没有了 → false');
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

test('issuePairingCode：需要 users.json 且用户在表内；码 8 位、15 分钟有效、文件 0600、防撞码',async()=>{
  const {dir,cleanup}=tempDir('along-issue-');
  try {
    await assert.rejects(issuePairingCode(dir,USER_A),/users\.json 不存在/);
    writeUsers(dir,[{userId:USER_A},{userId:USER_B}]);
    await assert.rejects(issuePairingCode(dir,'u_nope0000'),/没有用户/,'非 users.json 用户不发码');
    const t0=1_000_000_000_000;
    const code=await issuePairingCode(dir,USER_A,t0);
    assert.match(code,/^\d{8}$/);
    assert.deepEqual(readCodes(dir),{failures:{},codes:[[code,USER_A,t0+CODE_TTL_MS]]},'failures 是按来源分桶的对象（G-4）');
    assert.equal(statSync(join(dir,'pairing-codes.json')).mode&0o777,0o600,'码文件 0600');
    const second=await issuePairingCode(dir,USER_B,t0+1);
    assert.notEqual(second,code);
    assert.equal(readCodes(dir).codes.length,2,'不同用户各持一码');
    // 过期码在发码时顺带清理
    writeFileSync(join(dir,'pairing-codes.json'),JSON.stringify(
      {failures:{},codes:[...readCodes(dir).codes,['11111111',USER_B,t0-1]]}),{mode:0o600});
    await issuePairingCode(dir,USER_A,t0+2);
    const codes=readCodes(dir).codes;
    assert.equal(codes.some(item=>item[0]==='11111111'),false,'过期码已清理');
    assert.equal(codes.length,3,'未过期码全部保留');
  } finally {cleanup();}
});

test('consumeUserCode：失败窗口按来源分桶（G-4）；来源窗口满时不验码不写盘，有效码未消费',async()=>{
  const {dir,cleanup}=tempDir('along-consume-');
  try {
    writeUsers(dir,[{userId:USER_A}]);
    const t0=1_000_000_000_000;
    const codeA=await issuePairingCode(dir,USER_A,t0);
    const limit=2,sourceA='127.0.0.2',sourceB='127.0.0.3';
    assert.deepEqual(await consumeUserCode(dir,'00000000',limit,t0+1,sourceA),{ok:false,reason:'unknown'},'未命中计入该来源桶，reason=unknown');
    assert.deepEqual(await consumeUserCode(dir,'00000000',limit,t0+2,sourceA),{ok:false,reason:'unknown'});
    const full=readCodes(dir);
    assert.deepEqual(full.failures,{[sourceA]:[new Date(t0+1).toISOString(),new Date(t0+2).toISOString()]},'失败按来源分桶');
    assert.deepEqual(await consumeUserCode(dir,codeA,limit,t0+3,sourceA),{ok:false,reason:'window_full'},'满窗对有效码统一拒绝');
    assert.deepEqual(readCodes(dir),full,'窗口满时不验码、不写盘，码未消费（SD-7 语义按来源成立）');
    assert.deepEqual(await consumeUserCode(dir,'00000000',limit,t0+4,sourceA),{ok:false,reason:'window_full'},'满窗不再追加失败');
    assert.deepEqual(readCodes(dir),full);

    // 发码不清窗（G-12/SD-H2）：发码后 A 的失败桶原样
    writeUsers(dir,[{userId:USER_A},{userId:USER_B}]);
    const codeB=await issuePairingCode(dir,USER_B,t0+3);
    assert.deepEqual(readCodes(dir).failures,full.failures,'发码不清窗：失败桶原样');
    // 另一来源同刻用自己的码成功；成功只清本来源桶
    assert.deepEqual(await consumeUserCode(dir,codeB,limit,t0+5,sourceB),{ok:true,userId:USER_B},'另一来源不受 A 的满窗影响');
    assert.deepEqual(readCodes(dir).failures,full.failures,'成功只清 B 自己的桶，A 的桶不受影响');
    assert.deepEqual(readCodes(dir).codes.map(item=>item[0]),[codeA],'A 的有效码仍未消费');
  } finally {cleanup();}
});

test('issuePairingCode：发码不清窗（G-12/SD-H2）、保留未过期码，两码单次有效',async()=>{
  const {dir,cleanup}=tempDir('along-reopen-');
  try {
    writeUsers(dir,[{userId:USER_A},{userId:USER_B}]);
    const t0=1_000_000_000_000,limit=2,source='10.9.9.9';
    const codeA=await issuePairingCode(dir,USER_A,t0);
    assert.deepEqual(await consumeUserCode(dir,'00000000',limit,t0+1,source),{ok:false,reason:'unknown'});
    const before=readCodes(dir);
    assert.equal(before.failures[source].length,1);
    const codeB=await issuePairingCode(dir,USER_B,t0+3);
    assert.deepEqual(readCodes(dir).failures,before.failures,'发码不清窗：失败桶原样（评审砍掉 --reset-window）');
    assert.deepEqual(readCodes(dir).codes,[[codeA,USER_A,t0+CODE_TTL_MS],[codeB,USER_B,t0+3+CODE_TTL_MS]],'发码保留所有未过期码');
    assert.deepEqual(await consumeUserCode(dir,codeA,limit,t0+5,source),{ok:true,userId:USER_A},'窗口未满时有效码可配对');
    assert.deepEqual(readCodes(dir).failures,{},'成功只清本来源桶');
    assert.deepEqual(await consumeUserCode(dir,codeA,limit,t0+6,source),{ok:false,reason:'unknown'},'同一码第二次无效');
  } finally {cleanup();}
});

test('consumeUserCode：满窗自然恢复时，过期配对码仍然无效',async()=>{
  const {dir,cleanup}=tempDir('along-expired-code-');
  try {
    writeUsers(dir,[{userId:USER_A}]);
    const t0=1_000_000_000_000,limit=1,expires=t0+CODE_TTL_MS,source='192.0.2.7';
    const code=await issuePairingCode(dir,USER_A,t0);
    assert.deepEqual(await consumeUserCode(dir,'00000000',limit,t0,source),{ok:false,reason:'unknown'});
    assert.deepEqual(await consumeUserCode(dir,code,limit,expires-1,source),{ok:false,reason:'window_full'},'窗口尚未恢复时拒绝尚未过期的码');
    assert.deepEqual(await consumeUserCode(dir,code,limit,expires,source),{ok:false,reason:'unknown'},'原失败恰满 15 分钟已滑出：过期码按未命中处理');
    assert.deepEqual(readCodes(dir),{failures:{[source]:[new Date(expires).toISOString()]},codes:[]},
      '窗口过期自然恢复，新的失败重新计数');
  } finally {cleanup();}
});

test('consumeUserCode：码有效但用户已不在 users.json → 403 语义（reason=user_missing）、不消费、不计失败',async()=>{
  const {dir,cleanup}=tempDir('along-consume-user-');
  try {
    writeUsers(dir,[{userId:USER_A}]);
    const t0=1_000_000_000_000;
    const code=await issuePairingCode(dir,USER_A,t0);
    writeUsers(dir,[{userId:USER_B}]);
    assert.deepEqual(await consumeUserCode(dir,code,10,t0+1),{ok:false,reason:'user_missing'});
    const state=readCodes(dir);
    assert.deepEqual(state.codes,[[code,USER_A,t0+CODE_TTL_MS]],'码未被消费，改表后同一码仍可用');
    assert.deepEqual(state.failures,{},'有效码不计入失败窗口');
    writeUsers(dir,[{userId:USER_A},{userId:USER_B}]);
    assert.deepEqual(await consumeUserCode(dir,code,10,t0+2),{ok:true,userId:USER_A},'用户恢复后原码仍可配对');
  } finally {cleanup();}
});

test('失败窗口滑动：恰好 15 分钟前的失败不再计入（窗口与码 TTL 同步）',async()=>{
  const {dir,cleanup}=tempDir('along-window-');
  try {
    const t0=1_000_000_000_000,windowMs=15*60_000,source='203.0.113.9';
    writeUsers(dir,[{userId:USER_A}]);
    await consumeUserCode(dir,'00000000',10,t0,source);
    await consumeUserCode(dir,'00000000',10,t0+1,source);
    assert.equal(bucketOf(dir,source).length,2);
    assert.deepEqual(await consumeUserCode(dir,'00000000',10,t0+windowMs,source),{ok:false,reason:'unknown'});
    assert.deepEqual(readCodes(dir).failures,
      {[source]:[new Date(t0+1).toISOString(),new Date(t0+windowMs).toISOString()]},
      'now=t0+窗口：恰好 15 分钟前（t0）的失败已滑出，窗口内的保留并追加新失败');
    assert.deepEqual(await consumeUserCode(dir,'00000000',10,t0+1+windowMs,source),{ok:false,reason:'unknown'});
    assert.deepEqual(readCodes(dir).failures,
      {[source]:[new Date(t0+windowMs).toISOString(),new Date(t0+1+windowMs).toISOString()]},
      'now=t0+1+窗口：t0+1 的失败随之滑出，15 分钟前的失败一律不再计入');
  } finally {cleanup();}
});

test('failLimitFromEnv：默认 10，ALONG_PAIR_FAIL_LIMIT 只许调严（作用域为每来源）',()=>{
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
  const stop=()=>new Promise(resolve=>{
    if (stopped||child.exitCode!==null||child.signalCode!==null) {stopped=true; return resolve();}
    stopped=true;
    child.once('exit',()=>resolve());
    child.kill('SIGINT');
    setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},3_000).unref?.();
  });
  if (t) t.after(()=>stop());
  return {port,text,stop,pairingCode:()=>/一次性配对码: (\d+)/.exec(text())?.[1]??null};
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

test('多用户配对：CLI 发码 → 各自 /pair → 两 token 同时有效；A 再配对只覆盖 A；失败窗口按来源、发码不清窗、窗口自然恢复',async t=>{
  const {dir,cleanup}=tempDir('along-multi-user-');
  try {
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B,label:'B'}]);
    const host=await spawnHost(t,{dir});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const pairingsFile=()=>existsSync(join(dir,'pairings.json'))?JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8')):null;
    const startedAt=Date.now();

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
    assert.deepEqual(readCodes(dir).failures,{},'发码不动失败窗口');

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
    for (const entry of table) {
      assert.deepEqual(Object.keys(entry).sort(),['device_id','expiresAt','hash','user_id'],'多用户绑定条目带 30 天滑动过期（G-5）');
      assert.ok(Number.isFinite(entry.expiresAt)&&entry.expiresAt>startedAt+BINDING_TTL_MS-120_000
        &&entry.expiresAt<=startedAt+BINDING_TTL_MS+120_000,'expiresAt=配对时刻+30 天');
    }
    assert.equal(table.find(item=>item.user_id===USER_A).hash,sha256hex(tokenA1));
    assert.equal(table.find(item=>item.user_id===USER_B).hash,sha256hex(tokenB1));
    assert.match(table.find(item=>item.user_id===USER_A).device_id,/^d_[0-9a-f]{8}$/);
    assert.deepEqual(readCodes(dir).failures,{},'配对成功只清本来源桶（此前无失败）');

    // 错误码 → 403，文案不变，计入本来源失败桶。
    const wrong=await phoneCall(host.port,'/pair',{method:'POST',body:{code:'00000000'}});
    assert.equal(wrong.status,403);
    assert.deepEqual(wrong.json,{error:'配对码无效或已过期'});
    assert.equal(bucketOf(dir,'127.0.0.1').length,1);

    // 过期码 → 403（直接向码文件注入一条已过期的码）。
    writeFileSync(join(dir,'pairing-codes.json'),JSON.stringify(
      {failures:readCodes(dir).failures,codes:[...readCodes(dir).codes,['11111111',USER_B,Date.now()-1000]]}),{mode:0o600});
    const expired=await phoneCall(host.port,'/pair',{method:'POST',body:{code:'11111111'}});
    assert.equal(expired.status,403);
    assert.equal(bucketOf(dir,'127.0.0.1').length,2,'过期码按未命中计入来源失败桶');

    // 非 users.json 用户：发码后把该用户移出用户表 → 403，码不消费、不计失败；
    // 恢复用户表后同一码仍可配对（users.json 每次 /pair 重读，增删用户即刻生效）。
    const codeA2=issueCodeViaCli(dir,USER_A).stdout.trim();
    assert.equal(bucketOf(dir,'127.0.0.1').length,2,'发码不清窗（G-12/SD-H2）：失败桶原样');
    assert.equal((await phoneCall(host.port,'/pair',{method:'POST',body:{code:unknownCode(1)}})).status,403);
    writeUsers(dir,[{userId:USER_B}]);
    const stranger=await phoneCall(host.port,'/pair',{method:'POST',body:{code:codeA2}});
    assert.equal(stranger.status,403,'非 users.json 用户 → 403');
    assert.equal(readCodes(dir).codes.some(item=>item[0]===codeA2),true,'码未被消费');
    assert.equal(bucketOf(dir,'127.0.0.1').length,3,'有效码不计入失败窗口（此前窗口未满，user_missing 不计失败）');
    writeUsers(dir,[{userId:USER_A},{userId:USER_B}]);

    // A 再配对：只覆盖 A 的绑定，B 不受影响。
    const repair=await phoneCall(host.port,'/pair',{method:'POST',body:{code:codeA2}});
    assert.equal(repair.status,200);
    const tokenA2=repair.json.token;
    assert.deepEqual(readCodes(dir).failures,{},'成功只清本来源桶（127.0.0.1 是唯一有失败的来源）');
    const rebound=pairingsFile();
    assert.equal(rebound.length,2);
    assert.equal(rebound.find(item=>item.user_id===USER_A).hash,sha256hex(tokenA2),'A 换新 token、user_id 不变');
    assert.equal(rebound.find(item=>item.user_id===USER_A).user_id,USER_A);
    assert.match(rebound.find(item=>item.user_id===USER_A).device_id,/^d_[0-9a-f]{8}$/,'device_id 换新');
    assert.equal(rebound.find(item=>item.user_id===USER_B).hash,sha256hex(tokenB1),'B 的绑定不受影响');
    assert.deepEqual((await verify(tokenA2)).json,{paired:true});
    assert.equal((await verify(tokenA1)).status,401,'A 的旧 token 立即失效');
    assert.deepEqual((await verify(tokenB1)).json,{paired:true},'B 的 token 仍有效');

    // 防枚举（G-4）：窗口满后拒绝尚未过期的有效码且不消费；被限速的提交不追加失败。
    const codeB2=issueCodeViaCli(dir,USER_B).stdout.trim();
    for (let seed=1;seed<=11;seed++) {
      const miss=await phoneCall(host.port,'/pair',{method:'POST',body:{code:unknownCode(seed)}});
      assert.equal(miss.status,403,`未知码 #${seed} 403`);
    }
    assert.equal(bucketOf(dir,'127.0.0.1').length,10,'窗口封顶在限额（11 次未命中只记 10 条）');
    assert.equal((await phoneCall(host.port,'/pair',{method:'POST',body:{code:unknownCode(12)}})).status,403,
      '限速后未命中提交一律 403，文案不变');
    assert.equal(bucketOf(dir,'127.0.0.1').length,10,'被限速的提交不再追加');
    const blocked=await phoneCall(host.port,'/pair',{method:'POST',body:{code:codeB2}});
    assert.equal(blocked.status,403);
    assert.deepEqual(blocked.json,wrong.json,'窗口满与普通错误使用相同响应');
    assert.equal(readCodes(dir).codes.some(item=>item[0]===codeB2),true,'限流未消费有效码');
    assert.equal(bucketOf(dir,'127.0.0.1').length,10);
    assert.equal(pairingsFile().find(item=>item.user_id===USER_B).hash,sha256hex(tokenB1),'限流未改变 B 的绑定');

    // 发码不清窗（G-12/SD-H2，评审砍掉 --reset-window）：管理员发码后失败桶原样。
    const codeA3=issueCodeViaCli(dir,USER_A).stdout.trim();
    assert.equal(bucketOf(dir,'127.0.0.1').length,10,'发码不清窗');

    // 窗口过期自然恢复（G-4）：把本来源桶的失败回拨 16 分钟（等价于 15 分钟窗口滑过）。
    const state=readCodes(dir);
    state.failures['127.0.0.1']=state.failures['127.0.0.1'].map(at=>new Date(Date.parse(at)-16*60_000).toISOString());
    writeFileSync(join(dir,'pairing-codes.json'),JSON.stringify(state),{mode:0o600});
    const rescued=await phoneCall(host.port,'/pair',{method:'POST',body:{code:codeB2}});
    assert.equal(rescued.status,200,'窗口恢复后未过期的码可配对');
    assert.deepEqual(readCodes(dir).failures,{},'成功只清本来源桶');
    assert.deepEqual((await verify(rescued.json.token)).json,{paired:true});
    const pairedAgain=await phoneCall(host.port,'/pair',{method:'POST',body:{code:codeA3}});
    assert.equal(pairedAgain.status,200);
    assert.equal(pairingsFile().find(item=>item.user_id===USER_A).hash,sha256hex(pairedAgain.json.token));
    assert.equal(pairingsFile().find(item=>item.user_id===USER_B).hash,sha256hex(rescued.json.token));
    assert.equal((await phoneCall(host.port,'/pair',{method:'POST',body:{code:unknownCode(13)}})).status,403);
    assert.equal(bucketOf(dir,'127.0.0.1').length,1,'窗口清空后重新计数');
  } finally {cleanup();}
});

test('本地形态：连续五次配对失败锁住当前启动码',async t=>{
  const {dir,cleanup}=tempDir('along-local-pair-');
  try {
    const host=await spawnHost(t,{dir});
    await waitFor(()=>host.pairingCode(),'启动横幅出现通用码');
    const universal=host.pairingCode();
    assert.match(universal,/^\d{8}$/);
    const pairingsFile=()=>existsSync(join(dir,'pairings.json'))?JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8')):null;
    assert.equal(pairingsFile(),null);

    for (let seed=1;seed<=5;seed++) {
      const wrong=await phoneCall(host.port,'/pair',{method:'POST',body:{code:unknownCode(seed*7)}});
      assert.equal(wrong.status,403,`错误码 #${seed} 403`);
    }
    const paired=await phoneCall(host.port,'/pair',{method:'POST',body:{code:universal}});
    assert.equal(paired.status,403,'五次失败后连正确码也被拒绝');
    assert.deepEqual(paired.json,{error:'配对码无效或已过期'});
    assert.deepEqual(pairingsFile(),null,'拒绝后不产生绑定');
  } finally {cleanup();}
});
