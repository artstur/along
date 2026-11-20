import {createHash, randomBytes, randomInt, randomUUID, timingSafeEqual} from 'node:crypto';
import {readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {lock} from 'proper-lockfile';
import {HostError} from './host-error.mjs';

// 多用户配对（docs/cloud-deploy-multi-user.md §3.2，M1）。三个文件都在 host 状态目录：
// - pairings.json：绑定表（数组，每用户一条 {hash,user_id,device_id}，0600）；旧单对象 pairing.json
//   启动时幂等升级为一元数组。authorized() 在这张表里按 SHA-256 查找，返回请求自己的绑定。
// - users.json：静态用户表（部署者写入，0600）：[{"userId":"u_xxxxxxxx","label":"…"}]。
//   配置云端 Runner 时必填。启动时存在用户表即选择多用户形态，不生成通用码。
// - pairing-codes.json（0600，原子写替换）：顶层 failures:[ISO 时间戳]（全局失败滑动窗口）与
//   码数组 [code,userId,expiresAt]。CLI（host/pair-code.mjs）与 server 靠这个文件交接，/pair
//   每次调用重读，不在启动时缓存。CLI 与 Host 获取同一个文件锁后才读、修改并替换状态文件。

const USER_ID_RE=/^u_[0-9a-f]{8}$/,DEVICE_ID_RE=/^d_[0-9a-f]{8}$/,HASH_RE=/^[a-f0-9]{64}$/;
export const CODE_TTL_MS=15*60_000;

export const stateDir=()=>process.env.ALONG_AGENT_STATE_DIR||join(homedir(),'.along','agent-host');
export const newBoundId=prefix=>prefix+randomBytes(4).toString('hex');

// 全局失败窗口限额：默认 10，ALONG_PAIR_FAIL_LIMIT 只许调严（更大的值一律按 10）。
export function failLimitFromEnv(env=process.env) {
  const value=Number(env.ALONG_PAIR_FAIL_LIMIT);
  return Number.isInteger(value)&&value>=1?Math.min(value,10):10;
}

// ---- 用户表 ----

// 返回 userId 数组；users.json 不存在 → null（本地单用户形态）。
export function loadUsers(dir) {
  let raw;
  try { raw=readFileSync(join(dir,'users.json'),'utf8'); }
  catch (error) { if (error.code==='ENOENT') return null; throw error; }
  let users;
  try {users=JSON.parse(raw);}
  catch {throw Error('users.json 不是有效的 JSON');}
  if (!Array.isArray(users)||users.length===0) throw Error('users.json 必须是形如 [{"userId":"u_xxxxxxxx"}] 的非空数组');
  const seen=new Set();
  for (const item of users) {
    if (!item||typeof item!=='object'||Array.isArray(item)||typeof item.userId!=='string'||!USER_ID_RE.test(item.userId)) throw Error('users.json 的 userId 无效');
    if (seen.has(item.userId)) throw Error('users.json 的 userId 重复');
    seen.add(item.userId);
  }
  return [...seen];
}

// ---- 绑定表 ----

// 读取绑定表；旧单对象 pairing.json（仅 hash）幂等升级为一元数组并补齐 user_id/device_id：
// 配对 token 不变、手机无感（对齐 stage-a-tech-design.md §五-1 的既有升级手法）。升级后移除旧文件。
export function loadPairings(dir) {
  let entries=null,legacy=false,dirty=false;
  try { entries=JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8')); }
  catch (error) {
    if (error.code!=='ENOENT') throw error;
    try { entries=JSON.parse(readFileSync(join(dir,'pairing.json'),'utf8')); legacy=true; }
    catch (legacyError) { if (legacyError.code!=='ENOENT') throw legacyError; }
  }
  if (entries===null) return [];
  if (!Array.isArray(entries)) { entries=[entries]; dirty=true; }
  const upgraded=[];
  for (const entry of entries) {
    if (!entry||typeof entry!=='object'||Array.isArray(entry)||!HASH_RE.test(entry.hash??'')) { dirty=true; continue; }
    const ids=USER_ID_RE.test(entry.user_id??'')&&DEVICE_ID_RE.test(entry.device_id??'')
      ?{user_id:entry.user_id,device_id:entry.device_id}
      :(dirty=true,{user_id:USER_ID_RE.test(entry.user_id??'')?entry.user_id:newBoundId('u_'),
        device_id:DEVICE_ID_RE.test(entry.device_id??'')?entry.device_id:newBoundId('d_')});
    upgraded.push({hash:entry.hash,...ids});
  }
  if (dirty||legacy) savePairings(dir,upgraded);
  if (legacy) { try { unlinkSync(join(dir,'pairing.json')); } catch (error) { if (error.code!=='ENOENT') throw error; } }
  return upgraded;
}

// 原子写：temp 写 + renameSync 替换（参照 host/daily-action-history.mjs 的手法）。
export function savePairings(dir,entries) {
  writeJsonAtomically(join(dir,'pairings.json'),entries);
}

// 按表鉴权：服务端只存 SHA-256，逐条 timingSafeEqual，命中返回该请求自己的绑定，未命中 null。
export function findPairing(entries,token) {
  const digest=createHash('sha256').update(token).digest();
  for (const entry of entries) {
    const stored=Buffer.from(entry.hash,'hex');
    if (stored.length===digest.length&&timingSafeEqual(stored,digest)) return entry;
  }
  return null;
}

// ---- 配对码与全局失败滑动窗口 ----

function readCodeState(dir) {
  let state;
  try { state=JSON.parse(readFileSync(join(dir,'pairing-codes.json'),'utf8')); }
  catch (error) { if (error.code==='ENOENT') return {failures:[],codes:[]}; throw error; }
  if (!state||typeof state!=='object'||Array.isArray(state)||!Array.isArray(state.failures)||!Array.isArray(state.codes)) throw Error('pairing-codes.json 格式无效');
  return state;
}

function writeCodeState(dir,state) {
  writeJsonAtomically(join(dir,'pairing-codes.json'),state);
}

function writeJsonAtomically(file,value) {
  const temporary=file+'.'+randomUUID();
  writeFileSync(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});
  try {renameSync(temporary,file);}
  catch (error) {
    try { unlinkSync(temporary); } catch { /* Keep the write error. */ }
    throw error;
  }
}

async function withCodeStateLock(dir,operation) {
  let release;
  try {
    // Lock the stable path even when the state file does not yet exist or is atomically replaced.
    release=await lock(join(dir,'pairing-codes.json'),{
      realpath:false,stale:10_000,retries:{retries:12,factor:1,minTimeout:50,maxTimeout:50},
    });
  } catch (error) {
    if (error.code==='ELOCKED') throw new HostError('配对状态正在更新，请稍后重试',503);
    throw error;
  }
  try { return operation(); }
  finally { await release(); }
}

function pruneCodeState(state,now) {
  const cutoff=now-CODE_TTL_MS;
  state.failures=state.failures.filter(timestamp=>Date.parse(timestamp)>cutoff);
  state.codes=state.codes.filter(code=>Array.isArray(code)&&code[2]>now);
  return state;
}

// CLI 发码（host/pair-code.mjs）：确认用户后开启新失败窗口，保留所有未过期码。
// 返回明文码，经 docker exec 终端交给部署者（输出不进容器日志，§3.7）。
export function issuePairingCode(dir,userId,now) {
  return withCodeStateLock(dir,()=>{
    const users=loadUsers(dir);
    if (!users) throw Error('users.json 不存在：多用户发码需要静态用户表');
    if (!users.includes(userId)) throw Error(`users.json 中没有用户 ${userId}`);
    const at=now??Date.now();
    const state=pruneCodeState(readCodeState(dir),at);
    let code;
    do { code=String(randomInt(10000000,99999999)); } while (state.codes.some(item=>item[0]===code));
    state.codes.push([code,userId,at+CODE_TTL_MS]);
    state.failures=[];
    writeCodeState(dir,state);
    return code;
  });
}

// /pair 先检查全局失败窗口，满窗时拒绝所有码且不写回。未命中则追加失败，命中则用后删码并清空窗口。
// 码有效但用户已不在本次重读的 users.json 里 → 不消费、不计失败（部署者改表后同一码仍可用）。
export function consumeUserCode(dir,code,limit,now) {
  return withCodeStateLock(dir,()=>{
    let allowedUsers;
    try {allowedUsers=loadUsers(dir);}
    catch {throw new HostError('配对用户表未就绪，请稍后重试',503);}
    if (!allowedUsers) throw new HostError('配对用户表未就绪，请稍后重试',503);
    const at=now??Date.now();
    const state=pruneCodeState(readCodeState(dir),at);
    if (state.failures.length>=limit) return {ok:false};
    const index=typeof code==='string'?state.codes.findIndex(item=>item[0]===code):-1;
    if (index<0) {
      state.failures.push(new Date(at).toISOString());
      writeCodeState(dir,state);
      return {ok:false};
    }
    const userId=state.codes[index][1];
    if (!allowedUsers.includes(userId)) return {ok:false};
    state.codes.splice(index,1);
    state.failures=[];
    writeCodeState(dir,state);
    return {ok:true,userId};
  });
}
