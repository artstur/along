import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {request as tlsRequest} from 'node:https';
import net from 'node:net';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync} from 'node:fs';
import {networkInterfaces, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BINDING_TTL_MS,BINDING_RENEW_AHEAD_MS} from '../host/pairing.mjs';
import {agentHealthSnapshot} from '../web/contextual-planning.mjs';
import {DSH_RUNTIME,KIMI_RUNTIME} from '../web/super-agent.mjs';
import {provideCloudCa} from './cloud-ca-fixture.mjs';

// M1 host-admission 验收测试（docs/cloud-security-hardening.md §3.1 / §4-M1，验收 #1-#12）。
// 与改写后的 test/host-multi-user-pairing.test.mjs、test/pairing-multi-user-acceptance.test.mjs（验收 #13）
// 互补：那两个文件覆盖 pairing.mjs/pair-code.mjs 的单元与全链路语义；本文件按验收标准逐条覆盖
// host/agent-host.mjs 侧的准入、限流与输出闸门：
//   #1  状态目录权限自愈（G-18）        #2  OKX 密钥库启动守卫（G-9）
//   #3  /pair 准入预检（G-14）          #4  按来源失败窗口 + 双来源审计（G-4/G-12/G-15）
//   #5  --revoke 吊销（G-5）            #6  绑定滑动过期/续期/泵跳过（G-5）
//   #7  运行链路限流与 429 透传（G-1）  #8  normalizeTaskRun 输出契约（G-7）
//   #9  tasks context 全域清洗（G-20）  #10 连接级防护（G-3）
//   #11 /pair 审计与限速（G-15）        #12 绑定文件即事实来源（G-5/SD-H15）
// 验收 #4 的双来源断言：优先用 127.0.0.2/127.0.0.3 回环别名（Linux CI），不可用时退回
// 「本机局域网 IPv4 vs 127.0.0.1」（macOS 不配 root 无法加别名；两者都不可得则跳过并注明）。

const USER_A='u_aaaa1111',USER_B='u_bbbb2222',USER_C='u_cccc3333',USER_D='u_dddd4444',
  USER_E='u_eeee5555',USER_F='u_ffff6666';
const HOST_FILE=fileURLToPath(new URL('../host/agent-host.mjs',import.meta.url));
const PAIR_CODE_FILE=fileURLToPath(new URL('../host/pair-code.mjs',import.meta.url));
const sha256hex=value=>createHash('sha256').update(value).digest('hex');
const dead=seed=>String(seed).padStart(8,'0');   // 发码生成不了前导零，保证未命中
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function tempDir(prefix) {
  const dir=mkdtempSync(join(tmpdir(),prefix));
  const cleanup=()=>rmSync(dir,{recursive:true,force:true});
  return {dir,cleanup};
}
function writeUsers(dir,users) {
  writeFileSync(join(dir,'users.json'),JSON.stringify(users),{mode:0o600});
}
function writeSecret(dir,name,value='c'.repeat(64)) {
  const file=join(dir,name);
  writeFileSync(file,value,{mode:0o600});
  chmodSync(file,0o600);
  return file;
}
const readCodes=dir=>JSON.parse(readFileSync(join(dir,'pairing-codes.json'),'utf8'));
const readPairingsFile=dir=>JSON.parse(readFileSync(join(dir,'pairings.json'),'utf8'));
const pairingsFileOrNull=dir=>existsSync(join(dir,'pairings.json'))?readPairingsFile(dir):null;
const bucketOf=(dir,source)=>existsSync(join(dir,'pairing-codes.json'))?(readCodes(dir).failures[source]??[]):[];

function freePort() {
  return new Promise(resolve=>{
    const server=net.createServer();
    server.listen(0,'127.0.0.1',()=>{const port=server.address().port; server.close(()=>resolve(port));});
  });
}

function tlsCall(options,{body}={}) {
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const req=tlsRequest({...options,agent:false,rejectUnauthorized:false,
      headers:{...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...options.headers}},
    res=>{
      let text=''; res.on('data',chunk=>text+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,text,json:text?JSON.parse(text):null}));
    });
    req.setTimeout(10_000,()=>req.destroy(new Error(`tlsCall 超时：${options.method||'GET'} ${options.path} @${options.port}`)));
    req.on('error',reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const phoneCall=(port,path,opts={})=>tlsCall({host:'127.0.0.1',port,path,...opts},opts);
// 从指定来源发起（127.0.0.2/127.0.0.3 回环别名或本机局域网地址），用于按来源分桶与审计断言（G-4/G-15）。
const phoneCallFrom=(port,source,path,opts={})=>tlsCall({
  host:source.host,port,path,...opts,
  ...(source.localAddress?{localAddress:source.localAddress}:{})},opts);

async function spawnHost(t,{dir,host='127.0.0.1',env={}}={}) {
  const port=await freePort();
  // 云端形态（配置了云端 Runner）必须加载预签发的 CA 叶证书，缺失就在监听前拒启
  // （docs/iphone-ca-profile-design.md §3.1）。这里铺一套隔离测试 CA。
  const cloudCa=env.ALONG_DSH_RUNNER_URL?provideCloudCa(dir,{host:'along.test.local'}):null;
  const child=spawn(process.execPath,[HOST_FILE],{env:{
    ...process.env,
    ALONG_AGENT_STATE_DIR:dir,
    ALONG_AGENT_HOST:host,
    ALONG_AGENT_PORT:String(port),
    ...(cloudCa?{ALONG_TLS_CN:cloudCa.host}:{}),
    ...env,
  },stdio:['ignore','pipe','pipe']});
  const output=[];
  child.stdout.on('data',data=>output.push(String(data)));
  child.stderr.on('data',data=>output.push(String(data)));
  const deadline=Date.now()+20_000;
  let ready=false;
  while (Date.now()<deadline) {
    try { const health=await phoneCall(port,'/health'); if (health.status===200) {ready=true; break;} } catch { /* 还没起来 */ }
    await sleep(150);
  }
  const text=()=>output.join('');
  if (!ready && child.exitCode===null && !child.killed) child.kill('SIGKILL');
  assert.match(text(),/Along 服务: https:\/\//,`Host 进程要起来（监听 ${host}）：${text().slice(0,400)}`);
  let stopped=false;
  const stop=()=>new Promise(resolve=>{
    if (stopped||child.exitCode!==null||child.signalCode!==null) {stopped=true; return resolve();}
    stopped=true;
    child.once('exit',()=>resolve());
    child.kill('SIGINT');
    setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},3_000).unref?.();
  });
  if (t) t.after(()=>stop());
  return {port,text,stop,alive:()=>child.exitCode===null&&child.signalCode===null,
    pairingCode:()=>/一次性配对码: (\d{8})/.exec(text())?.[1]??null};
}

// 拒启断言（G-9）：进程自行退出、输出可定位、未进入监听。
function assertRefusesToStart(run,match) {
  assert.notEqual(run.status,0,`应非 0 退出，实际 status=${run.status}`);
  assert.equal(run.signal,null,'进程应自行退出，而不是超时被杀（超时=进入监听）');
  const output=String(run.stdout??'')+String(run.stderr??'');
  assert.match(output,match,'退出输出要能定位原因');
  assert.doesNotMatch(output,/Along 服务: /,'不得进入监听');
  return output;
}

