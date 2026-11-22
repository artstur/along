import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSourceJournal} from '../host/source-event-bridge.mjs';
import {createDeviceSourceGateway,DeviceSourceError} from '../host/device-source-gateway.mjs';
import {okxDataDigest} from '../host/okx-history.mjs';
import {history,fill,END} from './fixtures/okx-history.mjs';

// 安全加固配对测试：M5 cloud-source-guard（docs/cloud-security-hardening.md §3.5 机制、§4-M5 验收标准）。
// 只按验收标准逐条断言，不迁就实现：
// - 验收 1（两条 test）：父目录有 users.json（云端多用户形态。生产布局即 agent-host.mjs:37/52：
//   loadUsers 读状态目录的 users.json 判形态，gateway 目录传 join(状态目录,'device-sources')，
//   故 gateway 根的父目录就是状态目录）时：publish 带 history（任意取值，含非法值）→
//   DeviceSourceError invalid_request（status 400），先于收据/去重/持久化（同一 eventId+sequence
//   已 accepted 后再带 history 仍是 invalid_request 而非 duplicate/event_conflict；拒绝后落盘
//   字节逐字节不变、无 ready 源事实，≤2MB 明细不可能落 device-sources/<hash>.json）；
//   不带 history → accepted，三字段摘要照常持久化，记录与 metadata 均无 history/capabilities。
// - 验收 2：同形态下读已存在的含 history 记录（如误拷贝的 Mac 文件）→ storage_unavailable
//   （status 503，fail-closed，与损坏记录同通道）；读后落盘字节不变、history 仍在——不静默剥字段。
//   含 history 记录由 Mac 形态 publish 产出（同 docs/okx-trade-history.md：history 与 summary
//   同一次原子 publish、digest 绑定，无法事后拼接），构造用「先 Mac 建 gateway 产出记录 →
//   父目录补 users.json → 新建 gateway 读」；并断言创建于 users.json 之前的旧 gateway 仍照常读
//   （形态判定按设计 §3.5 固化在创建时刻，无运行时开关），无记录的其他 scope 照常返回不存在。
// - 验收 3（两条 test）：无 users.json（Mac/测试形态）publish/read 行为与现状一致：
//   history 照常接收（capabilities 照常含 trading_history、digest 绑定 summary+history、
//   快照照常返回 history、status 视图无 history 键），畸形/篡改的存量 history 照旧
//   storage_unavailable（校验只加严不放宽）。既有用例不改语义通过这一点由
//   test/device-source-gateway.test.mjs 与 test/okx-history-bridge.test.mjs 原样保留、
//   随套件运行覆盖（本文件不重复其逐条断言）。
// - 验收 4：回归 npm run check 全绿——由套件运行本身覆盖（本文件就是 npm run check 的一部分；
//   node:test 不自递归再跑全套件，故不在本文件内断言这一条）。

const NOW=Date.parse(END)+1000;                       // history() 窗口 END 之后，publish 的 observedAt 合法
const SCOPE={userId:'u_deadbeef',deviceId:'d_deadbeef',goalId:'g_guard'};
const SUMMARY={tradingEquityUsd:125.5,assetCount:2,positionCount:1};
const USERS_JSON=JSON.stringify([{userId:'u_deadbeef',label:'配对测试用户'}])+'\n';  // pairing.mjs:21 的 userId 形态
// host/device-source-gateway.mjs:8-9 的错误文案与状态映射（验收标准点名的 400/503）
const STATUS={invalid_request:400,storage_unavailable:503};
const ERROR_TEXT={invalid_request:'设备数据请求无效。',storage_unavailable:'设备数据缓存暂不可用。'};

