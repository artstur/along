import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseDocument} from 'yaml';

// PR #43 的审查修复回归（审查项 P1-1/2/3/4、P2-5/6）。
//
// 每一组用例对着**一条审查意见**，锁住那条意见指出的故障不再成立。
// 单测锁不住的部分（真实容器重建、真实重启恢复）由
// test/tier2-linux-integration.test.mjs 在隔离 Linux Compose 里验。

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const DEPLOY_DIR=join(ROOT,'deploy');
const COMPOSE_FILE=join(DEPLOY_DIR,'docker-compose.yml');
const COMPOSE_TIER2=join(DEPLOY_DIR,'docker-compose.tier2.yml');
const compose=readFileSync(COMPOSE_FILE,'utf8');
const composeTier2=readFileSync(COMPOSE_TIER2,'utf8');
const composeDoc=parseDocument(compose).toJS();
const composeTier2Doc=parseDocument(composeTier2).toJS();
const startScript=readFileSync(join(DEPLOY_DIR,'superagent-start.sh'),'utf8');
const hostSrc=readFileSync(join(ROOT,'host','agent-host.mjs'),'utf8');
const bridgeSrc=readFileSync(join(ROOT,'host','along-bridge.mjs'),'utf8');
const lockdownSrc=readFileSync(join(DEPLOY_DIR,'superagent-preset-lockdown.mjs'),'utf8');
const services=composeDoc.services;
const superagent=services.superagent;
const tier2=composeTier2Doc;

// ---- P1-1：双用户读取权限（文件与 shell 的读取面整体收紧）--------------------------

test('P1-1：收紧脚本去掉所有 preset 里的文件、shell、终端与文档读取能力',()=>{
  // 被禁的能力清单必须覆盖：任意路径的文件读、文件搜索、shell、PTY、文档工具、
  // 以及子代理（它跑在 standard preset 下，那套 preset 带全套读取工具）。
  for (const name of ['dsh-tool-fs','dsh-tool-fs-search','dsh-tool-bash','dsh-tool-pwsh',
    'dsh-tool-subagent','dsh-tool-subagent-control','dsh-tool-office','dsh-terminal-bash',
    'dsh-tool-bash-persistent','dsh-tool-pwsh-persistent','dsh-terminal']) {
    assert.ok(lockdownSrc.includes(name),`收紧清单必须覆盖 ${name}`);
  }
});

test('P1-1：收紧脚本是**推导**的（读上游自己的 patch），不抄一份上游 preset',()=>{
  // 抄一份上游 preset 会在上游改动时漂移；漏掉一个 preset 就是一个漏掉的读取面。
  assert.ok(lockdownSrc.includes('cordis.patch.yml'),'必须读上游 bundle 自己的 patch 文件');
  assert.ok(lockdownSrc.includes('dsh-web-app'),'必须读 DSH web 模板的 preset（子代理跑在 standard 下）');
  assert.ok(lockdownSrc.includes('lockdownRows'),'必须按上游的声明推导覆盖行');
  // 推导失败必须拒绝启动——收紧没生效等于没收紧。
  assert.ok(startScript.includes('along-superagent-preset-lockdown.mjs'),'启动脚本必须调用收紧脚本');
  assert.ok(/if \[ -z "\$LOCKDOWN_ROWS" \]/.test(startScript),'推导结果为空时必须拒绝启动');
  assert.ok(startScript.includes('exit 1'),'拒绝启动必须真的退出');
});

