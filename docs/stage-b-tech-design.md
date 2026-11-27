# 阶段 B：聊天到自动维护的最小闭环

> 2026-11-15。开发前方案。本轮建立新目标与聊天纠正闭环，验收结果在文末追加；不代表完整 B–E 已完成。

## 目标与范围

iPhone 的原话通过阶段 A 事件队列进入 Mac；Worker 读取服务端对话和当前版本，调用受校验的 Along 工具维护目标与任务，结果自动同步到既有目标页、聊天页。明确行动意图才创建目标，现象描述先回应，缺少决定性信息时询问；用户可以在执行中继续聊天，旧输入的结果不能覆盖新意图。

复用现有新建、目标选择、聊天、连接和返回入口，不加页面入口或模式开关。新链路的目标卡、任务、对话仅展示已校验的服务器状态，不显示采用、直接编辑或删除入口。健康新协议、记忆宿主接线、跨目标协调、完整通知策略和批量复盘不属于本轮；普通同步不发系统通知。

## 实现方案

1. **能力协商**：Host 在已鉴权的连接检查返回 `eventProtocol: 1` 和服务端绑定用户 ID。启用 `ALONG_EVENT_INGEST=on` 时优先检查 Along Source，不依赖旧 Kimi 选择。客户端按绑定用户隔离缓存和队列；曾进入新链路后，断网不回退旧写入。旧手机缓存原样保留，本轮不自动导入旧目标；正式数据接管仍须按阶段 A 备份/导入/核对后进行。
2. **可靠聊天**：复用事件信封和待同步队列，入队必须持久化成功才清输入框。新增消息在本机先可见，重试复用同一信封；收到 accepted 不等于 Agent 完成。连接恢复和前台轮询顺序重投，终态拒绝保留失败原因。一个用户的发送与同步串行，重复刷新单飞。
3. **服务端对话**：补齐无目标对话读取与 Worker 答复工具。工具的身份、事件、工作和目标均由宿主绑定；回复持久化并进入 sync，重复提交不重复消息。原话和历史都从库读取，客户端不上传自称的历史。无目标聊天可以携带同一会话的根消息引用，仅在归属验证通过时读上下文；创建目标后将该会话关联到新目标。
4. **意图与版本**：Along 派工加载内置目标/任务 Skill 与强制边界；语义由模型判断，不用关键词分类器替代意图理解。读取当前 `input_version`、`base_revision` 后提交；聊天纠正立即提升输入版本。对无目标同一会话亦检查较新输入，防止旧工作晚创建或重复创建；版本冲突要求重读原话后重规划，不把旧方案换一个版本号强行重交。
   Router 在本地 Along 部署中把已配对且允许的用户聊天视为需要回应的对话工作；不能因“不是仓库改动”或“只是现象”而静默 ignore。对不存在或已结束工单的误 stop 同样拒绝重试，避免被 Engine 终结成 ignore；有效停止仍交给原 Engine。是否建目标交给 Worker 判断，沿用暂停、停止、身份与授权检查；健康观察不受这条规则影响。
5. **同步展示**：sync 提供当前目标快照（含任务、版本和安全派生布局）及持久对话。客户端先校验整页，再原子写入一份缓存，然后 ack；失败不推进游标。服务器分配的稳定 ID、接收序号用于合并，客户端时间不用于重排。重新安装/缓存丢失从游标 0 重建，分页拉完，断网保留最近成功缓存。界面用服务器当前状态，归档目标从活动列表移除，原会话保留可查。
6. **旧链路边界**：新链路页面不调用旧 goals/tasks、旧采用或后台复评，暂停旧后台模板；未启用新链路的 Host 保持原兼容行为。iOS 新资源由 build 生成，并联动 HTML/SW/壳/Bundle 版本。

## 验收标准