function issueCodeViaCli(dir,userId) {
  return spawnSync(process.execPath,[PAIR_CODE_FILE,...(userId?[userId]:[])],
    {env:{...process.env,ALONG_AGENT_STATE_DIR:dir},encoding:'utf8'});
}
const pairCode=(host,code)=>phoneCall(host.port,'/pair',{method:'POST',body:{code}});
const verifyToken=(port,token)=>phoneCall(port,'/connection/verify',{method:'POST',headers:{authorization:`Bearer ${token}`}});

async function waitFor(predicate,label,timeout=6_000) {
  const deadline=Date.now()+timeout;
  while (Date.now()<deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  assert.ok(false,`等待超时：${label}`);
}

// 通用 HTTP stub（云端 runner / Along Agent 桥 / Kimi Code Web Server 共用）：记录全部请求，
// 由各测试给出按路径的应答。
async function stubServer(t,handler=()=>({status:404,body:{error:'stub 404'}})) {
  const requests=[];
  const server=http.createServer((req,res)=>{
    let raw='';
    req.on('data',chunk=>raw+=chunk);
    req.on('end',()=>{
      let json=null; try {json=raw?JSON.parse(raw):null;} catch {json=null;}
      const record={method:req.method,path:req.url,headers:req.headers,body:json,raw};
      requests.push(record);
      const reply=handler(record)??{status:404,body:{error:'stub 404'}};
      res.writeHead(reply.status??200,{'content-type':'application/json'});
      res.end(JSON.stringify(reply.body??{}));
    });
  });
  const port=Number(await listenOn(server));
  t.after(()=>new Promise(resolve=>{
    server.closeAllConnections?.();
    server.close(()=>resolve());
  }));
  return {port,url:`http://127.0.0.1:${port}`,requests};
}
function listenOn(server) {
  return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>resolve(server.address().port));
  });
}

// 双来源探测（G-4/G-15 验收 #4）：返回可用的两个不同来源，或 null。
async function probeSources() {
  const lan=Object.values(networkInterfaces()).flat()
    .filter(item=>item?.family==='IPv4'&&!item.internal).map(item=>item.address);
  const candidates=[
    {label:'loopback-alias',
      a:{ip:'127.0.0.2',host:'127.0.0.1',localAddress:'127.0.0.2'},
      b:{ip:'127.0.0.3',host:'127.0.0.1',localAddress:'127.0.0.3'}},
    ...lan.map(ip=>({label:'lan-loopback',
      a:{ip,host:ip},b:{ip:'127.0.0.1',host:'127.0.0.1'}})),
  ];
  const probe=net.createServer(socket=>socket.end(`SRC ${socket.remoteAddress}`));
  const port=await listenOn(probe);
  try {
    for (const candidate of candidates) {
      const seenA=await probeConnect(port,candidate.a),seenB=await probeConnect(port,candidate.b);
      if (seenA===candidate.a.ip&&seenB===candidate.b.ip) return candidate;
    }
    return null;
  } finally {
    probe.closeAllConnections?.();
    probe.close();
  }
}
function probeConnect(port,source) {
  return new Promise(resolve=>{
    const socket=net.connect({port,host:source.host,...(source.localAddress?{localAddress:source.localAddress}:{})});
    let text='';
    const finish=value=>{try{socket.destroy();}catch{} resolve(value);};
    socket.on('data',data=>{text+=String(data); if (text.startsWith('SRC ')) finish(text.slice(4).trim());});
    socket.on('error',()=>finish(null));
    socket.on('close',()=>finish(text.startsWith('SRC ')?text.slice(4).trim():null));
    setTimeout(()=>finish(null),800).unref?.();
  });
}

// 云端 runner 的任务运行信封（runnerRun 校验 version:2/kind≠goal/runtime/actual/requestId）。
const taskRun=(requestId,result,status='done')=>({version:2,kind:'task',requestId,runtime:DSH_RUNTIME,actual:true,status,result});

// ---- 验收 #1：状态目录权限自愈（G-18）-----------------------------------------------------------

test('验收#1 G-18：状态目录以 0755 预建，host 启动后 statSync(dir).mode&0o777===0o700（自愈）',async t=>{
  const {dir,cleanup}=tempDir('along-adm-chmod-');
  try {
    chmodSync(dir,0o755);
    assert.equal(statSync(dir).mode&0o777,0o755,'预置条件：部署者漏跑 chmod 700，目录是 0755');
    const host=await spawnHost(t,{dir});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    assert.equal(statSync(dir).mode&0o777,0o700,'启动即无条件收紧为 0700（自愈，无需重启）');
  } finally {cleanup();}
});

// ---- 验收 #2：OKX 密钥库启动守卫（G-9）----------------------------------------------------------

test('验收#2 G-9：多用户形态 + 64hex 密钥库 → 拒启含「OKX 密钥库」；空目录/仅 master.key/不存在 → 正常监听；本地形态不受影响',async t=>{
  const vaultFile='ab'.repeat(32)+'.json';   // 与 okx-connection.mjs 的 vault 识别同一模式
  const refuse=tempDir('along-adm-vault-refuse-');
  try {
    writeUsers(refuse.dir,[{userId:USER_A}]);
    mkdirSync(join(refuse.dir,'okx-connections'));
    writeFileSync(join(refuse.dir,'okx-connections',vaultFile),'{}',{mode:0o600});
    const run=spawnSync(process.execPath,[HOST_FILE],{env:{
      ...process.env,ALONG_AGENT_STATE_DIR:refuse.dir,ALONG_AGENT_HOST:'127.0.0.1',
      ALONG_AGENT_PORT:String(await freePort()),
    },timeout:15_000,killSignal:'SIGKILL',encoding:'utf8'});
    const output=assertRefusesToStart(run,/OKX 密钥库/);
    assert.match(output,/okx-connections/,'报错能定位到目录');
  } finally {refuse.cleanup();}

  const {dir,cleanup}=tempDir('along-adm-vault-ok-');
  try {
    writeUsers(dir,[{userId:USER_A}]);
    // 空目录 → 正常监听
    mkdirSync(join(dir,'okx-connections'));
    let host=await spawnHost(t,{dir});
    await waitFor(()=>host.text().includes('证书指纹'),'空 vault 目录 → 正常监听');
    await host.stop();
    // 仅 master.key（没有密文可解）→ 正常监听
    writeFileSync(join(dir,'okx-connections','master.key'),'k'.repeat(32),{mode:0o600});
    host=await spawnHost(t,{dir});
    await waitFor(()=>host.text().includes('证书指纹'),'仅 master.key → 正常监听');
    await host.stop();
    // 目录不存在 → 正常监听
    rmSync(join(dir,'okx-connections'),{recursive:true,force:true});
    host=await spawnHost(t,{dir});
    await waitFor(()=>host.text().includes('证书指纹'),'vault 目录不存在 → 正常监听');
    await host.stop();
  } finally {cleanup();}

  // 本地形态（无 users.json）不受守卫影响：带 64hex 密钥库照常启动（Mac 行为不变）
  const local=tempDir('along-adm-vault-local-');
  try {
    mkdirSync(join(local.dir,'okx-connections'));
    writeFileSync(join(local.dir,'okx-connections',vaultFile),'{}',{mode:0o600});
    const host=await spawnHost(t,{dir:local.dir});
    await waitFor(()=>host.text().includes('证书指纹'),'本地形态带密钥库 → 正常监听');
    assert.match(host.text(),/一次性配对码/,'本地形态照常打印通用码');
  } finally {local.cleanup();}
});

// ---- 验收 #3：/pair 准入预检（G-14）-------------------------------------------------------------

