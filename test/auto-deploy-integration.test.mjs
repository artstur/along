import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';

// 自动部署器的隔离集成验证。
//
// 单元测试锁不住编排契约的真实行为：compose up 会不会**部分成功**、
// 构建缓存会不会把旧内容烤进镜像、镜像里跑的内容与台账记的提交对不对得上、
// 解包失败会不会污染同 SHA 的下一轮。这些只能在隔离 Docker 环境里跑真实容器才验得了。
//
// 本文件用**真实** deploy/auto-deploy.sh 跑一套隔离栈：两个本地 git origin 当上游，
// 一套与生产同形状的三容器编排（锚点持 netns，host 与 superagent 加入它）。
//
// 门控：
//   - 没有可用 Docker 时整体跳过（本机/CI 常见）；
//   - 默认**不**跑（要构建镜像、起容器，耗时），用
//     ALONG_AUTO_DEPLOY_INTEGRATION=1 显式开启。
//     `npm run check` 不带这个变量，所以普通开发与 CI 不受它的耗时影响。
//
// 隔离：独立工作目录、独立 Compose 项目名、独立镜像标签、独立容器名。
// 与线上栈共用同一个 Docker daemon 时，这些隔离标记保证测试不会动到部署。

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const SCRIPT=join(ROOT,'deploy','auto-deploy.sh');

const PROJECT=`along-autodeploy-test-${process.pid}-${randomBytes(4).toString('hex')}`;
const CONTAINER_PREFIX=PROJECT;
const IMAGE_TAG=`${PROJECT}:local`;
// 端口写死：隔离环境里没有别的栈，不会撞；生产用的是别的端口。
const HOST_PORT=14176;
const JUMP_PORT=13083;
// 工作目录必须落在仓库内：colima 只把家目录共享进虚拟机，/tmp 不共享——
// bind mount 到 /tmp 会静默变成空目录。按进程号随机化，避免并发用例共用状态目录。
const BASE=join(ROOT,'.auto-deploy-integration',PROJECT);

const ENABLED=process.env.ALONG_AUTO_DEPLOY_INTEGRATION==='1';

function dockerBin() {
  if (spawnSync('docker',['compose','version'],{encoding:'utf8',timeout:30_000}).status===0) {
    return {bin:'docker',prefix:['compose']};
  }
  if (spawnSync('docker-compose',['version'],{encoding:'utf8',timeout:30_000}).status===0) {
    return {bin:'docker-compose',prefix:[]};
  }
  return null;
}

const DOCKER=dockerBin();

function git(args,cwd) {
  const result=spawnSync('git',args,{cwd,encoding:'utf8',timeout:60_000,
    env:{...process.env,GIT_AUTHOR_NAME:'test',GIT_AUTHOR_EMAIL:'test@example.com',
      GIT_COMMITTER_NAME:'test',GIT_COMMITTER_EMAIL:'test@example.com'}});
  if (result.status!==0) throw Error(`git ${args.join(' ')} 失败：${result.stderr||result.stdout}`);
  return (result.stdout||'').trim();
}

// 跑一轮部署器，返回退出码与输出。
function deploy(env={},args='run') {
  const result=spawnSync('bash',[SCRIPT,args],{
    cwd:BASE,encoding:'utf8',timeout:900_000,
    env:{...process.env,...env}});
  return {status:result.status,stdout:result.stdout||'',stderr:result.stderr||''};
}

// ---- 夹具：两个本地 git origin + 一套与生产同形状的编排 --------------------