- 从手机真实提交处理器到事件、回执、同步页：原话先保存；重试同号；失败不丢；新目标/任务自动展示，无采用入口。
- 真实 SQLite/Runtime 测试宿主：聊天→派工→读取→提交→答复→同步；现象路径仅回复、无目标写入；明确行动路径创建并关联原话；纠正使旧提交冲突，新提交生效；同会话无目标的过时创建被拒。
- 无目标连续对话和目标对话在重启后可读；回复幂等；跨用户/跨目标/伪造引用拒绝；缓存按绑定用户隔离。
- 同步分页、重复页、ack 失败、缓存写失败、坏 payload、断网重连、执行中第二句聊天均有回归；坏数据不进入目标空间、不推进游标。
- Along `npm run check`、superagent `pnpm check` 全绿；build 后两份前端产物与源码一致；本地页面可打开。真实模型/真机验收与测试替身证据分别记录。

## 实施与验证记录

代码落点：Along `web/event-workspace.mjs`（协议与缓存）、`web/app.mjs`（既有入口接线）、`host/agent-host.mjs`（能力协商与配对登记门）；Along Agent 的 `tools.ts`、`inbox.ts`、`store.ts`、`changeset.ts`、`worklink.ts` 与内置 Along 目标/任务 Skill。

- 创建工单最初没有目标；首个有效 ChangeSet 创建目标后，后续工具调用由宿主自动绑定到同一目标。客户端和 Worker 都不能自行换目标 ID。
- 业务 ChangeSet 的完整校验保持不变。工具层把 `goal.create` 分为 custom 与数值域两种参数形状：custom 的 metric 只能省略或为 null，由宿主固定补 null；health/finance 必须给完整 metric。这样去掉定性目标的冗余参数；`{}` 或自定义 metric 仍被拒绝，不做宽松转换。
- Harness 0.2.2 先要求工具结果为 lossless JSON，之后才渲染。可选对象字段中的 `undefined` 必须省略；数组中的 `undefined`、非有限数和非 JSON 对象仍拒绝。已用失败复现和独立只读核实确认，并纳入回归。
- 页面前台空轮询不重建表单；有变化时保留未发送文字、焦点、选区与滚动位置。旧连接退休后不能用迟到响应覆盖新连接的缓存。
- 工单执行说明保存在完整服务端记录中，手机聊天只展示实际答复；普通同步不发通知。

### 2026-11-16 收尾核对

- Along：`npm run check` 290 项通过；构建后 18 个源码文件与两份产物逐字节一致。
- Along Agent：`VITEST_MAX_WORKERS=4 pnpm check` 77 个文件、1484 项通过，类型检查与构建通过。限制测试并行数，不修改超时阈值或断言。
- 独立只读核实通过：lossless JSON、严格参数、同 work 创建后绑定、不能用无效 stop 变相忽略聊天。
- 真实 Harness 0.2.2-rc.3 / MiniMax-M3.1-Flash 合成验证通过：现象先回应不建目标；明确意图建立 custom 目标且没有数值指标；聊天纠正更新任务；3 条答复落库且工单结束。证明在 Along Agent 忽略目录 `.artifacts/along-phaseb-chat-ready/proof.json`；失败的早期探针没有计作通过。验证进程已停止。
- Playwright 390×844（原生桥/响应替身）：目标和任务自动展示，草稿及焦点跨空轮询保持，没有横向溢出、旧接口请求或控制台错误。
- Xcode 27.2 对 generic iOS 目标的无签名构建成功；尚未在实际 iPhone 上安装、配对或验证离线重连。健康新协议已在后续阶段 C 实现，见 [阶段 C](stage-c-tech-design.md)；完整迁移恢复仍待后续验收。记忆宿主接线已于后续实现，见 `../along-superagent/docs/along/006-memory-implementation.md` §5；定时记忆维护后续已实现，见相邻工程 `docs/along/008-scheduled-maintenance.md`，完整复盘和 Skill 作业仍待实现。

## 本地验证与手机连接

### 一条命令激活本机服务（2026-11-16）

目标：真机首次连接不再要求手动创建 profile、编辑 YAML、初始化 Source 或设置 Host 环境变量。在 Along 根目录执行 `npm run activate`，启动前台运行的 DSH 和 Along Host。

