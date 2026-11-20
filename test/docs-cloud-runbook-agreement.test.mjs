import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {failLimitFromEnv, stateDir} from '../host/pairing.mjs';

// M7 文档、决策与 Runbook 终稿（docs/cloud-deploy-multi-user.md §4-M7、§2.3、§6.4 定稿）的配对测试。
// 覆盖面（按 §4-M7 目标与 §2.3 三处调研/文档与代码不符的文案修正）：
// - AGENTS.md §4：状态目录三形态口径（修正 2）+ 云端部署形态条目（2 静态用户、Mac 回退、无模式开关）；
// - AGENTS.md §5：红线新措辞「凭证只留在服务端安全存储」（修正 1，SD-6），逐条断言实质约束完整保留
//   （凭证枚举 Kimi/模型/桥接/APNs/runner、绝不发 iPhone 或网页、不写运行结果和日志、
//   配对 token 只存哈希/只在配对响应出现一次/不复用为服务端内部凭证），旧措辞不再出现，
//   其余红线（校验只能加严）未被弱化；
// - README 配置段：状态目录三形态 + M1–M4 新增变量登记，默认值与实现核对
//   （ALONG_PAIR_FAIL_LIMIT/ALONG_AGENT_STATE_DIR 行为级断言，ALONG_TLS_*/ALONG_DSH_RUNNER_URL/
//   ALONG_RUNNER_TOKEN_FILE 与 host/agent-host.mjs 源码核对）；
// - README 隐私表：「凭证只留服务端」「部署面收敛（云端仅 443 + 配对码全局失败限速）」
//   「证书钉扎（本地 30 天/云端 3650 天自签）」与连接凭证哈希段落的 pairings.json 每用户一条
//   多绑定口径（旧 pairing.json 单文件路径移除）；
// - docs/README.md：云端部署索引条目与阅读边界（上线按 Runbook §6.4 由用户手动执行）；
// - 本设计文档 Runbook 定稿：§6.4 定稿说明、dsh 调用形态与 deploy/agent-runner.mjs 的 spawn 一致
//   （设计期 `--profile headless` 仅以废弃说明出现）、冒烟期望（横幅/指纹/到期时间/多用户不打码）
//   与 host/agent-host.mjs 启动横幅实现一致、§6.1 风险行同口径、§4-M7 施工记录（SD-6）；
// - 修正 3（「全局单飞锁阻塞整个 host」不准确）：AGENTS.md/README/docs/README.md 无该表述
//   （设计文档 §2.3 判定无落点），由设计文档 §2.1「以代码为准」承载——两边都断言；
// - along-superagent 决策记录：追加 D19（扩展 D1、不是推翻、user_id 归属检查原样保留），
//   D1 原条目未被改写（不含云端内容）。
// 断言全部用子串/行为核对（includes 与实现函数），不用长正则字面量：文档断言以逐字口径为准。
// 不在本测试断言、需要真实 Docker/真机的部分：compose up 后横幅实读（test/deploy-orchestration.test.mjs
// 与 Runbook §6.4 第 5 步手动执行覆盖）、真机端到端（验收 #7）。

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const read=(...p)=>readFileSync(join(ROOT,...p),'utf8');
const agents=read('AGENTS.md');
const readme=read('README.md');
const docsIndex=read('docs','README.md');
const design=read('docs','cloud-deploy-multi-user.md');
const hostSrc=read('host','agent-host.mjs');
const ADJACENT=resolve(ROOT,'../along-superagent');
const decisionsFile=join(ADJACENT,'docs','along','000-decisions.md');

// 按标题切片；to 标题缺失时取到文末。
function section(text,start,end) {
  const from=text.indexOf(start);
  assert.ok(from>=0,`缺少段落标题 ${start}`);
  const to=end===undefined?text.length:text.indexOf(end,from);
  return to<0?text.slice(from):text.slice(from,to);
}

