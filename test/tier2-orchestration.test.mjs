import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseDocument} from 'yaml';

// Tier 2 编排契约（docs/cloud-deploy-multi-user.md §3.5，验证项 V-1）。
//
// 覆盖 V-1 报告点名要 Along 仓补齐的五件事：常驻镜像、持久卷、桥接密钥、真实 readiness，
// 以及「管理面仅本机可达」这条硬约束（Super Agent 侧 src/along/api.ts:288 与
// src/app/http.ts 都要求 webserver.host === '127.0.0.1'）。
//
// 明确不在本测试断言、需真实 Docker 的部分（test/tier2-linux-integration.test.mjs
// 用隔离 Linux Compose 验）：两镜像可构建、compose up 后长驻进程起来、事件真的落库与投递、
// 重启后恢复投递。compose config 校验在下面用 {skip} 门控。

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const DEPLOY_DIR=join(ROOT,'deploy');
const COMPOSE_FILE=join(DEPLOY_DIR,'docker-compose.yml');
const COMPOSE_TIER2=join(DEPLOY_DIR,'docker-compose.tier2.yml');
const compose=readFileSync(COMPOSE_FILE,'utf8');
const composeTier2=readFileSync(COMPOSE_TIER2,'utf8');
const composeDoc=parseDocument(compose).toJS();
const composeTier2Doc=parseDocument(composeTier2).toJS();
const dockerSuperagent=readFileSync(join(DEPLOY_DIR,'Dockerfile.superagent'),'utf8');
const startScript=readFileSync(join(DEPLOY_DIR,'superagent-start.sh'),'utf8');
const seedScript=readFileSync(join(DEPLOY_DIR,'superagent-seed.mjs'),'utf8');
const envExample=readFileSync(join(DEPLOY_DIR,'env.example'),'utf8');
const deployReadme=readFileSync(join(DEPLOY_DIR,'README.md'),'utf8');
const hostSrc=readFileSync(join(ROOT,'host','agent-host.mjs'),'utf8');
const bridgeSrc=readFileSync(join(ROOT,'host','along-bridge.mjs'),'utf8');
const services=composeDoc.services;
const superagent=services.superagent;

// ---- compose：superagent 服务 ---------------------------------------------------

test('compose：superagent 与 host 共享网络命名空间且不发布端口（管理面仅本机可达，§3.5）',()=>{
  assert.ok(superagent,'必须有 superagent 服务（Tier 2 长驻运行时）');
  assert.equal(superagent.network_mode,'service:host',
    '必须与 host 共享网络命名空间：Super Agent 只监听 127.0.0.1，独立服务的服务名访问不到它的回环');
  assert.equal(superagent.ports??null,null,
    'superagent 不得发布端口——3082 只在共享命名空间内经 127.0.0.1 可达（管理面仅本机可达）');
  assert.equal(superagent.container_name,'along-superagent');
  assert.equal(superagent.restart,'unless-stopped','长驻服务必须由 compose 监督');
  assert.ok((superagent.depends_on??[]).includes('host'),'依赖 host（共享命名空间要求 host 先起）');
  assert.deepEqual(superagent.profiles,['tier2'],
    'superagent 必须挂在 tier2 profile 下：默认的 `docker compose up`（Tier 1）不受它影响');
});

test('compose：superagent 状态落在仓库外层的持久卷，重建容器不丢业务库',()=>{
  const volumes=superagent.volumes??[];
  assert.ok(volumes.some(v=>v.includes('/var/lib/along-superagent')),
    '业务库（along.sqlite）与编排库必须落在持久卷上');
  assert.ok(volumes.some(v=>v.includes('/var/lib/dsh')),
    'DSH home（profile、凭证文件、会话持久化）必须落在持久卷上');
  for (const volume of volumes) {
    const source=volume.split(':')[0];
    assert.ok(resolve(DEPLOY_DIR,source).startsWith(ROOT)===false,
      `卷源必须在仓库外层（不误提交）：${source}`);
  }
  assert.equal(superagent.environment.ALONG_SUPERAGENT_STATE_DIR,'/var/lib/along-superagent');
  assert.equal(superagent.environment.ALONG_SUPERAGENT_ALONG_STATE_DIR,'/var/lib/along-superagent/along');
});