test('验收#3 G-14：/pair 预检——content-type 非 JSON → 400、带 Origin/Referer → 403，均不计失败；JSON 无 Origin → 正常验码',async t=>{
  const {dir,cleanup}=tempDir('along-adm-precheck-');
  try {
    writeUsers(dir,[{userId:USER_A}]);
    const host=await spawnHost(t,{dir});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const code=issueCodeViaCli(dir,USER_A).stdout.trim();
    assert.match(code,/^\d{8}$/);
    const codesBefore=readCodes(dir);

    // 预检 1：content-type 非 application/json → 400「配对请求格式无效」
    const badType=await phoneCall(host.port,'/pair',{method:'POST',body:{code:'00000000'},headers:{'content-type':'text/plain'}});
    assert.equal(badType.status,400);
    assert.deepEqual(badType.json,{error:'配对请求格式无效'});
    // 预检 2：带 Origin → 403「配对请求来源无效」（跨站 text/plain 简单请求进不了验码逻辑）
    const withOrigin=await phoneCall(host.port,'/pair',{method:'POST',body:{code:'00000000'},headers:{origin:'https://evil.example'}});
    assert.equal(withOrigin.status,403);
    assert.deepEqual(withOrigin.json,{error:'配对请求来源无效'});
    // 预检 3：带 Referer → 403
    const withReferer=await phoneCall(host.port,'/pair',{method:'POST',body:{code:'00000000'},headers:{referer:'https://evil.example/pair'}});
    assert.equal(withReferer.status,403);
    assert.deepEqual(withReferer.json,{error:'配对请求来源无效'});
    // 两种预检都不计入失败窗口（读体之前拒绝，pairing-codes.json 无新失败、码未消费）
    assert.deepEqual(readCodes(dir),codesBefore,'预检拒绝不计失败窗口，码未消费');

    // iOS 同款头：application/json、无 Origin/Referer → 正常进入验码逻辑（错误码计入失败窗口）
    const wrong=await pairCode(host,'00000000');
    assert.equal(wrong.status,403);
    assert.deepEqual(wrong.json,{error:'配对码无效或已过期'});
    assert.equal(bucketOf(dir,'127.0.0.1').length,1,'JSON 无 Origin → 正常验码并按来源计失败');
    assert.equal(readCodes(dir).codes.some(item=>item[0]===code),true,'预检请求从未消费有效码');
    const paired=await pairCode(host,code);
    assert.equal(paired.status,200,'iOS 同款头可正常配对');
  } finally {cleanup();}
});

// ---- 验收 #4：按来源失败窗口 + 双来源审计（G-4/G-12/G-15）---------------------------------------

test('验收#4 G-4/G-12/G-15：来源 A 打满 limit 后有效码 403 且未消费；来源 B 同刻成功且审计显示两个不同来源 IP；成功只清 B 的桶；发码不清窗；窗口过期自然恢复',async t=>{
  const sources=await probeSources();
  if (!sources) return t.skip('本机无法构造两个不同的来源 IP（127.0.0.2/127.0.0.3 别名不可用且无局域网 IPv4）');
  const {dir,cleanup}=tempDir('along-adm-sources-');
  try {
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B,label:'B'}]);
    const host=await spawnHost(t,{dir,host:'0.0.0.0',env:{ALONG_PAIR_FAIL_LIMIT:'3'}});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const codeA=issueCodeViaCli(dir,USER_A).stdout.trim();
    const codeB=issueCodeViaCli(dir,USER_B).stdout.trim();
    const sourceA=sources.a,sourceB=sources.b;

    // 来源 A（如 127.0.0.2）打满 limit=3：三次未命中
    for (let seed=1;seed<=3;seed++) {
      const miss=await phoneCallFrom(host.port,sourceA,'/pair',{method:'POST',body:{code:dead(seed)}});
      assert.equal(miss.status,403);
    }
    assert.equal(bucketOf(dir,sourceA.ip).length,3,'来源 A 的失败桶已满');
    assert.deepEqual(Object.keys(readCodes(dir).failures),[sourceA.ip],'失败窗口按来源分桶：只有 A 有桶，B 未受影响');

    // 来源 A 的有效码也被拒绝（403），且码未消费
    const blocked=await phoneCallFrom(host.port,sourceA,'/pair',{method:'POST',body:{code:codeA}});
    assert.equal(blocked.status,403,'A 打满 limit 后有效码也 403');
    assert.deepEqual(blocked.json,{error:'配对码无效或已过期'},'满窗与普通错误同一文案');
    assert.equal(readCodes(dir).codes.some(item=>item[0]===codeA),true,'A 的有效码未消费');
    assert.equal(bucketOf(dir,sourceA.ip).length,3,'满窗不追加失败');

    // 发码不清窗（G-12/SD-H2）
    const reissued=issueCodeViaCli(dir,USER_A);
    assert.equal(reissued.status,0,'CLI 发码成功');
    assert.equal(bucketOf(dir,sourceA.ip).length,3,'issuePairingCode 后失败桶不变');

    // 来源 B（如 127.0.0.3）同刻用另一有效码成功
    const ok=await phoneCallFrom(host.port,sourceB,'/pair',{method:'POST',body:{code:codeB}});
    assert.equal(ok.status,200,'来源 B 不受 A 的满窗影响，另一有效码成功');
    assert.deepEqual((await verifyToken(host.port,ok.json.token)).json,{paired:true});

    // 成功只清 B 的桶；A 的桶原样
    assert.equal(readCodes(dir).failures[sourceB.ip],undefined,'成功只清 B 自己的桶');
    assert.equal(bucketOf(dir,sourceA.ip).length,3,'A 的失败桶不受 B 成功影响');

    // 审计行（G-15）：两个来源 IP 不同，行含来源值
    const text=host.text();
    const auditedSources=[...text.matchAll(/来源=([^（\s]+)/g)].map(match=>match[1]);
    assert.ok(auditedSources.includes(sourceA.ip)&&auditedSources.includes(sourceB.ip),
      `审计行显示两个来源 IP（${sourceA.ip} / ${sourceB.ip}）：${auditedSources.join(', ')}`);
    assert.notEqual(sourceA.ip,sourceB.ip,'两个来源 IP 不同（源 IP 语义等价断言）');

    // 窗口过期自然恢复（G-4）：把 A 的桶回拨 16 分钟（等价于 15 分钟窗口滑过），A 重新按未命中计数
    const backdated=readCodes(dir);
    backdated.failures[sourceA.ip]=backdated.failures[sourceA.ip].map(at=>new Date(Date.parse(at)-16*60_000).toISOString());
    writeFileSync(join(dir,'pairing-codes.json'),JSON.stringify(backdated),{mode:0o600});
    const fresh=await phoneCallFrom(host.port,sourceA,'/pair',{method:'POST',body:{code:dead(9)}});
    assert.equal(fresh.status,403,'窗口恢复后按未命中重新计数');
    assert.equal(bucketOf(dir,sourceA.ip).length,1,'旧失败已滑出，只剩新的一条');

    // 审计不含码与 token（§3.7 红线）
    const fullText=host.text();
    for (const secret of [codeA,codeB,ok.json.token]) {
      assert.equal(fullText.includes(secret),false,'码与 token 不落日志');
    }
  } finally {cleanup();}
});

// ---- 验收 #5：--revoke 吊销与 CLI 负断言（G-5）--------------------------------------------------