const s4=section(agents,'## 4. 运行时','## 5. 红线');
const s5=section(agents,'## 5. 红线');
const readmeConfig=section(readme,'## 配置','## 隐私与安全');
const readmePrivacy=section(readme,'## 隐私与安全','## 项目结构');
const runbook=section(design,'### 6.4 上线 Runbook','## 7. 方案内决策记录');
const risks=section(design,'### 6.1 风险清单','### 6.2');
const m7=section(design,'### M7 文档、决策与 Runbook 终稿','## 5. 验收标准');

test('AGENTS.md §4：状态目录三形态与云端部署条目（§2.3 修正 2）',()=>{
  // 三形态口径：直接 agent-host 默认 / activate / 云端挂载卷，与设计文档 §2.3-2 的可执行口径一致。
  assert.ok(s4.includes('状态目录由 `ALONG_AGENT_STATE_DIR` 决定，默认 `~/.along/agent-host/`（直接 `npm run agent-host`）；`npm run activate` 用 `~/.along/phone-test/`；云端部署用挂载卷（`/opt/along/data/host`）'),'§4 状态目录三形态口径不符');
  assert.ok(s4.includes('环境变量见 `README.md` 与 `deploy/env.example`'),'§4 环境变量指引缺失');
  // 云端部署形态条目：指向设计文档、Mac 回退保留、无模式开关。
  assert.ok(s4.includes('云端部署形态（一台云主机 + Docker Compose、2 个静态用户、每用户一次性配对码）的设计、决策与上线 Runbook 见 `docs/cloud-deploy-multi-user.md`'),'§4 云端部署条目缺失或口径不符');
  assert.ok(s4.includes('Mac 本地模式完全保留且行为不变，作为回退路径'),'§4 Mac 回退口径缺失');
  assert.ok(s4.includes('云端与本地共用同一套源码，不新增模式开关'),'§4 无模式开关口径缺失');
  // 旧措辞（只写一种本地状态目录）已移除。
  assert.ok(!s4.includes('Mac 本地状态存在 `~/.along/agent-host/`，环境变量见 `README.md`。'),'§4 旧状态目录措辞残留');
});

test('AGENTS.md §5：红线新措辞实质约束完整、旧措辞移除（§2.3 修正 1，SD-6）',()=>{
  // 新措辞逐条断言（SD-6 要求完整保留实质约束并加严）。
  assert.ok(s5.includes('凭证只留在服务端安全存储（Mac 或云主机的卷/secrets/env）：Kimi、模型、桥接、APNs、runner 等凭证绝不发给 iPhone 或网页，也不写进运行结果和日志；配对 token 服务端只存哈希、只在配对响应里出现一次，不复用为服务端内部凭证。'),'§5 新措辞与拍板口径不一致');
  // 旧措辞 distinctive 片段不再出现（含 README 同步检查）。
  for (const [name,text] of [['AGENTS.md',agents],['README.md',readme]]) {
    assert.ok(!text.includes('Token 只留在 Mac'),`${name} 旧措辞「Token 只留在 Mac」残留`);
    assert.ok(!text.includes('Token 留在 Mac'),`${name} 旧措辞「Token 留在 Mac」残留`);
    assert.ok(!text.includes('Kimi token 和配对 token'),`${name} 旧措辞「Kimi token 和配对 token」残留`);
  }
  // 其余红线未被弱化：校验链与「校验只能加严」原样保留。
  assert.ok(s5.includes('validateGoalReply'),'§5 校验链红线缺失');
  assert.ok(s5.includes('safeAdaptiveLayout'),'§5 布局校验红线缺失');
  assert.ok(s5.includes('校验只能加严，不能为了让结果通过而放宽'),'§5 校验加严红线被弱化');
});