test('compose：superagent 的加固三件套与资源上限与另两个服务同款（§3.1 G-1/G-2/G-3）',()=>{
  assert.equal(superagent.read_only,true,'superagent 只读根（G-2）');
  assert.deepEqual(superagent.tmpfs,['/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777'],'/tmp tmpfs noexec/nosuid/nodev');
  assert.deepEqual(superagent.security_opt,['no-new-privileges:true']);
  assert.deepEqual(superagent.cap_drop,['ALL']);
  assert.ok(superagent.mem_limit&&superagent.cpus&&superagent.pids_limit,'资源上限齐备（G-1/G-3）');
  assert.deepEqual(superagent.logging,{driver:'json-file',options:{'max-size':'10m','max-file':'3'}},'日志轮转（§3.7）');
});

test('compose：桥接凭证只经 secret 文件，两侧指向同一份宿主文件（§3.3/§3.7）',()=>{
  // Tier 1 默认不启用：host 的 ALONG_BRIDGE_TOKEN_FILE 为空（未配置 → 新链路端点 503，属预期）。
  assert.equal(services.host.environment.ALONG_BRIDGE_TOKEN_FILE??'','',
    'Tier 1 不配置桥接凭证（未配置即未开启，不静默启用新链路）');
  // compose 里两侧引用同一个宿主文件，容器内挂载点不同但内容同一份。
  assert.ok(composeTier2.includes('../../secrets/bridge-token'),
    '桥接凭证的宿主文件路径必须写明（§6.4 第 8 步）');
  // ALONG_BRIDGE_TOKEN_FILE 只允许指向 secret 挂载点，不得内联凭证本体。
  const bridgeFileValues=[...composeTier2.matchAll(/ALONG_BRIDGE_TOKEN_FILE:\s*(\S+)/g)].map(match=>match[1]);
  assert.ok(bridgeFileValues.length>0,'必须写桥接凭证的文件路径');
  for (const value of bridgeFileValues) {
    assert.ok(value.startsWith('/run/secrets/'),`ALONG_BRIDGE_TOKEN_FILE 只允许指向 /run/secrets/*：${value}`);
  }
  // 凭证形态的字符串不得出现在 environment 值里。
  const values=Object.values(superagent.environment).concat(Object.values(services.host.environment)).map(String);
  for (const value of values) {
    assert.ok(!/[0-9a-f]{32,}/i.test(value)&&!/BEGIN/i.test(value)&&!/PRIVATE KEY/i.test(value),
      `environment 值不得携带凭证形态字符串（§3.3）：${value}`);
  }
});

// ---- Tier 2 叠加文件：形态开关与桥接凭证 ------------------------------------------

test('Tier 2 叠加文件：只开新链路与桥接凭证，host 与 superagent 读同一份 secret',()=>{
  const tier2=composeTier2Doc;
  assert.equal(tier2.services.host.environment.ALONG_EVENT_INGEST,'on',
    'Tier 2 打开新链路（§3.5）');
  assert.equal(tier2.services.host.environment.ALONG_BRIDGE_TOKEN_FILE,'/run/secrets/bridge-token',
    'host 的桥接凭证走 secret 文件');
  assert.equal(tier2.services.host.environment.ALONG_SUPERAGENT_URL,'http://127.0.0.1:3082',
    '长驻 Super Agent 走共享命名空间的回环地址（不发布端口）');
  // 两侧挂同一个 secret：内容同一份，token 才一致。
  assert.ok(tier2.services.host.secrets.includes('bridge-token'),'host 挂 bridge-token');
  assert.ok(tier2.services.superagent.secrets.includes('bridge-token'),'superagent 挂 bridge-token');
  assert.equal(tier2.secrets['bridge-token'].file,'../../secrets/bridge-token',
    'secret 源是仓库外层的宿主文件（§6.4 第 1/3 步布局）');
  // superagent 侧指向的挂载点必须与 host 一致：profile 的 alongBridgeTokenFile 用同一个路径。
  assert.equal(superagent.environment.ALONG_BRIDGE_TOKEN_FILE,'/run/secrets/bridge-token',
    'superagent 的桥接凭证路径与 host 一致');
});

