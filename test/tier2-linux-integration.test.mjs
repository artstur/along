import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import https from 'node:https';
import {DatabaseSync} from 'node:sqlite';
import {makeTestCa, stageRelease} from './cloud-ca-fixture.mjs';

// Tier 2 的隔离 Linux 集成验证（docs/cloud-deploy-multi-user.md §3.5，验证项 V-1）。
//
// 单元测试锁不住编排契约的**真实**行为：镜像能不能构建、容器能不能常驻、
// 3082 是否真的不对外、事件能不能跨 TLS 入口落库、投递泵会不会在重启后把待投递行误过滤。
// 这些只能在隔离 Linux Compose 里跑真实容器才验得了。
//
// 本文件用**真实** docker compose 跑一套隔离栈（host + superagent），用合成双用户
// 与合成 CA 走完：TLS 入口 → 事件同步 → 后台投递 → 重启恢复。
//
// 门控：
//   - 没有可用 Docker 时整体跳过（本机/CI 常见）；
//   - 默认**不**跑（耗时且要构建镜像），用 ALONG_TIER2_INTEGRATION=1 显式开启。
//     `npm run check` 不带这个变量，所以普通开发与 CI 不受它的耗时影响。
// 隔离性：全部状态落在仓库内的临时目录（.tier2-integration/），端口用固定高位，
// 不碰仓库外的真实部署目录，也不碰生产 secret。

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const DEPLOY_DIR=join(ROOT,'deploy');
const COMPOSE_FILE=join(DEPLOY_DIR,'docker-compose.yml');
const COMPOSE_TIER2=join(DEPLOY_DIR,'docker-compose.tier2.yml');

const USERS=['u_aaaa1111','u_bbbb2222'];
const HOST_NAME='along.test.local';
const PORT='14476';

// Docker 探测 ----------------------------------------------------------

function dockerBin() {
  if (spawnSync('docker',['compose','version'],{encoding:'utf8',timeout:30_000}).status===0) return {bin:'docker',prefix:['compose']};
  if (spawnSync('docker-compose',['version'],{encoding:'utf8',timeout:30_000}).status===0) return {bin:'docker-compose',prefix:[]};
  return null;
}
const DOCKER=dockerBin();
const ENABLED=process.env.ALONG_TIER2_INTEGRATION==='1';

// 栈的隔离工作目录（必须落在仓库内：colima 只把家目录共享进虚拟机，
// /tmp 不共享——bind mount 到 /tmp 会静默变成空目录）。
const BASE=join(ROOT,'.tier2-integration');
const HOST_STATE=join(BASE,'host');
const SUPER_STATE=join(BASE,'superagent');
const DSH_HOME=join(BASE,'dsh-home');
const SECRETS=join(BASE,'secrets');
const OVERLAY=join(BASE,'compose.test.yml');

// ---- 栈内调用 --------------------------------------------------------------

function phoneRequest({path,method='POST',body,token}) {
  const raw=JSON.stringify(body??{});
  const ca=readFileSync(join(BASE,'test-ca','ca.crt'));
  return new Promise((resolve,reject)=>{
    const request=https.request({host:'127.0.0.1',port:Number(PORT),servername:HOST_NAME,ca,agent:false,path,method,
      headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw),
        ...(token?{authorization:`Bearer ${token}`}:{})}},response=>{
      let data='';
      response.on('data',chunk=>data+=chunk);
      response.on('end',()=>{
        let parsed=null;
        try { parsed=JSON.parse(data); } catch { /* 非 JSON 响应：保留原文。 */ }
        resolve({status:response.statusCode,body:parsed,text:data});
      });
    });
    request.on('error',reject);
    request.setTimeout(20_000,()=>request.destroy(Error('Host 请求超时')));
    request.end(raw);
  });
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function until(fn,ms=120_000,label='断言') {
  const deadline=Date.now()+ms;
  let lastError;
  while (Date.now()<deadline) {
    try { const value=await fn(); if (value) return value; } catch (error) { lastError=error; }
    await sleep(500);
  }
  throw Error(`等待超时（${label}）：${lastError?.message??'条件始终不成立'}`);
}

// ---- 栈的编排 --------------------------------------------------------------

