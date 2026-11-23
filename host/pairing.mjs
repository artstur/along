import {createHash, randomBytes, randomInt, randomUUID, timingSafeEqual} from 'node:crypto';
import {readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {lock} from 'proper-lockfile';
import {HostError} from './host-error.mjs';

// 多用户配对（docs/cloud-deploy-multi-user.md §3.2，M1；加固机制见 docs/cloud-security-hardening.md §3.1）。
// 三个文件都在 host 状态目录：
// - pairings.json：绑定表（数组，每用户一条 {hash,user_id,device_id[,expiresAt]}，0600）；旧单对象
//   pairing.json 启动时幂等升级为一元数组。authorized() 在这张表里按 SHA-256 查找，返回请求自己的绑定。
//   文件即绑定的唯一事实来源（SD-H15）：readPairings 每请求纯读，缺失/损坏按空表 fail-closed
//   （全部 401，重新发码配对自愈）；写侧共用 withPairingsLock（锁内重读 → 改 → 原子替换）。
// - users.json：静态用户表（部署者写入，0600）：[{"userId":"u_xxxxxxxx","label":"…"}]。
//   配置云端 Runner 时必填。启动时存在用户表即选择多用户形态，不生成通用码。
// - pairing-codes.json（0600，原子写替换）：failures 是按来源（归一化连接 IP）分桶的失败滑动窗口
//   {<source>:["ISO",…]}（旧全局数组格式读到即视为空——15 分钟 TTL 使迁移无意义，G-4），码数组
//   [code,userId,expiresAt]。CLI（host/pair-code.mjs）与 server 靠这个文件交接，/pair 每次调用重读，
//   不在启动时缓存。CLI 与 Host 获取同一个文件锁后才读、修改并替换状态文件。

const USER_ID_RE=/^u_[0-9a-f]{8}$/,DEVICE_ID_RE=/^d_[0-9a-f]{8}$/,HASH_RE=/^[a-f0-9]{64}$/;
export const CODE_TTL_MS=15*60_000;
// 绑定生命周期（G-5）：30 天滑动过期，剩余不足 7 天的成功请求续期一轮。过期/续期只在多用户形态
// 生效（SD-H3），Mac 本地行为不变；无 expiresAt 的既有绑定永不过期（grandfathered）。
export const BINDING_TTL_MS=30*24*60*60_000;
export const BINDING_RENEW_AHEAD_MS=7*24*60*60_000;
// 失败窗口桶键上限（G-4）：满 128 个来源 FIFO 淘汰最旧来源，文件体积有界。
const FAILURE_SOURCE_LIMIT=128;

export const stateDir=()=>process.env.ALONG_AGENT_STATE_DIR||join(homedir(),'.along','agent-host');
export const newBoundId=prefix=>prefix+randomBytes(4).toString('hex');

// 失败窗口限额：默认 10，ALONG_PAIR_FAIL_LIMIT 只许调严（更大的值一律按 10）。
// 语义不变，作用域变为每来源（G-4）。
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

// 每请求纯读（G-5/SD-H15）：pairings.json 是绑定的唯一事实来源。文件缺失、损坏或不可读一律按空表
// 处理——fail-closed：全部 401，重新发码配对自愈（与 pairing-codes.json 缺失同语义）；不做内存兜底，
// 兜底快照会让吊销与过期无法即时生效（本机制的核心目标）。合法条目过滤、无副作用。
//
// expiresAt 的两种情况要分开看（复核报告实测）：
//   - 字段缺失 → 既有绑定永不过期（grandfathered，SD-H3）：照常返回，由调用方按形态决定。
//   - 字段存在但不是有限数值（"not-a-number"、null、字符串、NaN）→ 显式非法，必须拒绝授权。
//     旧实现把非法值「丢弃成没有」，等于把非法条目当成永不过期——那是把显式错误读成了宽容。
//     现在这类条目直接不进表，请求按未命中处理（401），重新发码配对自愈。
export function readPairings(dir) {
  let entries;
  try { entries=JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8')); }
  catch { return []; }
  if (!Array.isArray(entries)) return [];
  const valid=[];
  for (const entry of entries) {
    if (!entry||typeof entry!=='object'||Array.isArray(entry)) continue;
    if (!HASH_RE.test(entry.hash??'')||!USER_ID_RE.test(entry.user_id??'')||!DEVICE_ID_RE.test(entry.device_id??'')) continue;
    // 显式给了 expiresAt 却不合法 → 拒绝该条目（不授权）。
    if (Object.hasOwn(entry,'expiresAt')&&!Number.isFinite(entry.expiresAt)) continue;
    valid.push({hash:entry.hash,user_id:entry.user_id,device_id:entry.device_id,
      ...(Number.isFinite(entry.expiresAt)?{expiresAt:entry.expiresAt}:{})});
  }
  return valid;
}

// 读取绑定表；旧单对象 pairing.json（仅 hash）幂等升级为一元数组并补齐 user_id/device_id：
// 配对 token 不变、手机无感（对齐 stage-a-tech-design.md §五-1 的既有升级手法）。升级后移除旧文件。
// expiresAt 随条目透传（G-5），只在合法数值时保留；字段存在但非法的条目整条丢弃
// （显式非法不授权），字段缺失的既有条目照常保留（永不过期，grandfathered）。
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
    if (Object.hasOwn(entry,'expiresAt')&&!Number.isFinite(entry.expiresAt)) { dirty=true; continue; }
    const ids=USER_ID_RE.test(entry.user_id??'')&&DEVICE_ID_RE.test(entry.device_id??'')
      ?{user_id:entry.user_id,device_id:entry.device_id}
      :(dirty=true,{user_id:USER_ID_RE.test(entry.user_id??'')?entry.user_id:newBoundId('u_'),
        device_id:DEVICE_ID_RE.test(entry.device_id??'')?entry.device_id:newBoundId('d_')});
    upgraded.push({hash:entry.hash,...ids,...(Number.isFinite(entry.expiresAt)?{expiresAt:entry.expiresAt}:{})});
  }
  if (dirty||legacy) savePairings(dir,upgraded);
  if (legacy) { try { unlinkSync(join(dir,'pairing.json')); } catch (error) { if (error.code!=='ENOENT') throw error; } }
  return upgraded;
}