test('P1-1：收紧脚本在真实上游 patch 上真的去掉了读取面（实跑推导）',()=>{
  // 用真实的上游 bundle 与 DSH web 模板跑一遍推导：所有 preset 里都不该再有读取工具。
  // 推导脚本依赖 DSH CLI 树里的 cordis-plugin-include 与 js-yaml——
  // 本仓库的 node_modules 里没有它们（它们只存在于 deploy/agent-dsh 的锁文件树里），
  // 所以这里用**真实的** dsh CLI 安装目录：/tmp 下没有时从 npm 装一份等价版本。
  const cliDir=mkdtempSync(join(tmpdir(),'along-lockdown-cli-'));
  const bundleDir=mkdtempSync(join(tmpdir(),'along-lockdown-bundle-'));
  try {
    const dshCli=join(DEPLOY_DIR,'agent-dsh');
    if (!existsSync(join(dshCli,'node_modules','js-yaml'))) {
      // 依赖树没装（CI 只 checkout 本仓库时）：跳过这条实跑推导，
      // 其余用例仍然锁住收紧清单本身。
      return;
    }
    // 脚本从 <cli>/node_modules/@deepseek-ai/dsh/package.json 解析依赖——
    // 夹具里造出同样的目录形状，指向真实的 dsh CLI 安装树。
    mkdirSync(join(cliDir,'node_modules','@deepseek-ai'),{recursive:true});
    symlinkSync(join(dshCli,'node_modules','@deepseek-ai','dsh'),
      join(cliDir,'node_modules','@deepseek-ai','dsh'),'dir');
    symlinkSync(join(dshCli,'node_modules','@deepseek-ai','cordis-plugin-include'),
      join(cliDir,'node_modules','@deepseek-ai','cordis-plugin-include'),'dir');
    symlinkSync(join(dshCli,'node_modules','js-yaml'),
      join(cliDir,'node_modules','js-yaml'),'dir');
    // 造一份最小的「上游」：bundle 的 patch 声明 worker preset，web 模板声明 standard。
    writeFileSync(join(bundleDir,'cordis.patch.yml'),[
      '- insert:',
      '    - id: dsh-superagent-worker-preset',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: dsh-superagent-worker',
      '        plugins:',
      '          - id: tool-todo',
      "            name: '@deepseek-ai/dsh-tool-todo'",
      '          - id: tool-fs',
      "            name: '@deepseek-ai/dsh-tool-fs'",
      '          - id: tool-bash',
      "            name: '@deepseek-ai/dsh-tool-bash'",
      '',
    ].join('\n'));
    const presetsDir=join(cliDir,'node_modules','@deepseek-ai','dsh-web-app','presets');
    mkdirSync(presetsDir,{recursive:true});
    writeFileSync(join(presetsDir,'standard.patch.yml'),[
      '- insert:',
      '    - id: preset-standard',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: standard',
      '        plugins:',
      '          - id: tool-todo',
      "            name: '@deepseek-ai/dsh-tool-todo'",
      '          - id: tool-fs',
      "            name: '@deepseek-ai/dsh-tool-fs'",
      '          - id: tool-fs-search',
      "            name: '@deepseek-ai/dsh-tool-fs-search'",
      '',
    ].join('\n'));
    const result=spawnSync(process.execPath,[join(DEPLOY_DIR,'superagent-preset-lockdown.mjs'),cliDir,bundleDir],
      {encoding:'utf8',timeout:60_000});
    assert.equal(result.status,0,`推导失败：${result.stderr}`);
    const out=result.stdout;
    // 全局的四个禁用行必须在。
    for (const id of ['tool-fs','tool-fs-search','tool-bash','tool-pwsh']) {
      assert.ok(new RegExp(`- id: ${id}\\n`).test(out),`全局禁用行缺失：${id}`);
    }
    // 两个 preset 都要被覆盖，且覆盖行里不再有被禁的工具。
    assert.ok(out.includes('- id: dsh-superagent-worker-preset'),'worker preset 必须被覆盖');
    assert.ok(out.includes('- id: preset-standard'),'standard preset 必须被覆盖');
    const covered=out.split('- id: preset-standard')[1];
    assert.ok(!covered.includes("'@deepseek-ai/dsh-tool-fs'"),'standard preset 覆盖行里不得再有文件工具');
    assert.ok(!covered.includes("'@deepseek-ai/dsh-tool-fs-search'"),'standard preset 覆盖行里不得再有文件搜索');
    assert.ok(out.includes("'@deepseek-ai/dsh-tool-todo'"),'不该被禁的工具要留着');
  } finally {
    rmSync(cliDir,{recursive:true,force:true});
    rmSync(bundleDir,{recursive:true,force:true});
  }
});