// 隔离栈的叠加文件：把主 compose 的相对路径（../../data、../../secrets、../../along-superagent）
// 换成本次测试的绝对路径，并关掉 Tier 1 的 runner 服务（它需要模型密钥，本用例不测）。
//
// 为什么用叠加文件而不是改主 compose：主 compose 是生产形态（§6.4 的 /opt/along 布局），
// 测试不该改动它。叠加文件是 compose 原生的隔离手段，`!override` 保证替换而不是追加。
function writeOverlay() {
  mkdirSync(BASE,{recursive:true});
  // Super Agent 源码位置：默认是相邻仓库。ALONG_TIER2_SUPERAGENT_REPO 可指向别处——
  // 例如就绪修复（feature/along-tier2-readiness）所在的 worktree，
  // 这样本用例能对着**带修复**的 Super Agent 验重启恢复（V-1 的原始失败面）。
  const superagentRepo=resolve(process.env.ALONG_TIER2_SUPERAGENT_REPO??resolve(ROOT,'../along-superagent'));
  if (!existsSync(superagentRepo)) throw Error(`Super Agent 源码目录不存在：${superagentRepo}`);
  writeFileSync(OVERLAY,[
    'services:',
    '  host:',
    '    ports: !override ["'+PORT+':4176"]',
    '    volumes: !override ["'+HOST_STATE+':/data"]',
    // 期望的 DNS 主机名必须与测试叶证书的 SAN 一致（云端 TLS 的启动前校验项之一：
    // 不一致就拒启——这正是「叶证书配错域名」该有的行为）。
    '    environment:',
    '      ALONG_TLS_CN: '+HOST_NAME,
    // 本用例不部署远程通知（没有 APNs 私钥），所以删掉 apns-key 引用——
    // file secret 指向不存在的文件会让 up 直接失败。
    // runner-token **必须保留**：配置了云端 Runner URL 就必须带它，否则 Host 拒绝启动
    // （host/agent-host.mjs 的启动守卫）。本用例不跑 runner 服务，只提供凭证。
    '    secrets: !override [runner-token, bridge-token]',
    '  agent:',
    '    profiles: ["!tier2"]',
    '  superagent:',
    '    volumes: !override ["'+SUPER_STATE+':/var/lib/along-superagent","'+DSH_HOME+':/var/lib/dsh"]',
    '    build:',
    '      additional_contexts:',
    '        along: '+superagentRepo,
    'secrets:',
    '  bridge-token:',
    '    file: '+join(SECRETS,'bridge-token'),
    '  runner-token:',
    '    file: '+join(SECRETS,'runner-token'),
    '',
  ].join('\n'));
}

function compose(args,{cwd=DEPLOY_DIR}={}) {
  const result=spawnSync(DOCKER.bin,[...DOCKER.prefix,'-f',COMPOSE_FILE,'-f',COMPOSE_TIER2,'-f',OVERLAY,'--profile','tier2',...args],
    {cwd,encoding:'utf8',timeout:900_000});
  return {status:result.status,stdout:result.stdout??'',stderr:result.stderr??''};
}