test('验收#5 G-5：--revoke 后被吊销 token 下一个请求 401（host 不重启）、其他用户不受影响、条目消失；CLI 缺参/未知用户 exit 1；无 --reset-window',async t=>{
  const {dir,cleanup}=tempDir('along-adm-revoke-');
  try {
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B,label:'B'},{userId:USER_C,label:'C'}]);
    const host=await spawnHost(t,{dir});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const tokenA=(await pairCode(host,issueCodeViaCli(dir,USER_A).stdout.trim())).json.token;
    const tokenB=(await pairCode(host,issueCodeViaCli(dir,USER_B).stdout.trim())).json.token;
    assert.deepEqual((await verifyToken(host.port,tokenA)).json,{paired:true});
    assert.deepEqual((await verifyToken(host.port,tokenB)).json,{paired:true});

    // 吊销 A：CLI exit 0，绑定条目消失
    const revoked=runPairCli(dir,'--revoke',USER_A);
    assert.equal(revoked.status,0,`--revoke 成功：${revoked.stderr}`);
    assert.match(revoked.stdout,/已吊销/);
    assert.equal(readPairingsFile(dir).some(item=>item.user_id===USER_A),false,'pairings.json 该条消失');
    assert.equal(readPairingsFile(dir).some(item=>item.user_id===USER_B),true,'B 的条目保留');

    // 被吊销 token 的下一个请求即 401（同一 host 进程，不重启）
    assert.equal((await verifyToken(host.port,tokenA)).status,401,'被吊销 token → 401');
    assert.deepEqual((await verifyToken(host.port,tokenA)).json,{error:'请先配对这台 Mac'});
    assert.deepEqual((await verifyToken(host.port,tokenB)).json,{paired:true},'其他用户不受影响');

    // CLI 失败路径：缺参 / 未知用户 → exit 1
    const failuresBefore=readCodes(dir).failures;
    const missing=runPairCli(dir,'--revoke');
    assert.equal(missing.status,1,'--revoke 缺 <userId> → exit 1');
    assert.match(missing.stderr,/用法/);
    const unknown=runPairCli(dir,'--revoke',USER_C);
    assert.equal(unknown.status,1,'未知用户（C 未配对）→ exit 1');
    assert.match(unknown.stderr,/没有用户/,'报错可定位');
    // 评审砍项负断言：CLI 无 --reset-window 子命令
    const reset=runPairCli(dir,'--reset-window',USER_A);
    assert.equal(reset.status,1,'不存在 --reset-window 子命令（G-12/SD-H2）');
    assert.match(reset.stderr,/用法|没有用户/,'--reset-window 被当作发码 userId 拒绝');
    assert.deepEqual(readCodes(dir).failures,failuresBefore,'清窗入口不存在：失败桶没有被动过');
  } finally {cleanup();}
});
// pair-code.mjs 的 --revoke 与发码走同一 CLI 文件；独立小包装避免与发码调用混淆。
function runPairCli(dir,...args) {
  return spawnSync(process.execPath,[PAIR_CODE_FILE,...args],
    {env:{...process.env,ALONG_AGENT_STATE_DIR:dir},encoding:'utf8'});
}

// ---- 验收 #6：绑定滑动过期 + 续期（G-5，注入时钟=直接改写 pairings.json 的 expiresAt）-----------

test('验收#6 G-5：过期 token 401；剩余<7 天成功请求续期到 now+30d；剩余充足不写盘；无 expiresAt 旧条目不过期',async t=>{
  const {dir,cleanup}=tempDir('along-adm-binding-');
  try {
    writeUsers(dir,[{userId:USER_A,label:'A'}]);
    const host=await spawnHost(t,{dir});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const startedAt=Date.now();
    const tokenA=(await pairCode(host,issueCodeViaCli(dir,USER_A).stdout.trim())).json.token;
    assert.deepEqual((await verifyToken(host.port,tokenA)).json,{paired:true});
    // /pair 写入 expiresAt=配对时刻+30 天
    const pairedEntry=readPairingsFile(dir)[0];
    assert.ok(Number.isFinite(pairedEntry.expiresAt)&&pairedEntry.expiresAt>startedAt+BINDING_TTL_MS-120_000
      &&pairedEntry.expiresAt<=Date.now()+BINDING_TTL_MS+120_000,'expiresAt=配对时刻+30 天（BINDING_TTL_MS）');
    const file=join(dir,'pairings.json');
    const rewrite=entries=>{writeFileSync(file,JSON.stringify(entries),{mode:0o600});};
    const expiresOf=()=>readPairingsFile(dir)[0].expiresAt;

    // 注入时钟：把 expiresAt 改成已过期 → token 立即 401（文案不变）
    rewrite([{...pairedEntry,expiresAt:Date.now()-1000}]);
    const expired=await verifyToken(host.port,tokenA);
    assert.equal(expired.status,401,'过期绑定 → 401');
    assert.deepEqual(expired.json,{error:'请先配对这台 Mac'});

    // 剩余 <7 天（BINDING_RENEW_AHEAD_MS）：成功请求续期到 now+30 天（续期为异步写盘，轮询等待）
    const renewAt=Date.now();
    rewrite([{...pairedEntry,expiresAt:renewAt+3*24*60*60_000}]);
    assert.deepEqual((await verifyToken(host.port,tokenA)).json,{paired:true});
    await waitFor(()=>Number.isFinite(expiresOf())&&expiresOf()>renewAt+BINDING_TTL_MS-5_000,
      '滑动续期把 expiresAt 续到 now+30d',3_000);
    assert.ok(expiresOf()<=renewAt+BINDING_TTL_MS+5_000,'续期目标恰为 now+30 天');

    // 剩余充足（>7 天）：成功请求不写盘
    const ample=renewAt+20*24*60*60_000;
    rewrite([{...pairedEntry,expiresAt:ample}]);
    const beforeAmple=readFileSync(file,'utf8');
    assert.deepEqual((await verifyToken(host.port,tokenA)).json,{paired:true});
    await sleep(400);
    assert.equal(readFileSync(file,'utf8'),beforeAmple,'剩余充足不写盘（无写放大）');

    // 无 expiresAt 的旧条目（grandfathered）：不过期、续期不适用、请求照常 200
    const legacy={hash:pairedEntry.hash,user_id:pairedEntry.user_id,device_id:pairedEntry.device_id};
    rewrite([legacy]);
    const beforeLegacy=readFileSync(file,'utf8');
    assert.deepEqual((await verifyToken(host.port,tokenA)).json,{paired:true},'无 expiresAt 旧条目不过期');
    await sleep(400);
    assert.equal(readFileSync(file,'utf8'),beforeLegacy,'grandfathered 条目不被续期改写');

    // 重新配对恢复正常路径（供后续断言使用）
    const tokenA2=(await pairCode(host,issueCodeViaCli(dir,USER_A).stdout.trim())).json.token;
    assert.deepEqual((await verifyToken(host.port,tokenA2)).json,{paired:true});
  } finally {cleanup();}
});

// ---- 验收 #6（续）：过期绑定在泵的每用户迭代中被跳过（G-5，Along Agent stub 观测）---------------