范围与实现：启动器位于 `tools/activate.mjs`，使用相邻的 `../along-superagent` 开发仓库；检查依赖并构建 Along Agent 和手机内置资源。首次创建专用 `along-phone` profile，数据存在 `~/.along/phone-test/`，不接管旧手机库。首次从同一 DSH_HOME 的 desktop profile 复制模型供应商和默认模型两个配置项，凭证不打印，生成文件为 0600；不复制其他桌面插件、会话或探针。没有可复用模型配置时在终端询问接口地址、模型和 API 类型；默认模型缺少 API Key 时隐藏输入并原子保存为本机 0600 凭证文件，通过 DSH 原生 credentials-local 读取，不把 Key 写进命令参数或导入 Host/Worker 环境；后续免输。已有 DSH 凭证和环境凭证可直接复用。非交互环境缺凭证时明确报错，不挂起或伪装就绪。新库经 Along Agent 自己的 Store 初始化 Along enabled、GitHub disabled 和 auto；重跑不改既有库、模型、暂停或授权设置。已有非启动器管理的同名 profile 拒绝覆盖。启动器串行检查 DSH 健康和 Along Bridge 后启动 Host，终端直接显示手机配对信息；端口占用或并发启动明确退出。Ctrl+C/子进程异常时优雅关闭本次创建的子进程，不停止其他 DSH profile。不会自动安装 App、授予健康权限或配置 Hy-Memory。

验收：首次运行完成 profile、Source 与资源准备，DSH 与 Bridge 就绪后打印 Host 配对信息；重跑沿用目标、对话、配对和用户配置；并发启动、端口占用及未知同名 profile 不覆盖文件或重复启动；启动失败和 Ctrl+C 清理本次子进程。自动测试覆盖配置复制边界、重复初始化和失败清理，运行 `npm run check`，本机真实启动/关闭验证不发送模型请求或健康数据。手机安装、配对与 HealthKit 仍按下述真机流程验收。

实施记录（2026-11-16）：`npm run activate` 已接通，`npm run check` 302 项通过，其中新增启动器测试 10 项。真实 DSH/Host 已验证本机桌面模型复用、首次初始化、Bridge 就绪、配对信息输出、重复启动拒绝、Host 退出联动关闭 DSH 及 Ctrl+C 清理。另在隔离 DSH_HOME 中用合成 Key 完成终端隐藏输入、0600 持久保存、原生 credentials-local 装载及第二次免输启动；未向模型发送请求，因此不代表合成 Key 通过供应商认证。未知同名 profile 保留、实际监听地址的端口冲突检测及不停止无关服务均已复验。Key 缺省保存路径为 `~/.along/phone-test/model-credentials.yaml`，不会写入仓库；临时验证服务均已停止，手机验收尚未执行。

不需要 iPhone 的验证：

```sh
cd /Users/zwh/personal/along-superagent
pnpm check
pnpm exec vitest run tests/along-phaseB.spec.ts
cd /Users/zwh/personal/Along
npm run check
npm run build
```

手机连接新链路需要一个已配置可用模型的**独立 Along DSH profile**。按 Along Agent 的 `docs/006-deployment.md` 安装本地 bundle、启用 `dsh-superagent-along` 并关闭 GitHub 插件。给该 profile 的配置加入绝对路径，例如新建本地测试数据：

```yaml
- id: dsh-superagent
  config:
    stateDir: /Users/zwh/.along/stage-b-local/dsh
    alongStateDir: /Users/zwh/.along/stage-b-local/data
    alongBridgeTokenFile: /Users/zwh/.along/stage-b-local/data/bridge-token
- id: dsh-superagent-github
  disabled: true
- id: dsh-superagent-along
  disabled: false
```

这个 profile 的持久 Source 设置必须同时为 Along enabled、GitHub disabled（只关闭插件不足以选择本地部署）。对**新建且尚未启动的测试目录**，可在 Along Agent 根目录初始化；已有正式数据按迁移/备份流程处理，不用此步骤替代迁移：