test('Tier 1 的默认形态不受 Tier 2 影响（叠加文件是唯一的形态开关）',()=>{
  assert.equal(services.host.environment.ALONG_EVENT_INGEST,'off',
    '默认形态仍是新链路关闭（云端 v1，§1）');
  assert.equal(composeDoc.secrets['bridge-token'],undefined,
    '主 compose 不声明桥接凭证 secret：宿主文件缺失会让 up 硬失败，Tier 1 部署没有它');
  for (const service of Object.values(services)) {
    assert.ok(!(service.secrets??[]).includes('bridge-token'),
      '主 compose 的服务不挂 bridge-token secret（Tier 2 才挂）');
  }
  assert.ok(compose.includes('profiles: ["tier2"]'),'superagent 挂在 profile 下（默认 up 不起它）');
});

// ---- Dockerfile.superagent -------------------------------------------------------

test('Dockerfile.superagent：node:24 digest pin、dsh 经锁文件安装、只取 bundle 编译产物',()=>{
  assert.match(dockerSuperagent,/FROM node:24-bookworm-slim@sha256:[0-9a-f]{64}$/m,'node:24 digest pin（G-8）');
  assert.ok(!dockerSuperagent.includes('npm install -g'),'不得用 npm install -g（G-8）');
  assert.ok(dockerSuperagent.split('\n').some(line=>line.startsWith('COPY deploy/agent-dsh/package.json deploy/agent-dsh/package-lock.json deploy/agent-dsh/')),
    'dsh 两个清单文件进镜像');
  assert.match(dockerSuperagent,/RUN npm ci --prefix deploy\/agent-dsh --omit=dev --ignore-scripts --no-fund --no-audit/,
    'dsh 按锁文件安装且禁脚本（G-8）');
  // bundle 必须是**编译产物**：V-1 实测「只配 bundle 层」时真实 boot 报 ERR_MODULE_NOT_FOUND，
  // 所以镜像里必须有 lib/（运行时真正 import 的东西）。
  // lib/ 在 along-superagent 里是 .gitignore 的构建产物，checkout 里没有——所以镜像必须
  // **从源码编译**：bundle 阶段 pnpm build 产出 lib/，运行阶段 COPY 过去。
  assert.ok(dockerSuperagent.split('\n').some(line=>line.startsWith('COPY --from=bundle /bundle/lib/')),
    '镜像必须携带 bundle 编译产物 lib/（V-1 的 ERR_MODULE_NOT_FOUND 根因）');
  assert.ok(/RUN pnpm build/.test(dockerSuperagent),
    '镜像必须在 bundle 阶段从源码编译 lib/（lib/ 是 gitignore 的构建产物，checkout 里没有）');
  assert.ok(dockerSuperagent.split('\n').some(line=>line.startsWith('COPY --from=along /src/')),
    'bundle 源码进 bundle 阶段（编译输入）');
  assert.ok(dockerSuperagent.split('\n').some(line=>line.startsWith('COPY --from=along /package.json')),
    'bundle 清单进镜像（package.json 是可解析包的必要部分）');
  assert.ok(dockerSuperagent.split('\n').some(line=>line.startsWith('COPY --from=along /cordis.patch.yml')),
    'bundle 的 patch 层进镜像（bundle 层由它声明）');
  // 源码不进镜像：镜像只需要运行期产物。
  assert.ok(!dockerSuperagent.split('\n').some(line=>line.startsWith('COPY --from=along src/')),
    'bundle 源码不进镜像（运行时只 import 编译产物）');
  // 与 Dockerfile.agent 共用同一份 dsh 锁文件 → 两个服务的 dsh 版本不会分叉。
  const agentDockerfile=readFileSync(join(DEPLOY_DIR,'Dockerfile.agent'),'utf8');
  const pin=/FROM (node:24-bookworm-slim@sha256:[0-9a-f]{64})/;
  assert.equal(dockerSuperagent.match(pin)?.[1],agentDockerfile.match(pin)?.[1],
    '两个镜像用同一个 node:24 摘要（同一份 dsh 锁文件）');
});