test('README 配置段：状态目录三形态与 M1–M4 新增变量登记',()=>{
  assert.ok(readmeConfig.includes('`~/.along/agent-host/`'),'配置段缺 agent-host 状态目录');
  assert.ok(readmeConfig.includes('`~/.along/phone-test/`'),'配置段缺 phone-test 状态目录');
  assert.ok(readmeConfig.includes('`/opt/along/data/host`'),'配置段缺云端挂载卷状态目录');
  assert.ok(readmeConfig.includes('`deploy/env.example`'),'配置段缺 env.example 指引');
  assert.ok(readmeConfig.includes('[云端部署与多用户](docs/cloud-deploy-multi-user.md)'),'配置段缺云端部署文档链接');
  for (const name of ['ALONG_AGENT_STATE_DIR','ALONG_TLS_DAYS','ALONG_TLS_CN','ALONG_DSH_RUNNER_URL','ALONG_RUNNER_TOKEN_FILE','ALONG_PAIR_FAIL_LIMIT']) {
    assert.ok(readmeConfig.includes(`\`${name}\``),`配置表缺少 ${name}`);
  }
  // 各新变量的默认值/语义口径（与实现核对见下面两个测试）。
  assert.ok(readmeConfig.includes('`30` / `Along Local Agent`'),'TLS 默认值口径不符');
  assert.ok(readmeConfig.includes('`3650` + 域名'),'云端 TLS 口径缺失');
  assert.ok(readmeConfig.includes('未设置走 Mac 本地 bridge'),'runner 分流默认口径不符');
  assert.ok(readmeConfig.includes('缺失拒绝启动'),'runner-token 缺失语义不符');
  assert.ok(readmeConfig.includes('满窗时停止验码，可将上限调低'),'配对失败限额口径不符');
});

test('README 默认值与实现行为一致：failLimitFromEnv 与 stateDir',()=>{
  // README「只许调严，更大的值一律按 10 处理」（host/pairing.mjs:26-28）。
  assert.equal(failLimitFromEnv({}),10);
  assert.equal(failLimitFromEnv({ALONG_PAIR_FAIL_LIMIT:'1'}),1);
  assert.equal(failLimitFromEnv({ALONG_PAIR_FAIL_LIMIT:'7'}),7);
  assert.equal(failLimitFromEnv({ALONG_PAIR_FAIL_LIMIT:'11'}),10,'更大的值必须按 10 处理');
  assert.equal(failLimitFromEnv({ALONG_PAIR_FAIL_LIMIT:'0'}),10,'非正数必须回落默认');
  assert.equal(failLimitFromEnv({ALONG_PAIR_FAIL_LIMIT:'abc'}),10,'非整数必须回落默认');
  // README「ALONG_AGENT_STATE_DIR 默认 ~/.along/agent-host」（host/pairing.mjs:22）。
  const saved=process.env.ALONG_AGENT_STATE_DIR;
  try {
    delete process.env.ALONG_AGENT_STATE_DIR;
    assert.equal(stateDir(),join(homedir(),'.along','agent-host'));
    process.env.ALONG_AGENT_STATE_DIR='/along-test/state-dir';
    assert.equal(stateDir(),'/along-test/state-dir');
  } finally {
    if (saved===undefined) delete process.env.ALONG_AGENT_STATE_DIR;
    else process.env.ALONG_AGENT_STATE_DIR=saved;
  }
});

test('README 默认值与实现源码一致：TLS 与 runner 分流（host/agent-host.mjs）',()=>{
  // ALONG_TLS_DAYS 默认 30（非正整数回落）、ALONG_TLS_CN 默认 Along Local Agent（:43-44）。
  assert.ok(hostSrc.includes('Number.isInteger(value)&&value>=1?value:30'),'TLS_DAYS 默认 30 回落实现不符');
  assert.ok(hostSrc.includes("process.env.ALONG_TLS_CN||'Along Local Agent'"),'TLS_CN 默认值不符');
  // ALONG_DSH_RUNNER_URL 未设置走 bridge（:82）、设置了就必须配 runner-token 否则拒绝启动（:83-84）。
  assert.ok(hostSrc.includes("process.env.ALONG_DSH_RUNNER_URL||''"),'DSH runner URL 缺省实现不符');
  assert.ok(hostSrc.includes('if (dshRunnerURL&&!dshRunnerToken) throw Error'),'runner-token 缺失拒绝启动实现不符');
});