test('验收#6 G-5：过期绑定在 source 泵/登记的每用户迭代中被跳过——stub 只看到现役绑定的注册与泵轮',async t=>{
  const {dir,cleanup}=tempDir('along-adm-pump-');
  const stub=await stubServer(t,record=>{
    if (record.path.startsWith('/along-source/api/goals?')) return {status:200,body:{items:[]}};
    if (record.path.startsWith('/along-source/api/source-reads')) return {status:200,body:{requests:[]}};
    return {status:200,body:{}};
  });
  try {
    const tokenA='e'.repeat(64),tokenB='f'.repeat(64);
    // 过期/续期只在多用户形态生效（SD-H3，Mac 本地行为不变），本场景按多用户形态启动
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B,label:'B'}]);
    // U1 现役（grandfathered 无 expiresAt），U2 已过期：文件即事实来源，启动即被过滤
    writeFileSync(join(dir,'pairings.json'),JSON.stringify([
      {hash:sha256hex(tokenA),user_id:USER_A,device_id:'d_aaaa1111'},
      {hash:sha256hex(tokenB),user_id:USER_B,device_id:'d_bbbb2222',expiresAt:Date.now()-1000}]),{mode:0o600});
    const host=await spawnHost(t,{dir,env:{
      ALONG_SUPERAGENT_URL:stub.url,
      ALONG_BRIDGE_TOKEN_FILE:writeSecret(dir,'bridge-token'),
      ALONG_EVENT_INGEST:'on',
    }});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');

    // 现役 token 通过；过期 token 立即 401
    assert.deepEqual((await verifyToken(host.port,tokenA)).json,{paired:true});
    assert.equal((await verifyToken(host.port,tokenB)).status,401,'过期绑定 → 401');

    // 泵/登记迭代（每 3s 一轮）：现役绑定被注册并泵轮，过期绑定在整个观测窗内零流量
    await waitFor(()=>stub.requests.some(record=>
      record.path.startsWith('/along-source/api/goals?')&&record.headers['x-along-user']===USER_A),
      '泵对现役绑定 U1 跑过一轮',9_000);
    await sleep(3_600);   // 再等一轮完整的泵 tick，确认 U2 始终被跳过
    assert.ok(stub.requests.some(record=>record.headers['x-along-user']===USER_A),'现役绑定收到注册/泵流量');
    assert.equal(stub.requests.some(record=>
      JSON.stringify({h:record.headers,b:record.body,p:record.path}).includes(USER_B)),
      false,'过期绑定在每用户迭代中被跳过：U2 零流量');
    assert.equal(stub.requests.some(record=>record.path.startsWith('/along-source/api/pairing')&&record.body?.user_id===USER_A),
      true,'启动登记只登记现役绑定');
    assert.equal(host.alive(),true,'带过期绑定的泵循环不使 host 出错');
  } finally {cleanup();}
});

// ---- 验收 #7：运行链路限流与 429 透传（G-1 host 侧）---------------------------------------------

test('验收#7 G-1：60s 内第 11 次 /super-agent/goals 与 /super-agent/tasks → 429「请求过于频繁」；stub runner /run 回 429 → 客户端 429 + 原文案（不折叠 502）；status 端点不受限',async t=>{
  const {dir,cleanup}=tempDir('along-adm-runlimit-');
  let runnerReply={status:429,body:{error:'模型运行并发已达上限，请稍后再试'}};
  const runner=await stubServer(t,()=>runnerReply);
  try {
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B,label:'B'}]);
    const host=await spawnHost(t,{dir,env:{
      ALONG_DSH_RUNNER_URL:runner.url,
      ALONG_RUNNER_TOKEN_FILE:writeSecret(dir,'runner-token'),
    }});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const tokenA=(await pairCode(host,issueCodeViaCli(dir,USER_A).stdout.trim())).json.token;
    const tokenB=(await pairCode(host,issueCodeViaCli(dir,USER_B).stdout.trim())).json.token;
    const post=(token,path,body)=>phoneCall(host.port,path,{method:'POST',body,headers:{authorization:`Bearer ${token}`}});

    // runner 的 429 原样透传（goals 与 tasks 两条 start 端点），不折叠成 502
    const passGoal=await post(tokenA,'/super-agent/goals',
      {runtime:DSH_RUNTIME,goal:{domain:'custom',title:'演示目标'},message:'你好',requestId:'adm-goal-429'});
    assert.equal(passGoal.status,429,'runnerCall 对 429 保留原状态码');
    assert.equal(passGoal.json.error,'模型运行并发已达上限，请稍后再试','客户端收到 runner 原文案');
    const passTask=await post(tokenB,'/super-agent/tasks',
      {runtime:DSH_RUNTIME,requestId:'adm-task-429',task:{title:'演示任务'},goal:{domain:'custom'},context:{}});
    assert.equal(passTask.status,429);
    assert.equal(passTask.json.error,'模型运行并发已达上限，请稍后再试');

    // 打满 USER_A 的 goals 窗口：以上透传 1 次 + 9 次无效体（400，不达上游）= 10 次 → 第 11 次 429
    for (let i=1;i<=9;i++) assert.equal((await post(tokenA,'/super-agent/goals',{})).status,400);
    const goalEleven=await post(tokenA,'/super-agent/goals',{});
    assert.equal(goalEleven.status,429,'60s 内第 11 次 /super-agent/goals → 429');
    assert.match(goalEleven.json.error,/请求过于频繁/,'限流文案「请求过于频繁」');

    // USER_B 的 tasks 窗口：透传 1 次 + 9 次缺 requestId（400）= 10 次 → 第 11 次 429
    for (let i=1;i<=9;i++) assert.equal((await post(tokenB,'/super-agent/tasks',{})).status,400);
    const taskEleven=await post(tokenB,'/super-agent/tasks',{});
    assert.equal(taskEleven.status,429,'60s 内第 11 次 /super-agent/tasks → 429');
    assert.match(taskEleven.json.error,/请求过于频繁/);

    // 两个 status 端点不受限：窗口满后连发 12 次都按上游错误 502，绝不 429（每 4s 轮询是合法高频）
    runnerReply={status:404,body:{error:'无此运行'}};
    for (let i=1;i<=12;i++) {
      const goalStatus=await post(tokenA,'/super-agent/goals/status',{requestId:'adm-goal-429'});
      assert.equal(goalStatus.status,502,'goals/status 不限流（仅上游故障 502）');
      assert.notEqual(goalStatus.status,429);
      const taskStatus=await post(tokenB,'/super-agent/tasks/status',{requestId:'adm-task-429'});
      assert.equal(taskStatus.status,502,'tasks/status 不限流');
      assert.notEqual(taskStatus.status,429);
    }
  } finally {cleanup();}
});

test('验收#7 G-1：本地单用户形态不启用限流（12 次 start 无 429），/pair 不产生审计行（Mac 行为不变）',async t=>{
  const {dir,cleanup}=tempDir('along-adm-local-');
  try {
    const host=await spawnHost(t,{dir});
    await waitFor(()=>host.pairingCode(),'启动横幅出现通用码');
    const universal=host.pairingCode();
    const token=(await pairCode(host,universal)).json.token;
    for (let i=1;i<=12;i++) {
      const run=await phoneCall(host.port,'/super-agent/goals',{method:'POST',body:{},
        headers:{authorization:`Bearer ${token}`}});
      assert.notEqual(run.status,429,`本地第 ${i} 次 start 绝不限流`);
      assert.equal(run.status,400,'本地无 DSH runner，无效体照常 400');
    }
    assert.doesNotMatch(host.text(),/请求过于频繁/,'本地形态无限流文案');
    assert.doesNotMatch(host.text(),/配对成功|配对失败/,'本地形态 /pair 无新增审计行（G-15 只在多用户形态）');
  } finally {cleanup();}
});