// ---- 启动脚本与播种脚本 ------------------------------------------------------------

test('superagent-start.sh：铺 profile、把 bundle 链进 node_modules、绑 127.0.0.1、播种后 exec 常驻',()=>{
  // 三个已知会踩的坑，逐个锁住：
  // 1) bundle 必须是 profile 里可解析的包（V-1 的 ERR_MODULE_NOT_FOUND）；
  // 2) webserver 必须绑 127.0.0.1（Super Agent 侧两处硬性要求）；
  // 3) 沿/GitHub 两个来源开关必须在第一次 boot 之前落库（assembleAlong 读的是已存好的设置）。
  assert.ok(startScript.includes('$PROFILE_DIR/node_modules/dsh-superagent'),
    '必须把 bundle 链进 profile 的 node_modules（V-1 的 ERR_MODULE_NOT_FOUND 根因）');
  assert.ok(/ln -sfn?\s+"\$BUNDLE_DIR"/.test(startScript),'bundle 以符号链接进入 profile');
  assert.ok(/host:\s*127\.0\.0\.1/.test(startScript),'webserver 必须绑 127.0.0.1（管理面仅本机可达）');
  assert.ok(startScript.includes('port: 3082'),'长驻服务监听 3082');
  assert.ok(startScript.includes('alongStateDir:'),'必须配置 alongStateDir（业务库目录）');
  assert.ok(startScript.includes('alongBridgeTokenFile:'),'必须配置 alongBridgeTokenFile（桥接凭证文件）');
  assert.ok(startScript.includes('dsh-superagent-along'),'必须显式启用 Along Source');
  assert.ok(/dsh-superagent-github[\s\S]{0,40}disabled:\s*true/.test(startScript),
    '必须显式禁用 GitHub Source（assembleAlong 要求 github.enabled === false）');
  assert.ok(startScript.includes('superagent-seed.mjs'),'第一次 boot 之前必须播种设置');
  assert.ok(/exec .*dsh.*--profile/.test(startScript),'最后 exec 常驻 dsh（脚本必须让出 PID 交给信号处理）');
  // 只在本机可达：脚本里不得出现把 3082 绑到 0.0.0.0 或发布端口的写法。
  assert.ok(!/host:\s*0\.0\.0\.0/.test(startScript),'webserver 不得绑 0.0.0.0');
});

test('superagent-start.sh：桥接凭证与 Host 读的是同一份文件（token 不一致 = 全量 401）',()=>{
  // 桥接凭证路径来自环境变量（compose 里两侧都是 /run/secrets/bridge-token），
  // 不能各自指向各自的默认路径——Super Agent 会自己生成一份，Host 那份就永远对不上。
  assert.ok(startScript.includes('ALONG_BRIDGE_TOKEN_FILE'),
    '桥接凭证路径必须由环境变量指定（与 Host 同一个 secret 挂载点）');
  assert.ok(startScript.includes('alongBridgeTokenFile: $BRIDGE_TOKEN_FILE'),
    'profile 的 alongBridgeTokenFile 必须指向该环境变量给出的路径');
});

