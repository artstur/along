# Along 两仓库代码质量与文档整理 Goal

## 可复用 Prompt

在 Goal 模式执行以下目标，直到完成可审阅交付：

> 对 `artstur/Along` 与 `artstur/along-superagent` 做一轮代码质量改进和文档清理。先读取工作区与仓库 AGENTS.md、修 bug 流程和最近 PR 遗留；核实最新 main，分别建立独立工作树、分支和 PR，保全已有改动。按 agent/data/ui/client/release 标明分类、依赖与用户可观察验收，先写方案再实现。
>
> 跑基线检查，巡检关键输入边界、状态转换和失败恢复。仅修复可复现、可说明正确行为的缺陷；每项补先失败后通过的回归测试，并临时回退修复证明测试能捕捉回归。对相关代码按单一职责、显式数据流和适用设计模式消除重复与含混逻辑；抽象应减少复杂度，避免为假想需求增加层次、功能或依赖。
>
> 同时清理重复、过时和互相矛盾的文档，整理 README 与文档导航、链接和命名。明确区分当前实现、目标设计、历史验收和待验项；保留历史证据，失效操作给出替代入口。接口和参数以当前源码为准。
>
> 遵守简化产品、Mac 凭证、健康汇总、Agent 输出校验、聊天纠正及理财演示边界。Along 运行 `npm run check`，修改前端后运行 `npm run build` 并核对 Web/iOS 产物及缓存版本；Along Agent 运行 `npm run check`（类型、测试和构建）。根据影响做本地运行验收。独立只读代理在固定提交上核实复现、修复与回归，处理有效发现至通过。
>
> 验证后分别提交、推送并维护 PR，写明根因、设计取舍、依赖、测试与回退检测证据、文档整理及遗留。结束条件是两仓库都有经验证的实际改进、可审阅 PR 和可重跑证据；构建、模拟、本地运行、公开部署及真机验收分别报告。

## 本轮范围（2026-11-16）

- Along 主分类：ui/data（事件工作区状态与共享协议校验）；基线 `aa1d7b2c79a74bdf766d2d0a28ce5f418f0bb212`。
- Along Agent 主分类：agent/data；独立任务从该仓库最新 main 开始，方案与证据见配套 PR。
- 默认无跨仓接口变更或 PR 依赖。开工时避开正在开发的通知功能（Along #17/#18、Along Agent #3）；交付前这些 PR 已并入主线，本轮同步后重验兼容性。
- 用户可观察验收：目标归档后仍能返回可操作的首页或其余目标，已保存的对话和草稿不丢；畸形健康摘要被明确拒绝，队列调用不因校验异常而中断。

## 实现方案与候选（已完成）

1. C1：复核上轮 PR #16 记录的归档目标选择问题。把“当前/返回目标必须有效且未归档”的状态约束集中处理，覆盖缓存恢复、目标选择与同步后状态；保持新对话和迟到结果隔离。
2. C2：复核健康摘要观测窗口为非对象时的校验行为。先校验结构，再访问字段；沿用现有契约，不放宽有效摘要与时间范围要求。
3. 文档：整理架构入口，修正指向旧开发分支的导航；拆清现行事件链路与旧 Host 兼容路径；修 bug Prompt 的历史机器路径/分支只作历史说明，新任务遵守工作区基线约定。

## 验收与交付记录

- 基线：`npm run check` 304/304 通过；日志 `/tmp/along-quality-baseline.log`。
- C1 → Bug#2：`node --test test/event-workspace.test.mjs test/event-workspace-app.test.mjs`，修复前 3 failed / 10 passed，修复后 13/13；只回退 `web/event-workspace.mjs` 后同样 3 项失败。`e253bcb` 集中维护导航选择不变量，缓存恢复与状态写入共用，历史快照、草稿和无关新会话保留。
- C2 → Bug#3：`node --test test/event-envelope.test.mjs`，修复前 2 项因 `Cannot use 'in' operator to search for 'start'` 失败，修复后 2/2；只回退 `web/event-envelope.mjs` 后再次 2 项失败。`d17f574` 提取窗口结构校验，再执行已有摘要约束；无效输入明确拒绝，不入队不发网络。
- 契约未变：仍只接受既有信封与已校验状态；修复使无效输入按原契约拒绝，归档历史仍保留且不作为活动目标。
- 初轮修复 `npm run check`：309/309 通过，0 跳过。`npm run build`：18 个文件与 `dist/`、`ios/AlongHealth/Web/` 逐字节一致。
- 资源版本 v62：Web 查询串、Service Worker、iOS 内置壳同步；避开待集成通知 PR 的 v61。初轮未安装 App，Bundle 当时为 52；后续同步主线沿用其 Bundle 53。生成资源独立提交 `7eb1e39`。
- 真实 Chrome 393×852 浏览器：合成协议桥接下“选目标 → 聊天 → 同步归档 → 返回首页”可退出，归档前草稿保留，新对话草稿返回后可恢复；无横向溢出或页面异常。本地 `host/server.mjs` 实际启动并提供页面与模块，验收后停止。此项不是实际 Agent 或真机验证。
- 文档：新增统一索引，收敛重复长导航；24 个旧开发分支链接改为主线；修正新事件能力被写成待实现、旧采用流程被混作现行规范，以及固定旧机器路径/复用已合并分支的指引。45 个本地链接和 24 个跨仓主线文件路径核对成功，历史验收数字保留。
- 日志：`/tmp/along-quality-{baseline,final}.log`、`/tmp/along-{archive,window}-{before,rollback}.log`；浏览器证据在工作区 `outputs/Along-code-quality-20261116/`。独立核实终态见下节，PR 随本轮任务分支交付。
- 本轮不涉及安装真机、公开部署或现有用户数据迁移；这些流程未执行时不得记录为已验收。