```sh
node --experimental-transform-types --input-type=module <<'JS'
import {Store} from './src/app/store.ts';
const store=new Store('/Users/zwh/.along/stage-b-local/dsh/orchestrator.sqlite');
const settings=store.settings();
store.saveSettings({...settings,sources:{...settings.sources,
  along:{enabled:true,config:{}},github:{enabled:false,config:{}}}});
store.close();
JS
```

先启动该 DSH profile；它首次启动生成桥接凭证，再在另一个终端运行：

```sh
cd /Users/zwh/personal/Along
ALONG_EVENT_INGEST=on \
ALONG_BRIDGE_TOKEN_FILE=/Users/zwh/.along/stage-b-local/data/bridge-token \
ALONG_SUPERAGENT_URL=http://127.0.0.1:3082 \
npm run agent-host
```

`ALONG_SUPERAGENT_URL` 应与这个 profile 的实际回环端口一致。随后 `npm run build`，在 Xcode 中重新安装 App（资源版本 58、Bundle 51），按 Host 打印的地址、指纹与一次性码配对。验收顺序：发「最近睡得不好」应得到回应而无新目标；再发「我想改善睡眠，先从睡前放下手机开始」应自动出现目标和任务；继续发纠正应自动更新。Agent 运行期间可以继续补充要求。Mac 暂不可达时显示待同步，恢复连接后同号补传；不能把网页上的替身验证当成 HealthKit、HTTPS 配对或真机后台验收。
# 目标数据源推荐与官方接入入口（2026-11-17）

主分类 ui，依赖 Along Agent 的目标级数据源推荐和同步契约。用户可观察验收：OKX 交易目标显示 Agent 推荐的 OKX，并可从 App 点击进入 OKX 官方 API 设置；没有健康关联的目标不显示 Apple Health。原健康目标继续使用原生授权和管理。

当前目标页把非 finance 的目标都显示为 Apple Health，且同步投影丢弃数据源。修复将接收目标快照 `dataSources: [{provider, status:"recommended", reason}]`，目前提供者为 `okx`、`apple-health`。Agent 只提供经宿主校验的提供者和理由，不提供可执行网址或连接成功状态；客户端将提供者映射到固定官方入口。OKX 使用 `https://www.okx.com/account/my-api`，按钮为“前往 OKX 设置”，说明只读接入仍待设置。此次没有 OAuth 应用，打开设置网页不代表授权、连接或读到账户。

数据源按目标存储和同步；缓存恢复和旧缓存重放保留目标、任务、草稿与推荐。新协议不按目标标题或关键词猜测数据源。缺少推荐的 custom 目标隐藏来源卡；health 域旧快照仍可显示原生健康入口，custom 健康目标通过服务端的实际健康关联或 Agent 推荐显示。使用现有 iOS 用户点击 HTTPS 外链的系统浏览器路径，不新增权限桥、不收集凭据、不读取真实理财账户。

验证包含：原始复现先失败后通过、来源跨目标隔离、离线重启/旧缓存重放、未知提供者/伪造连接状态/任意 URL 的拒绝、HTML 转义、官方入口链接以及原健康连接回归；全量 check、双端 build、浏览器和原配对 iPhone 分别取证。


## 2026-11-26 聊天等待态

目标：提交原话后立即看到「Agent 正在回复…」，在等待首条可见回复期间跨同步与重渲染保留；收到可见回复、发送失败或进入明确的离线待同步时结束等待，并保留原有反馈。复用现有三点样式、消息状态和聊天页，不新增入口或模式开关。

范围：`web/event-workspace.mjs` 从持久缓存派生等待请求；`web/app.mjs` 在事件工作区渲染等待行，旧 Host 兼容聊天页的三点提示在重渲染后按原目标恢复；复用 `web/style.css` 的 `.agent-thinking`。发送、校验和同步协议不变。

实现：

