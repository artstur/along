import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseDocument} from 'yaml';

// M5 Docker 编排与部署产物（docs/cloud-deploy-multi-user.md §3.1/§4-M5，验收 #5）的配对测试。
// 覆盖面（按验收 #5 可本地验证的条目）：
// - compose 结构与 §3.1 逐项一致：443→4176、agent 仅内网不发布端口、bind 卷与 secrets 指仓库外层、
//   additional_contexts 以 project directory（deploy/）为基准写 ../../along-superagent（§3.1 施工修正）、
//   restart/logging 轮转/healthcheck 指向真实存在的 /health 端点；
// - 凭证红线（§3.3/§3.7）：compose/env.example 的环境值不含凭证形态的字符串，凭证只经 /run/secrets/* 文件路径；
// - Dockerfile.host：Node 22、OpenSSL、锁定的生产依赖、Host 源码与 host→web 完整 import 闭包
//   （闭包由测试当次实测计算，与 §4-M5 的「以当次 grep 为准」同口径，防镜像缺文件）；
// - Dockerfile.agent：node:24-bookworm-slim + @deepseek-ai/dsh@0.2.2-rc.5 pin + runner 及其 web 闭包；
//   ALONG_DSH_VERSION 与 pin 跨文件一致；along bundle 不含 lib/（构建产物）；
// - env.example 只含非敏感示例值且与 compose environment 一一对应；
// - deploy/README.md 覆盖构建/启动/冒烟五步/路径基准警告/V-1 预置与凭证红线。
// 明确不在本测试断言、需真实 Docker 的部分（本机无 daemon，交付 Runbook §6.4 第 5 步在 ECS 验证）：
// 两镜像可构建、compose up 后 /health 200、启动横幅与 docker logs 抽查、
// file secret 缺失是 up 硬错误的行为。compose config 校验（验收 #5 第 1 条）在下面用
// {skip} 门控：检测到可用 compose CLI 才跑，并可用 ALONG_COMPOSE_BIN 指定 standalone 二进制。

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const DEPLOY_DIR=join(ROOT,'deploy');
const COMPOSE_FILE=join(DEPLOY_DIR,'docker-compose.yml');
const compose=readFileSync(COMPOSE_FILE,'utf8');
const composeDoc=parseDocument(compose).toJS();
const envExample=readFileSync(join(DEPLOY_DIR,'env.example'),'utf8');
const dockerHost=readFileSync(join(DEPLOY_DIR,'Dockerfile.host'),'utf8');
const dockerAgent=readFileSync(join(DEPLOY_DIR,'Dockerfile.agent'),'utf8');
const deployReadme=readFileSync(join(DEPLOY_DIR,'README.md'),'utf8');
const runnerSrc=readFileSync(join(DEPLOY_DIR,'agent-runner.mjs'),'utf8');
const hostSrc=readFileSync(join(ROOT,'host','agent-host.mjs'),'utf8');
const ADJACENT=resolve(DEPLOY_DIR,'../../along-superagent');
const BUNDLE_ROOT='/opt/along-superagent/';
const bundleCopies=dockerAgent.split('\n').filter(line=>line.startsWith('COPY --from=along '))
  .map(line=>line.trim().split(/\s+/).slice(2));

function copyTokens(dockerfile) {
  return dockerfile.split('\n').filter(line=>line.startsWith('COPY '))
    .flatMap(line=>line.split(/\s+/).slice(1));
}
function copyWebFiles(dockerfile) {
  return copyTokens(dockerfile).filter(token=>token.startsWith('web/')&&token!=='web/')
    .map(token=>token.slice('web/'.length));
}