test('superagent-seed.mjs：写的是带版本的设置快照，且不覆盖已有设置（幂等）',()=>{
  assert.ok(seedScript.includes('settings-revision'),'必须写版本指针（Store.settings() 读的是当前版本）');
  assert.ok(seedScript.includes('settings-version:'),'必须写版本快照本身');
  assert.ok(!seedScript.includes("set.run('schema'"),
    '不得预写 schema 版本键——那会让 Runtime 以为数据库需要迁移（沿 V-1：schema 由 Store 自己写）');
  assert.ok(seedScript.includes('along')&&seedScript.includes('github'),
    '必须设置 Along 与 GitHub 两个来源开关');
  assert.ok(/along:\s*\{\s*enabled:\s*true/.test(seedScript),'Along Source 必须显式开');
  assert.ok(/github:\s*\{\s*enabled:\s*false/.test(seedScript),'GitHub Source 必须显式关');
  assert.ok(/if\s*\(pointer\)/.test(seedScript),'已有设置时必须跳过（容器重启不覆盖运维改过的值）');
});

// ---- Host 侧：真实 readiness 契约与云端形态判据 ---------------------------------

test('host：真实就绪探针走 along-status-probe 契约（200 + ready:true），不是另造 /ready 路径',()=>{
  // 契约路径是 Super Agent 侧交付的既有路径（along-superagent 的 feature/along-tier2-readiness）：
  // 就绪 200 {"service":"along-source","ready":true}，未就绪 503 {"error":"along_source_not_ready"}。
  // 另造 /ready 路径在 Super Agent 没实现时会被当成「路径不存在 → 就绪」，恰好把要防的启动窗口放回去。
  assert.ok(bridgeSrc.includes('/along-source/api/goals/along-status-probe'),
    '桥接侧必须用真实的就绪契约路径');
  assert.ok(!bridgeSrc.includes('/along-source/api/ready'),'不得另造 /ready 路径');
  assert.ok(bridgeSrc.includes('readyStrict'),'桥接侧必须有严格就绪判定');
  assert.ok(bridgeSrc.includes('body.ready!==true'),'body.ready 不为 true 必须判为未就绪');
  assert.ok(bridgeSrc.includes("body.service!=='along-source'"),'body.service 不是 along-source 必须判为未就绪');
  assert.ok(hostSrc.includes('bridge.readyStrict({identity:who})'),
    'Host 的连接检查必须走真实就绪判定，并带上绑定身份');
  // 404 **不再**按「旧版没有契约路径」容忍成就绪（审查 P2-5）：
  // 旧版探针恒答 200 {ready:true}，Host 侦测不到装错版本；容忍 404 等于把
  // 「装错版本」说成「已就绪」，而装错版本的投递泵仍会把待投递行终结为
  // filtered / source_not_installed。404 归入未就绪（503）。
  assert.ok(!bridgeSrc.includes('response.status===404'),'404 不得再被当成就绪');
  assert.ok(bridgeSrc.includes('response.status!==200'),'只认 200：其它状态码（含 404）都是未就绪');
  // 就绪判定只探一次：探针之后不得再对同一路径发第二次请求。
  assert.ok(!hostSrc.includes("bridge.call('/along-source/api/goals/along-status-probe'"),
    '就绪判定后不得再对同一路径发第二次请求（持续 404 会被第二个请求判成 502）');
  // 401/403 是配置问题（凭证或身份头），不按未就绪静默处理。
  assert.ok(/status===401\|\|response\.status===403/.test(bridgeSrc),
    '401/403 必须给出配置提示，不能当成「未就绪」静默处理');
});

test('host：云端 Runner 仍需 users.json，公网代理只通过 Unix socket 提供服务',()=>{
  // 仓库纪律：不新增安全降级开关（docs/iphone-ca-profile-design.md §3.1、
  // docs/cloud-security-hardening.md SD-H7、AGENTS.md §4）。users.json 的存在性
  // 已经是云端形态的既定判据。
  assert.ok(!hostSrc.includes('ALONG_CLOUD_DEPLOY'),'不得新增 ALONG_CLOUD_DEPLOY 开关');
  // 判据是**云端 Runner 配置**（docs/iphone-ca-profile-design.md §3.1 原文：「以现有云端
  // Runner 配置识别云端形态……不新增安全降级开关」）。Tier 2 打开后 runner 服务仍留在
  // compose 里作为显式回退目标，所以这个判据在 Tier 2 下同样成立。
  assert.ok(hostSrc.includes('const cloudTls=dshRunnerURL&&!proxySocket?loadCloudTlsMaterial'),
    '云端直连加载 CA 材料，独立 nginx 入口才交由代理终止 TLS');
  assert.ok(hostSrc.includes('if (proxySocket&&(!dshRunnerURL||!isAbsolute(proxySocket)))'),
    'Unix socket 入口须配置云端 Runner 与绝对路径');
  assert.ok(hostSrc.includes('if (dshRunnerURL&&!multiUser) throw Error'),
    '配置了 runner 就必须有 users.json（多用户静态用户表）');
  // Tier 2 的叠加文件**不能**清掉 runner URL——清掉会让 Host 静默退回现场自签（安全降级）。
  assert.ok(!composeTier2.includes('ALONG_DSH_RUNNER_URL'),
    'Tier 2 叠加文件不得改 runner URL（云端形态判据；改动会让 Host 静默退回自签）');
});

// ---- 文档与 env.example ----------------------------------------------------------

test('env.example 与 deploy/README.md：写清 Tier 2 的开关、卷与回退路径',()=>{
  assert.ok(envExample.includes('ALONG_BRIDGE_TOKEN_FILE'),'env.example 必须写桥接凭证路径');
  assert.ok(envExample.includes('ALONG_SUPERAGENT_URL'),'env.example 必须写长驻服务地址');
  assert.ok(deployReadme.includes('superagent'),'README 必须覆盖 Tier 2 的 superagent 服务');
  assert.ok(deployReadme.includes('ALONG_EVENT_INGEST: "on"')||deployReadme.includes('ALONG_EVENT_INGEST=on'),
    'README 必须写 Tier 2 的开启方式');
  assert.ok(deployReadme.includes('docker-compose.tier2.yml'),'README 必须写 Tier 2 的叠加文件用法');
  assert.ok(deployReadme.includes('ALONG_EVENT_INGEST=off')||deployReadme.includes('改回 off'),
    'README 必须写回退方式（改回 off）');
  // 就绪判定口径必须是真实的契约路径。
  assert.ok(deployReadme.includes('along-status-probe'),'README 必须写真实就绪契约路径');
  assert.ok(!deployReadme.includes('/along-source/api/ready'),'README 不得写不存在的 /ready 路径');
});

// ---- compose config 校验（可选门控） -------------------------------------------------

test('compose config 通过（检测到 compose CLI 才跑）',{skip:!resolveComposeBin()&&'compose CLI 不可用'},()=>{
  const run=(args,label)=>{
    const result=spawnSync(args[0],args.slice(1),{encoding:'utf8',timeout:120_000});
    assert.equal(result.status,0,`${label} 失败：${result.stderr}`);
    return result;
  };
  // 主 compose（Tier 1 形态）必须成立。
  run(composeArgs(['-f',COMPOSE_FILE,'config','-q']),'Tier 1 compose config 校验');
  // 叠加后的 Tier 2 形态必须成立（两种形态各自可审计）。
  run(composeArgs(['-f',COMPOSE_FILE,'-f',COMPOSE_TIER2,'--profile','tier2','config','-q']),'Tier 2 compose config 校验');
});

function resolveComposeBin() {
  // standalone 的 docker-compose 与 docker compose 两种形态都要认（§6.4 第 7 步的验证命令用后者）。
  const standalone=spawnSync('docker-compose',['version'],{encoding:'utf8'});
  if (standalone.status===0) return {bin:'docker-compose',prefix:[]};
  const plugin=spawnSync('docker',['compose','version'],{encoding:'utf8'});
  if (plugin.status===0) return {bin:'docker',prefix:['compose']};
  return null;
}

function composeArgs(extra) {
  const resolved=resolveComposeBin();
  return resolved?[resolved.bin,...resolved.prefix,...extra]:['docker','compose',...extra];
}