test('README 隐私表按云端形态改写（§2.3 修正 1 落点）',()=>{
  assert.ok(readmePrivacy.includes('凭证只留服务端'),'缺少「凭证只留服务端」行');
  assert.ok(readmePrivacy.includes('Kimi、模型、桥接、APNs 凭证只保存在服务端安全存储（Mac 或云主机的卷/secrets/env），绝不发给 iPhone 或网页，也不写进运行结果和日志'),'隐私表凭证行口径不符');
  assert.ok(readmePrivacy.includes('配对 token 只在配对响应出现一次，服务端只存哈希'),'隐私表配对 token 口径不符');
  // 部署面收敛：云端仅 443 + 配对码全局失败限速。
  assert.ok(readmePrivacy.includes('部署面收敛'),'缺少「部署面收敛」行');
  assert.ok(readmePrivacy.includes('只开放 443 一个端口'),'隐私表云端端口口径缺失');
  assert.ok(readmePrivacy.includes('全局失败限速'),'隐私表配对码限速口径缺失');
  // 证书钉扎：本地 30 天 / 云端 3650 天自签。
  assert.ok(readmePrivacy.includes('本地 30 天自签；云端 3650 天自签、CN=域名'),'证书钉扎两形态口径不符');
  // 连接凭证哈希段落改为 pairings.json 每用户一条的多绑定口径；旧单文件路径移除。
  // includes 安全性：'pairings.json' 不含子串 'pairing.json'（pairing 后是 s 不是 .）。
  assert.ok(readmePrivacy.includes('`pairings.json`'),'缺 pairings.json 多绑定口径');
  assert.ok(readmePrivacy.includes('每用户一条'),'缺每用户一条口径');
  assert.ok(!readmePrivacy.includes('pairing.json'),'旧单文件 pairing.json 路径残留');
});

test('docs/README.md：云端部署索引条目与阅读边界',()=>{
  assert.ok(docsIndex.includes('[云端部署与多用户](cloud-deploy-multi-user.md)'),'索引缺云端部署条目');
  assert.ok(docsIndex.includes('云端部署与 2 用户（host/agent 上云、配对多绑定、Runbook）'),'索引条目描述不符');
  // 阅读边界写准：上线不由文档自动执行。
  assert.ok(docsIndex.includes('设计与施工记录；上线按 Runbook §6.4 由用户手动执行'),'阅读边界口径不符');
});

test('Runbook 指向经过认证的 runner 冒烟并复用现有发码命令',()=>{
  assert.ok(runbook.includes('2026-11-20 定稿'),'§6.4 缺少定稿说明');
  assert.match(runbook,/通过已认证的 runner 完成一次真实模型调用/);
  assert.match(runbook,/一行纯 DeepSeek API Key/);
  assert.match(risks,/经过认证的 runner/);
  assert.ok(runbook.includes('docker exec along-host node host/pair-code.mjs'),'发码命令与实现不符');
  assert.ok(existsSync(join(ROOT,'host','pair-code.mjs')),'host/pair-code.mjs 不存在');
});