// import 闭包（BFS）：从镜像携带的全部 host/ 顶层模块出发，
// 沿 ./ 与 ../web/ 的静态与动态 import 展开；web 文件继续沿 ./ 展开 web→web 依赖。
const IMPORT_RE=/(?:from|import\()\s*'([^']+\.(?:mjs|json))'/g;
function webClosure() {
  const reachable=new Set();
  const queue=[];
  for (const file of readdirSync(join(ROOT,'host'))) if (file.endsWith('.mjs')) queue.push(['host',file]);
  const seen=new Set();
  while (queue.length) {
    const [dir,file]=queue.pop();
    const key=`${dir}/${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (dir==='web') reachable.add(file);
    const src=readFileSync(join(ROOT,dir,file),'utf8');
    for (const match of src.matchAll(IMPORT_RE)) {
      const ref=match[1];
      if (ref.startsWith('../web/')) {
        queue.push(['web',ref.slice('../web/'.length)]);
      } else if (ref.startsWith('./')) {
        queue.push([dir,ref.slice(2)]);
      }
    }
  }
  return {reachable,seen};
}
const {reachable:webClosureSet}=webClosure();

// compose CLI 探测：优先 ALONG_COMPOSE_BIN（standalone 二进制），再 docker compose 插件，再 docker-compose。
function probeCompose() {
  if (process.env.ALONG_COMPOSE_BIN) {
    const bin=process.env.ALONG_COMPOSE_BIN;
    if (spawnSync(bin,['version'],{timeout:20_000,encoding:'utf8'}).status===0) return [bin];
    return null;
  }
  if (spawnSync('docker',['compose','version'],{timeout:20_000,encoding:'utf8'}).status===0) return ['docker','compose'];
  if (spawnSync('docker-compose',['version'],{timeout:20_000,encoding:'utf8'}).status===0) return ['docker-compose'];
  return null;
}
const composeCli=probeCompose();

// ---- compose 结构与路径基准（§3.1，验收 #5 静态部分） ------------------------------------------

test('compose 按 §3.1 编排：443→4176、agent 仅内网、bind 卷与 secrets 指仓库外层、闭包内网 DNS',()=>{
  const services=composeDoc.services;
  assert.ok(services.host&&services.agent,'必须恰有 host 与 agent 两个服务');
  assert.equal(Object.keys(services).length,2,'不引入 §3.1 之外的第三个服务（无反代，SD-1）');
  // host：端口映射、容器名、监督、状态卷
  assert.deepEqual(services.host.ports,['443:4176'],'443→4176 端口映射（§3.1）');
  assert.equal(services.host.container_name,'along-host','README 冒烟按容器名取日志');
  assert.equal(services.host.restart,'unless-stopped','restart 取代 tools/activate 的前台监督（§3.1）');
  assert.deepEqual(services.host.volumes,['../../data/host:/data'],'host 状态全在 bind 卷（§3.1）');
  assert.equal(services.host.build.context,'..','build context = 仓库根（deploy/ 为基准）');
  assert.equal(services.host.build.dockerfile,'deploy/Dockerfile.host');
  // host 环境：0.0.0.0 是硬性要求（容器内无 en0，缺省回退 127.0.0.1，443 打不通，§3.1/host:65）
  const hostEnv=services.host.environment;
  assert.equal(hostEnv.ALONG_AGENT_HOST,'0.0.0.0','ALONG_AGENT_HOST 必配 0.0.0.0（验收 #5）');
  assert.equal(hostEnv.ALONG_AGENT_PORT,'4176');
  assert.equal(hostEnv.ALONG_AGENT_STATE_DIR,'/data','bind 卷目标 = ALONG_AGENT_STATE_DIR');
  assert.equal(hostEnv.ALONG_DSH_RUNNER_URL,'http://agent:3088','DSH 分流指向 compose 内网 agent（§3.5）');
  assert.equal(hostEnv.ALONG_RUNNER_TOKEN_FILE,'/run/secrets/runner-token','runner-token 缺失 host 拒绝启动（host/agent-host.mjs:84）');
  assert.equal(hostEnv.ALONG_EVENT_INGEST,'off','云端 v1 新链路关闭（§1/§3.5；引号防 YAML 把 off 解析成布尔）');
  assert.equal(hostEnv.ALONG_TLS_DAYS,'3650','云端长期自签证书（§2.2 C7）');
  assert.ok(hostEnv.ALONG_TLS_CN,'ALONG_TLS_CN 必配域名');
  // agent：仅 compose 内网（不发布端口）、模型凭证与 runner token 经 secret 文件
  assert.equal(services.agent.ports??null,null,'agent 不得发布端口（仅 compose 内网，§3.1）');
  assert.equal(services.agent.container_name,'along-agent');
  assert.equal(services.agent.restart,'unless-stopped');
  assert.equal(services.agent.read_only,true);
  assert.deepEqual(services.agent.tmpfs,['/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777']);
  assert.deepEqual(services.agent.security_opt,['no-new-privileges:true']);
  const agentEnv=services.agent.environment;
  assert.equal(agentEnv.ALONG_RUNNER_TOKEN_FILE,'/run/secrets/runner-token');
  assert.equal(agentEnv.ALONG_MODEL_API_KEY_FILE,'/run/secrets/model-credentials');
  assert.equal(agentEnv.ALONG_DSH_VERSION,'0.2.2-rc.5','与 Dockerfile 的 dsh pin 跨文件一致（§4-M5）');
  assert.equal(services.agent.build.additional_contexts.along,'../../along-superagent',
    'additional_contexts 以 project directory（deploy/）为基准——§3.1 施工修正：写 ../along-superagent 会指向不存在的 /opt/along/along/along-superagent');
  assert.equal(services.agent.build.context,'..');
  assert.equal(services.agent.build.dockerfile,'deploy/Dockerfile.agent');
  // secrets：runner-token 两服务共用；apns-key 可选三处引用齐备（验收 #5 可选路径的前提）
  assert.deepEqual(services.host.secrets,['apns-key','runner-token']);
  assert.deepEqual(services.agent.secrets,['runner-token','model-credentials']);
  assert.deepEqual(composeDoc.secrets,{
    'apns-key':{file:'../../secrets/apns-key.p8'},
    'runner-token':{file:'../../secrets/runner-token'},
    'model-credentials':{file:'../../secrets/model-credentials'},
  },'三个 file secret 相对 deploy/ 解析，与 §6.4 第 1/3 步布局一致（§3.1）');
  // 相对路径全部落在 git 仓库外层：卷与密钥不进仓库、不误提交（§3.1「杜绝误提交」）
  const outside=relative=>resolve(DEPLOY_DIR,relative).startsWith(ROOT)===false;
  assert.ok(outside('../../data/host'),'bind 卷源必须在仓库外层');
  for (const secret of Object.values(composeDoc.secrets)) assert.ok(outside(secret.file),'secret 文件必须在仓库外层');
  assert.ok(outside(composeDoc.services.agent.build.additional_contexts.along),
    'along-superagent 相邻布局在仓库外层');
  // additional_contexts 按设计基准（project directory=deploy/）解析后必须指向真实存在的相邻仓库
  // （本地存在 along-superagent 时强断言；CI 只 checkout 本仓库，该分支由相邻仓库门控测试覆盖）。
  if (existsSync(ADJACENT)) {
    assert.equal(resolve(DEPLOY_DIR,composeDoc.services.agent.build.additional_contexts.along),ADJACENT,
      '按 deploy/ 基准解析必须命中真实相邻仓库（../along-superagent 的回归曾指向不存在的仓库内路径）');
  }
  // 监督与日志留存（§3.1/§3.7）：两服务都要 restart + json-file 轮转 + healthcheck(interval 30s)
  for (const [name,service] of Object.entries(services)) {
    assert.deepEqual(service.logging,{driver:'json-file',options:{'max-size':'10m','max-file':'3'}},
      `${name} 日志轮转上限（§3.7）`);
    assert.equal(service.healthcheck.interval,'30s',`${name} healthcheck 周期（§3.1）`);
  }
  // healthcheck 指向的端点必须真实存在（避免编排指向不存在的探活路径）
  assert.ok(hostSrc.includes("path==='/health'"),'host /health 端点存在（host/agent-host.mjs:370）');
  assert.ok(runnerSrc.includes("path==='/health'"),'agent runner /health 端点存在（deploy/agent-runner.mjs:174）');
  const hostProbe=services.host.healthcheck.test.join(' ');
  assert.ok(hostProbe.includes("https://127.0.0.1:4176/health")&&hostProbe.includes("NODE_TLS_REJECT_UNAUTHORIZED='0'"),
    'host healthcheck 自探 TLS 端点并放行自签证书（§3.1）');
  const agentProbe=services.agent.healthcheck.test.join(' ');
  assert.ok(agentProbe.includes('http://127.0.0.1:3088/health'),'agent healthcheck 自探内网端口');
  // compose 的 environment 是凭证红线的入口：值里不允许出现凭证形态字符串，凭证只经 *_FILE 指向 /run/secrets/*
  const envValues=Object.values(hostEnv).concat(Object.values(agentEnv)).map(String);
  for (const value of envValues) {
    assert.ok(!/[0-9a-f]{32,}/i.test(value)&&!/BEGIN/i.test(value)&&!/PRIVATE KEY/i.test(value),
      `environment 值不得携带凭证形态字符串（§3.3）：${value}`);
  }
  for (const [key,value] of Object.entries({...hostEnv,...agentEnv})) {
    if (!key.endsWith('_FILE')) continue;
    assert.ok(String(value).startsWith('/run/secrets/'),`${key} 只允许指向 compose secrets 挂载路径`);
  }
  // compose 注释必须写明路径基准与 apns-key 三处引用的删除方法（验收 #5 可选路径的操作说明）
  assert.ok(compose.includes('project directory'),'compose 头注释写明相对路径基准（§3.1）');
  assert.ok(compose.includes('apns-key')&&compose.includes('secrets.apns-key'),
    'apns-key 三处引用（env/secrets 列表/顶层定义）与删除注释齐备');
});

// ---- Dockerfile.host：基础镜像、openssl、host→web 完整 import 闭包（§4-M5） ---------------------

test('Dockerfile.host：node:22-slim+openssl，COPY 的 web 文件与当次实测的 host→web import 闭包完全一致',()=>{
  assert.match(dockerHost,/FROM node:22-bookworm-slim/,'node:22 系（package.json engines >=22.19）');
  assert.match(dockerHost,/apt-get install[^\n]*openssl/,'slim 无 openssl，而 host 启动即 execFileSync openssl 生成证书（host/agent-host.mjs:46）');
  assert.match(dockerHost,/COPY package\.json package-lock\.json \.\/\nRUN npm ci --omit=dev --ignore-scripts/,'按锁文件安装 Host 运行依赖');
  assert.ok(dockerHost.split('\n').some(line=>line==='COPY host/ host/'),'放行的 Host 模块与 schema 保留相对路径');
  assert.match(dockerHost,/CMD \["node", "host\/agent-host\.mjs"\]/,'容器入口 = agent-host');
  // 闭包以当次代码实测为准（§4-M5「闭包随代码演进会变，改 host→web 引用后同步改这里」）
  const copied=copyWebFiles(dockerHost).sort();
  assert.deepEqual(copied,[...webClosureSet].sort(),
    `Dockerfile.host 的 web COPY 列表必须等于当次实测闭包（实测 ${[...webClosureSet].sort().join(', ')}）`);
  for (const file of webClosureSet) {
    assert.ok(existsSync(join(ROOT,'web',file)),`闭包文件真实存在：web/${file}`);
    assert.ok(readFileSync(join(ROOT,'tools','build.mjs'),'utf8').includes(`'${file}'`),
      `web/${file} 已登记在 tools/build.mjs 白名单（§4-M5）`);
  }
  // 镜像里也不得 COPY 闭包之外的 web 文件（镜像不携带前端页面，web 静态页由 GitHub Pages/App 提供，§3.1）
  const allCopied=copyTokens(dockerHost).filter(token=>token!=='web/'&&token!=='host/');
  assert.deepEqual(allCopied.filter(token=>token.startsWith('web/')).map(token=>token.slice(4)).sort(),
    [...webClosureSet].sort(),'COPY 的 web 文件恰好是闭包，不多不少');
  for (const token of allCopied) {
    assert.ok(existsSync(join(ROOT,token)),`Dockerfile.host COPY 的源路径真实存在：${token}`);
  }
});

// ---- Dockerfile.agent：node:24、dsh pin、runner 闭包、along bundle 不含 lib（§3.5/§4-M5） -------

test('Dockerfile.agent：node:24-slim + dsh@0.2.2-rc.5 pin，runner 与其 web 闭包齐备，bundle 不 COPY lib/',()=>{
  assert.match(dockerAgent,/FROM node:24-bookworm-slim/,'@deepseek-ai/dsh@0.2.2-rc.5 的 engines 是 node>=24.9.0（§2.1）');
  assert.match(dockerAgent,/npm install -g[^\n]*@deepseek-ai\/dsh@0\.2\.2-rc\.5/,'dsh 版本写死 pin（§3.5 Tier 1）');
  assert.ok(dockerAgent.split('\n').some(line=>line.startsWith('COPY deploy/agent-runner.mjs deploy/')),
    'runner 本体进镜像');
  assert.match(dockerAgent,/CMD \["node", "deploy\/agent-runner\.mjs"\]/,'容器入口 = runner');
  // runner 的 web 闭包以当次 import 实测为准（与 Dockerfile.host 同口径）
  const runnerImports=new Set([...runnerSrc.matchAll(/from '\.\.\/web\/([^']+)'/g)].map(match=>match[1]));
  assert.ok(runnerImports.size>0,'deploy/agent-runner.mjs 确实引用共享契约层');
  assert.deepEqual(copyWebFiles(dockerAgent).sort(),[...runnerImports].sort(),
    'Dockerfile.agent COPY 的 web 文件必须等于 runner 当次实测 import 闭包（缺一个即容器内启动 MODULE_NOT_FOUND）');
  for (const file of runnerImports) assert.ok(existsSync(join(ROOT,'web',file)),`web/${file} 真实存在`);
  // COPY 目录复制内容。独立目标保留 tsdown 和运行时依赖的目录层级。
  const dirs=['src/','prompts/','skills/','locale/','scripts/'];
  const files=['package.json','pnpm-lock.yaml','tsdown.config.ts','tsconfig.json','cordis.patch.yml','README.md'];
  assert.deepEqual(bundleCopies,[
    ...dirs.map(dir=>[dir,BUNDLE_ROOT+dir]),
    [...files,BUNDLE_ROOT],
  ]);
  // compose 记录用版本与 pin 一致（前面已断言值，这里再锁「两处同源」的文案约束）
  assert.equal(composeDoc.services.agent.environment.ALONG_DSH_VERSION,/dsh@([\w.\-]+)\b/.exec(dockerAgent)?.[1],
    'ALONG_DSH_VERSION 必须等于 Dockerfile 里的 dsh pin');
});

// ---- env.example：非敏感示例值 + 与 compose environment 一一对应（验收 #5） ---------------------

test('env.example：只含非敏感示例值，键值与 compose environment 完全对应，云端不引入凭证 env',()=>{
  const entries={};
  for (const line of envExample.split('\n')) {
    const match=/^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) entries[match[1]]=match[2].split('#')[0].trim();
  }
  assert.ok(Object.keys(entries).length>0,'env.example 必须有可解析的 KEY=VALUE 行');
  // 非敏感（验收 #5）：无长十六进制（token/密钥形态）、无 PEM、无本不该上云的凭证 env（§3.3/README）
  assert.ok(!/[0-9a-f]{32,}/i.test(envExample),'env.example 不得出现凭证形态的十六进制串');
  assert.ok(!/BEGIN/i.test(envExample)&&!/PRIVATE KEY/i.test(envExample),'env.example 不得出现私钥内容');
  for (const key of Object.keys(entries)) {
    assert.ok(!/^(ALONG_BRIDGE|ALONG_CONTEXT_REVIEW|ALONG_KIMI|ALONG_SUPERAGENT_URL)/.test(key),
      `云端不配置桥接/情境评估/Kimi env（§3.5 开关语义），env.example 不得引入：${key}`);
  }
  assert.equal(entries.ALONG_TLS_CN,'along.example.com','域名占位符（README 必改项）');
  assert.equal(entries.ALONG_APNS_TEAM_ID,'XXXXXXXXXX','APNs 占位符（§3.3）');
  assert.equal(entries.ALONG_APNS_KEY_ID,'XXXXXXXXXX');
  assert.equal(entries.ALONG_EVENT_INGEST,'off');
  // 与 compose environment 一一对应（键集合相同，值一致——env.example 是 compose environment 的参考值）
  const composeEnv={...composeDoc.services.host.environment,...composeDoc.services.agent.environment};
  assert.deepEqual(Object.keys(entries).sort(),Object.keys(composeEnv).sort(),
    'env.example 的键与 compose environment 的键一一对应');
  for (const [key,value] of Object.entries(composeEnv)) {
    assert.equal(entries[key],String(value),`env.example.${key} 与 compose 值一致`);
  }
});

// ---- deploy/README.md：构建/启动/冒烟五步/路径基准/V-1/凭证红线（§4-M5 交付物） ----------------

test('deploy/README.md：构建启动命令、五步冒烟、路径基准与静默失败警告、V-1 预置、凭证红线齐备',()=>{
  assert.ok(deployReadme.includes('docker compose -f deploy/docker-compose.yml build'),'构建命令');
  assert.ok(deployReadme.includes('docker compose -f deploy/docker-compose.yml up -d'),'启动命令');
  assert.ok(deployReadme.includes('--build-context along=../along-superagent'),'手工等价构建命令（cwd=仓库根，基准与 compose 不同，§6.4 第 5 步）');
  assert.ok(deployReadme.includes('位置参数必须是'),'位置参数必须是仓库根的口径写明（写 .. 会把相邻仓库与 secrets 送进 context）');
  // 冒烟（验收 #5/Runbook §6.4 第 5 步）
  assert.ok(deployReadme.includes('https://0.0.0.0:4176'),'启动横幅期望值（ALONG_AGENT_HOST=0.0.0.0 生效）');
  assert.ok(deployReadme.includes('/data/users.json'),'users.json 可见性冒烟（卷挂错会静默单用户模式）');
  assert.ok(deployReadme.includes('curl -k https://127.0.0.1/health'),'宿主机 443 探活');
  assert.ok(deployReadme.includes('readRun("/run",')&&deployReadme.includes('DSH smoke passed'),
    '冒烟 POST 通过 runner 完成真实 DSH 运行');
  assert.match(deployReadme,/readRun\("\/run\/" \+ requestId, .*"x-along-user": userId/,'冒烟轮询请求提交时的用户和编号');
  // 路径基准警告（§3.1 静默失败模式）
  assert.ok(deployReadme.includes('project directory'),'路径基准=project directory 写明');
  assert.ok(deployReadme.includes('单用户模式'),'卷挂空的静默失败模式写明（验收 #5 路径一致性断言的人工核对项）');
  // V-1 预置（验收 #9）：bundle 源码形态、lib 需容器内构建
  assert.ok(deployReadme.includes('corepack pnpm'),'V-1 验证前在容器内构建 lib 的步骤');
  assert.ok(deployReadme.includes('test -f lib/index.js'),'V-1 构建后核对实际产物');
  // 凭证红线（AGENTS.md §5）
  assert.ok(deployReadme.includes('0600'),'secret 文件 0600');
  assert.ok(deployReadme.includes('docker history'),'secrets 不进镜像层的抽查手段');
  assert.ok(deployReadme.includes('三处引用'),'不部署远程通知时删除 apns-key 三处引用的说明');
});

// ---- .dockerignore：在 Docker 实际读取的位置写构建上下文规则 --------------------------

test('两个 Docker 构建共享根目录白名单，目录中的任意文件不会整包放行',()=>{
  for (const {build} of Object.values(composeDoc.services)) {
    assert.equal(resolve(DEPLOY_DIR,build.context),resolve(ROOT));
    assert.ok(!existsSync(join(ROOT,build.dockerfile+'.dockerignore')),'没有覆盖根目录白名单的 Dockerfile 专用规则');
  }
  const source=readFileSync(join(ROOT,'.dockerignore'),'utf8');
  const lines=source.split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
  assert.deepEqual(lines,[
    '*','!package.json','!package-lock.json','!host/*.mjs','!host/schemas/task-reply.schema.json','!web/*.mjs','!deploy/agent-runner.mjs',
  ]);
});

// ---- docker compose config（验收 #5 第 1 条；门控：本机有可用 compose CLI 才跑） --------------

function composeWithoutApns() {
  return compose.split('\n')
    .filter(line=>{
      if (/^\s*ALONG_APNS_(KEY_FILE|TEAM_ID|KEY_ID):/.test(line)) return false;
      if (/^  apns-key:\s*\{file/.test(line)) return false;
      return true;
    })
    .map(line=>line.includes('[apns-key, runner-token]')?line.replace('[apns-key, runner-token]','[runner-token]'):line)
    .join('\n');
}

test('docker compose config 校验通过；按注释删除 apns-key 三处引用后的变体同样通过', {skip: composeCli?false:'本机没有可用的 docker compose CLI（可用 ALONG_COMPOSE_BIN 指定 standalone 二进制）'},()=>{
  const run=(args,label)=>{
    const result=spawnSync(composeCli[0],[...composeCli.slice(1),...args],{encoding:'utf8',timeout:120_000});
    assert.equal(result.status,0,`${label} 失败（exit ${result.status}）：${result.stderr||result.stdout}`);
    return result;
  };
  run(['-f',COMPOSE_FILE,'config','-q'],'原始 compose config 校验');
  // 完整解析输出里，卷与 additional context 必须落在真实路径（真实解析器兜底静态断言）
  const full=run(['-f',COMPOSE_FILE,'config'],'原始 compose config 解析');
  assert.ok(full.stdout.includes(resolve(DEPLOY_DIR,'../../along-superagent')),
    'config 解析出的 additional_contexts 必须是真实相邻仓库路径');
  // 验收 #5 可选路径：删除 apns-key 三处引用后编排仍然成立（up 行为留 Runbook 第 5 步）
  const dir=mkdtempSync(join(tmpdir(),'along-deploy-noapns-'));
  try {
    const variant=join(dir,'compose-noapns.yml');
    writeFileSync(variant,composeWithoutApns());
    const stripped=composeWithoutApns();
    assert.ok(!stripped.includes('apns-key:          {file'),'变体删除了顶层 secrets.apns-key');
    assert.ok(!/^      ALONG_APNS_/m.test(stripped),'变体删除了 host 的三个 APNs env');
    assert.ok(stripped.includes('secrets: [runner-token]'),'变体保留 runner-token 引用（host 分流必需）');
    run(['-f',variant,'--project-directory',DEPLOY_DIR,'config','-q'],'删除 apns-key 引用后的 compose config 校验');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

// ---- along bundle 预置可从干净 checkout 构建（门控：需要相邻仓库） ----------------------------

test('along bundle 的 COPY 清单在沿用 Along Agent 的干净 checkout 时均存在', {skip: existsSync(ADJACENT)?false:'需要相邻的 along-superagent 仓库（CI 只 checkout 本仓库）'},()=>{
  const tokens=bundleCopies.flatMap(copy=>copy.slice(0,-1));
  const tracked=spawnSync('git',['ls-files'],{cwd:ADJACENT,encoding:'utf8'});
  assert.equal(tracked.status,0,'git ls-files 可用');
  const trackedSet=new Set(tracked.stdout.split('\n').filter(Boolean));
  for (const token of tokens) {
    assert.ok(existsSync(join(ADJACENT,token)),`bundle 源路径真实存在：${token}`);
    if (token.endsWith('/')) {
      assert.ok([...trackedSet].some(file=>file.startsWith(token)),`${token} 在相邻仓库里有 git 跟踪文件`);
    } else {
      assert.ok(trackedSet.has(token),`${token} 是相邻仓库的 git 跟踪文件（fresh clone 可构建的前提）`);
    }
  }
  const libTracked=spawnSync('git',['ls-files','lib/'],{cwd:ADJACENT,encoding:'utf8'});
  assert.equal(libTracked.stdout.trim(),'','lib/ 在相邻仓库里没有任何 git 跟踪文件（佐证不得 COPY lib/）');
});
