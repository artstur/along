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


### 2026-11-26 聊天等待态

目标：提交原话后立即看到「Agent 正在回复…」，在等待首条可见回复期间跨同步与重渲染保留；收到可见回复、发送失败或进入明确的离线待同步时结束等待，并保留原有反馈。复用现有三点样式、消息状态和聊天页，不新增入口或模式开关。

范围：`web/event-workspace.mjs` 从持久缓存派生等待请求；`web/app.mjs` 在事件工作区渲染等待行，旧 Host 兼容聊天页的三点提示在重渲染后按原目标恢复；复用 `web/style.css` 的 `.agent-thinking`。发送、校验和同步协议不变。

实现：

- 等待态不放在 `agentBusy` 这类瞬时变量里，而是从持久缓存派生。取当前可见范围（已选目标，或未绑定目标时的当前会话）里 seq 最大的用户消息，本机刚提交、还没有服务端 seq 的原话视为最新。以下情况不等待：该原话失败或被拒；它仍在待同步队列且同步已报错（明确的离线待同步）；同一会话已有 seq 更大的可见 assistant 消息。
- 同一范围里更新的原话会取代旧请求（服务端会把旧工作判为 `conflicted_input`），所以等待跟随最新原话；其他会话的消息、后台任务结果（`audience: background` 或 `presentation: execution`）不会提前结束它。
- 渲染复用 `agent-message assistant pending` 与 `agent-thinking` 三点样式和 `role="status"`；旧兼容聊天页的三点提示改由模块状态记录，重新渲染后只在原目标下恢复。
- 资源版本号联动：`web/index.html`、`web/sw.js`、`ios/AlongHealth/Sources/AlongShellView.swift` 的 `build=` 提升到 93。

验收：提交后立即出现「Agent 正在回复…」且可被辅助技术读出；空轮询、同步和重渲染后仍在；同会话可见回复、失败/被拒、离线待同步后消失并保留对应反馈；切到其他目标或新对话时不出现，回到原请求确认仍在等待时恢复；其他会话与后台结果不提前清除；`npm run check` 全绿，build 后源码与两份产物一致。
