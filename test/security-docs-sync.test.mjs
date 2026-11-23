import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// 安全加固配对测试：M6 docs-sync（docs/cloud-security-hardening.md §3.6 修订点 1–7、§4-M6 验收标准）。
// 与 test/docs-cloud-runbook-agreement.test.mjs 互补：本文件只按 §4-M6 的验收标准逐条断言，不迁就实现：
// - 验收 1（六条 test）：部署设计 docs/cloud-deploy-multi-user.md 的 §3.1/§3.2/§6.2/§3.3/§6.4 修订点
//   以 includes 断言落地——§3.1 限流在 host/runner 应用内实现并指向 docs/cloud-security-hardening.md
//   （SD-H1，旧「不需要限流」措辞清除）；§3.2 host start 端点限流数值（60 秒 10 次、超限 429、
//   status 不限）与 runner 并发硬上限数值（每用户 2、全局 4、超限 429 原样透传）；按来源（连接 IP）
//   失败窗口的六处口径（§0-P1、§3.2 码状态桶形状、§3.2 公网失败窗口、§6.1 风险行、SD-7、§5 验收 #1、
//   §4-M1）与四要素（发码不清窗、无清窗入口、15 分钟自然过期自愈、成功只清该来源桶，G-4/G-12、SD-H2）；
//   §6.2 不拷贝上云四目录清单与 okx-connections 可解密凭证库理由（G-9，旧「拷贝不移动」清除）；
//   §3.3 trading_history 成交/账单明细云端拒收（G-19）；§6.4 第 3 步密钥安全写入命令规范
//   （umask 077/HISTFILE/install -m 600/read -rs/unset v，G-21）与恢复/搬运后 chmod 600 注记；
//   第 6 步 DNS 只配 A 记录不配 AAAA 与 IPv6 源 IP 退化理由（SD-H16）；第 9 步 OKX 仅账户摘要指引
//   （G-19 连带影响）。deploy/README.md 的凭证红线写入形态与 agent-dsh 锁文件再生成说明（§3.6 修订点 4）。
// - 验收 2（一条 test）：README 配置表 ALONG_PAIR_FAIL_LIMIT 与隐私表「部署面收敛」行改为按来源新口径；
//   原断言子串「全局失败限速」「满窗时停止验码，可将上限调低」在 README 全文不再出现
//   （新文案是「满窗时**对该来源**停止验码，可将上限调低」——旧子串不是新文案的子串，负断言有意义）。
// - 验收 3（一条 test）：部署设计既有被测原文保持不变或等价更新——Runbook 2026-11-20 定稿说明、
//   冒烟期望（启动横幅地址/证书到期时间/多用户横幅不打码）、发码命令、cert/key.pem 迁移与
//   --force-recreate 重建、禁 docker compose restart host、一行纯 DeepSeek API Key。
// - 验收 4：回归 npm run check 全绿——由套件运行本身覆盖（本文件就是 npm run check 的一部分；
//   node:test 不自递归再跑全套件，故不在本文件内断言这一条）。
// 断言全部用子串/结构切片核对（includes 与 negative includes），与既有文档测试同口径；
// 需要真实 Docker/云主机的部分（compose up 后的横幅实读、A 记录解析、权限位实测）不在本文件范围，
// 按 Runbook §6.4 手动执行覆盖。

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const read=(...p)=>readFileSync(join(ROOT,...p),'utf8');
const design=read('docs','cloud-deploy-multi-user.md');
const readme=read('README.md');
const deployReadme=read('deploy','README.md');

// 按标题切片；to 标题缺失时取到文末。
function section(text,start,end) {
  const from=text.indexOf(start);
  assert.ok(from>=0,`缺少段落标题 ${start}`);
  const to=end===undefined?text.length:text.indexOf(end,from);
  return to<0?text.slice(from):text.slice(from,to);
}