## 独立发现与主线同步

首轮独立核实为 PARTIAL：原始两项缺陷复现与校验修复成立，但发现归档聊天后旧 textarea 值被复制进新会话，以及跨目标聊天后仍残留先前绑定的会话根。两处均补先失败回归，修复 `5100d69`；分别恢复旧 textarea 处理、旧根判定时，各有 1 项测试失败。现在由工作区提供统一 draftScope，页面只在同一作用域保留真实输入；移除目标选择后仅保留真正未绑定的新对话。无关的新会话草稿仍可恢复。

交付前同步 Along `43464b4c` 与 Along Agent `b79fccc`：通知与到期复查已成为主线能力。保留上游通知实现与测试，解决共同文件和资源版本冲突；本轮资源 v62，高于主线 v61，Bundle 沿用主线 53。本轮没有将新资源安装到设备或发布，主线发布/验收记录属于其他任务。

## 第一次主线集成验收（43464b4c）

- 第三项独立发现：未绑定对话收到新目标时，第二句未发送补充会因作用域变化而不可见。`709d7be` 让草稿通过持久消息关联目标，保留原会话作用域；即使清掉当前根后重选目标也可恢复。较新的会话草稿先继续编辑/发送，目标原有草稿保持独立，之后仍可恢复。新增模块与真实 textarea 两项回归先失败，修复后通过；只回退作用域解析时再次 2 项失败（`/tmp/along-binding-{before,after,rollback}.log`）。
- 最终固定代码快照：`62faf97b13f5ae4a1d3f04f9b61bab14247115a4`。独立复核 **PASS**：28 项定向、48 项相邻通知/原生/队列/共享校验通过；独立旧快照叠加新增绑定测试为 24 passed / 2 failed。三项独立发现全部关闭，没有带未处理发现交付。
- 最新主线同步后的 `npm run check`：**332/332，0 跳过**，日志 `/tmp/along-quality-final-reviewed.log`。初轮 309 与中间集成 330 是历史检查快照，不能替代最终结果。
- `npm run build`：**18** 份资源与 Web 源码、dist、iOS 内置目录逐字节一致。资源 **v62**，沿用上游 Bundle **53**；本轮没有重新安装或发布。
- 增强的真实 Chrome 393×852 验收同时覆盖归档隔离与合法绑定恢复，草稿返回重开不丢、原目标草稿仍保留，无横向溢出，`pageErrors=[]`。证据位于工作区 `outputs/Along-code-quality-20261116/browser-proof.json` 与两张截图；桥接为合成数据，不是实际 Agent 或设备验收。
- Along Agent 配套质量改进见 [PR #4](https://github.com/artstur/along-superagent/pull/4)：路径包含守卫修复、文档索引与部署说明整理。同步该仓库主线后 81 个文件 / **1544** 项通过，类型检查、构建、合成持久化冒烟与独立复核 PASS；两 PR 无协议依赖。
- 两仓库保留独立工作树、分支和 PR 供审阅；未合并质量 PR、未触发公开 Pages 部署、未替换正式 Host/Agent 或安装真机。通知真实送达、后台机会等沿用发版任务的独立验收，不由本轮测试推断。

## 最终交付（23d78f3）

推送前主线又合入 PR #19 的本机旧通知兼容与默认目标恢复。最终固定代码快照 `4c9e3731c254ead66dd8bd685400da61c9c7082e` 已保留该实现和冷启动定位测试；选择恢复统一复用上游 `restoreSelection`，移除本轮先前的重复恢复函数。归档后按主线行为回退其余活动目标，无其他目标才回空首页；显式开始新对话时不会继承旧目标根。两项测试按上游行为核对回退目标及先返回首页后重开聊天，不删除草稿或发送信封的断言。

- 最新全量 `npm run check`：**336/336，0 跳过**，日志 `/tmp/along-quality-latest-final.log`。
- 独立集成复核 **PASS**：**32/32** 定向通过，确认通知兼容、默认选择与本轮草稿保护共同成立；全部既有独立发现已关闭。
- **18** 份资源与两端产物逐字节一致；资源版本 **v63**，沿用主线 Bundle **54**。之前 v62 / Bundle 53 属于前一快照。
- 真实 Chrome 393×852 合成桥接再次通过归档隔离、草稿返回重开及同根绑定恢复，`pageErrors=[]`；更新同一组浏览器证据。
- `git diff --check` 与工作树检查通过；最终变更通过独立任务分支与 PR 交付。本轮未合并质量 PR、未部署或安装真机。

## 2026-11-25 部署回归与开发指引整理

两组部署回归分别保留各自的断言，共用 Dockerfile 的 `COPY` 解析及 Host 引用 Web 文件的遍历。验收时比较整理前后取得的文件列表、检查现有用例并逐份比对两端 Web 构建产物。README 的开发与发布段保留运行命令，构建白名单和缓存版本规则统一见[项目约定](../AGENTS.md)第 2 节。

### 可复用的维护任务提示词

> 清理目标仓库的文档和代码，保持线上功能一致。读取项目约定，从已核实的远端主干新建独立工作树。保全原检出的本地改动和历史记录，每仓一个维护 PR。
>
> 在已有维护文档中写清重复项、调用方、预期收益及如何证明等价。将重复说明集中到一个入口，核对命令、链接与引用，保留历史提交、失败记录和待验事项。代码改动限于可证明等价的局部简化，保留接口、返回值、错误、执行顺序和副作用。发现功能缺陷另行记录。
>
> 将运行时读取的提示词、技能、任务触发、权限、数据格式和依赖作为兼容边界。使用隔离数据运行工程规定的全量检查，对真实模块或产物做前后比对。撤回无法证明等价的改动，提交并推送已验证的改动，在 PR 列出固定提交、差异、验证结果及跳过项。线上部署另行安排。

### 复查 PR #61

在包含完整 Git 历史的仓库根目录运行下面的命令。依赖为 Git、Python 3 和项目支持的 Node.js。脚本把两个固定提交导出到临时目录，检查两组部署测试的断言和辅助函数、22 个 Web 资源以及文档入口。

```sh
python3 docs/verification/pr-61/replay.py
```

[PR #61](https://github.com/artstur/along/pull/61) 的清理前提交为 `c90569368330eb3a5394e7116d6e63cea491d269`，验收提交为 `c29928e21178ee0c6b80e8fc2482aa26071ec7af`。

## 2026-11-27 死代码清理（TASK-83）

### 范围与口径

只删除**确认无入口且无兼容用途**的导入、失效样式与私有辅助逻辑；涉及接口、持久化数据或兼容性语义的候选只记录证据，留待单独评估，不在本轮删除。沿用本文档的两仓库口径，Along 与 Along Agent 同批排查、同批交付。

### 排查手段

- **模块可达性**：从真实入口（`web/index.html` → `web/app.mjs`、`web/sw.js`、`host/server.mjs`、`host/agent-host.mjs`、`tools/*`、`deploy/*`、`test/*`）沿 `import` / `import()` 边遍历，列出无任何入口引用的模块；CLI 类脚本（`host/pair-code.mjs`、`tools/*`、`deploy/*`）按进程入口计。
- **导入级死代码**：解析 `web/`、`host/`、`tools/`、`deploy/`、`examples/`、`test/` 的全部 `import`（含跨行写法），对每个绑定名在导入文件其余部分做词边界检索。
- **声明级死代码**：`function` / `class` / `const` / `let` / `var` 的名字在全仓出现次数 ≤ 1（只有声明处）才列为候选。
- **未使用参数**：逐函数体括号配平后，对形参在函数体内做词边界检索；`...spread` 形式按同一前缀排除误判。
- **样式级死代码**：解析 `web/style.css` 的类选择器，逐个在 `web/`、`host/`、`ios/AlongHealth/Sources/` 的 HTML/JS/Swift 源码里反查；同时反查 `hidden-`、`generated-`、`orchestration-`、`architecture-` 等前缀，确认没有拼接生成的同名类。`ios/AlongHealth/Web/` 是 `web/` 的构建产物，不计入重复。
- **端点侧休眠**：列出 `host/` 暴露的 HTTP 路径，在 `web/`、`ios/AlongHealth/Sources/`、`deploy/`、`test/`、`docs/` 反查调用方。

### 已删除

**1. 4 条失效样式规则（`web/style.css`）**——没有任何标记使用，且不存在拼接生成的同名类：

| 类 | 原位置 | 判断依据 |
| --- | --- | --- |
| `.hidden-count` | `web/style.css:65`（与 `.module-more` 合并声明） | 全仓无 `hidden-count`；源码里也没有 `hidden-` 前缀的类名 |
| `.generated-status` | `web/style.css:98`（独立规则） | 全仓无 `generated-status`；源码里只有 `generated-task` |
| `.orchestration-section` | `web/style.css:152`（与 `.workers-section`、`.activity-section` 合并声明） | 全仓无 `orchestration-section`；源码里只有 `orchestration-flow` |
| `.architecture-note` | `web/style.css:187-189`（含 `strong`、`p` 两条子选择器） | 全仓无 `architecture-` 前缀的类名 |

合并声明里仍在使用的 `.module-more`、`.workers-section`、`.activity-section` 保留。

**2. `test/` 6 处未使用导入**（生产代码零命中）：

| 文件 | 删除的绑定 |
| --- | --- |
| `test/ca-tls-material.test.mjs` | `readdirSync` |
| `test/ios-phone-source-coordinator.test.mjs` | `readFileSync` |
| `test/pairing-host-verify.test.mjs` | `randomBytes` |
| `test/tier2-orchestration.test.mjs` | `existsSync` |

### 已记录、未删除的候选

- **`POST /goal/chat`（`host/agent-host.mjs:758`）**：全仓反查 `web/`、`ios/AlongHealth/Sources/`、`deploy/`、`test/`、`docs/` 均无调用方。属接口语义，删除需要裁决，留待单独评估。
- **`POST /goal/event` 与 `host/codex-agent.mjs`**：仓库文档已记录该路径为休眠路径（`docs/cloud-deploy-multi-user.md:54`、`:66`「`web/` 无任何调用 `/goal/event` 的代码……属休眠路径」）。它仍在 iPhone 连接自检白名单里（`ios/AlongHealth/Sources/AlongShellView.swift:1169`），且被 `docs/cloud-security-hardening.md` 记为 Mac 真实功能；删除会改变接口语义，不在本轮范围。
- **7 处只被本文件使用的 `export` 修饰**（`host/okx-history.mjs` 的 `OKX_HISTORY_TYPES`、`host/source-event-bridge.mjs` 的 `SourceBridgeError`、`deploy/superagent-preset-lockdown.mjs` 的 `rootEntryIds` / `presetRegistryRow` / `globalDenials`、`examples/guangzhou-health-replay.mjs` 的 `makeRequest`、`test/fixtures/okx-history.mjs` 的 `START`）：符号本身都在本文件内被使用，死的只是 `export` 关键字。收窄模块公开面属于接口变更，未纳入本轮。

### 结论与验证

除上述 4 条样式规则外，Along 仓的生产代码（`web/`、`host/`、`tools/`、`deploy/`、`examples/`、`ios/AlongHealth/Sources/`）在本轮口径下**没有**可达性缺失的模块、没有未使用导入、没有未使用参数或局部量、没有只声明不使用的符号、没有其余未被引用的 CSS 类。沿用多轮记录的结论：死代码在本仓主要集中在导入层与样式层，且此前已被逐步清掉。

- `npm run check`：**887** 项，**883 passed / 0 failed / 4 skipped**，与清理前基线逐项一致；差异只删除未使用绑定，未增删用例（`git diff -U0 -- test` 无用例声明行变化）。
- 样式改动按 `AGENTS.md` 第 2 节同步资源版本：`node tools/bump-shell-version.mjs 100` 把 `web/index.html` 的 `?v=`、`web/sw.js` 的 `CACHE`、`ios/AlongHealth/Sources/AlongShellView.swift` 的 `build=` 与全部 `web/*.mjs` 的模块说明符一起推进到 **v100**，并重新生成 `dist/` 与 `ios/AlongHealth/Web/`（22 份产物与 `web/` 逐字节一致）。
- **版本号说明**：本轮最初把版本推进到 v99，但主干随后合入 PR #80（聊天流时间分割线）并已占用 v99。合入主干时 `web/app.mjs:5` 与 `ios/AlongHealth/Web/app.mjs:5` 的同一行 import 冲突（#80 新增 `chatTimeline`、`captureChatAnchor`、`anchoredScrollTop`），按主干版本解决并保留这三个符号；资源版本随之推进到 **v100**——停在 v99 会让已缓存 v99 的客户端继续用 #80 的样式，本轮删除不生效。
- 未验证事项：未安装真机、未部署公开环境、未替换线上 Host/Agent；这些流程本轮未执行，不得记为已验收。删除的样式没有任何标记使用，因此不改变渲染结果；但「渲染结果逐像素不变」未在真机或真实浏览器上复核。