// 原子写：temp 写 + renameSync 替换（参照 host/daily-action-history.mjs 的手法）。
export function savePairings(dir,entries) {
  writeJsonAtomically(join(dir,'pairings.json'),entries);
}

// 跨进程状态锁（码状态与绑定表共用）：CLI 与 Host 获取同一把稳定路径的锁后才读、改、原子替换，
// 消除跨进程读写竞态（bugfix-goal-prompt §7「原子替换不能保护跨进程的读改写」）。
// 绑定写侧（G-5/SD-H4）：/pair 绑定写入、滑动续期、revokePairing 都经 withPairingsLock 取锁。
async function withStateLock(file,lockedMessage,operation) {
  let release;
  try {
    // Lock the stable path even when the state file does not yet exist or is atomically replaced.
    release=await lock(file,{realpath:false,stale:10_000,retries:{retries:12,factor:1,minTimeout:50,maxTimeout:50}});
  } catch (error) {
    if (error.code==='ELOCKED') throw new HostError(lockedMessage,503);
    throw error;
  }
  try { return operation(); }
  finally { await release(); }
}

export function withPairingsLock(dir,operation) {
  return withStateLock(join(dir,'pairings.json'),'配对绑定正在更新，请稍后重试',operation);
}

// 吊销（G-5）：删除该用户的绑定条目**与未消费的配对码**，返回是否确有绑定被删（没有 → CLI exit 1）。
// 被吊销 token 的下一个请求按未命中处理 → 401，host 无需重启。
//
// 未消费码必须一并吊销（docs/iphone-ca-profile-design.md §6「服务端吊销该用户 token 及未消费配对码」、
// §8 T18「吊销覆盖该用户旧码」）：只删绑定表的话，吊销前发给该用户、还没用掉的码仍然能换出
// 一枚新 token——实测可复现，等于吊销没有真正生效。
//
// 绑定表与码表是两个文件、两把锁：先在码表锁内删掉该用户的未消费码（原子替换），
// 再在绑定表锁内删绑定。两个文件各自原子替换，顺序是先码后绑定——
// 万一中途失败，最多留下「码已删但绑定还在」的保守状态（用户需要重新发码），
// 而不是「绑定已删但码还能用」的漏状态。
export async function revokePairing(dir,userId) {
  const revokedCodes=await withCodeStateLock(dir,()=>{
    const state=readCodeState(dir);
    const codes=state.codes.filter(code=>!Array.isArray(code)||code[1]!==userId);
    if(codes.length!==state.codes.length) {
      state.codes=codes;
      writeCodeState(dir,state);
      return true;
    }
    return false;
  });
  const revokedBinding=await withPairingsLock(dir,()=>{
    const entries=readPairings(dir);
    if (!entries.some(item=>item.user_id===userId)) return false;
    savePairings(dir,entries.filter(item=>item.user_id!==userId));
    return true;
  });
  return revokedBinding||revokedCodes;
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

// ---- 配对码与按来源失败滑动窗口 ----

function readCodeState(dir) {
  let state;
  try { state=JSON.parse(readFileSync(join(dir,'pairing-codes.json'),'utf8')); }
  catch (error) { if (error.code==='ENOENT') return {failures:{},codes:[]}; throw error; }
  if (!state||typeof state!=='object'||Array.isArray(state)||!Array.isArray(state.codes)) throw Error('pairing-codes.json 格式无效');
  // 旧格式 failures:[ISO,…]（全局单计数器）读到即视为空：15 分钟滑动窗口使迁移无意义（G-4 按来源分桶）。
  const failures=Array.isArray(state.failures)?{}
    :state.failures&&typeof state.failures==='object'&&!Array.isArray(state.failures)?state.failures:{};
  return {failures,codes:state.codes};
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

function withCodeStateLock(dir,operation) {
  return withStateLock(join(dir,'pairing-codes.json'),'配对状态正在更新，请稍后重试',operation);
}

// 每来源桶内淘汰 15 分钟前的失败；清空的桶一并移除——窗口过期即自然恢复（G-4）。
function pruneCodeState(state,now) {
  const cutoff=now-CODE_TTL_MS;
  const failures={};
  for (const [source,times] of Object.entries(state.failures)) {
    if (!Array.isArray(times)) continue;
    const live=times.filter(timestamp=>Date.parse(timestamp)>cutoff);
    if (live.length) failures[source]=live;
  }
  state.failures=failures;
  state.codes=state.codes.filter(code=>Array.isArray(code)&&code[2]>now);
  return state;
}

// CLI 发码（host/pair-code.mjs）：保留所有未过期码。发码不清窗（G-12/SD-H2）——按来源分桶后
// 「发码清窗刷新攻击者配额」不复存在（攻击者只能烧自己的桶），也不设清窗入口；与攻击者同 IP 的
// 合法设备最长等 15 分钟窗口自然过期。返回明文码，经 docker exec 终端交给部署者（输出不进容器日志，§3.7）。
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
    writeCodeState(dir,state);
    return code;
  });
}