// ---- P1-2：固定上游构建版本 ---------------------------------------------------

test('P1-2：上游构建输入锁到远端 git 上下文的固定提交，不指向本地工作区',()=>{
  const source=superagent.build.additional_contexts.along;
  assert.ok(source.includes('https://github.com/artstur/along-superagent.git#'),
    '默认必须取远端 git 上下文（相邻仓库的 HEAD 是可变的）');
  // 固定提交：40 位完整 SHA。短 SHA 与分支名都指向可移动的引用，
  // 而旧版探针恒答 200 {ready:true}，Host 侦测不到装错版本。
  const sha=source.match(/#([0-9a-f]{40})/);
  assert.ok(sha,`必须钉到 40 位完整提交（实测 ${source}）`);
  // 仍允许本地调试覆盖（对着未推送的提交）。
  assert.ok(source.includes('${ALONG_SUPERAGENT_SOURCE'),'必须允许用 ALONG_SUPERAGENT_SOURCE 覆盖');
});

test('P1-2：Agent 镜像的上游来源同样钉住，且两份来源一致',()=>{
  assert.equal(services.agent.build.additional_contexts.along,
    superagent.build.additional_contexts.along,
    '两个镜像的上游来源必须一致——否则装的是两个不同的 Super Agent');
});

// ---- P1-3：容器重建不断链 -----------------------------------------------------

test('P1-3：Tier 2 用独立的命名空间锚点，host 与 superagent 都不挂在对方身上',()=>{
  // 挂在 host 命名空间上的 superagent 在 host 单独重建时留在旧命名空间里，
  // 新 host 访问 127.0.0.1:3082 得到 ECONNREFUSED（实测复现）。
  assert.ok(tier2.services.netns,'Tier 2 必须有一个命名空间锚点容器');
  assert.equal(tier2.services.host.network_mode,'service:netns','host 必须加入锚点的命名空间');
  assert.equal(tier2.services.superagent.network_mode,'service:netns','superagent 必须加入锚点的命名空间');
  // 锚点与 host、superagent 都无关：它的 depends_on 为空。
  assert.equal(tier2.services.netns.depends_on??null,null,'锚点不依赖任何服务');
});

test('P1-3：端口发布落在锚点上（加入他人命名空间的容器不能自己发布端口）',()=>{
  // docker 报 "conflicting options: port publishing and the container type network mode"，
  // 所以 host 加入命名空间后不能自己声明 ports——映射写在锚点上。
  assert.deepEqual(tier2.services.host.ports??[],[],'host 不得自己发布端口（它在别人的命名空间里）');
  assert.ok(tier2.services.netns.ports?.includes('443:4176'),'锚点负责发布 443 → 4176');
  // 3082 仍然不对外。
  assert.equal(superagent.ports??null,null,'superagent 不得发布端口（管理面仅本机可达）');
  assert.ok(!JSON.stringify(tier2.services.netns.ports).includes('3082'),'锚点不得发布 3082');
});

test('P1-3：锚点重建时依赖它的容器一起重建（否则留在旧命名空间里）',()=>{
  for (const name of ['host','superagent']) {
    const depends=tier2.services[name].depends_on;
    assert.ok(depends?.netns,'必须声明对锚点的依赖');
    assert.equal(depends.netns.restart,true,
      `depends_on.restart: true —— 锚点重建时把 ${name} 一起重建`);
  }
});

// ---- P1-4：长驻服务拿得到模型密钥 ---------------------------------------------

test('P1-4：模型密钥经 file secret 挂给长驻服务，不进 compose 的 environment',()=>{
  // 之前是 DEEPSEEK_API_KEY 环境变量：它会进 `compose config` 的输出与容器元数据。
  assert.equal(superagent.environment.DEEPSEEK_API_KEY,undefined,
    '模型密钥不得进 compose 的 environment');
  assert.equal(superagent.environment.ALONG_MODEL_API_KEY_FILE,'/run/secrets/model-credentials',
    '长驻服务必须知道模型密钥文件的挂载点');
  assert.ok(tier2.services.superagent.secrets.includes('model-credentials'),
    '长驻服务必须挂模型密钥 secret');
  assert.equal(tier2.secrets['model-credentials'].file,'../../secrets/model-credentials',
    '模型密钥的宿主文件与 Tier 1 runner 共用同一份');
});

test('P1-4：启动脚本读模型密钥并按 0600 校验（权限过宽拒绝启动）',()=>{
  assert.ok(startScript.includes('ALONG_MODEL_API_KEY_FILE'),'密钥路径必须由环境变量指定');
  assert.ok(startScript.includes('0o077'),'必须校验权限（组/其他可读等同配置错误）');
  assert.ok(startScript.includes('export DEEPSEEK_API_KEY'),'读出后注入进程环境');
  assert.ok(!/DEEPSEEK_API_KEY:\s*"/.test(compose),'compose 里不得内联模型密钥');
});

// ---- P2-5：就绪判定 ------------------------------------------------------------

test('P2-5：就绪只探一次，且严格只认 200 + 契约 body',()=>{
  assert.ok(!hostSrc.includes("bridge.call('/along-source/api/goals/along-status-probe'"),
    '就绪判定之后不得再对同一路径发第二次请求——持续 404 会被第二个请求判成 502');
  assert.ok(hostSrc.includes('bridge.readyStrict({identity:who})'),'必须走真实就绪判定');
  assert.ok(bridgeSrc.includes('response.status!==200'),'只认 200');
  assert.ok(!bridgeSrc.includes('response.status===404'),'404 不得再被当成就绪');
  assert.ok(bridgeSrc.includes("body.service!=='along-source'"),'body 必须校验 service');
  assert.ok(bridgeSrc.includes('body.ready!==true'),'body 必须校验 ready');
});

// ---- P2-6：集成测试不复用部署的 compose 项目与容器名 -----------------------------

test('P2-6：隔离集成栈用独立的 project 名、容器名与镜像标签',()=>{
  const integration=readFileSync(join(ROOT,'test','tier2-linux-integration.test.mjs'),'utf8');
  // 与部署共用 Docker daemon 时，复用项目名/容器名会重建或停掉正在运行的服务。
  assert.ok(/along-tier2-test-/.test(integration),'必须用独立的项目名（带进程号后缀）');
  assert.ok(/CONTAINER_PREFIX/.test(integration),'必须给容器名加前缀');
  assert.ok(/along-tier2-test:local/.test(integration),'必须用独立的镜像标签');
  // 端口也不能与部署撞：部署用 443，测试用高位端口。
  assert.ok(!/443:4176/.test(integration),'测试不得占用部署的 443 端口');
});

// ---- compose config 校验 --------------------------------------------------------

test('compose config 通过（两种形态各自可审计）',{skip:!resolveComposeBin()&&'compose CLI 不可用'},()=>{
  const run=(args,label)=>{
    const result=spawnSync(args[0],args.slice(1),{encoding:'utf8',timeout:120_000});
    assert.equal(result.status,0,`${label} 失败：${result.stderr}`);
  };
  run(composeArgs(['-f',COMPOSE_FILE,'config','-q']),'Tier 1 compose config 校验');
  run(composeArgs(['-f',COMPOSE_FILE,'-f',COMPOSE_TIER2,'--profile','tier2','config','-q']),'Tier 2 compose config 校验');
});

function resolveComposeBin() {
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