test('Runbook 冒烟期望与 host 启动横幅实现一致',()=>{
  // 横幅：地址 + 指纹 + 证书到期时间（定稿引用 host/agent-host.mjs:538）。
  assert.ok(runbook.includes('Along 服务: https://0.0.0.0:4176'),'冒烟期望缺少启动横幅地址');
  assert.ok(runbook.includes('证书到期时间'),'冒烟期望缺少证书到期时间');
  assert.ok(hostSrc.includes('证书到期: '),'host 横幅未打印证书到期');
  assert.ok(hostSrc.includes('Along 服务: https://'),'host 横幅地址格式不符');
  // 多用户形态横幅不打码：通用码仅在本地单用户形态（code 非空）打印。
  assert.ok(runbook.includes('多用户形态下横幅**不打印**配对码'),'多用户横幅不打码口径缺失');
  assert.ok(hostSrc.includes('if (code) console.log(`一次性配对码'),'host 横幅未按条件打印通用码');
});

test('Runbook uses the current binding table and recreates the Host after certificate changes',()=>{
  const migration=section(design,'### 6.2 Mac 本地数据怎么迁','### 6.3');
  assert.match(migration,/读取 `pairings\.json` 中现役绑定的 `user_id`/);
  assert.match(runbook,/\/opt\/along\/data\/host\/cert\.pem.*\/opt\/along\/data\/host\/key\.pem/);
  assert.match(runbook,/docker compose -f deploy\/docker-compose\.yml up -d --no-deps --force-recreate host/);
  assert.doesNotMatch(runbook,/docker compose restart host/);
});

test('修正 3 无落点：AGENTS/README/docs 索引无不准确的全局锁表述，设计文档 §2.1 承载修正',()=>{
  // §2.3-3 判定该不准确表述在 AGENTS.md/README/docs/README.md 无落点（全库 grep 无命中）。
  for (const [name,text] of [['AGENTS.md',agents],['README.md',readme],['docs/README.md',docsIndex]]) {
    assert.ok(!text.includes('全局单飞锁'),`${name} 残留「全局单飞锁」`);
    assert.ok(!text.includes('一次只处理一条请求'),`${name} 残留「一次只处理一条请求」`);
  }
  // 修正内容以 §2.1 现状结论「以代码为准」承载。
  assert.ok(design.includes('调研材料「整个 host 一次只处理一条请求」不准确，以代码为准'),'设计文档 §2.1 缺少修正 3 的承载');
});

test('设计文档 §4-M7 施工记录：SD-6 确认与遗留点已记录',()=>{
  assert.ok(m7.includes('施工记录（2026-11-20）'),'缺少 M7 施工记录');
  assert.ok(m7.includes('SD-6'),'施工记录未记录 SD-6 措辞确认');
  // 已知遗留（bugfix-goal-prompt.md 红线清单旧措辞）写进施工记录，供下轮同步。
  assert.ok(m7.includes('bugfix-goal-prompt.md'),'施工记录未记录遗留点');
});

test('along-superagent 决策记录：D1 保留本地约束，D19 明确云端接入边界', {skip:!existsSync(decisionsFile)},()=>{
  const decisions=readFileSync(decisionsFile,'utf8');
  const d1=section(decisions,'## D1 ','## D2 ');
  const d19=section(decisions,'## D19 ');
  assert.ok(decisions.includes('## D19 云端单机 2 用户部署（扩展 D1）'),'缺少 D19 条目');
  assert.match(d19,/公网.*443|443.*公网/);
  assert.match(d19,/`user_id` 归属检查/);
  assert.ok(d19.includes('不建设注册、计费'),'D19 未保留 D1 的不建设边界');
  assert.ok(d19.includes('docs/cloud-deploy-multi-user.md'),'D19 未指向设计文档');
  // D19 追加在决策区（被替代的设计表之前）。
  assert.ok(decisions.indexOf('## D19 ')<decisions.indexOf('## 被替代的设计'),'D19 未追加在决策区');
  // D1 原条目未被改写：仍为本地单用户表述，不含云端内容（扩展内容只进 D19）。
  assert.ok(d1.includes('首期按单用户、一个本地部署设计'),'D1 原文被改写');
  assert.ok(!d1.includes('云端'),'D1 原文被写入云端内容');
  assert.ok(!d1.includes('Docker'),'D1 原文被写入 Docker 内容');
});
