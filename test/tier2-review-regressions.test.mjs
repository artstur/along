import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseDocument} from 'yaml';
import {lockdownRows,verifyEffectiveConfig} from '../deploy/superagent-preset-lockdown.mjs';

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
const services=composeDoc.services;
const superagent=services.superagent;
const tier2=composeTier2Doc;

// ---- P1-1：双用户读取权限（文件与 shell 的读取面整体收紧）--------------------------

const configParser={yaml:{load:JSON.parse}};
const preset=(id,plugins=[])=>({
  id:`preset-${id}`,name:'@deepseek-ai/dsh-agent-preset',config:{id,plugins},
});
const registry={id:'agent-preset-registry',name:'@deepseek-ai/dsh-agent-preset-registry',
  config:{default:'dsh-superagent-worker'}};
const todo={id:'todo',name:'@deepseek-ai/dsh-tool-todo'};
const group=(...config)=>({id:'group',name:'cordis:group',config});
const worker=(plugins)=>preset('dsh-superagent-worker',plugins);
const router=preset('dsh-superagent-router',[todo]);

test('Tier 2 narrows the effective presets even when the change is inside one group', t=>{
  const fixture=mkdtempSync(join(tmpdir(),'along-lockdown-'));
  t.after(()=>rmSync(fixture,{recursive:true,force:true}));
  const presetsDir=join(fixture,'node_modules','@deepseek-ai','dsh-web-app','presets');
  mkdirSync(presetsDir,{recursive:true});
  const shell={id:'shell',name:'@deepseek-ai/dsh-tool-bash'};
  writeFileSync(join(fixture,'cordis.patch.yml'),JSON.stringify([{insert:[worker([group(todo,shell)]),router]}]));
  writeFileSync(join(presetsDir,'standard.patch.yml'),JSON.stringify([{insert:[preset('standard',[todo])]}]));
  const rows=lockdownRows(configParser,fixture,fixture);
  assert.deepEqual(rows.find(row=>row.id==='preset-dsh-superagent-worker').config.plugins,[group(todo)]);
  assert.equal(rows.find(row=>row.id==='preset-standard').disabled,true);
});

test('Tier 2 rejects incomplete scopes, unreviewed plugins and an incorrect default at boot',()=>{
  const verify=(...rows)=>verifyEffectiveConfig(configParser,JSON.stringify(rows));
  const allowed=worker([todo]);
  const standard=preset('standard',[todo]);
  assert.deepEqual(verify(registry,allowed,router,{...standard,disabled:true}),[]);
  assert.match(verify(registry,allowed).join(),/缺少启用的 preset.*router/);
  assert.match(verify().join(),/唯一启用的 preset 注册表/);
  assert.match(verify({...registry,config:{default:'standard'}},allowed,router).join(),/默认 preset/);
  assert.match(verify(registry,allowed,router,group(standard)).join(),/未知、无效或重复的 preset/);
  assert.match(verify(registry,worker([group(todo,{id:'unknown',name:'fixture:unknown'})]),router).join(),/不在白名单内/);
  assert.match(verify(registry,allowed,router,{id:'workflow',name:'@deepseek-ai/dsh-workflow-ptc'}).join(),/不在白名单内/);
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

test('P1-3：运维命令一次重建锚点与两个依赖方',()=>{
  for (const name of ['host','superagent']) {
    const depends=tier2.services[name].depends_on;
    assert.ok(depends?.netns,'必须声明对锚点的依赖');
  }
  const stackScript=readFileSync(join(DEPLOY_DIR,'tier2-stack.sh'),'utf8');
  assert.match(stackScript,/compose up -d --force-recreate netns host superagent/);
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
  // 第二轮复核：标签也要带进程号——标签是全局的，两个并发用例共用一个标签时，
  // `up --build` 会把另一个用例正在用的镜像覆盖掉。
  assert.ok(/along-tier2-test-\$\{process\.pid\}/.test(integration),'镜像标签必须带进程号（并发用例不共用标签）');
  // 端口也不能与部署撞：部署用 443，测试用高位端口。
  assert.ok(!/443:4176/.test(integration),'测试不得占用部署的 443 端口');
  // 第二轮复核：端口按运行随机化——固定端口意味着两个并发用例撞端口，
  // 后起的那个 `up` 直接失败（port is already allocated），那是噪声不是被测行为。
  assert.match(integration,/127\.0\.0\.1::4176/,'Docker 为每个测试栈分配端口');
  // 第二轮复核：目录按运行随机化——固定目录意味着两个并发用例共用同一份状态目录，
  // 而用例开头会清掉它（后一个把前一个的业务库与证书删了）。
  assert.match(integration,/join\(ROOT,'\.tier2-integration',PROJECT\)/,'状态目录必须按运行隔离');
});

test('P2-6：测试覆盖**构建标签**，不更新部署的镜像标签',()=>{
  const integration=readFileSync(join(ROOT,'test','tier2-linux-integration.test.mjs'),'utf8');
  // 第二轮复核的缺口：主 compose 的 host 服务带 `build: {tags: [along-host:local]}`。
  // 叠加文件只改 `image:` 是不够的——`up --build` 按 build 段的 tags **重新打标签**，
  // 于是测试的构建会更新部署正在用的 along-host:local 标签：
  // 部署的容器还在跑（跑的是旧镜像层），但它下次重建就会拿到测试的镜像。
  assert.ok(/tags: !override/.test(integration),'必须用 !override 覆盖 build.tags');
  // 注意 !override 要加在 **tags 键**上：加在 build: 上只是追加（序列默认合并），
  // 那样部署的标签还在，up --build 照样更新它。
  assert.ok(/tags: !override \["\$\{IMAGE_TAG\}-host"\]/.test(integration),'host 的 build.tags 必须被替换');
  assert.ok(/tags: !override \["\$\{IMAGE_TAG\}-superagent"\]/.test(integration),'superagent 的 build.tags 必须被替换');
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