// 部署设计的修订点分区（切片标题取自该文档的既有标题，缺失即 fail 并给出可读消息）。
const p1=section(design,'### 上线前 P1 修复','### `b29483d` 审核后的修复与验收');          // §0-P1
const s31=section(design,'### 3.1 部署拓扑与 Docker Compose 结构','### 3.2 多用户模型与数据隔离');
const s32=section(design,'### 3.2 多用户模型与数据隔离','### 3.3 认证与密钥');
const s33=section(design,'### 3.3 认证与密钥','### 3.4 web/iOS 客户端连接迁移');
const m1=section(design,'### M1 配对多绑定与用户表','### M2 请求级身份与每用户隔离');
const acceptance=section(design,'## 5. 验收标准（可测试）','## 6. 风险与迁移');
const risks=section(design,'### 6.1 风险清单','### 6.2 Mac 本地数据怎么迁');
const migration=section(design,'### 6.2 Mac 本地数据怎么迁','### 6.3 迁移期间如何回退');
const runbook=section(design,'### 6.4 上线 Runbook','## 7. 方案内决策记录');
const decisions=section(design,'## 7. 方案内决策记录');
const sd7=decisions.slice(decisions.indexOf('- **SD-7 '));
// §6.4 第 3 步的 sh 代码块（全文唯一 ```sh 围栏，步骤 3 密钥写入规范）。
const shFrom=runbook.indexOf('```sh');
assert.ok(shFrom>=0,'§6.4 缺少 ```sh 密钥写入代码块');
const shBlock=runbook.slice(shFrom,runbook.indexOf('```',shFrom+4));
const credentials=section(deployReadme,'## 凭证红线（AGENTS.md §5）');
const fileTable=section(deployReadme,'## 文件清单','## 路径基准');
const readmeConfig=section(readme,'## 配置','## 隐私与安全');
const readmePrivacy=section(readme,'## 隐私与安全','## 项目结构');

// ---- 验收 1：§3.1 反代否决修订为「限流在应用内实现」并指向 hardening 文档 ------------------------

test('§3.1（验收 1）：单一服务不需要虚拟主机但限流在 host/runner 应用内实现，指向 cloud-security-hardening.md，旧「不需要限流」措辞清除',()=>{
  assert.ok(s31.includes('单一服务也不需要虚拟主机；限流在 host/runner 应用内实现（连接上限、超时、`/pair` 按来源失败窗口与运行链路限流，见 `docs/cloud-security-hardening.md`），不引入反代'),'§3.1 应用内限流与 hardening 文档指向口径缺失');
  assert.ok(s31.includes('TLS 由 host 端到端提供并由 iPhone 系统信任评估校验'),'§3.1 系统信任评估口径缺失');
  assert.ok(!s31.includes('被 iPhone 钉扎'),'§3.1 旧叶钉扎措辞残留（云端已迁移到系统信任评估）');
  assert.ok(!s31.includes('单一服务也不需要虚拟主机/限流'),'§3.1 旧「不需要虚拟主机/限流」措辞残留');
  assert.ok(existsSync(join(ROOT,'docs','cloud-security-hardening.md')),'被指向的 docs/cloud-security-hardening.md 不存在');
});

// ---- 验收 1：§3.2 限流数值（host start 滑动窗口 / runner 并发硬上限） ----------------------------

test('§3.2（验收 1）：host start 端点限流数值（60 秒 10 次、超限 429、status 不限）与 runner 并发上限数值（每用户 2、全局 4、429 透传）落地',()=>{
  assert.ok(s32.includes('运行链路另有资源防护（`docs/cloud-security-hardening.md` §3.1-(7)/§3.2）'),'§3.2 并发行缺 hardening 文档指向');
  assert.ok(s32.includes('host 对 `/super-agent/goals` 与 `/super-agent/tasks` 两个 start 端点做每用户滑动窗口限流（60 秒窗口内最多 10 次，超限 429；`status` 轮询端点不限）'),'§3.2 host start 限流数值与范围口径缺失');
  assert.ok(s32.includes('runner 并发硬上限为每用户 2、全局 4 个 dsh 进程（超限回 429，host 原样透传给客户端）'),'§3.2 runner 并发上限数值与透传口径缺失');
});

// ---- 验收 1：按来源失败窗口六处口径与四要素（G-4/G-12，SD-H2） ------------------------------------

