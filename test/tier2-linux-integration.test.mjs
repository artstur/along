import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,X509Certificate} from 'node:crypto';
import https from 'node:https';
import {DatabaseSync} from 'node:sqlite';
import {makeTestCa, stageRelease, rotateLeaf} from './cloud-ca-fixture.mjs';

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
// Docker 为每个隔离栈分配回环端口。项目名同时隔离容器、镜像标签和夹具目录。

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const DEPLOY_DIR=join(ROOT,'deploy');
const COMPOSE_FILE=join(DEPLOY_DIR,'docker-compose.yml');
const COMPOSE_TIER2=join(DEPLOY_DIR,'docker-compose.tier2.yml');

const USERS=['u_aaaa1111','u_bbbb2222'];
const HOST_NAME='along.test.local';

// ---- 隔离标识（审查 P2-6）--------------------------------------------------
//
// 之前这个用例在默认的 `deploy` 项目下跑 `up --build` 与 `down -v`，
// 容器名也是生产名（along-host / along-superagent）。与部署共用同一个 Docker daemon 时，
// 这会**重建或停掉正在运行的服务**——测试不该动别人的东西。
// 所以这里用独立的项目名、容器名与镜像标签：项目名带随机后缀（两次并发也不撞），
// 容器名与镜像标签带固定前缀（一眼看出是测试栈）。
const PROJECT=`along-tier2-test-${process.pid}-${randomBytes(4).toString('hex')}`;
// 容器名也带进程号：上一次跑崩了留下的容器不挡下一次——
// docker 的容器名是全局的，重名会让 `up` 直接失败。
const CONTAINER_PREFIX=PROJECT;
// 镜像标签也带进程号（第二轮复核 P2-6）：标签是全局的，
// 两个并发用例共用一个标签时，`up --build` 会把**另一个用例**正在用的镜像覆盖掉，
// 而那个用例的容器还在跑着那个标签——它的下一次重建就会拿到别人的镜像。
const IMAGE_TAG=`${PROJECT}:local`;

// Docker 分配锚点端口，回退时由 Tier 1 Host 接管同一个端口。
let port;

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
//
// 目录按运行随机化（第二轮复核 P2-6）：固定目录意味着两个并发用例会**共用**同一份
// 状态目录——而这个用例的开头会 `rmSync(BASE)` 清掉它，于是后一个用例把前一个的
// 业务库、证书与 secret 全删了（两个用例同时跑时，前一个的断言会莫名其妙地失败）。
// 按进程号 + 随机段分目录，各跑各的。
const BASE=join(ROOT,'.tier2-integration',PROJECT);
const HOST_STATE=join(BASE,'host');
const SUPER_STATE=join(BASE,'superagent');
const DSH_HOME=join(BASE,'dsh-home');
const SECRETS=join(BASE,'secrets');
const OVERLAY=join(BASE,'compose.test.yml');
// 回退形态（Tier 1）的叠加文件：Tier 1 的 Host 自己发布端口（不再是锚点发布），
// 而且它不需要 netns / superagent 两个服务。
const ROLLBACK_OVERLAY=join(BASE,'compose.rollback.yml');
// Tier 2 专用的叠加文件：netns 与 superagent 两个服务（只在 Tier 2 形态存在）。
const TIER2_OVERLAY=join(BASE,'compose.tier2.yml');

// ---- 栈内调用 --------------------------------------------------------------

