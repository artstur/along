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

代码落点：Along `web/event-workspace.mjs`（协议与缓存）、`web/app.mjs`（既有入口接线）、`host/agent-host.mjs`（能力协商与配对登记门）；fork 的 `tools.ts`、`inbox.ts`、`store.ts`、`changeset.ts`、`worklink.ts` 与内置 Along 目标/任务 Skill。

- 创建工单最初没有目标；首个有效 ChangeSet 创建目标后，后续工具调用由宿主自动绑定到同一目标。客户端和 Worker 都不能自行换目标 ID。
- 业务 ChangeSet 的完整校验保持不变。工具层把 `goal.create` 分为 custom 与数值域两种参数形状：custom 的 metric 只能省略或为 null，由宿主固定补 null；health/finance 必须给完整 metric。这样去掉定性目标的冗余参数；`{}` 或自定义 metric 仍被拒绝，不做宽松转换。
- Harness 0.2.2 先要求工具结果为 lossless JSON，之后才渲染。可选对象字段中的 `undefined` 必须省略；数组中的 `undefined`、非有限数和非 JSON 对象仍拒绝。已用失败复现和独立只读核实确认，并纳入回归。
- 页面前台空轮询不重建表单；有变化时保留未发送文字、焦点、选区与滚动位置。旧连接退休后不能用迟到响应覆盖新连接的缓存。
- 工单执行说明保存在完整服务端记录中，手机聊天只展示实际答复；普通同步不发通知。

### 2026-11-16 收尾核对

- Along：`npm run check` 290 项通过；构建后 18 个源码文件与两份产物逐字节一致。
- fork：`VITEST_MAX_WORKERS=4 pnpm check` 77 个文件、1484 项通过，类型检查与构建通过。限制测试并行数，不修改超时阈值或断言。
- 独立只读核实通过：lossless JSON、严格参数、同 work 创建后绑定、不能用无效 stop 变相忽略聊天。
- 真实 Harness 0.2.2-rc.3 / MiniMax-M3.1-Flash 合成验证通过：现象先回应不建目标；明确意图建立 custom 目标且没有数值指标；聊天纠正更新任务；3 条答复落库且工单结束。证明在 fork 忽略目录 `.artifacts/along-phaseb-chat-ready/proof.json`；失败的早期探针没有计作通过。验证进程已停止。
- Playwright 390×844（原生桥/响应替身）：目标和任务自动展示，草稿及焦点跨空轮询保持，没有横向溢出、旧接口请求或控制台错误。
- Xcode 27.2 对 generic iOS 目标的无签名构建成功；尚未在实际 iPhone 上安装、配对或验证离线重连。健康新协议、记忆宿主接线及完整迁移恢复仍待后续实施。

## 本地验证与手机连接

不需要 iPhone 的验证：

```sh
cd /Users/zwh/personal/along-superagent
pnpm check
pnpm exec vitest run tests/along-phaseB.spec.ts
cd /Users/zwh/personal/Along
npm run check
npm run build
```

手机连接新链路需要一个已配置可用模型的**独立 Along DSH profile**。按 fork 的 `docs/006-deployment.md` 安装本地 bundle、启用 `dsh-superagent-along` 并关闭 GitHub 插件。给该 profile 的配置加入绝对路径，例如新建本地测试数据：

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

这个 profile 的持久 Source 设置必须同时为 Along enabled、GitHub disabled（只关闭插件不足以选择本地部署）。对**新建且尚未启动的测试目录**，可在 fork 根目录初始化；已有正式数据按迁移/备份流程处理，不用此步骤替代迁移：

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