test('按来源失败窗口（验收 1）：§0-P1/§3.2 码状态/§3.2 公网失败窗口/§6.1/SD-7/§5 验收 #1/§4-M1 按来源口径与四要素（发码不清窗、无清窗入口、15 分钟自愈、成功只清该来源桶）',()=>{
  // §0-P1 第 1 条：按来源检查 + 自愈口径。
  assert.ok(p1.includes('按来源（连接 IP）的失败窗口检查'),'§0-P1 按来源失败窗口口径缺失');
  assert.ok(p1.includes('某来源窗口满时对该来源统一拒绝，包括有效码，保持码未消费；其他来源不受影响'),'§0-P1 满窗对该来源拒绝且有效码未消费口径缺失');
  assert.ok(p1.includes('发码不清窗，同 IP 噪音最长 15 分钟自然过期自愈，无清窗入口'),'§0-P1 发码不清窗/15 分钟自愈/无清窗入口口径缺失');
  // §3.2 码状态：桶形状 {<source>:[ISO,…]}。
  assert.ok(s32.includes('保存按来源（连接 IP）分桶的失败时间戳（`{<source>:[ISO,…]}`）'),'§3.2 码状态按来源桶形状口径缺失');
  // §3.2 公网失败窗口：来源定义、计入与清除范围、自愈、hardening 指向。
  assert.ok(s32.includes('**公网按来源失败窗口**'),'§3.2 公网失败窗口标题口径缺失');
  assert.ok(s32.includes('失败按来源（`req.socket.remoteAddress` 归一化后的连接 IP）分桶记录'),'§3.2 失败按来源分桶口径缺失');
  assert.ok(s32.includes('成功消费命中的码并只清该来源的桶'),'§3.2 成功只清该来源桶口径缺失');
  assert.ok(s32.includes('**发码不清窗，无清窗入口**'),'§3.2 发码不清窗/无清窗入口口径缺失');
  assert.ok(s32.includes('最长 15 分钟窗口自然过期自愈'),'§3.2 15 分钟自愈口径缺失');
  assert.ok(s32.includes('SD-7 经 `docs/cloud-security-hardening.md` SD-H2 修订'),'§3.2 缺 SD-H2 修订指向');
  // §6.1 风险行：满窗只对该来源停止验码。
  assert.ok(risks.includes('窗口按来源分桶：满窗只对该来源停止验码，其他用户照常；发码不清窗，15 分钟自然过期自愈，无清窗入口'),'§6.1 风险行按来源口径缺失');
  // SD-7：按来源分桶 + 自愈 + hardening 指向。
  assert.ok(sd7.includes('窗口按来源（连接 IP）分桶，满窗只对该来源拒绝；发码不清窗'),'SD-7 按来源分桶口径缺失');
  assert.ok(sd7.includes('最长 15 分钟窗口自然过期自愈（`docs/cloud-security-hardening.md` SD-H2 修订）'),'SD-7 自愈与 hardening 指向缺失');
  // §5 验收 #1 与 §4-M1：验收覆盖面同步为按来源。
  assert.ok(acceptance.includes('覆盖按来源窗口自然恢复（发码不清窗，无清窗入口）、成功只清该来源的桶'),'§5 验收 #1 按来源覆盖口径缺失');
  assert.ok(m1.includes('按来源失败窗口'),'§4-M1 按来源失败窗口口径缺失');
  // 旧「全局失败窗口」口径在部署设计全文清除（同为窗口语义的「全局互斥锁/全局键」不在此列）。
  assert.ok(!design.includes('全局失败窗口'),'部署设计残留「全局失败窗口」旧口径');
});

// ---- 验收 1：§6.2 不拷贝清单与 §3.3 trading_history 拒收（G-9/G-19） ------------------------------