- 等待态不放在 `agentBusy` 这类瞬时变量里，而是从持久缓存派生。取当前可见范围（已选目标，或未绑定目标时的当前会话）里 seq 最大的用户消息，本机刚提交、还没有服务端 seq 的原话视为最新。以下情况不等待：该原话失败或被拒；它仍在待同步队列且同步已报错（明确的离线待同步）；同一会话已有 seq 更大的可见 assistant 消息。
- 同一范围里更新的原话会取代旧请求（服务端会把旧工作判为 `conflicted_input`），所以等待跟随最新原话；其他会话的消息、后台任务结果（`audience: background` 或 `presentation: execution`）不会提前结束它。
- 渲染复用 `agent-message assistant pending` 与 `agent-thinking` 三点样式和 `role="status"`；旧兼容聊天页的三点提示改由模块状态记录，重新渲染后只在原目标下恢复。
- 资源版本号联动：`web/index.html`、`web/sw.js`、`ios/AlongHealth/Sources/AlongShellView.swift` 的 `build=` 提升到 93。

验收：提交后立即出现「Agent 正在回复…」且可被辅助技术读出；空轮询、同步和重渲染后仍在；同会话可见回复、失败/被拒、离线待同步后消失并保留对应反馈；切到其他目标或新对话时不出现，回到原请求确认仍在等待时恢复；其他会话与后台结果不提前清除；`npm run check` 全绿，build 后源码与两份产物一致。
## 2026-11-26 聊天等待态（第 2 轮：修 PR #71 review 出的缺陷）

根因：等待态的范围判定用 `message.goalId===activeGoalId` 直接筛原话，而本机刚提交、还没被服务端回填 `goalId` 的原话 `goalId` 是 `undefined`（`web/event-workspace.mjs` 的 `submit()`）。会话被绑定到目标那一刻 `activeGoalId` 由 null 变成目标，判定口径随之从「当前会话」切成「这个目标」，原话掉出范围 → `awaiting` 变 `null` → 「Agent 正在回复…」提前消失：既没有可见回复，也没有失败或离线反馈。服务端今天只在 `goal.create` 分支保证回填（along-superagent `src/along/changeset.ts`），所以线上多数时候碰巧是对的；客户端把「还在等」绑在这个服务端并不保证回填的字段上，属于隐藏耦合。

改法：范围规则收成一份（`web/event-workspace.mjs` 的 `visibleScope()`），页面渲染与等待判定共用同一份结论：

- 会话归属只认消息自己的 `conversationId`；目标只决定「这条消息算不算当前可见的目标」。
- 消息所属会话绑定了目标就按那个目标算，没有才回退消息自己的 `goalId`；不再用 `message.goalId===activeGoalId` 直接筛原话。（第 3 轮把优先级再调了一次：消息自己的 `goalId` 在前，会话关联在后——见下。）
- 可见性（`audience: background` / `presentation: execution` 不算可见回复）也在同一份规则里：页面历史与等待判定给出同样的结论（§7：同一件事的两条读取路径要给出同样的结论——原来的分叉正是本缺陷的成因）。

等待态的终止条件（与 `awaitingReply` 一致）：同一会话出现 seq 更大的可见 assistant 消息；该原话失败或被拒；该原话仍在待同步队列且同步已报错（明确的离线待同步）；被更新的原话取代。

旧 Host 兼容路径：`agentPendingRequest` 的清理只认「我这条还是当前的那一条」（id 守卫），不再挂在 `agentConfig===config` 守卫下——请求在途时重新配对会换掉 `agentConfig`，挂在守卫下会留下一条永久的假等待，用户只剩一个永远转圈的界面（§7 已记过这条坑）。`agentBusy` 同理，不再挂在配置守卫下。

实施与验证记录（第 2 轮）：