// ---- 验收 #8：任务信封输出契约 normalizeTaskRun（G-7）-------------------------------------------

test('验收#8 G-7：normalizeTaskRun 合法 {summary,next} 原样；缺任一/空串/超长/多键/非字符串/数组 → blocked 终态 result:null error 含「输出校验失败」；result:null 透传；start 与 status 两路径都执行',async t=>{
  const {dir,cleanup}=tempDir('along-adm-taskrun-');
  const envelopes=new Map();
  const runner=await stubServer(t,record=>{
    const id=record.method==='POST'&&record.path==='/run'
      ?record.body?.requestId
      :decodeURIComponent(record.path.replace(/^\/run\//,''));
    const run=envelopes.get(id);
    return run?{status:200,body:{run}}:{status:404,body:{error:'无此运行'}};
  });
  try {
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B,label:'B'}]);
    const host=await spawnHost(t,{dir,env:{
      ALONG_DSH_RUNNER_URL:runner.url,
      ALONG_RUNNER_TOKEN_FILE:writeSecret(dir,'runner-token'),
    }});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const tokenA=(await pairCode(host,issueCodeViaCli(dir,USER_A).stdout.trim())).json.token;
    const tokenB=(await pairCode(host,issueCodeViaCli(dir,USER_B).stdout.trim())).json.token;
    const post=(token,path,body)=>phoneCall(host.port,path,{method:'POST',body,headers:{authorization:`Bearer ${token}`}});
    const taskBody=(token,requestId)=>post(token,'/super-agent/tasks',
      {runtime:DSH_RUNTIME,requestId,task:{title:'演示任务'},goal:{domain:'custom'},context:{}});
    const statusBody=(token,requestId)=>post(token,'/super-agent/tasks/status',{requestId});

    // 合法 {summary,next}：start 路径原样透传
    envelopes.set('adm-task-ok',taskRun('adm-task-ok',{summary:'已完成演示摘要',next:'查看演示结果'}));
    const ok=await taskBody(tokenA,'adm-task-ok');
    assert.equal(ok.status,200);
    assert.equal(ok.json.run.status,'done');
    assert.deepEqual(ok.json.run.result,{summary:'已完成演示摘要',next:'查看演示结果'},'合法输出原样');
    assert.equal('error' in ok.json.run,false,'合法输出无 error');

    // 非法输出：一律 blocked 终态 + result:null + error 含「输出校验失败」（不 5xx、不原样入站）
    const invalid=[
      ['缺 next',{summary:'有摘要'}],
      ['缺 summary',{next:'有下一步'}],
      ['空串',{summary:'   ',next:'n'}],
      ['summary 超长',{summary:'超'.repeat(301),next:'n'}],
      ['next 超长',{summary:'s',next:'长'.repeat(301)}],
      ['多键',{summary:'s',next:'n',extra:'任意其他键即拒绝'}],
      ['非字符串',{summary:42,next:'n'}],
      ['数组 result',['摘要','下一步']],
    ];
    for (const [label,result] of invalid) {
      const id=`adm-task-bad-${invalid.findIndex(item=>item[0]===label)}`;
      envelopes.set(id,taskRun(id,result));
      const reply=await taskBody(tokenA,id);
      assert.equal(reply.status,200,`${label}：落终态而不是 5xx`);
      const run=reply.json.run;
      assert.equal(run.status,'blocked',`${label} → blocked 终态`);
      assert.equal(run.statusLabel,'输出需要重试',`${label} → statusLabel`);
      assert.equal(run.result,null,`${label} → result:null（任意形状 JSON 不入运行信封）`);
      assert.match(run.error,/输出校验失败/,`${label} → error 含「输出校验失败」`);
    }

    // result:null 中间态透传（working）
    envelopes.set('adm-task-working',taskRun('adm-task-working',null,'working'));
    const working=await taskBody(tokenB,'adm-task-working');
    assert.equal(working.json.run.status,'working','result:null 中间态原样透传');
    assert.equal(working.json.run.result,null);

    // status 路径同样强制执行：非法 → blocked；合法 → 原样
    envelopes.set('adm-task-status-bad',taskRun('adm-task-status-bad',{summary:'只有摘要'}));
    const badStatus=await statusBody(tokenB,'adm-task-status-bad');
    assert.equal(badStatus.json.status,'blocked','status 路径的非法输出 → blocked');
    assert.equal(badStatus.json.result,null);
    assert.match(badStatus.json.error,/输出校验失败/);
    envelopes.set('adm-task-status-ok',taskRun('adm-task-status-ok',{summary:'状态摘要',next:'状态下一步'}));
    const okStatus=await statusBody(tokenB,'adm-task-status-ok');
    assert.equal(okStatus.json.status,'done','status 路径的合法输出原样');
    assert.deepEqual(okStatus.json.result,{summary:'状态摘要',next:'状态下一步'});
  } finally {cleanup();}
});

// ---- 验收 #9：tasks 路径 context 全域清洗（G-20）------------------------------------------------

test('验收#9 G-20（云端 runner 路径）：finance/custom/health/无合法域的 context 在上游收到前完成清洗',async t=>{
  const {dir,cleanup}=tempDir('along-adm-context-');
  const runner=await stubServer(t,record=>({status:200,body:{run:taskRun(record.body?.requestId??'stub',{summary:'s',next:'n'})}}));
  try {
    writeUsers(dir,[{userId:USER_C,label:'C'},{userId:USER_D,label:'D'},{userId:USER_E,label:'E'}]);
    const host=await spawnHost(t,{dir,env:{
      ALONG_DSH_RUNNER_URL:runner.url,
      ALONG_RUNNER_TOKEN_FILE:writeSecret(dir,'runner-token'),
    }});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const tokenC=(await pairCode(host,issueCodeViaCli(dir,USER_C).stdout.trim())).json.token;
    const tokenD=(await pairCode(host,issueCodeViaCli(dir,USER_D).stdout.trim())).json.token;
    const tokenE=(await pairCode(host,issueCodeViaCli(dir,USER_E).stdout.trim())).json.token;
    const post=(token,requestId,goal,context)=>phoneCall(host.port,'/super-agent/tasks',
      {method:'POST',body:{runtime:DSH_RUNTIME,requestId,task:{title:'演示任务'},goal,context},
        headers:{authorization:`Bearer ${token}`}});
    const sent=requestId=>runner.requests.find(record=>
      record.method==='POST'&&record.path==='/run'&&record.body?.requestId===requestId);

    // finance：{saved:123,junk:…} → 上游仅收到 {saved:123,source:'演示数据'}
    const finance=await post(tokenC,'adm-ctx-finance',{domain:'finance'},{saved:123,junk:'原始明细',nested:{secret:1}});
    assert.equal(finance.status,200);
    const sentFinance=sent('adm-ctx-finance');
    assert.ok(sentFinance,'runner 收到一次 /run');
    assert.deepEqual(sentFinance.body.input.context,{saved:123,source:'演示数据'},'finance 只留 saved+演示数据来源');
    assert.equal(sentFinance.raw.includes('原始明细'),false,'junk 不出站到模型');
    assert.equal(sentFinance.raw.includes('secret'),false);

    // custom：任意值 → {source:'暂无连接'}
    await post(tokenD,'adm-ctx-custom',{domain:'custom'},{raw:'原始',saved:1});
    assert.deepEqual(sent('adm-ctx-custom').body.input.context,{source:'暂无连接'},'custom → {source:暂无连接}');

    // health：与 agentHealthSnapshot 一致（tasks 无 planning）
    const sample={selectedTypes:['workout','sleep'],workoutMinutes:210,capturedAt:'2026-11-21T08:00:00.000Z',source:'watch'};
    await post(tokenE,'adm-ctx-health',{domain:'health'},sample);
    assert.deepEqual(sent('adm-ctx-health').body.input.context,agentHealthSnapshot(sample),
      'health 域与 agentHealthSnapshot 逐键一致');

    // 无合法域 → {}
    await post(tokenD,'adm-ctx-bogus',{domain:'bogus'},{saved:1,junk:'原始'});
    assert.deepEqual(sent('adm-ctx-bogus').body.input.context,{},'无合法域 → {}');
  } finally {cleanup();}
});