test('§6.2/§3.3（验收 1）：四目录不拷贝上云（原 Mac 保留回退）与 okx-connections 可解密凭证库守卫、trading_history 云端拒收',()=>{
  // §6.2 第 2 条：四目录一律不拷贝 + 理由与启动守卫指向。
  assert.ok(migration.includes('`device-sources/`、`okx-connections/`、`source-events/`、`kimi-runs.json` **不拷贝上云**'),'§6.2 不拷贝上云四目录清单缺失');
  assert.ok(migration.includes('原 Mac 数据保留用于回退'),'§6.2 原 Mac 保留用于回退口径缺失');
  assert.ok(migration.includes('`okx-connections/` 是可解密的 OKX 凭证库，云端多用户形态启动守卫发现它即拒绝启动'),'§6.2 okx-connections 可解密凭证库理由缺失');
  assert.ok(migration.includes('`docs/cloud-security-hardening.md` §3.1-(2)'),'§6.2 缺 hardening 启动守卫指向');
  assert.ok(!migration.includes('**拷贝不移动**'),'§6.2 旧「拷贝不移动」措辞残留');
  // §3.3 OKX 行：云端只收三字段摘要，多用户形态 gateway 拒收 trading_history 明细。
  assert.ok(s33.includes('云端 host 只收三字段摘要，多用户形态 gateway 拒收 `trading_history` 成交/账单明细'),'§3.3 trading_history 云端拒收口径缺失');
  assert.ok(s33.includes('（`host/device-source-gateway.mjs`，用户指引见 §6.4 第 9 步）'),'§3.3 缺拒收实现与用户指引指向');
});

// ---- 验收 1：§6.4 第 3 步密钥安全写入命令规范（G-21） ----------------------------------------------

test('§6.4 第 3 步（验收 1）：密钥安全写入命令规范完整落地（umask/历史/install/read -rs/unset）与恢复/搬运后 chmod 600 注记',()=>{
  // 规范文字段：五个形态要点 + 明文不入历史的理由 + hardening 指向。
  assert.ok(runbook.includes('**密钥统一用下述形态写入**'),'§6.4 第 3 步缺安全写入形态引言');
  assert.ok(runbook.includes('`umask 077` 预设权限'),'§6.4 第 3 步缺 umask 077 要点');
  assert.ok(runbook.includes('`HISTFILE=/dev/null`（或执行前 `set +o history`）不落 shell 历史'),'§6.4 第 3 步缺 HISTFILE 要点');
  assert.ok(runbook.includes('`install -m 600 /dev/null` 预建空文件'),'§6.4 第 3 步缺 install -m 600 要点');
  assert.ok(runbook.includes('`read -rs` 静默读入再重定向'),'§6.4 第 3 步缺 read -rs 要点');
  assert.ok(runbook.includes('杜绝 key 明文出现在命令行参数里进历史与进程列表'),'§6.4 第 3 步缺明文不入历史的理由');
  assert.ok(runbook.includes('`docs/cloud-security-hardening.md` §6 步骤 2'),'§6.4 第 3 步缺 hardening 指向');
  // sh 代码块本体：两个 secret 文件的完整命令行。
  assert.ok(shBlock.includes('umask 077'),'sh 代码块缺 umask 077');
  assert.ok(shBlock.includes('HISTFILE=/dev/null'),'sh 代码块缺 HISTFILE=/dev/null');
  assert.ok(shBlock.includes('install -m 600 /dev/null /opt/along/secrets/runner-token'),'sh 代码块缺 runner-token 预建命令');
  assert.ok(shBlock.includes('install -m 600 /dev/null /opt/along/secrets/model-credentials'),'sh 代码块缺 model-credentials 预建命令');
  assert.ok(shBlock.includes('read -rs'),'sh 代码块缺 read -rs 静默读入');
  assert.ok(shBlock.includes('unset v'),'sh 代码块缺 unset v 清理变量');
  assert.ok(shBlock.includes('openssl rand -hex 32'),'sh 代码块缺留空自动生成');
  // 恢复/手工搬运后的权限注记（0600 校验 fail-closed 的说明）。
  assert.ok(runbook.includes('恢复或手工搬运 secret 文件后统一 `chmod 600`'),'§6.4 第 3 步缺恢复/搬运后 chmod 600 注记');
  assert.ok(runbook.includes('权限过宽会被 0600 校验拒绝启动'),'§6.4 第 3 步缺权限过宽拒启说明');
});

// ---- 验收 1：§6.4 第 6 步 DNS 口径与第 9 步 OKX 明细采集指引（SD-H16/G-19 连带影响） ---------------