- 修前失败证据：新增三条回归用例，在未修复的代码上 **3 failed / 71 passed**（`node --test test/app-agent-pending-rerender.test.mjs test/event-workspace.test.mjs test/event-workspace-app.test.mjs`）。两条红在「绑定目标不结束等待：还没有任何可见回复」（工作区级与页面级各一条），一条红在「重新配对后不留永久的假等待」。
- 修复后：同三条 **74 passed / 0 failed**。
- 回退复测：只回退 `web/event-workspace.mjs` 与 `web/app.mjs` 的修复、保留新增用例，三条重新变红（**3 failed / 71 passed**，红在同样三条断言）；恢复修复后重新全绿（**74 passed / 0 failed**）。
- 全量 `npm run check`：**856 tests / 853 pass / 0 fail / 3 skipped**。3 个 skip 是本机缺 docker compose 的环境用例（public IPv4 Compose 入口、来源限流、Tier 2 Linux Compose），与本次改动无关。
- build：`npm run build`（Built 22 files）后 `web/` 与 `ios/AlongHealth/Web/`、`dist/` 的对应文件逐字节一致（`cmp` 校验）；重跑 build 后 `git status` 干净，产物不是手改的。
- 资源版本：`web/index.html` 的 `?v=`、`web/sw.js` 的 `CACHE`、`ios/AlongHealth/Sources/AlongShellView.swift` 的 `build=` 一起提升到 **94**（该轮的临时编号；第 3 轮 rebase 到主线 v97 后，最终随 **v98** 交付，`CFBundleVersion` 随主线保持 **88**）；`ios/AlongHealth/Info.plist` 的 `CFBundleVersion` 本轮不产新安装包——**本轮修复要随下次 App 安装才到达设备**。
- 顺带修掉一条**主线既有失败**（与本次改动无关，但在本分支上会挡住全量检查）：主线给模块说明符加了资源版本参数（`./x.mjs?v=97`）后，`test/helpers/dockerfile-web-dependencies.mjs` 的 import 正则只认「引号紧跟 .mjs」，于是跟不到 web→web 的引用，`web/health.mjs` 从实测闭包里消失，`Dockerfile.host` 的 web COPY 列表与闭包对不上（`test/deploy-orchestration.test.mjs`、`test/security-deploy-hardening.test.mjs` 各红一条）。修法：正则容忍版本参数（版本参数不属于文件名）。按修好的正则重算，主线实测闭包正好是 Dockerfile 已复制的那 7 个文件——镜像的 COPY 列表本来就对，坏的是量闭包的那段代码。
- 仓库没有 PR CI（`.github/workflows/` 只有手动触发的 `pages.yml`），全量检查以本地 `npm run check` 为准。

本轮不做（记录理由）：

- 等待态没有时间上限：Agent 这一轮没在该会话落可见回复时会一直转。加超时属于产品决策（慢回复不该被误杀，§7「别给等用户操作的调用加超时」），且当前没有宿主「本轮结束但无可见回复」的显式信号可用，留待产品决定。
- `role="status"` 可能被整页重建反复朗读：`app.innerHTML` 整体替换 DOM 是既有架构，改它是渲染层重构，不在 bugfix 轮做。记为遗留风险，需真机/VoiceOver 验证。
- 旧 Host 兼容路径的文案与结束点：保留「正在连接 <runtime>…」语义（该路径确实在连接旧运行时），结束条件是拿到 HTTP 回执；与事件工作区路径的差异在此写明。该路径运行期间仍有「Super Agent 编排中…」与禁用的输入框，用户不会没有反馈。
- 旧 Host 兼容路径「在途重新配对」时的失败提示：失败原因仍被 `agentConfig===config` 守卫挡住（避免把旧绑定的错误误报到新绑定上），用户看不到失败提示。本轮只清理等待态，失败提示的去向另议。

## 2026-11-26 聊天等待态（第 3 轮：修独立复核复现出的两条用户路径回归）

第 2 轮的提交 `0632210`（本分支已 rebase 为 `c9d2a72`）通过了上一轮的三条回归，但独立复核在两条基线通过、该提交失败的路径上复现出回归。两条都不是「等待行」的样式或文案问题，而是**归属**问题：谁持有请求、谁持有等待、这条原话属于哪个目标。

### 回归 1：切换目标后原话串到旧目标，当前目标不显示等待

触发：在事件工作区打开目标 A 并发送 → 切到目标 B 再发送。