// 上游仓库的最小内容：只放"能被构建、且内容会变"的文件。
//
// superagent 仓放 prompts/（对应生产里 bundle 的提示词目录）：复核发现的
// 缺陷 2 就是"改这个目录里的文件"触发的。
function writeUpstream() {
  const originAlong=join(BASE,'origin','along.git');
  const originSa=join(BASE,'origin','superagent.git');
  mkdirSync(join(BASE,'origin'),{recursive:true});
  git(['init','-q','--bare',originAlong]);
  git(['init','-q','--bare',originSa]);

  const wcAlong=join(BASE,'work','along');
  const wcSa=join(BASE,'work','along-superagent');
  mkdirSync(join(BASE,'work'),{recursive:true});
  git(['clone','-q',originAlong,wcAlong]);
  git(['clone','-q',originSa,wcSa]);

  // Along 侧：编排 + 构建上下文。目录结构对齐生产的 deploy/ 布局
  // （compose 在 deploy/ 下，构建上下文是仓库根）。
  mkdirSync(join(wcAlong,'deploy'),{recursive:true});
  mkdirSync(join(wcAlong,'www'),{recursive:true});
  writeFileSync(join(wcAlong,'www','health'),'ok\n');
  // Host 服务在共享命名空间里监听 4176，宿主经锚点发布的端口进来。
  writeFileSync(join(wcAlong,'deploy','Dockerfile.host'),[
    'FROM busybox',
    'COPY www/ /www/',
    'CMD ["httpd","-f","-p","4176","-h","/www"]',
    '',
  ].join('\n'));
  // Super Agent 镜像从 additional_contexts（相邻仓库）取 bundle——
  // 与生产同一条构建路径（缺陷 2 就发生在这条路径上）。
  writeFileSync(join(wcAlong,'deploy','Dockerfile.superagent'),[
    'FROM busybox',
    'COPY --from=along /prompts/ /prompts/',
    'CMD ["sh","-c","while true; do sleep 3600; done"]',
    '',
  ].join('\n'));
  // 与生产同形状的编排：锚点持 netns，host 与 superagent 加入它。
  writeFileSync(join(wcAlong,'deploy','docker-compose.cloud.yml'),[
    'services:',
    '  anchor:',
    '    image: busybox',
    `    container_name: ${CONTAINER_PREFIX}-anchor`,
    '    command: ["httpd","-f","-p","3083","-h","/tmp"]',
    '    ports:',
    `      - "127.0.0.1:${JUMP_PORT}:3083"`,
    `      - "127.0.0.1:${HOST_PORT}:4176"`,
    '    healthcheck:',
    '      test: ["CMD","true"]',
    '      interval: 2s',
    '      timeout: 2s',
    '      retries: 3',
    '  superagent:',
    '    build:',
    '      context: ..',
    '      dockerfile: deploy/Dockerfile.superagent',
    '      additional_contexts: {along: "${ALONG_SUPERAGENT_SOURCE:-../../along-superagent}"}',
    `    image: ${IMAGE_TAG}-superagent`,
    `    container_name: ${CONTAINER_PREFIX}-superagent`,
    '    network_mode: "service:anchor"',
    '    depends_on:',
    '      anchor:',
    '        condition: service_started',
    '    healthcheck:',
    '      test: ["CMD","true"]',
    '      interval: 2s',
    '      timeout: 2s',
    '      retries: 3',
    '  host:',
    '    build:',
    '      context: ..',
    '      dockerfile: deploy/Dockerfile.host',
    `    image: ${IMAGE_TAG}-host`,
    `    container_name: ${CONTAINER_PREFIX}-host`,
    '    network_mode: "service:anchor"',
    '    depends_on:',
    '      anchor:',
    '        condition: service_started',
    '    healthcheck:',
    '      test: ["CMD","true"]',
    '      interval: 2s',
    '      timeout: 2s',
    '      retries: 3',
    '',
  ].join('\n'));

  // Super Agent 侧：bundle 的提示词目录。
  mkdirSync(join(wcSa,'prompts'),{recursive:true});
  writeFileSync(join(wcSa,'prompts','worker.md'),'worker-v1\n');

  git(['add','-A'],wcAlong); git(['commit','-qm','v1'],wcAlong); git(['push','-q','origin','HEAD:main'],wcAlong);
  git(['add','-A'],wcSa); git(['commit','-qm','v1'],wcSa); git(['push','-q','origin','HEAD:main'],wcSa);
  return {originAlong,originSa,wcAlong,wcSa};
}