test('§6.4 第 6/9 步（验收 1）：DNS 只配 A 记录不配 AAAA 与 IPv6 源 IP 退化理由、OKX 仅账户摘要指引与开启明细的后果',()=>{
  // 第 6 步：A 记录口径 + 源 IP 退化理由 + 对分桶/连接上限的影响。
  assert.ok(runbook.includes('域名**只配 A 记录**指向 ECS 公网 IPv4，**不配 AAAA**'),'§6.4 第 6 步缺只配 A 记录口径');
  assert.ok(runbook.includes('IPv6 客户端经 docker-proxy 会让源 IP 退化为网关地址'),'§6.4 第 6 步缺 IPv6 源 IP 退化理由');
  assert.ok(runbook.includes('`/pair` 按来源失败分桶与单 IP 连接上限都会失效'),'§6.4 第 6 步缺对分桶与连接上限的影响');
  assert.ok(runbook.includes('`docs/cloud-security-hardening.md` §3.1-(3)'),'§6.4 第 6 步缺 hardening 指向');
  // 第 9 步：OKX 采集口径用户指引（G-19 连带影响：明细与摘要同一次原子发布）。
  assert.ok(runbook.includes('云端使用期间 iPhone 的 OKX 连接保持「仅账户摘要」'),'§6.4 第 9 步缺 OKX 仅账户摘要指引');
  assert.ok(runbook.includes('勿开启成交/账单明细采集'),'§6.4 第 9 步缺勿开明细告诫');
  assert.ok(runbook.includes('明细与摘要在同一次原子发布里，开启后发布会持续失败、连接无法就绪'),'§6.4 第 9 步缺开启明细的后果说明');
  assert.ok(runbook.includes('需明细复盘时在 Mac 本地模式操作'),'§6.4 第 9 步缺明细复盘走 Mac 的出口');
});

// ---- 验收 1：deploy/README.md 凭证红线写入形态与 agent-dsh 锁文件再生成（§3.6 修订点 4） ----------

test('deploy/README.md（验收 1）：凭证红线段安全写入形态、恢复/搬运 chmod 600 注记与 agent-dsh 锁文件再生成说明',()=>{
  // 写入/更新 secret 的安全形态四要素 + 以 Runbook 为准的指向。
  assert.ok(credentials.includes('**写入/更新 secret 用安全形态**'),'deploy/README.md 缺「写入/更新 secret 用安全形态」条目');
  assert.ok(credentials.includes('`umask 077` 预设权限'),'deploy/README.md 缺 umask 077 要点');
  assert.ok(credentials.includes('`HISTFILE=/dev/null`（或执行前 `set +o history`）'),'deploy/README.md 缺 HISTFILE 要点');
  assert.ok(credentials.includes('`install -m 600 /dev/null <目标文件>` 预建空文件'),'deploy/README.md 缺 install -m 600 要点');
  assert.ok(credentials.includes('`read -rs` 静默读入后重定向写入'),'deploy/README.md 缺 read -rs 要点');
  assert.ok(credentials.includes('完整命令以 Runbook §6.4 第 3 步为准'),'deploy/README.md 缺以 Runbook 为准指向');
  assert.ok(credentials.includes('权限过宽会被 0600 校验拒绝启动'),'deploy/README.md 缺权限过宽拒启说明');
  // 恢复/搬运后的统一 chmod 600（备份脚本只有备份链路、手工 cp/mv 可能改权限位）。
  assert.ok(credentials.includes('**恢复/搬运 secret 文件后统一 `chmod 600`**'),'deploy/README.md 缺恢复/搬运后 chmod 600 条目');
  assert.ok(credentials.includes('手工 `cp`/`mv` 或未来的恢复链路都可能改变权限位'),'deploy/README.md 缺权限位改变理由');
  // 文件清单表：agent-dsh/ 行与锁文件再生成、pin/版本同步说明。
  assert.ok(fileTable.includes('`agent-dsh/`'),'deploy/README.md 文件清单缺 agent-dsh/ 行');
  assert.ok(fileTable.includes('`npm install --package-lock-only --ignore-scripts` 重新生成 lock'),'deploy/README.md 缺锁文件再生成说明');
  assert.ok(fileTable.includes('同步 `Dockerfile.agent` 的 pin 与 compose 的 `ALONG_DSH_VERSION`'),'deploy/README.md 缺 pin 与版本同步说明');
});

