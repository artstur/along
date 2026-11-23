import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseDocument} from 'yaml';

// 安全加固配对测试：M3 deploy-hardening（docs/cloud-security-hardening.md §3.3 机制、§4-M3 验收标准）。
// 与 test/deploy-orchestration.test.mjs 互补：本文件只按 §4-M3 的验收标准逐条断言，不迁就实现：
// - 验收 1（两条 test）：compose host 服务新增 read_only/tmpfs(noexec,nosuid,nodev)/
//   no-new-privileges/cap_drop [ALL]，agent 服务新增 cap_drop [ALL] + cap_add [SETUID,SETGID]，
//   两服务 mem_limit/cpus/pids_limit 为正值；docker compose config（有 CLI 时）通过且
//   apns 删除变体仍通过（G-2 + G-1/G-3 编排配合）。
// - 验收 2：Dockerfile.host FROM node:22-bookworm-slim@sha256:<64hex>；COPY 闭包等既有断言不变。
// - 验收 3：Dockerfile.agent FROM node:24-bookworm-slim@sha256:<64hex>；无 npm install -g；
//   npm ci --ignore-scripts 于 deploy/agent-dsh；ln -s 建 dsh；ALONG_DSH_VERSION 与
//   deploy/agent-dsh/package.json 版本一致（G-8）。
// - 验收 4：deploy/agent-dsh/package-lock.json 存在且锁定 @deepseek-ai/dsh@0.2.2-rc.5，
//   packages 含传递依赖条目（解析 lock 断言）。
// - 验收 5：.dockerignore 白名单数组更新（含两条 agent-dsh 清单放行）且语义不变（任意新文件不放行）。
// - 验收 6：回归 npm run check 全绿——由套件运行本身覆盖（本文件就是 npm run check 的一部分；
//   node:test 不自递归再跑全套件，故不在本文件内断言这一条）。
// 需要真实 Docker daemon 的运行时行为（read_only/cap_drop/资源上限实际生效、非 root 读写面）
// 不在本地可断言范围，按设计 §6 步骤 7 在 ECS 冒烟核实。compose config 校验用 {skip} 门控：
// 检测到可用 compose CLI 才跑，可用 ALONG_COMPOSE_BIN 指定 standalone 二进制。

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const DEPLOY_DIR=join(ROOT,'deploy');
const COMPOSE_FILE=join(DEPLOY_DIR,'docker-compose.yml');
const compose=readFileSync(COMPOSE_FILE,'utf8');
const composeDoc=parseDocument(compose).toJS();
const dockerHost=readFileSync(join(DEPLOY_DIR,'Dockerfile.host'),'utf8');
const dockerAgent=readFileSync(join(DEPLOY_DIR,'Dockerfile.agent'),'utf8');
const dshManifest=JSON.parse(readFileSync(join(DEPLOY_DIR,'agent-dsh','package.json'),'utf8'));
const DSH_PIN='0.2.2-rc.5';   // 设计文档 §3.3-(3)/§4-M3 指定的 dsh 版本

function copyTokens(dockerfile) {
  return dockerfile.split('\n').filter(line=>line.startsWith('COPY '))
    .flatMap(line=>line.split(/\s+/).slice(1));
}
function copyWebFiles(dockerfile) {
  return copyTokens(dockerfile).filter(token=>token.startsWith('web/')&&token!=='web/')
    .map(token=>token.slice('web/'.length));
}

// host→web import 闭包（既有断言的同款算法）：从镜像携带的全部 host/ 顶层模块出发，
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
      if (ref.startsWith('../web/')) queue.push(['web',ref.slice('../web/'.length)]);
      else if (ref.startsWith('./')) queue.push([dir,ref.slice(2)]);
    }
  }
  return reachable;
}
const webClosureSet=webClosure();

// compose mem_limit 接受字节数字或 '512m'/'2g' 后缀字符串（验收 1：只要求可解析且为正值）
function memLimitBytes(value) {
  const match=/^(\d+(?:\.\d+)?)\s*([kmg]?)(?:i?b)?$/i.exec(String(value));
  if (!match) return NaN;
  const unit={'':1,k:2**10,m:2**20,g:2**30}[match[2].toLowerCase()];
  return Number(match[1])*unit;
}

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