test('验收#9 G-20（Mac bridge 路径）：本地形态（无 ALONG_DSH_RUNNER_URL）的 tasks 同样收到清洗后 context',async t=>{
  const {dir,cleanup}=tempDir('along-adm-bridge-');
  const along=await stubServer(t,()=>({status:200,body:{ok:true}}));
  try {
    const host=await spawnHost(t,{dir,env:{ALONG_SUPERAGENT_URL:along.url}});
    await waitFor(()=>host.pairingCode(),'启动横幅出现通用码');
    const token=(await pairCode(host,host.pairingCode())).json.token;
    const reply=await phoneCall(host.port,'/super-agent/tasks',{method:'POST',
      body:{runtime:DSH_RUNTIME,requestId:'adm-bridge-ctx',task:{title:'演示任务'},goal:{domain:'finance'},
        context:{saved:123,junk:'机密原始明细'}},
      headers:{authorization:`Bearer ${token}`}});
    assert.equal(reply.status,200);
    const sent=along.requests.find(record=>record.method==='POST'&&record.path==='/along-source/api/tasks');
    assert.ok(sent,'Along Agent 桥收到一次 /along-source/api/tasks');
    assert.deepEqual(sent.body.context,{saved:123,source:'演示数据'},'Mac bridge 路径同样收到清洗后 context');
    assert.equal(sent.raw.includes('机密原始明细'),false,'原始 context 不出站');
  } finally {cleanup();}
});

test('验收#9 G-20（Kimi 分支）：清洗发生在分流之前——Kimi 提示词与 kimi-runs.json 落盘都不含原始 context',async t=>{
  const {dir,cleanup}=tempDir('along-adm-kimi-');
  const kimi=await stubServer(t,record=>{
    if (record.path==='/api/v1/meta') return {status:200,body:{code:0,data:{server_version:'stub',features:[{name:'swarm',state:'Active'}]}}};
    if (record.path==='/api/v1/auth') return {status:200,body:{code:0,data:{models_ready:true}}};
    if (record.path==='/api/v1/oauth/userinfo') return {status:200,body:{code:0,data:{kind:'ok',userInfo:{userLevelName:'Team'}}}};
    if (record.path==='/api/v1/sessions') return {status:200,body:{code:0,data:{id:'stub-session'}}};
    if (record.path==='/api/v1/sessions/stub-session/profile') return {status:200,body:{code:0,data:{}}};
    if (record.path==='/api/v1/sessions/stub-session/prompts') return {status:200,body:{code:0,data:{}}};
    if (record.path==='/api/v1/sessions/stub-session') return {status:200,body:{code:0,data:{busy:false,last_turn_reason:'completed',pending_interaction:null,updated_at:'2026-11-21T08:00:00.000Z'}}};
    if (record.path==='/api/v1/sessions/stub-session/messages') return {status:200,body:{code:0,data:{items:[]}}};
    if (record.path==='/api/v1/sessions/stub-session/children') return {status:200,body:{code:0,data:{items:[]}}};
    if (record.path.startsWith('/api/v1/sessions/stub-session/transcript')) return {status:200,body:{code:0,data:{items:[]}}};
    return {status:200,body:{code:0,data:{}}};
  });
  try {
    writeUsers(dir,[{userId:USER_F,label:'F'}]);
    const host=await spawnHost(t,{dir,env:{
      ALONG_KIMI_CODE_URL:kimi.url,
      ALONG_KIMI_CODE_TOKEN:'kimi-stub-token',
    }});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const token=(await pairCode(host,issueCodeViaCli(dir,USER_F).stdout.trim())).json.token;
    const reply=await phoneCall(host.port,'/super-agent/tasks',{method:'POST',
      body:{runtime:KIMI_RUNTIME,requestId:'adm-kimi-ctx',task:{title:'演示任务'},goal:{domain:'finance'},
        context:{saved:123,junk:'机密原始明细'}},
      headers:{authorization:`Bearer ${token}`}});
    assert.equal(reply.status,200);
    assert.equal(reply.json.run.runtime,KIMI_RUNTIME,'Kimi 分支正常返回');
    assert.equal('result' in reply.json.run,false,'Kimi 任务信封本就无 result 字段');

    // 提示词（分流前的同一份 dshInput）：含清洗后的 context，不含原始明细
    const prompt=kimi.requests.find(record=>record.path==='/api/v1/sessions/stub-session/prompts');
    assert.ok(prompt,'Kimi 收到一次 prompts 提交');
    const promptText=prompt.body?.content?.[0]?.text??'';
    assert.equal(promptText.includes('机密原始明细'),false,'Kimi 提示词不含原始明细');
    assert.match(promptText,/"saved":123/,'Kimi 提示词含清洗后 context');

    // kimi-runs.json 落盘的 entry.input 同样是清洗后的 context
    const runs=JSON.parse(readFileSync(join(dir,'kimi-runs.json'),'utf8'));
    const entry=runs[`${USER_F}:adm-kimi-ctx`];
    assert.ok(entry,'运行记录按 userId:requestId 落盘');
    assert.deepEqual(entry.input.context,{saved:123,source:'演示数据'},'kimi-runs.json 落盘清洗后 context');
    assert.equal(readFileSync(join(dir,'kimi-runs.json'),'utf8').includes('机密原始明细'),false,'原始 context 不落盘');
  } finally {cleanup();}
});

// ---- 验收 #10：连接级防护（G-3，真实进程行为级）-------------------------------------------------