// /pair 验码（G-4/G-12/G-14）：失败窗口按来源（归一化连接 IP）分桶。满窗时对该来源统一拒绝
// （不验码、不写盘，保持码未消费——SD-7 语义按来源成立）；未命中才把失败计入该来源桶（桶键数
// 上限 128，FIFO 淘汰最旧来源）；命中消费成功时只清该来源自己的桶。码有效但用户已不在本次重读的
// users.json 里 → 不消费、不计失败（部署者改表后同一码仍可用）。reason 供 /pair 审计区分（G-15）。
export function consumeUserCode(dir,code,limit,now,source) {
  const sourceKey=typeof source==='string'&&source?source:'unknown';
  return withCodeStateLock(dir,()=>{
    let allowedUsers;
    try {allowedUsers=loadUsers(dir);}
    catch {throw new HostError('配对用户表未就绪，请稍后重试',503);}
    if (!allowedUsers) throw new HostError('配对用户表未就绪，请稍后重试',503);
    const at=now??Date.now();
    const state=pruneCodeState(readCodeState(dir),at);
    if ((state.failures[sourceKey]?.length??0)>=limit) return {ok:false,reason:'window_full'};
    const index=typeof code==='string'?state.codes.findIndex(item=>item[0]===code):-1;
    if (index<0) {
      const bucket=state.failures[sourceKey]??[];
      bucket.push(new Date(at).toISOString());
      if (!(sourceKey in state.failures)&&Object.keys(state.failures).length>=FAILURE_SOURCE_LIMIT) {
        delete state.failures[Object.keys(state.failures)[0]];
      }
      state.failures[sourceKey]=bucket;
      writeCodeState(dir,state);
      return {ok:false,reason:'unknown'};
    }
    const userId=state.codes[index][1];
    if (!allowedUsers.includes(userId)) {
      // 不消费、不计失败（部署者改表后同一码仍可用）；把随 15 分钟窗口自然过期的桶落盘淘汰。
      writeCodeState(dir,state);
      return {ok:false,reason:'user_missing'};
    }
    state.codes.splice(index,1);
    delete state.failures[sourceKey];
    writeCodeState(dir,state);
    return {ok:true,userId};
  });
}