function phoneRequest({path,method='POST',body,token}) {
  const raw=JSON.stringify(body??{});
  const ca=readFileSync(join(BASE,'test-ca','ca.crt'));
  return new Promise((resolve,reject)=>{
    const request=https.request({host:'127.0.0.1',port,servername:HOST_NAME,ca,agent:false,path,method,
      headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw),
        ...(token?{authorization:`Bearer ${token}`}:{})}},response=>{
      const fingerprint=response.socket.getPeerCertificate().fingerprint256;
      let data='';
      response.on('data',chunk=>data+=chunk);
      response.on('end',()=>{
        let parsed=null;
        try { parsed=JSON.parse(data); } catch { /* 非 JSON 响应：保留原文。 */ }
        resolve({status:response.statusCode,body:parsed,text:data,fingerprint});
      });
    });
    request.on('error',reject);
    request.setTimeout(4_000,()=>request.destroy(Error('Host 请求超时')));
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
// 换成本次测试的绝对路径。真实 Tier 1 runner 在回退后处理连接检查。
//
// 为什么用叠加文件而不是改主 compose：主 compose 是生产形态（§6.4 的 /opt/along 布局），
// 测试不该改动它。叠加文件是 compose 原生的隔离手段，`!override` 保证替换而不是追加。
function writeOverlay() {
  mkdirSync(BASE,{recursive:true});
  // Super Agent 源码位置：**默认与部署同源**（compose 里钉住的那个远端 git 上下文 +
  // 固定提交）。用例必须验的是**部署真正会装的那个版本**——
  // 否则会出现「部署装的是固定提交，用例验的是本地工作区」这种验不到点上的情况
  // （本地工作区没带就绪修复时，重启恢复那一步会失败于 filtered/source_not_installed）。
  //
  // 要对着**别的** Super Agent 验（例如未修复的上游，做负例）时用
  // ALONG_TIER2_SUPERAGENT_REPO 指向它。
  const override=process.env.ALONG_TIER2_SUPERAGENT_REPO;
  const superagentRepo=override?resolve(override):null;
  if (superagentRepo&&!existsSync(superagentRepo)) throw Error(`Super Agent 源码目录不存在：${superagentRepo}`);
  writeFileSync(OVERLAY,[
    'services:',
    '  host:',
    // 容器名：独立前缀，不与部署的 along-host / along-superagent 撞。
    `    container_name: ${CONTAINER_PREFIX}-host`,
    // 镜像标签：独立标签，不覆盖部署栈正在用的 along-host:local / along-superagent:local。
    `    image: ${IMAGE_TAG}-host`,
    // **构建标签**也必须覆盖（第二轮复核 P2-6）：主 compose 的 host 服务带
    // `build: {tags: [along-host:local]}`。叠加文件只改 `image:` 是不够的——
    // `up --build` 会按 build 段的 tags **重新打标签**，于是测试的构建会更新
    // 部署正在用的 `along-host:local` 标签：部署的容器还在跑（跑的是旧镜像的
    // 镜像层），但它下次重建就会拿到测试的镜像——测试改了部署的行为。
    // 注意 `!override` 要加在 **tags 键本身**上：加在 `build:` 上只会**追加**
    // （compose 对序列默认是合并），那样部署的 along-host:local 标签还在，
    // `up --build` 照样会更新它——实测过。
    '    build:',
    `      tags: !override ["${IMAGE_TAG}-host"]`,
    '    volumes: !override ["'+HOST_STATE+':/data"]',
    // 期望的 DNS 主机名必须与测试叶证书的 SAN 一致（云端 TLS 的启动前校验项之一：
    // 不一致就拒启——这正是「叶证书配错域名」该有的行为）。
    '    environment:',
    '      ALONG_TLS_CN: '+HOST_NAME,
    // 本用例不部署远程通知（没有 APNs 私钥），所以删掉 apns-key 引用——
    // file secret 指向不存在的文件会让 up 直接失败。
    // runner-token **必须保留**：配置了云端 Runner URL 就必须带它，否则 Host 拒绝启动
    // （host/agent-host.mjs 的启动守卫）。
    '    secrets: !override [runner-token, bridge-token]',
    '  agent:',
    `    container_name: ${CONTAINER_PREFIX}-agent`,
    `    image: ${IMAGE_TAG}-agent`,
    '    build:',
    `      tags: !override ["${IMAGE_TAG}-agent"]`,
    'secrets:',
    '  bridge-token:',
    '    file: '+join(SECRETS,'bridge-token'),
    '  runner-token:',
    '    file: '+join(SECRETS,'runner-token'),
    '  model-credentials:',
    '    file: '+join(SECRETS,'model-credentials'),
    '',
  ].join('\n'));

  // Tier 2 专用的叠加文件：命名空间锚点（netns）与常驻服务（superagent）。
  //
  // 为什么单独一个文件：这两个服务**只在 Tier 2 形态**里存在（Tier 1 的 Host
  // 自己发布端口，没有锚点，也没有常驻服务）。写在共用文件里的话，
  // 回退（不叠加 tier2 文件）会因为「netns 没有 image 或 build context」
  // 而直接报 invalid compose project——回退根本走不到。
  writeFileSync(TIER2_OVERLAY,[
    'services:',
    '  superagent:',
    `    container_name: ${CONTAINER_PREFIX}-superagent`,
    `    image: ${IMAGE_TAG}-superagent`,
    // 模型密钥：长驻服务要真跑模型回合就得拿得到它（审查 P1-4）。
    // 本用例不跑真实模型回合，所以放一份**合成的**占位 key——
    // 验的是「凭证能到位、启动脚本能读出并注入」，不是模型本身。
    '    secrets: !override [bridge-token, model-credentials]',
    '    volumes: !override ["'+SUPER_STATE+':/var/lib/along-superagent","'+DSH_HOME+':/var/lib/dsh"]',
    '    build:',
    // superagent 服务的 build.tags 也要换成测试标签，
    // 否则 `up --build` 会更新部署的 along-superagent:local 标签。
    `      tags: !override ["${IMAGE_TAG}-superagent"]`,
    // 默认**不覆盖**构建来源：用主 compose 里钉住的那个远端 git 上下文 + 固定提交
    // （部署真正会装的那个版本）。覆盖时（负例）才写本地路径。
    ...(superagentRepo?['      additional_contexts:','        along: '+superagentRepo]:[]),
    // 命名空间锚点：Tier 2 的叠加文件定义它。测试里换掉端口与容器名，
    // 但拓扑不变——host 与 superagent 都加入锚点的命名空间（审查 P1-3）。
    '  netns:',
    `    container_name: ${CONTAINER_PREFIX}-netns`,
    '    ports: !override ["127.0.0.1::4176"]',
    '',
  ].join('\n'));
}

function publishedPort() {
  const result=compose(['port','netns','4176']);
  assert.equal(result.status,0,result.stderr);
  const value=result.stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  assert.ok(value,'应由 Docker 为测试锚点分配本地端口');
  return Number(value);
}

function compose(args,{cwd=DEPLOY_DIR,input,timeout=90_000}={}) {
  // 独立项目名（审查 P2-6）：测试栈不与部署栈共用项目、容器名或镜像标签。
  const result=spawnSync(DOCKER.bin,[...DOCKER.prefix,'-f',COMPOSE_FILE,'-f',COMPOSE_TIER2,'-f',OVERLAY,'-f',TIER2_OVERLAY,
    '--profile','tier2','-p',PROJECT,...args],
    {cwd,encoding:'utf8',input,timeout});
  return {status:result.status,stdout:result.stdout??'',stderr:result.stderr??''};
}

/**
 * Tier 1 形态的 compose 调用（**不叠加** tier2 文件）。
 *
 * 回退就是「去掉 Tier 2 叠加文件」——用 Tier 2 的文件重建出来的不是回退形态：
 * ALONG_EVENT_INGEST 还是 on、443 的发布还在锚点上。
 * 所以回退那一步必须走这个。
 */
function composeTier1(args,{cwd=DEPLOY_DIR}={}) {
  const result=spawnSync(DOCKER.bin,[...DOCKER.prefix,'-f',COMPOSE_FILE,'-f',OVERLAY,'-f',ROLLBACK_OVERLAY,
    '-p',PROJECT,...args],
    {cwd,encoding:'utf8',timeout:90_000});
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
  // 桥接凭证：host 与 superagent 读同一份 0600 的 32 字节 hex 文件。
  writeFileSync(join(SECRETS,'bridge-token'),randomBytes(32).toString('hex'),{mode:0o600});
  // Tier 1 runner 的内网令牌：Host 启动守卫要求它（配置了云端 Runner URL 就必须有）。
  writeFileSync(join(SECRETS,'runner-token'),randomBytes(32).toString('hex'),{mode:0o600});
  // 合成的模型密钥占位（0600 单行）：验凭证到位与注入，不验真实模型回合。
  writeFileSync(join(SECRETS,'model-credentials'),'sk-synthetic-placeholder-key',{mode:0o600});

  writeOverlay();

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

  const config=compose(['config','--format','json']);
  assert.equal(config.status,0,config.stderr);
  const rendered=JSON.parse(config.stdout);
  for (const service of ['host','agent','superagent']) {
    const entry=rendered.services[service];
    assert.equal(entry.image,`${IMAGE_TAG}-${service}`);
    assert.deepEqual(entry.build.tags,[entry.image]);
  }
  const up=compose(['up','-d','--build'],{timeout:600_000});
  assert.equal(up.status,0,`compose up 失败：${up.stderr.slice(-4000)}`);
  port=publishedPort();
  t.diagnostic('隔离栈已启动，检查 TLS、配对与容器重建');

  // A running container can still be seeding the DSH profile. Wait for its
  // private listener before inspecting the loaded profile.
  await until(()=>{
    const probe=compose(['exec','-T','host','node','-e',
      'fetch("http://127.0.0.1:3082/",{signal:AbortSignal.timeout(2500)}).catch(()=>process.exit(1))']);
    return probe.status===0;
  },120_000,'superagent 回环监听与 profile 就绪');

  const dump=compose(['exec','-T','superagent','dsh','--profile','along','--dump-config']);
  assert.equal(dump.status,0,dump.stderr);
  const cliDir='/app/deploy/agent-dsh';
  const bundleDir=`${cliDir}/node_modules/dsh-superagent`;
  const policy=compose(['exec','-T','superagent','node','/usr/local/bin/along-superagent-preset-lockdown.mjs',
    cliDir,bundleDir,'verify'],{input:dump.stdout});
  assert.equal(policy.status,0,policy.stderr);
  const incomplete=spawnSync('docker',['run','--rm','--network','none','--entrypoint','sh',
    `${IMAGE_TAG}-superagent`,'-ec','printf "[]\\n" > "$1/cordis.patch.yml"; exec along-superagent-start',
    'sh',bundleDir],{encoding:'utf8',timeout:30_000});
  assert.equal(incomplete.status,1,'缺少必需 preset 时容器入口必须退出');
  assert.match(incomplete.stderr,/缺少启用的 preset/);

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

  // ---- 4b. 容器重建不断链（审查 P1-3）----
  //
  // 旧形态（superagent 挂在 host 的命名空间上）在这里会失败：**只重建 host** 时，
  // superagent 仍挂在旧 host 容器的命名空间上，新 host 访问 127.0.0.1:3082 得到
  // ECONNREFUSED。命名空间锚点（deploy/docker-compose.tier2.yml 的 netns 服务）
  // 让 host 与 superagent 都挂在一个与它们无关的容器上，任一方重建都不影响另一方。
  const rebuild=compose(['up','-d','--force-recreate','host']);
  assert.equal(rebuild.status,0,`重建 host 失败：${rebuild.stderr.slice(-2000)}`);
  const afterRebuild=await until(async()=>{
    const response=await phoneRequest({path:'/connection/status',body:{},token:tokens[0]});
    return response.status===200?response:null;
  },180_000,'重建 host 后的连接检查（命名空间锚点未断链）');
  assert.equal(afterRebuild.body.ready,true,'重建 host 后仍报就绪（桥接连通性未断）');

  // 重建 superagent 同样不得断链（它换了容器，但命名空间是锚点的，两边都还在）。
  const rebuildAgent=compose(['up','-d','--force-recreate','superagent']);
  assert.equal(rebuildAgent.status,0,`重建 superagent 失败：${rebuildAgent.stderr.slice(-2000)}`);
  const afterAgentRebuild=await until(async()=>{
    const response=await phoneRequest({path:'/connection/status',body:{},token:tokens[0]});
    return response.status===200?response:null;
  },180_000,'重建 superagent 后的连接检查');
  assert.equal(afterAgentRebuild.body.ready,true,'重建 superagent 后仍报就绪');

  // ---- 4c. 锚点重建（第二轮复核 P1-3）----
  //
  // 单独重建锚点（netns）会**断链**：Docker 的 `network_mode: "service:netns"`
  // 在**创建时**就把 network_mode 解析成锚点容器的 **容器 ID**（实测
  // `docker inspect -f '{{.HostConfig.NetworkMode}}'` 显示 `container:<64 位 ID>`）。
  // 锚点换了个新容器 → ID 变了 → 两个依赖者仍绑在旧 ID 上：
  // host 访问 127.0.0.1:3082 得 ECONNRESET，TLS 入口跟着断。
  //
  // `depends_on.restart: true` 不覆盖这个情形（它只在 compose 自己感知到依赖被
  // restart 时传播，锚点被 recreate 不在其中），`--always-recreate-deps` 也不覆盖
  // （实测依赖者没被重建）。唯一能让三个容器绑在同一个新命名空间上的做法是
  // **锚点与它的两个依赖者一起重建**——deploy/tier2-stack.sh 的 rebuild-anchor
  // 把这条路固化成一个命令，并自检三个容器确实绑在同一个命名空间。
  const anchorIdBefore=spawnSync('docker',['inspect','-f','{{.Id}}',`${CONTAINER_PREFIX}-netns`],{encoding:'utf8'}).stdout.trim();
  assert.ok(anchorIdBefore,'锚点容器应有 ID');

  const stackScript=join(DEPLOY_DIR,'tier2-stack.sh');
  const rebuildAnchor=spawnSync('sh',[stackScript,'rebuild-anchor'],{
    encoding:'utf8',
    timeout:600_000,
    env:{
      ...process.env,
      // 空格分隔的**文件路径**（脚本自己给每个加 "-f"）——
      // 写成 "-f a -f b" 会让脚本把 "-f" 当成文件名。
      ALONG_TIER2_COMPOSE_FILES:`${COMPOSE_FILE} ${COMPOSE_TIER2} ${OVERLAY} ${TIER2_OVERLAY}`,
      ALONG_TIER2_COMPOSE_PROJECT:PROJECT,
      ALONG_TIER2_COMPOSE_PROFILE:'tier2',
      ALONG_TIER2_TLS_HOST:HOST_NAME,
      ALONG_TIER2_CA_FILE:join(caDir,'ca.crt'),
    },
    cwd:ROOT,
  });
  assert.equal(rebuildAnchor.status,0,
    `锚点重建失败：${(rebuildAnchor.stderr||'')+(rebuildAnchor.stdout||'')}`.slice(-3000));
  port=publishedPort();

  const anchorIdAfter=spawnSync('docker',['inspect','-f','{{.Id}}',`${CONTAINER_PREFIX}-netns`],{encoding:'utf8'}).stdout.trim();
  assert.notEqual(anchorIdAfter,anchorIdBefore,'锚点应当真的换了容器（否则这条断言是空的）');

  // 三个容器必须绑在同一个命名空间：两个依赖者的 network_mode 要等于锚点的容器 ID。
  const anchorMode=spawnSync('docker',['inspect','-f','{{.HostConfig.NetworkMode}}',`${CONTAINER_PREFIX}-netns`],{encoding:'utf8'}).stdout.trim();
  for (const service of ['host','superagent']) {
    const mode=spawnSync('docker',['inspect','-f','{{.HostConfig.NetworkMode}}',`${CONTAINER_PREFIX}-${service}`],{encoding:'utf8'}).stdout.trim();
    assert.ok(mode.startsWith('container:'),`${service} 应绑在锚点的命名空间上，实际 ${mode}`);
    assert.equal(mode,`container:${anchorIdAfter}`,`${service} 绑的命名空间不是**当前**锚点（锚点换过 ID，依赖者没跟上）`);
  }
  assert.notEqual(anchorMode,'',`container:${anchorIdAfter}`,'锚点自身的 network_mode 应是它自己的项目网络');

  // 锚点重建后原配对仍有效、TLS 入口仍通。
  const afterAnchorRebuild=await until(async()=>{
    const response=await phoneRequest({path:'/connection/status',body:{},token:tokens[0]});
    return response.status===200?response:null;
  },180_000,'锚点重建后的连接检查');
  assert.equal(afterAnchorRebuild.body.ready,true,'锚点重建后仍报就绪');
  const health=await phoneRequest({path:'/health',method:'GET'});
  assert.equal(health.status,200,`锚点重建后 TLS 入口不通：${health.text}`);

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

  // ---- 9. 证书轮换（手册 §6.4，第二轮复核 P1-3）----
  //
  // 同根同域换叶：相对链接原子切 tls/current，只重建 Host 即可读到新指纹，
  // 原配对继续有效（不发新码）。手册 §6.4 的换证命令原先有两个问题：
  //   - 用了**绝对**链接 → 状态目录被 bind mount 进容器时，容器里那个绝对路径
  //     不存在，tls/current 变成断链，Host 因「缺少证书版本目录」拒启；
  //   - 漏了叠加文件（`-f deploy/docker-compose.tier2.yml --profile tier2`）。
  // 下面跑的就是修正后的命令形状。
  // **同根同域换叶**（CA 方案 §6 的轮换口径）：用同一个根签一张新叶。
  // 手机信任的是根，所以换叶不必重新装机——换根才需要逐台撤根。
  const rotatedLeaf=rotateLeaf(caDir,HOST_NAME,'tier2-2');
  const rotatedVersion=stageRelease(HOST_STATE,caDir,{serial:'tier2-2',leafDir:rotatedLeaf});
  const currentLink=join(HOST_STATE,'tls','current');
  assert.equal(readlinkSync(currentLink),'releases/tier2-2');
  // 只重建 Host（Tier 2 形态下 443 的发布在锚点上，Host 重建不影响锚点）。
  const recreateHost=compose(['up','-d','--no-deps','--force-recreate','host']);
  assert.equal(recreateHost.status,0,`换证后重建 Host 失败：${recreateHost.stderr.slice(-2000)}`);
  const afterRotate=await until(async()=>{
    const response=await phoneRequest({path:'/connection/status',body:{},token:tokens[0]});
    return response.status===200?response:null;
  },180_000,'换证后的连接检查');
  assert.equal(afterRotate.body.ready,true,'同根同域换叶后原配对应继续有效');
  const newLeaf=new X509Certificate(readFileSync(join(rotatedVersion,'fullchain.pem')));
  assert.equal(afterRotate.fingerprint,newLeaf.fingerprint256,'原配对请求应实际收到新叶');
  t.diagnostic('锚点重建和同根换叶通过，开始回退到 Tier 1');

  // ---- 10. 回退（手册 §6.5，第二轮复核 P1-3）----
  //
  // 回退 = 去掉 Tier 2 叠加文件并重建 Host。**顺序要紧**：
  // Tier 2 形态下 443 的发布在锚点 netns 上，而 Tier 1 的 Host 自己发布 443——
  // 锚点还在跑着就重建 Tier 1 的 Host，会报 "port is already allocated"。
  // 所以回退必须**先停掉 superagent 与 netns**，再重建 Tier 1 的 Host。
  //
  // 回退的验收：旧连接与 runner 仍 200、事件入口 503（预期）、
  // 两份 SQLite 库**保留**（回退是「新链路停用」，不是「数据回滚」）。
  for (const service of ['superagent','netns']) {
    const stop=compose(['stop',service]);
    assert.equal(stop.status,0,`停止 ${service} 失败：${stop.stderr.slice(-2000)}`);
  }
  writeFileSync(ROLLBACK_OVERLAY,[
    'services:',
    '  host:',
    `    ports: !override ["127.0.0.1:${port}:4176"]`,
    '    secrets: !override [runner-token]',
    '',
  ].join('\n'));
  // 回退 = **不叠加** tier2 文件（ALONG_EVENT_INGEST 回到 off、443 的发布回到 Host 自己）。
  // 叠加文件里还声明了 netns 与 superagent 两个服务，所以回退时那个叠加文件
  // 必须整个不参与——否则重建出来的还是 Tier 2 形态。
  const rollbackHost=composeTier1(['up','-d','--no-deps','--force-recreate','host']);
  assert.equal(rollbackHost.status,0,`回退重建 Host 失败：${rollbackHost.stderr.slice(-2000)}`);
  const rollbackHealth=await until(async()=>{
    const response=await phoneRequest({path:'/health',method:'GET'});
    assert.equal(response.status,200);
    return response;
  },30_000,'回退后的 TLS 入口');
  assert.equal(rollbackHealth.fingerprint,newLeaf.fingerprint256);
  for (const token of tokens) {
    const response=await phoneRequest({path:'/connection/status',body:{runtime:'dsh-superagent'},token});
    assert.equal(response.status,200,`回退后原配对及 runner 就绪：${response.text}`);
    assert.equal(response.body.ready,true);
    assert.equal(response.body.dsh,true);
  }
  // 事件入口 503：回退后新链路停用，属预期。
  const eventsAfterRollback=await phoneRequest({path:'/events',body:message('tier2 rollback',"tier2-rollback"),token:tokens[0]});
  assert.equal(eventsAfterRollback.status,503,`回退后事件入口应 503（预期），实际 ${eventsAfterRollback.status}`);
  // 两份库保留。
  for (const name of ['along/along.sqlite','engine/orchestrator.sqlite']) {
    assert.ok(existsSync(join(SUPER_STATE,name)),`回退后 ${name} 必须保留（回退不是数据回滚）`);
  }
  assert.equal(readRows(dbPath,"SELECT status FROM delivery WHERE event_id='tier2-pending'")[0].status,'delivered');
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