test('验收#10 G-3：同 IP 第 25 个并发 TCP 连接被销毁、前 24 个可用、close 后计数递减；源码断言 maxConnections=64/headersTimeout=15_000/requestTimeout=60_000',async t=>{
  // 源码切片断言（三个常数内置，两种形态一致）
  const source=readFileSync(HOST_FILE,'utf8');
  assert.match(source,/server\.maxConnections=64;/,'maxConnections=64');
  assert.match(source,/server\.headersTimeout=15_000;/,'headersTimeout=15_000');
  assert.match(source,/server\.requestTimeout=60_000;/,'requestTimeout=60_000');

  const {dir,cleanup}=tempDir('along-adm-conn-');
  const sockets=[];
  try {
    const host=await spawnHost(t,{dir});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const openSocket=()=>new Promise(resolve=>{
      const socket=net.connect({host:'127.0.0.1',port:host.port});
      const state={socket,closed:false};
      let settled=false;
      const settle=()=>{if (!settled) {settled=true; resolve(state);}};
      socket.on('connect',settle);
      socket.on('close',()=>{state.closed=true; settle();});
      socket.on('error',()=>{/* destroy 后的 RST/ECONNRESET */});
      setTimeout(settle,5_000).unref?.();
    });
    // 前 24 个连接建立并保持（TLS 握手开始前只占计数，不发数据）
    for (let i=0;i<24;i++) sockets.push(await openSocket());
    for (const state of sockets) assert.equal(state.closed,false,'前 24 个连接可用');
    await sleep(500);
    for (const state of sockets) assert.equal(state.closed,false,'前 24 个连接未被服务端销毁');
    // 第 25 个：立即被销毁（在握手开始前）。客户端 socket 没有 'data' 监听时处于非 flowing 模式，
    // Node 不会主动读它，对端 destroy 的 FIN 不会被派发成 'close'——轮询期间主动 read() 触发流机器，
    // EOF 才能被观察到（真实 iOS 客户端本来就处于 TLS 读写状态，无此问题；服务端 destroy 已在内核生效）。
    const doomed=await openSocket();
    sockets.push(doomed);
    const doomedDeadline=Date.now()+1_500;
    while (Date.now()<doomedDeadline && !doomed.closed) { doomed.socket.read(); await sleep(50); }
    assert.equal(doomed.closed,true,'第 25 个连接被服务端销毁');
    // close 一个后计数递减：新连接可用
    await new Promise(resolve=>{
      sockets[0].socket.end();
      sockets[0].socket.once('close',resolve);
      setTimeout(resolve,2_000).unref?.();
    });
    const revived=await openSocket();
    sockets.push(revived);
    await sleep(500);
    assert.equal(revived.closed,false,'释放一个连接后新连接可用（close 递减计数）');
  } finally {
    for (const state of sockets) {try{state.socket.destroy();}catch{}}
    cleanup();
  }
});

// ---- 验收 #11：/pair 审计与拒绝限速（G-15）------------------------------------------------------

test('验收#11 G-15：多用户 /pair 成功/计入窗口的失败/预检拒绝各产生一行含来源 IP 的日志且不含码与 token；同源 60s ≥30 次预检拒绝只 1 行；计入窗口的失败与成功不受限速',async t=>{
  const {dir,cleanup}=tempDir('along-adm-audit-');
  try {
    writeUsers(dir,[{userId:USER_A,label:'A'}]);
    const host=await spawnHost(t,{dir});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const code=issueCodeViaCli(dir,USER_A).stdout.trim();

    // 同一来源 60s 内 30 次预检拒绝（content-type 非法）→ 只产生 1 行拒绝日志
    for (let i=0;i<30;i++) {
      const reply=await phoneCall(host.port,'/pair',{method:'POST',body:{code:'00000000'},headers:{'content-type':'text/plain'}});
      assert.equal(reply.status,400);
    }
    // 再来一次来源无效预检：同源同窗被限速抑制，预检拒绝仍只有 1 行
    const originReply=await phoneCall(host.port,'/pair',{method:'POST',body:{code:'00000000'},headers:{origin:'https://evil.example'}});
    assert.equal(originReply.status,403);
    const precheckLines=host.text().match(/配对失败 原因=(?:格式无效|来源无效) 来源=[^（]+（[^）]+）/g)??[];
    assert.equal(precheckLines.length,1,'同源 60s 内 ≥30 次预检拒绝只产生 1 行拒绝日志');
    assert.match(precheckLines[0],/来源=127\.0\.0\.1（\d{4}-/,'拒绝行含来源 IP 与 ISO 时间');

    // 计入窗口的失败不受限速：unknown 立即落行
    const unknownReply=await pairCode(host,'00000000');
    assert.equal(unknownReply.status,403);
    const unknownLines=host.text().match(/配对失败 原因=unknown 来源=[^（]+（[^）]+）/g)??[];
    assert.equal(unknownLines.length,1,'计入窗口的失败不受限速影响，立即落行');

    // 成功一行（成功不受限速）
    const paired=await pairCode(host,code);
    assert.equal(paired.status,200);
    const token=paired.json.token;
    const successLines=host.text().match(/配对成功 user=[^（]+ 来源=[^（]+（[^）]+）/g)??[];
    assert.equal(successLines.length,1,'成功记一行');
    assert.match(successLines[0],/user=u_aaaa1111 来源=127\.0\.0\.1（\d{4}-\d{2}-\d{2}T/,'成功行含 userId、来源 IP 与 ISO 时间');

    // 日志不含码与 token（§3.7 红线）
    const text=host.text();
    assert.equal(text.includes(code),false,'码不落日志');
    assert.equal(text.includes(token),false,'token 不落日志');
  } finally {cleanup();}
});

// ---- 验收 #12：绑定文件即事实来源（G-5/SD-H15，防内存兜底复活）----------------------------------

test('验收#12 G-5/SD-H15：删除 pairings.json 后所有绑定 401、重新配对即恢复（负路径语义断言）',async t=>{
  const {dir,cleanup}=tempDir('along-adm-source-of-truth-');
  try {
    writeUsers(dir,[{userId:USER_A,label:'A'},{userId:USER_B,label:'B'}]);
    const host=await spawnHost(t,{dir});
    await waitFor(()=>host.text().includes('证书指纹'),'启动横幅');
    const tokenA=(await pairCode(host,issueCodeViaCli(dir,USER_A).stdout.trim())).json.token;
    const tokenB=(await pairCode(host,issueCodeViaCli(dir,USER_B).stdout.trim())).json.token;
    assert.deepEqual((await verifyToken(host.port,tokenA)).json,{paired:true});
    assert.deepEqual((await verifyToken(host.port,tokenB)).json,{paired:true});

    // 误删 pairings.json：文件即唯一事实来源，所有绑定立即丢失（fail-closed，不做内存兜底）
    rmSync(join(dir,'pairings.json'));
    assert.equal((await verifyToken(host.port,tokenA)).status,401,'删除后 A 的绑定 401');
    assert.equal((await verifyToken(host.port,tokenB)).status,401,'删除后 B 的绑定 401');
    assert.equal(pairingsFileOrNull(dir),null,'host 没有用内存兜底写回绑定表');

    // 恢复路径=重新发码配对：即恢复
    const tokenA2=(await pairCode(host,issueCodeViaCli(dir,USER_A).stdout.trim())).json.token;
    assert.equal((await verifyToken(host.port,tokenA)).status,401,'旧 token 仍是 401');
    assert.deepEqual((await verifyToken(host.port,tokenA2)).json,{paired:true},'重新配对即恢复');
    const tokenB2=(await pairCode(host,issueCodeViaCli(dir,USER_B).stdout.trim())).json.token;
    assert.deepEqual((await verifyToken(host.port,tokenB2)).json,{paired:true},'B 重新配对后恢复');
    assert.equal(readPairingsFile(dir).length,2);
    assert.ok(readPairingsFile(dir).every(item=>Number.isFinite(item.expiresAt)),'重新写入的绑定带 expiresAt');
  } finally {cleanup();}
});

// ---- 验收 #13 的支撑： BINDING_RENEW_AHEAD_MS 导出常数（滑动续期阈值与文档一致）----------------

test('验收#6 支撑：BINDING_TTL_MS=30 天、BINDING_RENEW_AHEAD_MS=7 天为导出常数（剩余<7 天续期一轮）',()=>{
  assert.equal(BINDING_TTL_MS,30*24*60*60_000);
  assert.equal(BINDING_RENEW_AHEAD_MS,7*24*60*60_000);
  assert.ok(BINDING_RENEW_AHEAD_MS<BINDING_TTL_MS,'续期提前量小于过期时长');
});