// 改上游内容并提交。fixedDate 让两次提交落在**同一秒**——复核发现的缺陷 2
// 就是"同秒、等长"的改动触发的构建缓存串味。
function commitUpstream({alongContent,saContent,fixedDate}) {
  const env=fixedDate?{GIT_AUTHOR_DATE:fixedDate,GIT_COMMITTER_DATE:fixedDate}:{};
  if (alongContent) {
    writeFileSync(join(BASE,'work','along','www','health'),alongContent);
    git(['add','-A'],join(BASE,'work','along'));
    git(['commit','-qm','update'],join(BASE,'work','along'));
    git(['push','-q','origin','HEAD:main'],join(BASE,'work','along'));
  }
  if (saContent) {
    writeFileSync(join(BASE,'work','along-superagent','prompts','worker.md'),saContent);
    git(['add','-A'],join(BASE,'work','along-superagent'));
    git(['commit','-qm','update'],join(BASE,'work','along-superagent'));
    git(['push','-q','origin','HEAD:main'],join(BASE,'work','along-superagent'));
  }
  return env;
}

// 部署器的配置：工作区、两个上游地址、隔离的 Compose 编排。
function deployEnv(extra={}) {
  return {
    ALONG_DEPLOY_WORKSPACE:join(BASE,'workspace'),
    ALONG_DEPLOY_ALONG_URL:join(BASE,'origin','along.git'),
    ALONG_DEPLOY_SUPERAGENT_URL:join(BASE,'origin','superagent.git'),
    ALONG_DEPLOY_BRANCH:'main',
    ALONG_DEPLOY_ALONG_CHECKOUT:join(BASE,'work','along'),
    ALONG_DEPLOY_SUPERAGENT_CHECKOUT:join(BASE,'work','along-superagent'),
    ALONG_DEPLOY_COMPOSE_REL:'deploy/docker-compose.cloud.yml',
    ALONG_DEPLOY_STATE_DIR:join(BASE,'state'),
    ALONG_DEPLOY_RELEASE_DIR:join(BASE,'release'),
    ALONG_DEPLOY_KEEP_RELEASES:'2',
    ALONG_DEPLOY_HEALTH_URL:`http://127.0.0.1:${HOST_PORT}/health`,
    ALONG_DEPLOY_PROBE_URL:`http://127.0.0.1:${JUMP_PORT}/`,
    ALONG_DEPLOY_HEALTH_TIMEOUT:'60',
    ALONG_DEPLOY_BUILD_TIMEOUT:'600',
    ALONG_DEPLOY_MIN_FREE_KB:'1048576',
    // 隔离栈的镜像标签与容器名与生产不同。
    ALONG_DEPLOY_HOST_IMAGE:`${IMAGE_TAG}-host`,
    ALONG_DEPLOY_SUPERAGENT_IMAGE:`${IMAGE_TAG}-superagent`,
    ALONG_DEPLOY_HOST_CONTAINER:`${CONTAINER_PREFIX}-host`,
    ALONG_DEPLOY_SUPERAGENT_CONTAINER:`${CONTAINER_PREFIX}-superagent`,
    // 隔离栈没有生产那样的卷与凭证。
    ALONG_DEPLOY_EXPECT_BINDS:'',
    ALONG_DEPLOY_EXPECT_SECRETS:'',
    ALONG_DEPLOY_EXPECT_CONTEXTS:'host=along',
    ALONG_DEPLOY_EXPECT_ADDCTX:'superagent:along=along-superagent',
    ALONG_DEPLOY_VERIFY_HOST_IMAGE:`${IMAGE_TAG}-host|along|/www:www`,
    ALONG_DEPLOY_VERIFY_SUPERAGENT_IMAGE:`${IMAGE_TAG}-superagent|along-superagent|/prompts:prompts`,
    ...extra,
  };
}

function readState() {
  const path=join(BASE,'state','last-success.env');
  return existsSync(path)?readFileSync(path,'utf8'):'';
}

// ---- 用例 ------------------------------------------------------------------