// ---- 验收 1a：compose 加固字段（G-2 三件套 + cap + 资源上限正值） -------------------------------

test('compose 加固（验收 1）：host 补齐 read_only/tmpfs/no-new-privileges/cap_drop ALL，agent 补 cap_drop ALL+cap_add SETUID/SETGID，两服务 mem/cpus/pids 正值',()=>{
  const services=composeDoc.services;
  assert.ok(services.host&&services.agent,'host 与 agent 服务存在');
  // host 三件套（G-2，§3.3-(1)）：唯一可写面 = /data 卷 + /tmp tmpfs；不加非 root USER（SD-H5）
  assert.equal(services.host.read_only,true,'host 只读根：封死落盘持久化');
  const hostTmpfs=services.host.tmpfs;
  assert.ok(Array.isArray(hostTmpfs)&&hostTmpfs.length===1,'host tmpfs 恰一条挂载');
  assert.ok(String(hostTmpfs[0]).startsWith('/tmp:'),'tmpfs 挂在 /tmp');
  for (const flag of ['noexec','nosuid','nodev']) {
    assert.ok(String(hostTmpfs[0]).includes(flag),`/tmp tmpfs 带 ${flag}（验收 1）`);
  }
  assert.ok((services.host.security_opt??[]).some(entry=>String(entry).startsWith('no-new-privileges')),
    'host security_opt 含 no-new-privileges：封死 setuid 提权路径');
  assert.deepEqual(services.host.cap_drop,['ALL'],'host cap_drop [ALL]（写 /data、spawn openssl 同 uid、绑 4176>1024 都不需要能力位）');
  // agent（验收 1）：cap_drop ALL + cap_add SETUID/SETGID——仅为 M2 读入 secrets 后整进程降权保留
  assert.deepEqual(services.agent.cap_drop,['ALL'],'agent cap_drop [ALL]');
  assert.deepEqual(services.agent.cap_add,['SETUID','SETGID'],'agent cap_add [SETUID,SETGID]（NNP 不拦 syscall 降权，SD-H5）');
  // agent 三件套是 M3 之前就有的既有加固（host 以它为模板「同款」）：防本模块改 host 时误伤 agent
  assert.equal(services.agent.read_only,true,'agent 只读根（既有，回归保护）');
  assert.ok((services.agent.security_opt??[]).some(entry=>String(entry).startsWith('no-new-privileges')),
    'agent no-new-privileges（既有，回归保护）');
  const agentTmpfs=String((services.agent.tmpfs??[])[0]??'');
  for (const flag of ['noexec','nosuid','nodev']) {
    assert.ok(agentTmpfs.includes(flag),`agent /tmp tmpfs 带 ${flag}（既有，回归保护）`);
  }
  // 两服务资源上限为正值（G-1/G-3；SD-H9：数值为常数初值，验收只要求正值，冒烟后可调）
  for (const [name,service] of Object.entries(services)) {
    const mem=memLimitBytes(service.mem_limit);
    assert.ok(Number.isFinite(mem)&&mem>0,`${name} mem_limit 可解析且为正值（实测 ${service.mem_limit}）`);
    const cpus=Number(service.cpus);
    assert.ok(Number.isFinite(cpus)&&cpus>0,`${name} cpus 可解析且为正值（实测 ${service.cpus}）`);
    const pids=Number(service.pids_limit);
    assert.ok(Number.isInteger(pids)&&pids>0,`${name} pids_limit 正整数（实测 ${service.pids_limit}）`);
  }
});

// ---- 验收 1b：docker compose config（门控：有可用 compose CLI 才跑） -----------------------------