/** 直接读栈内业务库（沿用 V-1 的取证口径）。 */
function readRows(dbPath,sql) {
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

// ---- 集成用例 --------------------------------------------------------------

test('Tier 2 隔离 Linux Compose：TLS 入口、双用户事件同步、后台投递与重启恢复',{
  skip:!DOCKER&&'没有可用的 Docker',
  ...(DOCKER&&!ENABLED?{skip:'需要显式开启（ALONG_TIER2_INTEGRATION=1）'}:{}),
},async t=>{
  rmSync(BASE,{recursive:true,force:true});
  mkdirSync(HOST_STATE,{recursive:true,mode:0o700});
  mkdirSync(SUPER_STATE,{recursive:true,mode:0o700});
  mkdirSync(DSH_HOME,{recursive:true,mode:0o700});
  mkdirSync(SECRETS,{recursive:true,mode:0o700});

  // 隔离测试 CA + 证书版本目录（host/tls-material.mjs 的目录契约）。
  const caDir=join(BASE,'test-ca');
  makeTestCa(caDir,HOST_NAME);
  stageRelease(HOST_STATE,caDir,{serial:'tier2-1'});
  // 多用户静态用户表：它同时是**云端形态的判据**（host/agent-host.mjs 的 cloudForm）。
  writeFileSync(join(HOST_STATE,'users.json'),JSON.stringify(USERS.map(userId=>({userId}))),{mode:0o600});
  // Tier 1 runner 的内网令牌：形态判据与显式回退目标都要它（runner 服务本用例不启动）。
  writeFileSync(join(HOST_STATE,'runner-token'),randomBytes(32).toString('hex'),{mode:0o600});
  // 桥接凭证：host 与 superagent 读同一份 0600 的 32 字节 hex 文件。
  writeFileSync(join(SECRETS,'bridge-token'),randomBytes(32).toString('hex'),{mode:0o600});
  // Tier 1 runner 的内网令牌：Host 启动守卫要求它（配置了云端 Runner URL 就必须有）。
  writeFileSync(join(SECRETS,'runner-token'),randomBytes(32).toString('hex'),{mode:0o600});

  writeOverlay();

  const up=compose(['up','-d','--build']);
  assert.equal(up.status,0,`compose up 失败：${up.stderr.slice(-4000)}`);

  t.after(()=>{
    // 失败时保留现场（ALONG_TIER2_KEEP=1），便于看容器日志与库里的行；
    // 默认仍清理干净——测试目录在仓库内，留在工作树里会污染 git status。
    if (process.env.ALONG_TIER2_KEEP==='1') {
      console.error(`Tier 2 栈保留在 ${BASE}`);
      return;
    }
    compose(['down','-v']);
    rmSync(BASE,{recursive:true,force:true});
  });

  // ---- 1. 长驻服务起来，3082 不对外 ----
  await until(()=>{
    const result=compose(['ps','-q','superagent']);
    const id=result.stdout.trim();
    if (!id) return null;
    // 注意：这里要用**原生** docker ps（不是 compose ps）——compose 的 ps 没有 --filter，
    // 混用会把「容器在跑」误判成「没起来」，然后一直等到超时。
    const inspect=spawnSync('docker',['ps','--filter',`id=${id}`,'--format','{{.State}}'],{encoding:'utf8'});
    return inspect.stdout.includes('running')?id:null;
  },300_000,'superagent 容器常驻');

  // 3082 不发布端口：宿主与外网都连不上，只能经共享命名空间的 127.0.0.1 访问。
  const ports=compose(['ps','--format','json']);
  assert.ok(!/:3082->/.test(ports.stdout),
    'superagent 不得发布 3082 端口（管理面仅本机可达）');

  // ---- 2. Host 起来，TLS 入口通 ----
  await until(async()=>{
    const health=await phoneRequest({path:'/health',method:'GET'});
    return health.status===200;
  },180_000,'Host TLS 入口就绪');

  // ---- 3. 配对两个合成用户 ----
  const tokens=[];
  for (const userId of USERS) {
    const code=compose(['exec','-T','host','node','host/pair-code.mjs',userId]);
    assert.equal(code.status,0,`发码失败：${code.stderr}`);
    const pairCode=code.stdout.trim().split(/\s+/).pop();
    const paired=await phoneRequest({path:'/pair',body:{code:pairCode}});
    assert.equal(paired.status,200,`配对失败：${paired.text}`);
    tokens.push(paired.body.token);
  }

  // ---- 4. 连接检查走真实就绪判定（along-status-probe 契约）----
  for (const [index,token] of tokens.entries()) {
    const status=await until(async()=>{
      const response=await phoneRequest({path:'/connection/status',body:{},token});
      return response.status===200?response:null;
    },120_000,`用户 ${USERS[index]} 的连接检查`);
    assert.equal(status.body.userId,USERS[index],'连接检查必须回报各自的用户身份');
    assert.equal(status.body.ready,true,'就绪时必须答 ready:true');
  }

  // ---- 5. 事件写入与双用户隔离 ----
  const message=(text,eventId)=>({event_id:eventId,schema_version:'1',event_type:'along.user_message',
    occurred_at:new Date().toISOString(),timezone:'UTC',payload:{event_type:'along.user_message',text}});
  const events=[message('tier2 A 的消息','tier2-shared'),message('tier2 B 的消息','tier2-shared')];
  for (const [index,token] of tokens.entries()) {
    const accepted=await phoneRequest({path:'/events',body:events[index],token});
    assert.equal(accepted.status,200,`事件写入失败：${accepted.text}`);
    assert.equal(accepted.body.status,'accepted');
  }
  // 同一个 event_id 在两个用户下各自成行（V-1 同款口径）。
  const inbox=readRows(join(SUPER_STATE,'along','along.sqlite'),
    'SELECT user_id,event_id FROM event_inbox ORDER BY user_id');
  assert.deepEqual(inbox.map(row=>row.user_id),USERS,'两个用户各自入库（按 user_id 分行）');

  // 同步：A 只读到自己的内容。
  for (const [index,token] of tokens.entries()) {
    const page=await phoneRequest({path:'/sync',body:{after_seq:0,conversation_version:1},token});
    assert.equal(page.status,200);
    const text=JSON.stringify(page.body);
    assert.ok(text.includes(events[index].payload.text),'各自读到自己的消息');
    assert.ok(!text.includes(events[1-index].payload.text),'读不到对方的消息');
  }

  // ---- 6. 后台投递到编排 Engine ----
  const delivered=await until(()=>{
    const rows=readRows(join(SUPER_STATE,'along','along.sqlite'),
      'SELECT user_id,event_id,status FROM delivery ORDER BY user_id');
    return rows.length===2&&rows.every(row=>row.status==='delivered')?rows:null;
  },180_000,'投递泵把两条事件投到 Engine');
  assert.equal(delivered.length,2);
  const triggers=readRows(join(SUPER_STATE,'engine','orchestrator.sqlite'),
    "SELECT id FROM trigger WHERE id LIKE 'along:%' ORDER BY id");
  assert.ok(triggers.length>=2,'编排库按用户各有 Trigger');

  // ---- 7. 重启恢复：停掉长驻服务，写入真实待投递行，重启后应恢复投递 ----
  //
  // 关键：事件必须走**真实的 inbox**（Host /events → bridge → 业务库），不能直接插行——
  // 直接插的行缺 message/sync 行，测的就不是重启恢复，而是手工插数据。
  // 但长驻服务停机时 Host 的桥接调用会失败，事件进不去。
  // 所以顺序是：先让长驻服务在跑时写入事件（状态机完整走过），
  // 把它的到期时间推到未来（此时它不会被投递），停机，把到期时间改回过去，
  // 再启动——这正是「重启前就已到期」的窗口（V-1 的 LAB_RECOVERY=deferred 同款手法）。
  const pendingEvent=message('tier2 待投递事件','tier2-pending');
  const staged=await phoneRequest({path:'/events',body:pendingEvent,token:tokens[1]});
  assert.equal(staged.status,200,`待投递事件写入失败：${staged.text}`);
  assert.equal(staged.body.status,'accepted');

  const dbPath=join(SUPER_STATE,'along','along.sqlite');
  const pendingRows=readRows(dbPath,"SELECT user_id,event_id,status FROM delivery WHERE event_id='tier2-pending'");
  assert.equal(pendingRows.length,1,'待投递行已落库');

  // 把它推到未来：此时长驻服务在跑，但这一行还不到期，不会被投递。
  setDeliveryDue(dbPath,'tier2-pending',Date.now()+600_000);

  compose(['stop','superagent']);
  await until(()=>{
    const result=compose(['ps','-q','superagent']);
    return !result.stdout.trim();
  },120_000,'superagent 停止');

  // 停机后把到期时间改回过去：制造「重启前就已到期」的窗口。
  setDeliveryDue(dbPath,'tier2-pending',Date.now()-60_000);

  compose(['start','superagent']);
  const recovered=await until(()=>{
    const rows=readRows(dbPath,"SELECT status,last_error FROM delivery WHERE event_id='tier2-pending'");
    return rows.length===1&&rows[0].status!=='pending'?rows:null;
  },240_000,'重启后待投递行结算');
  assert.equal(recovered[0].status,'delivered',
    `重启后已到期的待投递行必须恢复投递，实际 ${recovered[0].status} / ${recovered[0].last_error??''}`);

  // 投递泵在 Source 注册前领取，是 V-1 的原始故障：那一行会被终结为
  // filtered / source_not_installed，客户端收到 delivery_failed。这里必须没有。
  assert.notEqual(recovered[0].status,'filtered','重启后不得把待投递行误判为 filtered');

  // ---- 8. 两份库的完整性 ----
  for (const name of ['along/along.sqlite','engine/orchestrator.sqlite']) {
    const db=new DatabaseSync(join(SUPER_STATE,name),{readOnly:true});
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').all()[0].integrity_check,'ok',`${name} 完整性`);
    } finally { db.close(); }
  }
});

/**
 * 改待投递行的到期时间（V-1 的复现手法）。
 *
 * 事件本身是走 Host 的 /events 落进**真实 inbox** 的（收件状态机完整走过），
 * 这里只改到期时间这一个字段，用来制造「重启前就已到期」的窗口。
 */
function setDeliveryDue(dbPath,eventId,nextAttemptAt) {
  const db=new DatabaseSync(dbPath);
  try {
    db.prepare('UPDATE delivery SET next_attempt_at=? WHERE event_id=?').run(nextAttemptAt,eventId);
  } finally { db.close(); }
}