- 根因：`select()` 保留旧会话根，`submit()` 复用它（`const root=next.conversationId??receipt.event_id`），`visibleScope()` 又用该会话根上的第一条目标关联覆盖 B 的显式 `goalId`。于是 B 的原话被记到 A 的会话上：当前目标看不到自己的原话和「Agent 正在回复…」，切回 A 反而看到 B 的原话。
- 服务端口径：客户端只给**未绑定目标**的会话带 `causation_id`，服务端因此把每条目标内消息各自起一段会话（along-superagent `src/along/inbox.ts` 的 `conversationRoot`）。本地记录必须和它一致，否则本地记录与回执长期分叉，等待行也可能永远等不到同一会话的回复。
- 改法：
  - `submit()`：目标内的消息各自起一段会话（`root=receipt.event_id`），只有未绑定目标的会话沿用旧根（`root=next.conversationId??receipt.event_id`）。
  - `visibleScope()`：目标的判定改成**消息自己的 `goalId` 优先**，缺失时才回退到它所属会话的目标关联。服务端在 `goal.create` 回链时会把会话里的消息改挂到新目标，沿用旧关联会把刚回链的原话判到旧目标上。

### 回归 2：旧 Host 的迟到结果解除新请求的忙碌保护

触发：旧 Host 的请求 A 在途时重新配对并发出新请求 B，B 仍在途时 A 返回失败。

- 根因：旧请求的 `finally` 只用 id 守卫保护等待行，随后仍**无条件**清掉共享的 `agentBusy`。B 的等待行还在，但忙碌保护没了，运行时切换在 B 途中就被放开。
- 改法：忙碌状态有主人（`agentBusyOwner`），只有发起这条请求的那一次能释放它——旧请求的 `finally` 只在 `agentBusyOwner===pendingId` 时清 `agentBusy`。换端（`activateAgentConfig` 的 replaceBinding 分支）时旧绑定的忙碌状态与等待行一并作废：那条等待属于已经换掉的 Host，留着只会转圈。

### 实施与验证记录（第 3 轮）

- 修前失败证据：把两条 DOM 探针固化成仓库里的回归用例（`test/event-workspace-app.test.mjs` 的「switching goals keeps the request, the original message and the waiting row on the new goal」、`test/app-agent-pending-rerender.test.mjs` 的「the old Host response cannot unlock a newer request after pairing again」），在未修复的代码上 **3 failed / 73 passed**（同三个文件）。三条红分别是：切换目标后新目标看不到自己的原话与等待行、旧目标显示别人的原话、旧 Host 的迟到结果放开了运行时切换。
- 修复后：同三个文件 **76 passed / 0 failed**。
- 回退复测：只回退 `web/app.mjs` 与 `web/event-workspace.mjs` 的修复、保留新增用例，三条重新变红；恢复修复后重新全绿。
- 随之更新的一条既有用例：`archiving after switching goals detaches any previously bound conversation root`（`test/event-workspace.test.mjs`）原来断言「切换目标后会话根仍是旧目标的那一个」——那正是回归 1 的成因。断言改为：会话根跟着目标走，旧目标的根不被沿用；该用例要验的「目标归档后会话根被摘掉」这条边界不变。
- 全量 `npm run check`：**887 tests / 883 pass / 0 fail / 4 skipped**（4 个 skip 是环境门控用例：自动部署集成验证需要 `ALONG_AUTO_DEPLOY_INTEGRATION=1`、public IPv4 Compose 入口、Tier 2 Linux Compose 需要 docker compose、来源限流用例需要两个可用的本机来源 IP；与本次改动无关）。
- build：`npm run build`（Built 22 files）后 `web/` 与 `ios/AlongHealth/Web/`、`dist/` 的对应文件逐字节一致（`cmp` 校验）；重跑 build 后工作区无新增差异，产物不是手改的。
- 资源版本：基于最新主线（`a8b4b9b`，Web v97 / App build 97 / `CFBundleVersion` 88），用仓库自带的 `node tools/bump-shell-version.mjs 98` 一起推进 `web/index.html` 的 `?v=`、`web/sw.js` 的 `CACHE`、`ios/AlongHealth/Sources/AlongShellView.swift` 的 `build=` 和全部模块说明符到 **98**；`ios/AlongHealth/Info.plist` 的 `CFBundleVersion` 保持主线的 **88**（本轮不产新安装包）——**本轮修复随下次 App 安装才到达设备**，已装机的 App 仍是旧页面。已装机的 Service Worker 缓存也不会因为这次合入触发更新，离线时可能继续读到旧资源。
- 仓库没有 PR CI（`.github/workflows/` 只有手动触发的 `pages.yml`），全量检查以本地 `npm run check` 为准。