// apns 删除变体（compose 注释写明的可选路径）：删除 APNs 三个 env、host secrets 列表与顶层定义三处引用
function composeWithoutApns(source) {
  return source.split('\n')
    .filter(line=>!/^\s*ALONG_APNS_(KEY_FILE|TEAM_ID|KEY_ID):/.test(line))
    .filter(line=>!/^\s*apns-key:\s*\{file/.test(line))
    .map(line=>line.includes('apns-key, runner-token')?line.replace('apns-key, runner-token','runner-token'):line)
    .join('\n');
}

test('docker compose config 通过且 apns 删除变体仍通过（验收 1，有 CLI 时）',
  {skip:composeCli?false:'本机没有可用的 docker compose CLI（可用 ALONG_COMPOSE_BIN 指定 standalone 二进制）'},()=>{
  const run=(args,label)=>{
    const result=spawnSync(composeCli[0],[...composeCli.slice(1),...args],{encoding:'utf8',timeout:120_000});
    assert.equal(result.status,0,`${label} 失败（exit ${result.status}）：${result.stderr||result.stdout}`);
  };
  run(['-f',COMPOSE_FILE,'config','-q'],'原始 compose config 校验（加固字段必须是 compose 认识的字段）');
  const dir=mkdtempSync(join(tmpdir(),'along-security-deploy-'));
  try {
    const stripped=composeWithoutApns(compose);
    assert.ok(!/^\s*ALONG_APNS_/m.test(stripped),'变体删除了 host 的三个 APNs env');
    assert.ok(!/^\s*apns-key:\s*\{file/m.test(stripped),'变体删除了顶层 secrets.apns-key 定义');
    assert.ok(/^\s*secrets:\s*\[runner-token\]/m.test(stripped),'变体保留 runner-token 引用（host 分流必需）');
    const variant=join(dir,'compose-noapns.yml');
    writeFileSync(variant,stripped);
    run(['-f',variant,'--project-directory',DEPLOY_DIR,'config','-q'],'apns 删除变体的 compose config 校验');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

// ---- 验收 2：Dockerfile.host digest pin + COPY 闭包等既有断言不变 --------------------------------

test('Dockerfile.host（验收 2）：FROM node:22-bookworm-slim@sha256:<64hex>；COPY 闭包等既有断言不变',()=>{
  // digest pin（G-8）：行尾锚定——浮动 tag（无 @sha256）从此不通过
  assert.match(dockerHost,/^\s*FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}\s*$/m,
    'node:22 基础镜像按 digest pin（§3.3-(3)）');
  for (const line of dockerHost.split('\n').filter(line=>line.startsWith('FROM '))) {
    assert.ok(/@sha256:[0-9a-f]{64}/.test(line),`每条 FROM 都带 digest pin：${line}`);
  }
  // 既有断言不变：openssl、根依赖锁文件安装、host/ 源码、容器入口
  assert.match(dockerHost,/apt-get install[^\n]*openssl/,'slim 无 openssl，而 host 启动即 execFileSync openssl 生成自签证书');
  assert.match(dockerHost,/COPY package\.json package-lock\.json \.\/\nRUN npm ci --omit=dev --ignore-scripts/,
    'Host 运行依赖按根锁文件安装');
  assert.ok(dockerHost.split('\n').some(line=>line==='COPY host/ host/'),'Host 源码整体进镜像');
  assert.match(dockerHost,/CMD \["node", "host\/agent-host\.mjs"\]/,'容器入口 = agent-host');
  // 既有断言不变：COPY 的 web 文件与当次实测 host→web import 闭包完全一致（不多不少）
  const copied=copyWebFiles(dockerHost).sort();
  assert.deepEqual(copied,[...webClosureSet].sort(),
    `Dockerfile.host 的 web COPY 列表必须等于当次实测闭包（实测 ${[...webClosureSet].sort().join(', ')}）`);
  for (const file of webClosureSet) {
    assert.ok(existsSync(join(ROOT,'web',file)),`闭包文件真实存在：web/${file}`);
    assert.ok(readFileSync(join(ROOT,'tools','build.mjs'),'utf8').includes(`'${file}'`),
      `web/${file} 已登记在 tools/build.mjs 白名单`);
  }
  const allCopied=copyTokens(dockerHost).filter(token=>token!=='web/'&&token!=='host/');
  assert.deepEqual(allCopied.filter(token=>token.startsWith('web/')).map(token=>token.slice(4)).sort(),
    [...webClosureSet].sort(),'COPY 的 web 文件恰好是闭包，不多不少');
  for (const token of allCopied) {
    assert.ok(existsSync(join(ROOT,token)),`Dockerfile.host COPY 的源路径真实存在：${token}`);
  }
});

// ---- 验收 3：Dockerfile.agent digest pin + dsh 锁文件安装形态 ------------------------------------

test('Dockerfile.agent（验收 3）：FROM node:24-bookworm-slim@sha256:<64hex>；无 npm install -g；npm ci --ignore-scripts 于 deploy/agent-dsh；ln -s 建 dsh；ALONG_DSH_VERSION 与清单一致',()=>{
  assert.match(dockerAgent,/^\s*FROM node:24-bookworm-slim@sha256:[0-9a-f]{64}\s*$/m,
    'node:24 基础镜像按 digest pin（@deepseek-ai/dsh@0.2.2-rc.5 的 engines 是 node>=24.9.0）');
  assert.ok(!/\bnpm\s+(?:install|i)\b[^\n]*\s(?:-g|--global)\b/m.test(dockerAgent),
    '不得用 npm install -g（传递依赖无锁、postinstall 以 root 执行，G-8）');
  const lines=dockerAgent.split('\n');
  // dsh 两个清单 COPY 进镜像，且先于 npm ci（构建顺序前提）
  const manifestCopy=lines.findIndex(line=>line.startsWith('COPY ')
    &&line.includes('deploy/agent-dsh/package.json')&&line.includes('deploy/agent-dsh/package-lock.json'));
  assert.ok(manifestCopy>=0,'dsh 的 package.json 与 package-lock.json 被 COPY 进镜像');
  const npmCi=lines.findIndex(line=>/\bRUN\b/.test(line)&&/\bnpm\s+ci\b/.test(line));
  assert.ok(npmCi>=0,'有 RUN npm ci 安装步');
  assert.ok(npmCi>manifestCopy,'清单 COPY 先于 npm ci');
  assert.ok(lines[npmCi].includes('--prefix deploy/agent-dsh'),'npm ci 安装 deploy/agent-dsh（替代全局安装）');
  assert.ok(lines[npmCi].includes('--ignore-scripts'),'--ignore-scripts 挡传递依赖在构建期以 root 执行 postinstall');
  const ln=lines.find(line=>/\bln\s+-s\b/.test(line));
  assert.ok(ln&&ln.includes('node_modules/.bin/dsh')&&ln.includes('/usr/local/bin/dsh'),
    'ln -s 把 node_modules/.bin/dsh 提供到 /usr/local/bin（runner spawn dsh 走 PATH）');
  // 跨文件一致（验收 3）：版本唯一源头 = deploy/agent-dsh/package.json，compose 记录值与之相等
  assert.equal(dshManifest.dependencies['@deepseek-ai/dsh'],DSH_PIN,'清单 pin @deepseek-ai/dsh@0.2.2-rc.5');
  assert.equal(composeDoc.services.agent.environment.ALONG_DSH_VERSION,dshManifest.dependencies['@deepseek-ai/dsh'],
    'ALONG_DSH_VERSION 与 deploy/agent-dsh/package.json 的 dsh pin 跨文件一致');
});

// ---- 验收 4：agent-dsh 锁文件解析断言 ------------------------------------------------------------

test('deploy/agent-dsh/package-lock.json（验收 4）：存在且锁定 @deepseek-ai/dsh@0.2.2-rc.5，packages 含传递依赖条目',()=>{
  const lockPath=join(DEPLOY_DIR,'agent-dsh','package-lock.json');
  assert.ok(existsSync(lockPath),'锁文件存在');
  const lock=JSON.parse(readFileSync(lockPath,'utf8'));
  assert.ok(lock.packages&&typeof lock.packages==='object','lock.packages 形态（npm ci 可消费）');
  assert.equal(lock.packages['']?.dependencies?.['@deepseek-ai/dsh'],DSH_PIN,'root 条目与清单同 pin');
  const dshEntry=lock.packages['node_modules/@deepseek-ai/dsh'];
  assert.ok(dshEntry,'packages 含 @deepseek-ai/dsh 条目');
  assert.equal(dshEntry.version,DSH_PIN,'dsh 版本被锁文件固定');
  assert.match(dshEntry.resolved??'',/^https:\/\/registry\.npmjs\.org\//,'resolved 指向官方 registry 的固定 tarball');
  assert.match(dshEntry.integrity??'',/^sha512-[A-Za-z0-9+/=]+$/,'dsh 条目带 integrity 哈希');
  // 传递依赖条目：dsh 的每个直接依赖都有锁定条目，且总量远多于 root+dsh 两条
  const dshDeps=Object.keys(dshEntry.dependencies??{});
  assert.ok(dshDeps.length>0,'dsh 声明直接依赖');
  for (const dep of dshDeps) {
    assert.ok(lock.packages[`node_modules/${dep}`],`dsh 直接依赖被锁文件固定：${dep}`);
  }
  assert.ok(Object.keys(lock.packages).length>dshDeps.length+2,
    `packages 含传递依赖条目（${Object.keys(lock.packages).length} 条 > root+dsh+直接依赖 ${dshDeps.length}）`);
});

// ---- 验收 5：.dockerignore 白名单更新且语义不变 --------------------------------------------------

test('.dockerignore（验收 5）：白名单数组更新（两条 agent-dsh 清单放行），语义不变（任意新文件不放行）',()=>{
  const source=readFileSync(join(ROOT,'.dockerignore'),'utf8');
  const lines=source.split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
  // 数组 = pre-M3 白名单（git show HEAD:.dockerignore 基线，7 行）+ 两条 agent-dsh 清单放行
  assert.deepEqual(lines,[
    '*','!package.json','!package-lock.json','!host/*.mjs','!host/schemas/task-reply.schema.json','!web/*.mjs',
    // 云端 Host 镜像整目录 COPY web/（deploy/Dockerfile.host.cloud），静态资源也要放行。
    '!web/*.html','!web/*.css','!web/*.png','!web/*.webmanifest',
    '!deploy/agent-runner.mjs',
    '!deploy/agent-dsh/package.json','!deploy/agent-dsh/package-lock.json',
    // Tier 2 长驻镜像（deploy/Dockerfile.superagent）的启动脚本与设置播种脚本。
    '!deploy/superagent-start.sh','!deploy/superagent-seed.mjs',
    // 读取面收紧的推导脚本（审查 P1-1）。
    '!deploy/superagent-preset-lockdown.mjs',
  ]);
  assert.equal(lines[0],'*','默认拒绝一切：白名单语义不变（只增不改）');
  for (const line of lines.filter(item=>item.startsWith('!')&&!item.includes('*'))) {
    assert.ok(existsSync(join(ROOT,line.slice(1))),`非 glob 放行项必须是真实存在的具体文件（防目录级整包放行）：${line}`);
  }
  // 白名单匹配语义（dockerignore 子集：'*' 为段内通配）：放行 = 命中某条 '!' 模式
  const allowPatterns=lines.filter(line=>line.startsWith('!')).map(line=>line.slice(1));
  const allowMatch=path=>allowPatterns.some(pattern=>new RegExp('^'+pattern.split('*')
    .map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*')+'$').test(path));
  // 两条 agent-dsh 清单确实放行（Dockerfile.agent 的 COPY/npm ci 需要它们进构建上下文）
  assert.ok(allowMatch('deploy/agent-dsh/package.json'),'agent-dsh 清单放行');
  assert.ok(allowMatch('deploy/agent-dsh/package-lock.json'),'agent-dsh 锁文件放行');
  // 任意新文件不放行：agent-dsh 目录里清单之外的任何文件（含 node_modules、可执行脚本）、
  // 其他目录新文件，都不得命中任何放行模式——白名单更新不能扩大成目录级放行
  for (const newcomer of [
    'deploy/agent-dsh/postinstall.js',
    'deploy/agent-dsh/setup.sh',
    'deploy/agent-dsh/node_modules/pkg/index.js',
    'deploy/agent-dsh/extra-file.txt',
    'deploy/secret.txt',
    'docs/leak.md',
  ]) {
    assert.ok(!allowMatch(newcomer),`白名单外的新文件不放行：${newcomer}`);
  }
});