test('自动部署器的隔离集成验证', {skip:!ENABLED?'未设置 ALONG_AUTO_DEPLOY_INTEGRATION=1':!DOCKER?'没有可用的 Docker':false}, async t => {
  writeUpstream();
  mkdirSync(join(BASE,'workspace','data'),{recursive:true});
  mkdirSync(join(BASE,'workspace','secrets'),{recursive:true});
  mkdirSync(join(BASE,'state'),{recursive:true});
  mkdirSync(join(BASE,'release'),{recursive:true});

  // macOS 没有 flock（util-linux）与 timeout（coreutils）。各桩一个。
  // 注意这样**锁的并发语义在本机验不了**——那一条由目标机上的实跑覆盖。
  mkdirSync(join(BASE,'bin'),{recursive:true});
  if (spawnSync('bash',['-c','command -v flock'],{encoding:'utf8'}).status!==0) {
    writeFileSync(join(BASE,'bin','flock'),'#!/bin/sh\nexit 0\n');
    chmodSync(join(BASE,'bin','flock'),0o755);
  }
  if (spawnSync('bash',['-c','command -v timeout'],{encoding:'utf8'}).status!==0) {
    writeFileSync(join(BASE,'bin','timeout'),'#!/bin/sh\nshift\nexec "$@"\n');
    chmodSync(join(BASE,'bin','timeout'),0o755);
  }
  process.env.PATH=`${join(BASE,'bin')}:${process.env.PATH}`;

  t.after(() => {
    const result=spawnSync(DOCKER.bin,[...DOCKER.prefix,'-f',
      join(BASE,'work','along','deploy','docker-compose.cloud.yml'),
      'down','--volumes','--remove-orphans'],{encoding:'utf8',timeout:120_000});
    if (result.status!==0) process.stderr.write(result.stderr||'');
    rmSync(BASE,{recursive:true,force:true});
  });

  await t.test('两个仓都没变时跳过构建与重启', () => {
    const first=deploy(deployEnv());
    assert.equal(first.status,0,`第一轮应当成功：\n${first.stderr}`);
    const second=deploy(deployEnv());
    assert.equal(second.status,0);
    assert.match(second.stderr,/SKIP/,'第二轮应当判定为无更新');
  });

  await t.test('同秒等长的改动必须进到镜像里，台账记的提交与镜像内容一致', () => {
    // 固定提交时间，让两次提交落在同一秒；内容等长（沿用缺陷 2 的触发条件）。
    const fixedDate='2026-01-01T00:00:00Z';
    commitUpstream({
      alongContent:'ok-v2\n',
      saContent:'worker-v2\n',
      fixedDate,
    });
    const newAlong=git(['rev-parse','HEAD'],join(BASE,'work','along'));
    const newSa=git(['rev-parse','HEAD'],join(BASE,'work','along-superagent'));

    const result=deploy(deployEnv());
    assert.equal(result.status,0,`部署应当成功：\n${result.stderr}`);

    // 台账记的是本轮固定的那对提交。
    const state=readState();
    assert.match(state,new RegExp(`ALONG_SHA=${newAlong}`));
    assert.match(state,new RegExp(`SUPERAGENT_SHA=${newSa}`));

    // **镜像里的内容必须与台账记的提交对应**：内容对不上就是旧内容进了镜像。
    const marker=spawnSync('docker',['run','--rm','--entrypoint','sh',`${IMAGE_TAG}-host`,
      '-c','cat /www/health'],{encoding:'utf8',timeout:120_000});
    assert.equal(marker.status,0);
    assert.equal(marker.stdout.trim(),'ok-v2','Host 镜像里应是新提交的内容');
    const prompt=spawnSync('docker',['run','--rm','--entrypoint','sh',`${IMAGE_TAG}-superagent`,
      '-c','cat /prompts/worker.md'],{encoding:'utf8',timeout:120_000});
    assert.equal(prompt.status,0);
    assert.equal(prompt.stdout.trim(),'worker-v2','Super Agent 镜像里应是新提交的 bundle');
  });

  await t.test('解包失败不污染同 SHA 的下一轮', () => {
    // 先推一个上游改动，让本轮真的走到解包那一步（否则会直接判定无更新而跳过）。
    commitUpstream({alongContent:'ok-v3\n'});
    // 让 tar 在解包时失败：把 tar 换成会失败的桩。
    const stub=join(BASE,'bin','tar');
    mkdirSync(join(BASE,'bin'),{recursive:true});
    writeFileSync(stub,'#!/bin/sh\nexit 74\n');
    chmodSync(stub,0o755);
    const result=deploy(deployEnv({PATH:`${join(BASE,'bin')}:${process.env.PATH}`}));
    assert.notEqual(result.status,0,'解包失败时本轮应当失败');
    // 关键：失败轮次不能把"半个发布目录"当成可用的发布目录记下来。
    const listing=spawnSync('bash',['-c',
      `ls -1 ${join(BASE,'release')} 2>/dev/null | grep -v '^\\.' | while read -r d; do
         [ -f "${join(BASE,'release')}/$d/manifest.env" ] && echo "$d"; done`],
      {encoding:'utf8',timeout:60_000});
    for (const dir of (listing.stdout||'').split('\n').filter(Boolean)) {
      assert.ok(existsSync(join(BASE,'release',dir,'along')),
        `发布目录 ${dir} 缺 along 源码：解包失败不能留下半成品`);
      assert.ok(existsSync(join(BASE,'release',dir,'along-superagent')),
        `发布目录 ${dir} 缺 along-superagent 源码`);
    }
    // tar 恢复正常后，同一个 SHA 必须能重新构建成功。
    rmSync(stub);
    const retry=deploy(deployEnv());
    assert.equal(retry.status,0,`恢复后应当能重试成功：\n${retry.stderr}`);
  });

  await t.test('compose up 部分失败时回退到上一成功版本', () => {
    // 制造"锚点与 Super Agent 已重建、Host 容器没起来、up 返回非零"：
    // 用 docker 桩——第一次 up 只重建锚点与 Super Agent，然后返回 1。
    const stubDir=join(BASE,'bin');
    const realDocker=spawnSync('bash',['-c','command -v docker'],{encoding:'utf8'}).stdout.trim();
    mkdirSync(stubDir,{recursive:true});
    writeFileSync(join(stubDir,'docker'),[
      '#!/bin/bash',
      `REAL="${realDocker}"`,
      'for a in "$@"; do',
      '  if [ "$a" = "up" ]; then',
      `    if [ -f "${join(BASE,'fail-up')}" ] && [ ! -f "${join(BASE,'.up-failed-once')}" ]; then`,
      `      touch "${join(BASE,'.up-failed-once')}"`,
      '      args=(); for x in "$@"; do [ "$x" = "up" ] || args+=("$x"); done',
      '      "$REAL" "${args[@]}" up -d --no-build --force-recreate anchor superagent >/dev/null 2>&1',
      '      echo "stub: compose up 部分成功（Host 未创建），返回 1" >&2',
      '      exit 1',
      '    fi',
      '  fi',
      'done',
      'exec "$REAL" "$@"',
      '',
    ].join('\n'));
    chmodSync(join(stubDir,'docker'),0o755);
    // 推一个上游改动，让本轮进入"有更新"的分支。
    commitUpstream({alongContent:'ok-v4\n'});
    writeFileSync(join(BASE,'fail-up'),'');

    const result=deploy(deployEnv({PATH:`${stubDir}:${process.env.PATH}`}));
    assert.notEqual(result.status,0,'Host 容器创建失败时本轮应当失败');
    assert.match(result.stderr,/ROLLBACK/,'失败必须触发回退');
    // 回退后线上仍是上一成功版本：成功记录不能推进。
    const state=readState();
    assert.match(state,/ALONG_SHA=/,'成功记录必须仍然存在');
    assert.doesNotMatch(state,/ALONG_SHA=.*v3/);
    // 回退之后入口恢复。
    const probe=spawnSync('bash',['-c',
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${HOST_PORT}/health`],
      {encoding:'utf8',timeout:60_000});
    assert.equal(probe.stdout.trim(),'200','回退后入口必须恢复');
    rmSync(join(stubDir,'docker'),{force:true});
  });
});