function fixture(t,{cloud=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'along-cloud-source-guard-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const journal=createSourceJournal({dir:join(dir,'journal'),now:()=>NOW});
  // 生产布局：gateway 根 = <状态目录>/device-sources，父目录即状态目录
  const cache=join(dir,'device-sources');
  if(cloud)writeFileSync(join(dir,'users.json'),USERS_JSON,{mode:0o600});
  const make=()=>createDeviceSourceGateway({dir:cache,journal,now:()=>NOW});
  const gateway=make();
  const handle=(input,extra={})=>gateway.handle({...SCOPE,input:{provider:'okx',...input},...extra});
  let opens=0;
  const open=async(requestId='open_'+(++opens),expectedGrantId=undefined)=>handle({action:'open',requestId,expectedGrantId:expectedGrantId===undefined?(await handle({action:'context'})).currentGrantId:expectedGrantId});
  const publish=(grantId,extra={},context={})=>handle({action:'publish',grantId,eventId:'event_1',sequence:1,observedAt:new Date(NOW).toISOString(),permission:'read_only',summary:{...SUMMARY},...extra},context);
  const storedBytes=()=>{const name=readdirSync(cache).find(name=>name.endsWith('.json'));return name===undefined?null:readFileSync(join(cache,name),'utf8');};
  return {dir,cache,journal,gateway,make,handle,open,publish,storedBytes};
}

async function error(promise,code){
  await assert.rejects(promise,e=>{
    assert.ok(e instanceof DeviceSourceError,'错误是 DeviceSourceError');
    assert.equal(e.code,code,`错误码应为 ${code}（实测 ${e?.code}）`);
    assert.equal(e.status,STATUS[code],`HTTP 状态应为 ${STATUS[code]}（验收点名的 ${code}）`);
    assert.equal(e.message,ERROR_TEXT[code],'用户文案为既有固定文案');
    assert.doesNotMatch(e.message,/u_deadbeef|g_guard|\.json|BTC-LEAKMARK/,'错误信息不含用户/目标标识、文件路径或明细内容');
    return true;
  });
}

// ---- 验收 1：云端形态 publish 带 history 一律 invalid_request（400），明细不落盘 ------------------

test('云端形态（验收 1）：publish 带 history 一律 invalid_request（400）——合法、空、非法取值 alike，且明细绝不落盘',async t=>{
  const f=fixture(t,{cloud:true}),{grantId}=await f.open();
  const marked={...history(),fills:[fill({instId:'BTC-LEAKMARK'})]};   // 合法且带可追踪标记的成交明细
  const before=f.storedBytes();
  assert.ok(before,'open 之后已有 pending 记录落盘');
  for (const extra of [{history:marked},{history:history({fills:[],bills:[]})},{history:null},{history:{}},{history:'<≤2MB 成交/账单明细>'},{history:42},{history:[]}]) {
    await error(f.publish(grantId,extra),'invalid_request');
    assert.equal((await f.handle({action:'status'})).state,'pending','拒绝不改变连接状态');
    assert.equal(f.storedBytes(),before,'拒绝后落盘字节逐字节不变（明细未持久化）');
  }
  assert.equal(f.journal.outbox(SCOPE.userId).filter(x=>x.state==='ready').length,0,'未产生任何 ready 源事实');
  assert.equal(readdirSync(f.cache).filter(n=>n.endsWith('.json')).length,1,'缓存目录只有 open 的记录，无任何明细文件');
  // 门在收据/去重之前：同一 eventId+sequence 已 accepted 后再带 history，仍是 invalid_request
  // 而非 duplicate/event_conflict（若先去重后拒收，指纹含 history digest，会落到 event_conflict）
  assert.deepEqual(await f.publish(grantId),{event_id:'event_1',status:'accepted'});
  await error(f.publish(grantId,{eventId:'event_1',sequence:1,history:marked}),'invalid_request');
  assert.equal((await f.handle({action:'status'})).state,'connected','带 history 的重发不改变已连接状态');
});

test('云端形态（验收 1）：publish 不带 history → accepted，三字段摘要照常持久化，记录与 metadata 无 history/capabilities，重启后照常读',async t=>{
  const f=fixture(t,{cloud:true}),{grantId}=await f.open();
  assert.deepEqual(await f.publish(grantId),{event_id:'event_1',status:'accepted'});
  assert.equal((await f.handle({action:'status'})).state,'connected','连接照常到 connected');
  const stored=JSON.parse(f.storedBytes());
  assert.equal(Object.hasOwn(stored,'history'),false,'落盘记录无 history 键');
  assert.equal(Object.hasOwn(stored.metadata,'capabilities'),false,'metadata 无 capabilities 键');
  assert.deepEqual(stored.summary,SUMMARY,'三字段摘要照常持久化');
  assert.deepEqual(Object.keys(stored.summary).sort(),['assetCount','positionCount','tradingEquityUsd']);
  assert.equal(stored.metadata.digest,okxDataDigest(SUMMARY,undefined),'digest 恰为无 history 的摘要绑定');
  assert.equal(stored.metadata.state,'ready');assert.equal(stored.admission,'accepted');
  const snapshot=await f.gateway.sourceSnapshot(SCOPE);
  assert.deepEqual(snapshot.summary,SUMMARY);assert.equal(Object.hasOwn(snapshot,'history'),false);
  assert.equal(Object.hasOwn(snapshot.metadata,'capabilities'),false);
  assert.ok((await f.handle({action:'status'})).summary,'status 视图照常带摘要');
  assert.equal(f.journal.outbox(SCOPE.userId).filter(x=>x.state==='ready').length,1,'照常产生一个 ready 源事实');
  // 同目录新建（仍云端形态）读干净记录照常工作：读路径只对含 history 的记录 fail-closed
  const reopened=f.make();
  assert.deepEqual((await reopened.sourceSnapshot(SCOPE)).summary,SUMMARY);
  assert.equal((await reopened.handle({...SCOPE,input:{provider:'okx',action:'status'}})).state,'connected');
});

// ---- 验收 2：云端形态读已存在的含 history 记录 → storage_unavailable（fail-closed）--------------

test('云端形态（验收 2）：读已存在的含 history 记录 → storage_unavailable（503）fail-closed，不静默剥字段；判定固化在创建时',async t=>{
  const f=fixture(t);                                  // 先无 users.json：Mac 形态产出含 history 的存量记录
  const {grantId}=await f.open(),H=history();
  assert.deepEqual(await f.publish(grantId,{history:H}),{event_id:'event_1',status:'accepted'});
  const bytesBefore=f.storedBytes(),storedBefore=JSON.parse(bytesBefore);
  assert.deepEqual(storedBefore.history,H,'存量记录确含 history（原子 publish 产出）');
  assert.deepEqual(storedBefore.metadata.capabilities,['trading_account_summary','trading_history']);
  // 父目录补 users.json → 同生产布局下新建的 gateway 判定为云端形态（如误拷贝 Mac 文件上云）
  writeFileSync(join(f.dir,'users.json'),USERS_JSON,{mode:0o600});
  const cloudGateway=f.make();
  await error(cloudGateway.sourceSnapshot(SCOPE),'storage_unavailable');
  await error(cloudGateway.handle({...SCOPE,input:{provider:'okx',action:'status'}}),'storage_unavailable');
  await error(cloudGateway.handle({...SCOPE,input:{provider:'okx',action:'context'}}),'storage_unavailable');
  assert.throws(()=>cloudGateway.hasScope(SCOPE),e=>e instanceof DeviceSourceError&&e.code==='storage_unavailable'&&e.status===503,'hasScope 同样 fail-closed');
  assert.equal(cloudGateway.hasScope('u_00000000','g_other'),false,'无记录的其他 scope 照常返回不存在——503 只落在含 history 的记录上');
  // fail-closed 而非静默剥字段：字节不变、history 仍在
  assert.equal(f.storedBytes(),bytesBefore,'读失败后落盘字节不变');
  assert.deepEqual(JSON.parse(f.storedBytes()).history,H,'history 未被剥离');
  // 形态判定一次性固化：创建于 users.json 之前的旧 gateway 仍按 Mac 形态照常读
  assert.deepEqual((await f.gateway.sourceSnapshot(SCOPE)).history,H,'旧 gateway（Mac 形态判定）不受新 users.json 影响');
});

// ---- 验收 3：无 users.json（Mac/测试形态）publish/read 行为与现状一致 ----------------------------

test('Mac/测试形态（验收 3）：无 users.json 时 publish/read 与现状一致——history 照常收，capabilities 照常带，快照照常返回 history',async t=>{
  const f=fixture(t);
  const first=await f.open();
  assert.deepEqual(await f.publish(first.grantId,{eventId:'plain_1'}),{event_id:'plain_1',status:'accepted'},'不带 history 的 publish 照常 accepted');
  const plain=JSON.parse(f.storedBytes());
  assert.equal(Object.hasOwn(plain,'history'),false);assert.equal(Object.hasOwn(plain.metadata,'capabilities'),false);
  const second=await f.open('open_hist');
  assert.deepEqual(await f.publish(second.grantId,{eventId:'hist_1',history:history()}),{event_id:'hist_1',status:'accepted'},'带 history 的 publish 照常 accepted（现状）');
  const stored=JSON.parse(f.storedBytes());
  assert.deepEqual(stored.history,history(),'history 原样持久化');
  assert.deepEqual(stored.metadata.capabilities,['trading_account_summary','trading_history'],'capabilities 照常含 trading_history');
  assert.equal(stored.metadata.digest,okxDataDigest(SUMMARY,history()),'digest 照常绑定 summary+history');
  assert.deepEqual((await f.gateway.sourceSnapshot(SCOPE)).history,history(),'快照照常返回 history');
  assert.equal(Object.hasOwn(await f.handle({action:'status'}),'history'),false,'status 视图照常无 history 键');
  const reopened=f.make();                             // 重启（仍无 users.json）后照常读
  assert.deepEqual((await reopened.sourceSnapshot(SCOPE)).history,history());
});

test('Mac/测试形态（验收 3）：存量记录的畸形/篡改 history 照旧 storage_unavailable——校验只加严不放宽',async t=>{
  const f=fixture(t),{grantId}=await f.open();
  await f.publish(grantId,{history:history()});
  const file=join(f.cache,readdirSync(f.cache).find(name=>name.endsWith('.json'))),good=f.storedBytes();
  const tamper=patch=>{writeFileSync(file,patch);chmodSync(file,0o600);};   // 保持 0600，保证拒收只来自 history 校验
  tamper(JSON.stringify({...JSON.parse(good),history:{version:1}}));
  await error(f.handle({action:'status'}),'storage_unavailable');
  await error(f.gateway.sourceSnapshot(SCOPE),'storage_unavailable');
  tamper(good);
  assert.deepEqual((await f.gateway.sourceSnapshot(SCOPE)).history,history(),'还原后照常读');
  tamper(JSON.stringify({...JSON.parse(good),history:null}));
  await error(f.handle({action:'status'}),'storage_unavailable');
});