// ---- 验收 2：README 配置表/隐私表按来源新口径，旧措辞清除 ------------------------------------------

test('README（验收 2）：配置表 ALONG_PAIR_FAIL_LIMIT 与隐私表「部署面收敛」行改为按来源（连接 IP）新口径，旧措辞清除',()=>{
  // 配置表新口径：按来源分桶计数 + 满窗只对该来源停止验码。
  assert.ok(readmeConfig.includes('`ALONG_PAIR_FAIL_LIMIT`'),'配置表缺 ALONG_PAIR_FAIL_LIMIT 行');
  assert.ok(readmeConfig.includes('公网配对失败窗口上限，按来源（连接 IP）分桶计数。某来源满窗时对该来源停止验码，可将上限调低'),'配置表 ALONG_PAIR_FAIL_LIMIT 新口径缺失');
  // 隐私表新口径：部署面收敛行按来源失败限速。
  assert.ok(readmePrivacy.includes('部署面收敛'),'隐私表缺「部署面收敛」行');
  assert.ok(readmePrivacy.includes('只开放 443 一个端口'),'隐私表缺云端仅 443 口径');
  assert.ok(readmePrivacy.includes('配对码另有按来源（连接 IP）失败限速'),'隐私表按来源失败限速新口径缺失');
  // 旧口径在 README 全文清除：旧断言子串「满窗时停止验码，可将上限调低」不是新文案的子串
  // （新文案为「满窗时对该来源停止验码，可将上限调低」），故负断言有效。
  assert.ok(!readme.includes('全局失败限速'),'README 残留旧「全局失败限速」口径');
  assert.ok(!readme.includes('满窗时停止验码，可将上限调低'),'README 残留旧「满窗时停止验码」口径');
});

// ---- 验收 3：既有被测原文保持不变或等价更新 ---------------------------------------------------------

test('既有被测原文（验收 3）：Runbook 定稿、冒烟期望、发码命令、证书迁移与 --force-recreate、禁 restart host 保持不变',()=>{
  // 定稿说明与真实模型冒烟期望。
  assert.ok(runbook.includes('2026-11-20 定稿'),'§6.4 缺 2026-11-20 定稿说明');
  assert.ok(runbook.includes('通过已认证的 runner 完成一次真实模型调用'),'§6.4 缺通过已认证 runner 的真实模型调用冒烟');
  assert.ok(runbook.includes('一行纯 DeepSeek API Key'),'§6.4 缺一行纯 DeepSeek API Key 口径');
  // 发码命令与 host/pair-code.mjs 存在。
  assert.ok(runbook.includes('docker exec along-host node host/pair-code.mjs'),'§6.4 发码命令与实现不符');
  assert.ok(existsSync(join(ROOT,'host','pair-code.mjs')),'host/pair-code.mjs 不存在');
  // 冒烟期望：启动横幅地址、证书到期时间、多用户横幅不打码。
  assert.ok(runbook.includes('Along 服务: https://0.0.0.0:4176'),'§6.4 缺启动横幅地址冒烟期望');
  assert.ok(runbook.includes('证书到期时间'),'§6.4 缺证书到期时间冒烟期望');
  assert.ok(runbook.includes('多用户形态下横幅**不打印**配对码'),'§6.4 缺多用户横幅不打码口径');
  // 证书/域名迁移：cert/key.pem 一起移到备份目录、--force-recreate 重建 Host、禁 restart。
  assert.ok(runbook.includes('/opt/along/data/host/cert.pem'),'§6.4 缺 cert.pem 迁移路径');
  assert.ok(runbook.includes('/opt/along/data/host/key.pem'),'§6.4 缺 key.pem 迁移路径');
  assert.ok(runbook.includes('docker compose -f deploy/docker-compose.yml up -d --no-deps --force-recreate host'),'§6.4 缺 --force-recreate 重建命令');
  assert.doesNotMatch(runbook,/docker compose restart host/,'§6.4 出现被禁的 docker compose restart host');
});
