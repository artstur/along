import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';
import {KEY as HEALTH_KEY} from '../web/health.mjs';
import {ADAPTIVE_LAYOUTS_KEY} from '../web/adaptive-ui.mjs';
import {AGENT_KEY, GOALS_KEY} from '../web/agent-client.mjs';
import {AGENT_RUNTIME_KEY, DSH_RUNTIME} from '../web/super-agent.mjs';

// 升级到 CA 形态时的本地状态迁移（docs/iphone-ca-profile-design.md §2.2）。
//
// 旧 App 的本地连接是 {baseURL, fingerprint, token}；升级当次原生回填了 bindingScopeId。
// 那是同一台设备、同一个 origin、同一个 token 的口径升级，不是换用户、也不是换端。
// 本文件钉住三条边界：
//   1. 同一绑定升级 → 每日委托授权与提醒时间原样保留；
//   2. 真实换端 → 仍然隔离（委托被撤销、事件工作区断开）；
//   3. 用户主动撤销过的授权 → 升级不恢复。

const SHARE_KEY='along.health-sharing.v1';
const AGENT_RUNTIME=DSH_RUNTIME;
const OLD_CONFIG={baseURL:'https://192.168.1.2:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};
const NEW_CONFIG={...OLD_CONFIG,bindingScopeId:'scope-upgraded'};
const OTHER_CONFIG={baseURL:'https://192.168.1.9:4176',fingerprint:'A'.repeat(64),token:'b'.repeat(64),bindingScopeId:'scope-other'};
const grant={id:'dlg_old',goalKey:'health',topics:['sleep','workout'],weeklyWorkoutMinutes:180};
const layout={version:1,title:'我的健康目标',summary:'按已确认的目标提醒',modules:[],questions:[],
  tasks:[{id:'wind-down',when:'今晚',title:'睡前收尾提醒',detail:'按你确认的时间提醒。',state:'planned'}]};
const snapshot={contextReviewAllowed:true,selectedTypes:['sleep','workout'],capturedAt:'2026-11-11T04:00:00Z'};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
let instance=0;

async function browser({storage={},connection}={}) {
  const dom=installDomStub({storage:{
    [HEALTH_KEY]:JSON.stringify({version:1,source:'healthkit',snapshot,goals:[]}),
    [ADAPTIVE_LAYOUTS_KEY]:JSON.stringify({health:layout}),
    [GOALS_KEY]:JSON.stringify({health:{title:'我的健康目标',intent:'平均每天睡 8 小时'}}),
    [AGENT_KEY]:JSON.stringify(OLD_CONFIG),[AGENT_RUNTIME_KEY]:AGENT_RUNTIME,
    ...storage,
  }});
  window.dispatchEvent=event=>dom.fireWindow(event.type,event);
  const submits=[];
  window.AlongAgentBridge={
    ...(connection?{connection}:{}),
    request({path,body}) {
      if (path==='/connection/status') return Promise.resolve({along:true,runtime:DSH_RUNTIME,ready:true});
      if (path==='/super-agent/goals') {
        return new Promise((resolve,reject)=>submits.push({body,resolve,reject}));
      }
      throw Error('unexpected Agent route '+path);
    },
    async notification() { return {scheduled:true}; },
  };
  await import('../web/app.mjs?upgrade-migration='+ ++instance);
  await settle();
  return {...dom,submits,read:key=>JSON.parse(dom.storage.get(key))};
}

// 旧 App 的本地状态：连接记录没有 bindingScopeId，每日委托的接收人是旧的归属键。
function legacyStorage({recipient=OLD_CONFIG.token,revokedIds,revokedAt}={}) {
  const sharing={dailyDelegation:grant,dailyRecipient:recipient};
  if (revokedIds) sharing.dailyRevokedIds=revokedIds;
  if (revokedAt) sharing.dailyRevokedAt=revokedAt;
  return {[SHARE_KEY]:JSON.stringify(sharing)};
}

test('upgrading the same binding keeps the daily delegation and its reminder time instead of silently revoking it',async()=>{
  const app=await browser({
    storage:legacyStorage(),
    // 原生在升级后回填 bindingScopeId（AlongConnectionStore.clean）。
    connection:async action=>action==='load'?NEW_CONFIG:NEW_CONFIG,
  });
  await settle();
  const sharing=app.read(SHARE_KEY);
  assert.equal(sharing.dailyDelegation?.id,grant.id,'升级后每日委托授权仍在');
  assert.equal(sharing.dailyRecipient,NEW_CONFIG.bindingScopeId,'接收人迁到新的归属键');
  assert.ok(!sharing.dailyRevokedIds?.includes(grant.id),'升级不应把授权写进撤销名单');
  assert.equal(sharing.dailyRevokedAt,undefined,'升级不应留下撤销时间戳');
  // 授权内容原样保留：主题与每周运动分钟都没变。
  assert.deepEqual(sharing.dailyDelegation.topics,grant.topics);
  assert.equal(sharing.dailyDelegation.weeklyWorkoutMinutes,grant.weeklyWorkoutMinutes);
});

test('a real endpoint change still isolates: the daily delegation is revoked and the event connection dropped',async()=>{
  const app=await browser({
    storage:{...legacyStorage(),'along.event-connection.v1':JSON.stringify({userId:'u_a',bindingScopeId:'scope-old'})},
    connection:async()=>OTHER_CONFIG,
  });
  await settle();
  const sharing=app.read(SHARE_KEY);
  assert.equal(sharing.dailyDelegation,undefined,'真换端仍然撤销每日委托');
  assert.ok(sharing.dailyRevokedIds?.includes(grant.id),'真换端的撤销写入撤销名单');
  assert.equal(app.read('along.event-connection.v1'),null,'真换端断开事件工作区绑定');
});

test('a token change on the same host is a real endpoint change and still revokes the daily delegation',async()=>{
  const app=await browser({
    storage:legacyStorage(),
    connection:async()=>({...NEW_CONFIG,token:'c'.repeat(64)}),
  });
  await settle();
  const sharing=app.read(SHARE_KEY);
  assert.equal(sharing.dailyDelegation,undefined,'换 token 是换端，委托被撤销');
  assert.ok(sharing.dailyRevokedIds?.includes(grant.id));
});

test('two different hosts over plain http are not treated as the same binding',async()=>{
  // 复核报告实测：originOf 对任何非 https 的地址一律返回空串，
  // 于是两个不同的 http host 都被折叠成同一个空 origin，被判成「同一绑定」——
  // 既不撤销每日委托，也不隔离事件工作区。解析不出 origin 时必须按「不是同一绑定」处理。
  // 前提：旧记录与新配置都是非 https，两边才会折叠成同一个值。
  const httpOld={baseURL:'http://a.example.com',fingerprint:'A'.repeat(64),token:'b'.repeat(64)};
  const app=await browser({
    storage:{
      ...legacyStorage(),
      [AGENT_KEY]:JSON.stringify(httpOld),
      'along.event-connection.v1':JSON.stringify({userId:'u_a',bindingScopeId:'scope-old'}),
    },
    connection:async()=>({baseURL:'http://b.example.com',fingerprint:'A'.repeat(64),token:'b'.repeat(64)}),
  });
  await settle();
  const sharing=app.read(SHARE_KEY);
  assert.equal(sharing.dailyDelegation,undefined,'不同 host 之间不得保留委托');
  assert.ok(sharing.dailyRevokedIds?.includes(grant.id),'不同 host 视为换端，委托被撤销');
  assert.equal(app.read('along.event-connection.v1'),null,'不同 host 断开事件工作区绑定');
});

test('a delegation the user explicitly withdrew is never restored by the upgrade',async()=>{
  const app=await browser({
    // 用户主动撤销：授权已从 sharing 里删掉，并留在撤销名单里。
    storage:{[SHARE_KEY]:JSON.stringify({dailyRevokedIds:['dlg_old'],dailyRevokedAt:Date.now()-1000})},
    connection:async()=>NEW_CONFIG,
  });
  await settle();
  const sharing=app.read(SHARE_KEY);
  assert.equal(sharing.dailyDelegation,undefined,'用户撤销过的授权不被升级恢复');
  assert.deepEqual(sharing.dailyRevokedIds,['dlg_old'],'撤销名单保持原样');
});

test('a revoked delegation id is not migrated back even when a stale grant is still present in storage',async()=>{
  const app=await browser({
    // 存储里同时有 grant 与撤销名单：撤销优先，升级不得把它迁回生效。
    storage:legacyStorage({revokedIds:['dlg_old'],revokedAt:Date.now()-1000}),
    connection:async()=>NEW_CONFIG,
  });
  await settle();
  const sharing=app.read(SHARE_KEY);
  assert.equal(sharing.dailyRecipient,OLD_CONFIG.token,'已撤销的授权不迁接收人键');
  assert.ok(sharing.dailyRevokedIds?.includes('dlg_old'));
});