### 本轮不做（记录理由）

- 等待态没有时间上限：与第 2 轮同因，仍是产品决策，且当前没有宿主「本轮结束但无可见回复」的显式信号可用。
- `role="status"` 可能被整页重建反复朗读：既有渲染架构，需真机/VoiceOver 验证。
- 旧 Host 兼容路径的文案与结束点、失败提示的归属：与第 2 轮同因，另议。

### 2026-11-27 会话时间分割线

目标：「聊聊这个目标」的消息流里，按消息发送时间插入居中的分割线，方便回看时辨认每段对话从何时开始。常规界面改动，不新增入口、模式开关或接口。

范围：`web/event-workspace.mjs` 投影可选的 `sentAt` 并导出纯函数 `chatTimeline`；`web/app.mjs` 在气泡渲染处插入 `<time>`；`web/style.css` 增加 `.agent-time-divider`。请求、响应、服务端存储和同步协议都不变。

实现：

- 发送时间取服务端消息行已有的字段，不新增写入路径：用户消息用入队信封的 `occurred_at`（`message.occurredAt`），Agent 回复用落库时间（`message.createdAt`）。`sentAt` 只是前端可选缓存字段，缺失或非法就当这条没有时间。
- 本机刚提交、还没同步成功的原话，按入队信封的 `occurred_at` 参与计算；队列里还在时按同一 `eventId` 补回这个时间。同步回执继续按同一 `eventId` 覆盖本地回显，因此待发原话和它的分割结果都只有一份。
- 判定在整条可见消息列表上算：首条有时间的消息前显示一条；之后与上一条「有时间的消息」比较，间隔达到 30 分钟，或两条在设备本地时区的日历日不同，就在后一条前显示一条。两个条件同时成立只显示一次；同日时间戳倒序不触发门槛。
- 缺时间或时间无效（空串、非字符串、2 月 30 日这类非法日期）的消息保留气泡，但不参与门槛比较，下一条有时间的消息仍与更早那条有效消息比。空列表或全部无有效时间时显示零条分割线。
- 文案按设备本地时区：当天只显示 `HH:mm`，其他日期显示 `YYYY年MM月DD日 HH:mm`。等待态（`view.awaiting`）沿用现有分支，不计入分割。
- 分页按 `after_seq` 递增拉取，按 `eventId` 合并进同一份可见列表后重算，因此页边界沿用同一套相邻判断。旧缓存缺时间字段时按缺失处理，原消息、草稿和游标照常读取。
- 资源版本号用 `node tools/bump-shell-version.mjs 98` 一次推进：入口 `?v=`、Service Worker 的 `CACHE`、原生壳的 `build=` 和全部模块说明符一起到 98；`ios/AlongHealth/Info.plist` 的 `CFBundleVersion` 从 88 提升到 89。

验收：同日间隔 29 分 59 秒无线、恰好 30 分钟有线；23:59 → 00:00 跨日有线，23:00 → 00:00 双条件只出一条；当天与历史文案格式正确；空列表、全部无时间、列表开头或中间缺时间、非法时间都不丢气泡；两页 sync 回放时接缝按相邻消息正确出一条或零条；重复同步同一 `eventId` 不产生重复气泡或重复分割线；断网重开仍保留时间与原文；`npm run check` 全绿，build 后源码与两份产物一致。
