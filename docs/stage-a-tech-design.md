# Along 阶段 A 技术方案设计

> 2026-11-15。阶段 A（骨架与数据契约）的模块级实施设计。规格依据：[决策记录](https://github.com/artstur/along-superagent/blob/feature/along-phase0/docs/along/000-decisions.md)（D1–D17）、[系统架构](https://github.com/artstur/along-superagent/blob/feature/along-phase0/docs/along/001-architecture.md) v0.6 §4/§5/§7/§8/§9、[实施与验收](https://github.com/artstur/along-superagent/blob/feature/along-phase0/docs/along/003-implementation.md) v0.6 §2/§3/§4、[阶段 0 验证](https://github.com/artstur/along-superagent/blob/feature/along-phase0/docs/along/004-phase0-validation.md)、[业务测试用例](business-test-cases.md)。本文不推翻任何已定决策；对规格未拍板的点以 `SD-n` 编号给出决策与理由（§5），实施中方案有变化须回写本文（AGENTS.md §3）。
>
> 设计时基线（2026-11-15，非当前实现状态）：Along Agent（`along-superagent`）分支 `feature/along-phase0`，工作树干净，`src/along/` 尚不存在；`along` 仓库分支 `feature/new-structure`。行号引用以该基线为准。

## 0. 范围与读法

阶段 A 交付（003 §2）：`along.sqlite`、配对、事件 Inbox、对象版本、WorkLink、执行记录登记。验收场景三条：重启后能查目标、任务和完整对话；重复事件不产生重复工作；每次 Worker 结束都有执行记录且未调用模型。

阶段 A **不做**：变化语义筛选与合并（阶段 C）、意图识别与目标/任务 Skill（阶段 B）、记忆提取召回与记忆工具（阶段 D）、批量复盘（阶段 E）、健康授权撤回（D15 不做）、采用/确认/审批环节（D3 禁止新增）。阶段 B 才要求更新的 along 仓库 README、`docs/goal-agent-flow.md` 本阶段不动。

UI 约束：`web/` 页面结构、样式、文案、交互流程零改动。允许触碰的共享文件仅限协议层（§2.4、SD-4），且须按 AGENTS.md §2 联动版本号（§2.7.6）。

## 1. 总览

### 1.1 模块划分与依赖

| 模块 | 仓库 | 核心产出 | 依赖 |
| --- | --- | --- | --- |
| 存储 | Along Agent | `along.sqlite`、Schema 迁移、唯一业务服务层、幂等导入 | — |
| inbox | Along Agent + along | 事件信封、可靠接收、回执、待投递 | 存储、配对、worklink |
| 版本 | Along Agent | 对象版本、ChangeSet 校验与自动提交、Along 业务工具 | 存储 |
| 配对 | along | 配对身份绑定、Host↔Along Agent 回环接口、访问边界 | 存储（接口契约） |
| worklink | Along Agent | 业务对象↔Ticket/Assignment 映射、thread 命名 | 存储 |
| 记录 | Along Agent | Worker 结束宿主登记 RunRecord（不调模型） | 存储、worklink |
| 集成 | along + Along Agent | 装配、端到端联测、迁移备份、红线回归 | 全部 |

### 1.2 数据流

```text
iPhone（web 页面 + iOS 桥）
  │ HTTPS + Bearer 配对 token（Token 只留 Mac：模型/管理凭证不出 Mac）
  ▼
Along Host（现有 Node，host/agent-host.mjs）
  │ ① 配对鉴权 → 绑定 user_id/device_id（不信任请求体身份）
  │ ② 输出校验（validateGoalReply/safeAdaptiveLayout，现状保留）
  │ ③ 本机回环调用（bridge token + x-along-bridge-token）
  ▼
Along Agent 进程（src/along/*，Along 业务服务）
  ├─④ 回环接口（/along-source/api/*）：Schema/归属/去重 → 事务写入 along.sqlite
  │     Inbox + 业务记录（消息/摘要）+ Delivery 待投递 —— 同一事务 → 返回持久回执
  ├─⑤ 投递泵（进程内计时器）：Delivery → SourceContext.receive(Trigger)（至少一次）
  ▼
DSH 核心（不改）：Trigger → Intake 去重 → 评估 → Ticket/Assignment → Worker Session
  ├─⑥ Worker 用 Along 工具读写业务（along_goal_read…along_changes_commit）
  │     ChangeSet 四层校验 → 通过即一个事务原子生效 + 版本推进 + sync_outbox
  ├─⑦ 域事件（ticket.created / assignment.ended …）经 Store.afterCommit 回调：
  │     worklink 写映射；记录模块写 RunRecord（不调模型，D7）
  ▼
along.sqlite（权威业务库） ←→ Host /sync 拉取 → iPhone 展示（BC-00-05）
```

两份权威源互不越界（001 §5.2）：`along.sqlite` 只由 Along Agent 内 Along 业务服务读写；DSH Store 只归 DSH；Host 两边都不直读，只走回环接口。

### 1.3 进程、目录与凭证布局

| 路径 | 内容 | 权限 | 归属 |
| --- | --- | --- | --- |
| `~/.along/along-data/along.sqlite` | 业务库 | 0600 | Along Agent 独占 |
| `~/.along/along-data/bridge-token` | Host→Along Agent 回环凭证（32B hex） | 0600 | Host 读、Along Agent 读，绝不发 iPhone、不进 Worker |
| `~/.along/agent-host/` | Host 现有状态（证书、pairing.json） | 0700 | 本轮不迁移（001 §5.2） |
| `~/.along/memory/` | Hy-Memory 正式数据与索引（阶段 D 接入时启用） | 0700 | 不在 Worker 工作目录内 |
| DSH `stateDir`（profile 配置，如 `~/.dsh/state/superagent`） | orchestrator.sqlite、锁、worker shim、工单目录 | — | DSH 备份语义（docs/006-deployment.md:99），不放业务数据 |

路径经 Along Agent 配置键显式传入、绝对路径校验（`src/deployment.ts:13` 的 `absolute()` 模式），不硬编码；SD-5 记录选位理由。配置键本身**可选**，仅 localDeployment（along 启用且 github 显式关闭）装配时 fail-fast 必填（§2.7.1），不影响现有 GitHub profile。启动时 fail-fast 断言 `alongStateDir` 不在 `executionRoot(settings, machine.stateDir)`（`src/app/execution-environment.ts:18`）之下，否则拒绝启动（BC-07-02 实现侧保证）。目录隔离是约定非沙箱（阶段 0 已实证 Worker 能读 cwd 外兄弟目录，`tests/along-phase0.spec.ts:120-135`）：业务写入只认 Along 工具 + 校验这条红线由服务层强制，不靠目录承诺。

## 2. 模块设计

### 2.1 存储模块（Along Agent）

**职责**：`along.sqlite` 的建库与迁移、唯一业务写入口（存储原语 `AlongStore` + Runtime 装配的门面 `AlongService`）、归属检查、对象版本与输入版本基元、按目标的分页查询、幂等导入。所有业务写入必须经此服务层（001 §5.2），其余模块不得自行拼 SQL 写业务库。

**文件所有权**（拟新增 `src/along/`）：

- 本模块拥有：`src/along/store.ts`（DatabaseSync 打开、PRAGMA、chmod）、`src/along/schema.ts`（DDL 常量）、`src/along/migrate.ts`（schema 版本检查与单事务迁移）、`src/along/service.ts`（服务层门面）、`src/along/legacy-import.ts`（幂等导入）
- 拥有测试：`tests/along-store.spec.ts`
- 只读参照、不修改：`src/app/store.ts`（DatabaseSync 模式与 `atomic()` savepoint 事务，`store.ts:2,58-64,140-153`）、`src/app/migration.ts`（版本检查+单事务迁移的错误包装模式，`migration.ts:19-25,32-34`）、`src/app/versions.ts`（快照+指针模式，仅参考，业务库不用 KV 存版本）、`src/kv.ts`
- EventInbox/Delivery/WorkLink/RunRecord 四张表由本模块建表（§3 DDL），写入逻辑分别归 inbox/worklink/记录 模块，经 `AlongStore` 提供的事务内原语写入。

**对外接口**（完整签名唯一以 §4.3 为准，此处列存储原语）：

```ts
// 存储原语（本模块拥有）。inbox/版本等模块以工厂函数注入它，依赖方向单向（§2.2/§2.3），
// 门面 AlongService 由 Runtime 装配组合，不经门面互相引用，避免 src/along 内部循环 import。
export class AlongStore {
  constructor(path: string): void                       // 打开+迁移；目录锁由 Runtime 持有（要点 2）
  atomic<T>(work: () => T): T                           // savepoint 包裹，复用 store.ts:140-153 模式
  assertUser(userId: string): void                      // user 行 upsert（配对身份首次出现时）
  assertGoalOwner(userId: string, goalId: string): GoalRow   // 归属不符抛 OwnershipError（回环层统一转 404，§4.2）
  assertTaskOwner(userId: string, taskId: string): TaskRow
  currentRevision(kind: 'goal' | 'task', id: string): number
  inputVersion(goalId: string): number                  // 001 §7.4 输入版本
  raiseInputVersion(userId: string, goalId: string, eventId: string): number
  appendMessage(input: AppendMessageInput): MessageRow  // id 按事件锚定、seq 服务端单调分配（要点 4）
  linkMessageToGoals(messageId: string, goalIds: string[], relation: 'direct' | 'derived'): void
  listGoals(userId: string, cursor?: PageCursor): Page<GoalRow>
  goalDetail(userId: string, goalId: string): GoalDetail
  listTasks(userId: string, filter?: TaskFilter, cursor?: PageCursor): Page<TaskRow>
  messagesByGoal(userId: string, goalId: string, cursor?: PageCursor): Page<MessageWithLinks>
  changeSetsByGoal(userId: string, goalId: string, cursor?: PageCursor): Page<ChangeSetRow>
  saveHealthSummary(envelope: EventEnvelope, adapter: 'known' | 'pending'): void   // adapter 由接收层派生（§2.2.4）
  enqueueDelivery(eventId: string, triggerId: string): void
  claimDueDeliveries(now: number, limit: number): DeliveryRow[]
  markDelivered(triggerId: string, at: string): void
  recordDeliveryFailure(triggerId: string, at: string, error: string): { attempts: number; status: 'pending' | 'failed' }
  markDeliveryFiltered(triggerId: string, at: string, reason: string): void
  recordWorkLink(link: WorkLinkInput): void
  recordRunRecord(record: RunRecordInput): void
  appendSync(item: SyncItemInput): void
  syncPage(userId: string, afterSeq: number, limit: number): Page<SyncItem>
  markSynced(userId: string, seqs: readonly number[]): void
}
```

**实现要点**：

1. 打开方式照抄 `src/app/store.ts:58-64`：`mkdirSync(0o700)` → `new DatabaseSync(path)` → `chmodSync(path, 0o600)` → `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL` → 读 `meta.schema_version` → 版本检查（高于当前版本拒绝「新版本库旧程序打开」；低于 `OLDEST_SCHEMA` 拒绝并提示备份恢复）→ 单事务内执行 §3 DDL 与迁移步骤。迁移失败时库不变、句柄关闭（`store.ts:92-100` 的错误包装模式）。
2. 目录独占锁照 `src/app/runtime.ts:91-94` 由 **Runtime 持有**（`lockSync(alongStateDir, { stale: 30_000, onCompromised })`）；`AlongStore` 构造函数只开库与迁移、**不加锁**——同进程对同一目录二次加锁会启动即败。锁与库同目录（`~/.along/along-data/`），Runtime 在 `stop()` 时先关 AlongStore 再释放锁（`runtime.ts:246-251` 顺序）。
3. **所有写入过 `atomic()`**：001 §4.3 的事务性（Inbox+业务记录+待投递同事务）、001 §8.4 的原子提交、幂等导入，都落在这一层；测试以「半途抛错后全量回滚」锁定。
4. `message.id` **按事件锚定**：`msg:<user_id>:<event_id>`（幂等键=事件，重传不新落行）；客户端 `message_id` 只作关联与展示、不参与主键——`task.completed/feedback` 与原消息共用同一 `message_id` 时各落一行不冲突（落行规则见 §2.2.6）。`seq`（消息顺序）为 per-user 单调整数，事务内 `SELECT IFNULL(MAX(seq),0)+1 FROM message WHERE user_id=?` 分配。**不信任客户端时间**：`occurred_at` 只作展示与参考，因果顺序一律按 `seq`（BC-08-07，001 §5.3）。时间归一复用 `src/core/model.ts:17` 的 `isoTime`（Along Agent 同仓库可直接 import）。
5. 版本基元：每对象 `current_revision` 行内单调；`input_version` 独立成表（§3），用户新聊天即提升。ChangeSet 提交的 base_revision / input_version 比较在此之上实现（§2.3）。
6. 幂等导入（BC-09-02）：`legacy-import.ts` 输入旧链路导出 JSON（App localStorage：`along.goal-custom.v1`、`along.goal-conversations.v1`，`web/agent-client.mjs:2-3`）+ 固定稳定 ID 映射表（旧 domain key `health|finance|custom` → `g_health|g_finance|g_custom`；消息按导出顺序重编 `msg:<user>:import:<n>`）。写入一律 `INSERT … ON CONFLICT(id) DO NOTHING`，重复导入不产生重复记录；产出核对报告（目标/任务/对话条数与内容 hash 对照）。已删除且无备份的旧消息不凭摘要或模型推测恢复原文（001 §5.3）。
7. 文件位置常量：`along.sqlite` 与 `bridge-token` 在 `alongStateDir`；`alongStateDir`、`alongBridgeTokenFile` 为 Along Agent 配置**可选键**（集成模块在 `src/deployment.ts` Config 登记，`absolute()` 模式校验），仅 localDeployment 装配时 fail-fast 必填（§2.7.1）——GitHub profile 不受影响。

**错误路径**：schema 版本不符 → 启动失败并给「先备份恢复」指引；归属不符 → `OwnershipError`（回环层统一转 404，与「不存在」同码防存在性泄露，§4.2）；事务内任何抛错 → savepoint 回滚、回执不发（BC-08-01 的失败侧）；磁盘/锁异常 → `onCompromised` 中止运行时（照 `runtime.ts:92`）。

### 2.2 inbox 模块（Along Agent + along）

**职责**：事件信封 Schema 与双端共享校验、可靠接收（事务回执）、去重与冲突、待投递（至少一次送入 DSH）、健康摘要保存（7 类口径）。

**文件所有权**：

- Along Agent 拥有：`src/along/envelope.ts`（zod Schema、`payloadHash`、`envelopeForTrigger` 映射；`BoundIdentity`/`EventEnvelope`/`EventReceipt` 类型定义于此）、`src/along/inbox.ts`（接收状态机，工厂 `createInbox(store)` 注入 `AlongStore`，对外统一入口为门面的 `acceptEvent`）、`src/along/delivery.ts`（投递泵）
- Along Agent 扩展：`src/sources/along.ts` 的触发与线程映射接线由 worklink 模块统一负责（§2.5，单 owner；本模块经 `envelopeForTrigger` 消费其命名函数）——阶段 0 注释已预留 "Authenticated event translation and phone APIs are added in phase A"，`along.ts:1`
- along 拥有：`web/event-envelope.mjs`（拟新增，浏览器+Node 双端共享信封组装/校验；登记 `tools/build.mjs:3` files 与 `web/sw.js:2` FILES）、`web/agent-client.mjs`（待同步队列协议层，不改 UI）、`host/agent-host.mjs`（事件接收端点与回执）
- iOS 仅协议层：`ios/AlongHealth/Sources/AlongShellView.swift` `agentRequest` 路径白名单（`AlongShellView.swift:882-883`）追加新路径；不改视觉与交互
- 测试：`tests/along-inbox.spec.ts`（Along Agent）、`test/event-queue.test.mjs`（along）

**对外接口**：

```ts
// Along Agent src/along/envelope.ts（类型 owner：BoundIdentity/EventEnvelope/EventReceipt 定义于此，§4.6）
export const EVENT_SCHEMA_VERSION = '1'
export const EventEnvelopeSchema: z.ZodType<EventEnvelope>       // §4.1
export type BoundIdentity = { userId: string; deviceId: string }  // Host 绑定身份（回环头注入）
export function payloadHash(envelope: EventEnvelope): string      // 覆盖域固定，见要点 8
export function envelopeForTrigger(envelope: EventEnvelope, identity: BoundIdentity,
  threadId: string): Trigger                                      // Trigger id/threads/actor/human/meta 映射（§4.6）

// Along Agent src/along/inbox.ts（工厂注入 AlongStore，依赖单向；对外统一入口是门面 AlongService.acceptEvent）
export function createInbox(store: AlongStore): {
  acceptEvent(envelope: EventEnvelope, identity: BoundIdentity): EventReceipt
}
export type EventReceipt = { status: 'accepted' | 'duplicate' | 'conflict' | 'rejected';
  event_id: string; received_seq?: number; reason?: string }

// Along Agent src/along/delivery.ts
export function startDeliveryPump(store: AlongStore, deps: DeliveryDeps, signal: AbortSignal): () => void
// DeliveryDeps = { receive(trigger): ReceiveResult | Promise<ReceiveResult>   // SourceContext.receive
//                 , filteredReason(triggerId): string | undefined }            // 经 orchestrator Store 读 disposition
```

**实现要点**：

1. **接收状态机**（统一入口 `acceptEvent`，全部在一个 `store.atomic` 内，BC-08-01），判定顺序固定：
   a0. **显式判定先于 zod 解析**（基于原始 JSON）：`event_type` 为 `along.goal.updated`/`along.goal.archived`（按 `along.*` 前缀全名匹配——阶段 0 探针口径即带前缀，`tests/along-phase0.spec.ts:80`；裸名 `goal.updated` 会落 invalid_envelope 而非 client_goal_mutation，仅拒因精度差异）→ `rejected`（reason=`client_goal_mutation`，BC-01-06 的拒绝逻辑随接收校验先落，rejected 行供「拒绝原因可查」）；请求体含 `user_id`/`device_id` 字段 → `rejected`（reason=`identity_in_body`，BC-07-04 接口侧防线）；
   a. zod Schema 校验（§4.1）→ 不符：原始 `event_id` 是合法 ID 时落 `rejected` 行（reason=`invalid_envelope`）；连合法 `event_id` 都没有的信封不落行、直接 400；
   b. `kind` 范围检查（**读 envelope.kind**——EnvelopeCrossRefine 已保证与 payload.kind 相等、非 along.message 事件不带 kind，§4.1）——与 `src/sources/along.ts:6,11-17` 的范围口径一致：`task.completed`/`task.feedback`/`authorization.changed` 三者合法；`authorization.changed` 按 D15 **接受并记录、不投递、不当作失败**（§2.2.5）；其余 `kind` → `rejected`（reason=`unsupported_kind`）；
   c. `goal_id`/`task_id` 归属检查（`assertGoalOwner`/`assertTaskOwner`）→ 不符 `rejected`（内部 reason=`ownership`，BC-07-05 的归属侧；对外响应统一 not_found，§4.2）；
   d. Inbox 按 `(user_id, event_id)` 查重，**仅对 `status='accepted'` 的旧行判重**：命中且 `payload_hash` 相同 → `duplicate` 回执（BC-08-03）；命中但 hash 不同 → `conflict`（001 §4.3）；**命中 `rejected` 行 → 重新 `rejected`**（返回原 reason，HTTP 400，不是 duplicate——被拒事件同号重试不得伪装成已接收，否则客户端按回执删除本地项会造成静默丢失）；
   e. 业务写入按类型（仅 accepted 分支）：`along.user_message` → `appendMessage`（原文先保存，BC-08-11）；**信封带 `goal_id` 且归属通过时**才 `linkMessageToGoals(relation='direct')` + `raiseInputVersion`（001 §7.4：用户新聊天立即提升输入版本）——**无 `goal_id` 时不提升任何 `input_version`、也不建 link**（没有可提升的目标；新目标由评估产生，commit 应用时回填关联与 `input_version(version=1, raised_by=该事件)`，§2.3.2），消息照常落库不丢弃；`along.health_summary_updated` → `saveHealthSummary`（`adapter` 由服务端派生，§2.2.4）；`along.message kind='task.completed'` → 确定性事实反馈（D4：它是事实、不是对目标的编辑，不经 ChangeSet）：接收事务内按 §2.2.6 落消息行、置 `user_task.status='done'`、更新 `completed_feedback_event_id`、`current_revision+1` 并写 `task_revision`（`origin_event_id`=事件号、`basis_changeset`=NULL）；`kind='task.feedback'` → 只落消息行 + `reply_to` 关联，不改状态不推版本（反馈语义由阶段 B Worker 判定）；`kind='authorization.changed'` → 只落 Inbox 行，无业务写入；
   f. `enqueueDelivery(event_id, trigger_id)`（§4.6 Trigger id 稳定）——**`authorization.changed` 跳过本步**（D15 不投递）；
   g. 事务提交后才返回持久回执（含 `received_seq`）。
2. **投递泵**：`setInterval` 1s（进程内计时器，阶段 0 选定的调度方式，004 §3）调 `claimDueDeliveries(now, limit)`——扫描范围是 `status IN ('pending','failed') AND next_attempt_at <= now` 按 `seq` 序（到期判定唯一来源是 `next_attempt_at` 列，§3）。**单飞防护**：① 进程持 `alongStateDir` 目录锁（§2.1.2）→ 单实例单泵；② claim 即预置租约——被领取行的 `next_attempt_at` 先置 `now + 30_000`（租约 ≥ receive 超时），投递成功/失败再覆写终值；若进程在租约内死亡，行到期后自动重回扫描，至少一次语义不破。对每条构造 Trigger 并 `await receive(trigger)`——`SourceContext.receive` 注释要求完成后再推游标（`src/sources/host.ts:42`）。`ReceiveResult` 有三种（`src/core/intake.ts:8`，`src/app/passes.ts:34-39` 原样透传）：`'stored'` 与 `'duplicate'`（`src/core/intake.ts:23` 稳定 Trigger id 去重）都算送达 → `markDelivered`（status='delivered'）；**`'filtered'` 是终态** → `markDeliveryFiltered`（status='filtered'，经 orchestrator Store 读 disposition 记录 scope 原因——Source 未安装/停用时 `SourceRegistry.scope` 返回 `listened:false`（`src/sources/registry.ts:124-131`），重试不可能成功，不得以 1s 频率无限重试）；异常 → `recordDeliveryFailure`（`attempts+1`，`next_attempt_at = now + 退避`：1s/2s/4s…上限 60s；`attempts ≥ 12` 时置 `failed` 并发 delivery_failed 同步——之后泵仍按 failed 的慢节奏续试，`next_attempt_at = now + 600_000`，10 分钟一次）。至少一次投递，DSH 侧幂等。进程停机时 signal abort，行留库（含租约中的行），重启续投。
3. **明确失败状态**（001 §4.1）：`recordDeliveryFailure` 在 `attempts ≥ 12` 时把 `delivery.status` 置 `failed`，并对 `along.user_message` 事件 `appendSync({kind:'delivery_failed'})`（每个事件只发一次：进入 failed 那次触发），让手机重连后能查到「该请求已登记但处理失败」；**failed 行的重试路径=泵的慢节奏续试**（`next_attempt_at = now + 600_000`，10 分钟一次，§2.2.2），恢复后无需人工清库即自动追上；`'filtered'` 终态同样走该同步路径（用户消息必须得到答复或明确失败状态），但不再重试；不丢弃原文。
4. **健康摘要保存**（001 §4.4，D5）：每份摘要一行（§3 `health_summary`），字段含类型标识、单位、统计方法、窗口、时区、版本、摘要器版本；`availability ∈ ok|no_permission|unavailable|not_synced`，「实际为零」= `availability='ok'` 且 `value=0`，四态可区分（BC-03-11 的存储侧）。**`adapter` 由服务端派生、不采信客户端自报**：信封不携带 adapter 字段（§4.1），接收层按 D5 七类清单（`steps|workout|active_energy|weight|resting_heart_rate|wrist_temperature|sleep`，以 `ios/AlongHealth/Sources/HealthKitReader.swift:56-62` 实测的 7 个 sampleType 为准）判定 `known|pending`——未知类型 `adapter='pending'`，保存但 `along_health_read` 不返回、不进模型上下文（001 §4.4「服务端遇到未知类型标记为待适配」；BC-03-10 的服务端权威判定）。变化语义筛选/合并/多目标拆分是阶段 C，阶段 A 只保存 + 投递 Trigger。
5. **D15**：`along.message kind='authorization.changed'` 与 `src/sources/along.ts:6` 口径一致——接收层接受并记录（信封 Schema 含该 kind，§4.1）、不投递（§2.2.1f 跳过）、不当作失败；不做撤回业务。
6. **任务反馈落行与状态/版本语义**（001 §4.1；D4「完成反馈是事实，不是对目标的编辑」）：`task.completed`/`task.feedback` 各自作为独立事件落一条消息行——`id=msg:<user_id>:<event_id>`，与原消息（可能共用同一 `message_id`）不冲突；`text = payload.note`，无 note 时服务端兜底生成（completed：`任务完成反馈：{task.content}`；feedback：`任务反馈`），保证非空约束有来源；`reply_to_message_id` 指向同 user 内该 `message_id` 的原 user 消息，实现「用同一 `message_id` 关联对话、不当作两次请求」。状态与版本由**接收层确定性变更、不经 ChangeSet**：`task.completed` 把 `user_task.status` 置 `done`、更新 `completed_feedback_event_id`、`current_revision+1` 并写 `task_revision`（`origin_event_id`=事件号、`basis_changeset`=NULL——非 Agent 来源的标记，与 Agent 变更经 changeset 区分）；`task.feedback` 不改状态不推版本。防护口径：后续 `task.update/cancel` 走 ChangeSet 时受 base_revision 校验（反馈已推版本，旧基准自然 conflicted），且不得清除 `completed_feedback_event_id`（BC-02-07「已收到的完成反馈不被覆盖」的机制）。**红线**：健康只发汇总值，不收原始样本（接收层 Schema 无样本字段，zod strict 拒绝多余字段）。
7. **客户端待同步队列**（along 仓库，协议层）：`web/event-envelope.mjs` 导出 `buildEnvelope(...)` 与共享校验（与 Along Agent 同一 Schema 语义的 JS 版本，静态用例向量对齐，见 SD-1/SG-1）；`web/agent-client.mjs` 新增 `queueEvent(config, envelope)`：信封入 localStorage 待同步队列（**重试复用队列中同一份序列化信封，不重新组包**，保证 `payload_hash` 稳定）→ `agentCall('/events', envelope)` → 收到持久回执后按 `event_id` 删除本地项。回执处置口径：`200 accepted|duplicate` → 删除本地项；**`400 rejected` → 终止重试并删除本地项**（本地记录失败状态可查——被拒事件重发不会变成 accepted）；**`409 conflict` → 终止重试并删除本地项**（同号已存在不同内容，重发只会继续冲突）；`401/404/5xx` 与网络失败 → 保留待同步项并同号重试（BC-08-01/02 的客户端断言）。不接到任何 UI 交互（页面零改动）；真机接线随阶段 B 迁移切换。
8. **`payload_hash` 覆盖域固定**：哈希输入为信封中**客户端声明的全部字段**（`event_id/schema_version/event_type/kind/goal_id/task_id/occurred_at/timezone/message_id/causation_id/base_revision/payload`）按 key 排序的稳定 JSON 序列化；服务端绑定字段（回环头）与接收时刻元数据（`received_at`）不参与。客户端重试必须复用同一份序列化信封（§2.2.7），否则同号重试会被误判 conflict（001 §4.3、BC-08-02）。

**错误路径**：`client_goal_mutation`/`identity_in_body`/归属不符/Schema 不符（有合法 `event_id`）→ 落 `rejected` 行并返回 400（对外 reason 统一为 `not_found`/`rejected` 口径，§4.2；内部行记精确原因供「拒绝原因可查」；同号重试返回 rejected 而非 duplicate）；无合法 `event_id` → 400 不落行；`duplicate` 200 / `conflict` 409 仅对 accepted 行成立；投递失败不回滚接收（业务记录已持久），只保留重试与失败状态；`filtered` 终态不再重试；泵异常不阻塞接收路径。

### 2.3 版本模块（Along Agent）

**职责**：对象版本与 ChangeSet 四层校验、自动提交（applied/conflicted/invalid）、幂等重放、写入资格（版本保证）、Along 业务工具注册。

**文件所有权**：

- 拥有：`src/along/changeset.ts`（ChangeSet Schema、校验、应用）、`src/along/tools.ts`（5 个 Along 工具实现）
- 扩展：`src/app/tools/executor.ts`（**注册点**：5 个 Along 工具追加进 `executorTools()` 返回数组，`executor.ts:23-104` 的 `tool()` + zod strict + 宿主绑定模式；装配链路 `runtime.ts:124` `host.tools` → `sessions.ts:261` `register`——不动既有 `orchestrator_*` 工具）、`src/app/sessions.ts`（`WORK_TOOLS`（line 61）追加 Along 工具名；`WORK_TOOLS` 只影响 `restrict` allow 名单的过滤（`sessions.ts:292`），真正注册靠 `executorTools()`——**两处都要改，缺一处工具不可见**）
- 测试：`tests/along-changeset.spec.ts`
- 对齐基准（只读）：`web/goal-agent-core.mjs`（`numberLikeTarget:124`、`validateGoalReply:153`、`requestedTargetFromMessage:76`）、`web/adaptive-ui.mjs`（`safeAdaptiveLayout:225`）

**对外接口**（完整 Schema 见 §4.4/§4.5）：

```ts
// src/along/changeset.ts（工厂注入 AlongStore，依赖单向；门面入口见 §4.3；类型 owner：本模块）
export const ChangeSetInputSchema: z.ZodType<ChangeSetInput>
export function createChangeSetModule(store: AlongStore): {
  commitChangeSet(input: ChangeSetInput, scope: CommitScope): ChangeSetResult
}
export type CommitScope = { userId: string; allowedGoalId?: string;
  ticketId?: string; assignmentId?: string; workId?: string; triggerEventId?: string }
  // 宿主绑定，模型不可指定。工作上下文四项由 workScopeForTicket 反查注入（§2.5，type-only import，
  // 无运行时依赖）：写入 changeset 行的执行来源列（§3 changeset），并供指派一致性检查取
  // user_message 原文（§2.3.1）——缺了该检查永不触发、追踪链落空。
  // triggerEventId 取 **Inbox 事件号**（work_link.event_id），不是 DSH Trigger id：
  // 取原文的键是 message.id = msg:<user_id>:<event_id>（§2.1.4），Inbox 事件号直接可查；
  // trigger_id（'along:<user>:<event>'）带前缀，需解析才可用，不作该键。
export type ChangeSetResult =
  | { status: 'applied'; changeset_id: string; goal_revision: number; reused: false }
  | { status: 'applied'; changeset_id: string; reused: true }            // 同幂等键原结果（BC-02-04）
  | { status: 'conflicted'; reason: string }                             // base/input 版本过时
  | { status: 'invalid'; reason: string }                                // Schema/关联/越权
```

**实现要点**：

1. **四层校验**（001 §8.4，全部在 `atomic` 内按序执行）：
   - Schema 层：zod strict 解析（§4.4）；长度/范围上限与 `validateGoalReply`（`goal-agent-core.mjs:153-169`）对齐——标题 ≤80 非空、任务 ≤120、原因 ≤300、`domain='custom'` 时 metric 必须为 null（`goal-agent-core.mjs:159`）、健康 target 1..10080 整数、其余 1..10000000；**指派一致性**（权威口径与拒绝码见 §4.4，此处同义）：`scope.triggerEventId`（宿主注入，取 Inbox 事件号）指向 `along.user_message` 时，服务端按 `message.id = msg:<user_id>:<event_id>` 取该消息原文，用对齐 `requestedTargetFromMessage`（`goal-agent-core.mjs:76`）的实现比对 `goal.create/goal.update` 的 `metric.target`，不一致 → `invalid`（reason=`target_mismatch`）——旧 DSH 链路已执行该检查（`goal-agent-core.mjs:166-167`、`host/agent-host.mjs:153` 传入用户原话启用），新链路不得比现有基线更弱（校验只能加严）；scope 无 `triggerEventId` 的提交（导入等）跳过该项，`basis:'no_message'` 记入 `changeset.result` JSON 列（applied 后落库，非 `ChangeSetResult` 类型字段）（对齐机制见 SD-1）。
   - 对象关联层：`goal_id` 存在且归属 `scope.userId`；`task.create` 无需 task_id，`task.update/cancel` 的 task 必须属于该 goal；`allowedGoalId` 存在时（Worker 场景）`goal_id` 必须等于宿主绑定的目标（BC-07-04 工具侧防线）。
   - 输入版本层：`input.input_version === store.inputVersion(goal_id)`，不等 → `conflicted`（BC-08-05：旧输入的结果不能提交，不靠提示词）；**`goal.create` 跳过本层与业务版本层的比较**（此时 goal 行与 input_version 行都不存在，要求 `base_revision=0`，`input_version` 忽略并记 1），应用时随 goal 行插入 `input_version(version=1, raised_by=trigger_event_id)`。
   - 业务版本层：`input.base_revision === store.currentRevision('goal', goal_id)`；每个 `task.update/cancel` 另带 `base_revision` 与该 task 当前 revision 比较。任一不符 → `conflicted`（BC-08-04/BC-08-09：并发第二次提交因版本不符被拒，同一目标同一时刻只有一个写入资格——版本检查即硬保证，SQLite 单写者 + 服务层串行）。
2. **自动提交**：全部通过后同一事务内——写 `changeset` 行（status=applied）→ goal `current_revision+1` 并写 `goal_revision`（含 basis=changeset_id、origin_event_id；`goal.create` 首操作时新建 goal 行与 `input_version(version=1, raised_by=trigger_event_id)`，回填 `changeset.goal_id`，并**对来源 user_message 回填 `message_goal_link(relation='direct')`**——该消息接收时无 goal 未建关联，§2.2.1e）→ 逐 op 更新/创建 task 并推进 `task.current_revision`、写 `task_revision` → `appendSync`（变更说明给手机，001 §8.4）→ 提交。中途任何失败整体回滚（BC-02-01/02 的机制在 A 落：invalid/conflicted 不写入任何业务行，仅 `changeset` 行本身记录 status 与 reason 供审计）。
3. **幂等**：`changeset` 表 `(user_id, idempotency_key)` 唯一（§3）；重复提交返回原结果不重放 ops（BC-02-04 机制在 A 落，场景验收在 B）。
4. **状态只有 applied/conflicted/invalid**（001 §5.1、D3）：没有待批准、没有采用；冲突或无效时 Worker 基于最新状态继续（调用方拿到明确结果后自行决定重读重提）。
5. **「改回去」**：`derived_from_changeset` 指向被恢复的 ChangeSet，应用时按该 ChangeSet 的 `goal_revision` 快照生成恢复内容；历史不改写（001 §8.4，BC-00-06 机制就绪）。
6. **Along 工具**（001 §8.3；SD-3 范围）：

   | 工具 | Schema 要点 | 服务端行为 |
   | --- | --- | --- |
   | `along_goal_read` | `goal_id?`（缺省=绑定目标）、`include_revisions?` | 绑定用户与派工范围；返回当前版本/指标/情境；分页 |
   | `along_conversation_read` | `before_seq?`、`limit≤50` | 按 goal 分页消息（含关联变更说明），绑定 goal |
   | `along_task_list` | `status?` | 返回稳定 ID、状态、版本（001 §8.3） |
   | `along_health_read` | `type?` | 检查窗口/可用性/版本；`adapter='pending'` 的类型不返回（待适配不进上下文） |
   | `along_changes_commit` | §4.4 输入，**无 user_id/goal_id 参数**（由宿主绑定注入 scope） | 校验通过即原子生效 |

   注册点：`executorTools()` 返回数组追加 5 个工具（§2.3 文件所有权；`sessions.ts:261` 经 `host.tools` 装配）+ `sessions.ts:61` `WORK_TOOLS` 追加 5 个名字（后者只影响 `restrict` allow 名单，Worker 保留 DSH WORK_TOOLS 不缩小，D8）；工具实现绑定 scope 来自 worklink 模块的 `workScopeForTicket(ticketId): CommitScope`（§2.5，含 ticket/assignment/work/trigger_event 工作上下文），模型不能指定 `user_id`、Ticket 或目标（001 §8.3）。无绑定 goal 的 ticket 只允许 `goal.create` 首操作（阶段 B 的建目标路径，阶段 A 已支持 Schema）。工具实现沿用 `tools/executor.ts` 的 `tool()` + zod strict 模式；Worker 结束后调用被 `sessions.ts:293-296` 的既有 guard 拒绝（无需新代码）。
7. **记忆工具不落**：`along_memory_search/along_memory_forget` 依赖 Hy-Memory 与治理召回（阶段 D，D6），`memory` 表与治理状态读写由存储层就绪即可（SD-3）。
8. **工具执行 API 差异**（004 §5）：沿用批量工具执行 API（Harness 0.2.2，`scripts/along-worker-probe.mjs:16` 注释）；开发依赖（`engines.dsh ^0.2.1-alpha.2`，`package.json:54-57`）与真实 Harness 0.2.2-rc.3 的差异如实记录在实现 PR 与 `docs/along/004` 后续记录中，不硬绕，优先补验但不阻塞。

**错误路径**：`invalid`/`conflicted` 均返回可识别 reason（BC-02-02）；工具层抛错走 DSH 工具错误通道（isError=true + 消息），不部分写库（`atomic` 回滚）；`along_health_read` 对无权限/不可用/未同步返回结构化状态而非空值。

### 2.4 配对与进程间接口模块（along 仓库）

**职责**：配对会话 → `user_id/device_id` 服务端绑定；所有新端点强制配对鉴权与归属检查；Host→Along Agent 回环接口客户端与 Along Agent 侧服务；新旧链路切换开关。

**文件所有权**：

- 拥有：`host/along-bridge.mjs`（拟新增：回环客户端——封装 base URL、bridge token、超时、错误语义）
- 扩展：`host/agent-host.mjs`（配对与 Bearer 校验已在：`agent-host.mjs:25-46` 一次性配对码、pairing.json 0600、`authorized()` at :52-55；扩展为身份绑定 + 新端点）
- Along Agent 侧接口实现在集成模块装配（`src/along/api.ts` 注册路由）；本模块定义契约（§4.2）
- 测试：along `test/along-bridge.test.mjs`（Node 替身模式，参照 `test/recent-health-context.test.mjs:93` 直接替换上游调用的写法）

**实现要点**：

1. **身份绑定**：`pairing.json` 扩展为 `{hash, user_id, device_id}`——首次 `/pair` 成功时生成 `user_id`（`u_` + 8 hex）与 `device_id`（`d_` + 8 hex）；旧文件（仅 `hash`）启动时幂等升级补齐，配对 token 不变、手机无感。`authorized()` 比较逻辑不动（Bearer 64hex + timingSafeEqual，`agent-host.mjs:52-55`）。D1 单用户：一个 pairing.json 即一个绑定会话；新配对（换设备）覆盖旧绑定，`user_id` 不变（同一用户换手机）。**身份注册**：配对完成后 Host 调回环 `POST /along-source/api/pairing`（§4.2）把 `{user_id, device_id}` 注册进 Along Agent；**旧 pairing.json（仅 hash）启动时幂等升级补齐 `user_id`/`device_id` 后同样调用一次注册**（Host 启动且 Along Agent 可达时，幂等可重试）——否则既有已配对设备在不重新配对的情况下 `user_id` 不在 allowed 名单（`src/sources/along.ts:19-24` 的 allowed 默认为空），其 `user_message` 不成 explicit 请求、静默无工作。Along Agent 侧幂等 upsert `user` 行，并把 `user_id` 幂等加入 DSH Policy `sources.along.allowed`（经 Settings 保存）。
2. **所有新端点**（手机侧 `POST /events`、`POST /sync`、`POST /sync/ack`——iOS 桥 `agentRequest` 固定 `POST`（`AlongShellView.swift:888`），不改桥语义；Host→Along Agent 侧方法见 §4.2）在 `authorized(req)` 之后统一从 pairing.json 取 `{user_id, device_id}` 注入请求上下文；**请求体自称的 user_id/device_id 一律不信任**（001 §4.2），Body 内若出现这两个字段则拒绝（reason=`identity_in_body`）。
3. **回环客户端**（`along-bridge.mjs`）：`bridgeCall(path, {method, value})` → `fetch(ALONG_SUPERAGENT_URL + path)`，带 `x-along-bridge: 1`（沿用 `agent-host.mjs:59` 头）与 `x-along-bridge-token: <bridge-token 内容>`；凭证来自 `ALONG_BRIDGE_TOKEN_FILE`（缺失或文件不存在 → 新端点 503「未配置桥接凭证」，旧链路不受影响）；超时与 `HostError` 语义沿用 `superAgentCall`（`agent-host.mjs:56-66`）。15s 超时对 `/events` 不够（含 DSH 投递触发）→ `/events` 用 30s。**存量调用点必须同步带 token**：现状 `superAgentCall`（`agent-host.mjs:215,220,240,246`）与 `superAgentReady` 探测（`agent-host.mjs:70-71`）只发 `x-along-bridge: 1`——Along Agent 契约上线后会对全部 `/along-source/api/*` 校验 token，不改则旧链路一律 401，与 `ALONG_EVENT_INGEST=off`「旧链路照旧」（§2.4.5、BC-09-03）矛盾。改法：Host 进程启动时读一次 `ALONG_BRIDGE_TOKEN_FILE`，`superAgentCall`/`superAgentReady` 统一追加 `x-along-bridge-token` 头（`along-bridge.mjs` 落地后由它承载，存量调用点切到 `bridgeCall`）。现状缺口核实：Host 已调 `/along-source/api/goals|tasks` 但 Along Agent 无任何 `/along-source` 路由（`src/app/http.ts:234` 只注册 `/orchestrator`）——本契约（§4.2）即为补齐目标，两端按同一文档实现并联调，不据现状推定对方已实现（003 §1）。
4. **回环凭证不复用配对 token**（SD-2）：配对 token 已发 iPhone（`agent-host.mjs:187` /pair 响应），泄露面在手机；Along Agent 接口凭证只允许存在于 Mac 两个进程内存中。文件 0600，进程启动读入，不进日志、不进运行结果、不进 Worker 环境（Worker 环境变量来自 `environmentOf` 白名单，`execution-environment.ts:27-36`，天然不含）。
5. **新旧切换开关**：Host 环境变量 `ALONG_EVENT_INGEST`（`off` 默认 / `on`）。`on`：新 `/events`、`/sync` 生效，同时 `/super-agent/goals`、`/super-agent/tasks` 的 DSH 分支返回 409「已切换新链路」（旧适配器停止消费用户输入）；`off`：新端点 503，旧链路照旧。回退 = 改回 `off`，Along Agent 业务库与 DSH 状态不清（BC-09-03/04 的机制）。
6. **信任模型写进实现注释**：Along Agent 信任「持 bridge token 的本机 Host」声明的身份（回环 + 文件凭证 0600）；归属防线在 Along Agent 侧逐请求 `assertGoalOwner`（BC-07-05：用 A 的配对凭证请求 B 的目标 → Host 解析出 user A → Along Agent 查 goal 属 B → **404 不回显内容**，与「不存在」同码防存在性泄露，§4.2）。模型侧防线在工具层（§2.3.6）；两处口径统一为「宿主绑定，模型/手机均不可自报」。
7. **红线**：Kimi token 与配对 token 不发第三方、不留运行结果（`agent-host.mjs:184-185` 现状保持）；DSH 管理端不暴露给 iPhone——Along Agent `/orchestrator` 前缀保持 loopback + same-origin 校验（`http.ts:234-240`），新 `/along-source` 前缀只服务 bridge 调用，不注册进手机可达路径。

**错误路径**：配对码错/过期 → 403（现状）；token 无效 → 401；身份头缺失/非法 → 403；归属不符 → 404（统一码防存在性泄露，§4.2）；Along Agent 不可达 → 502/503（现状 `superAgentCall` 语义）；`conflict` 回执 → 409 透传给手机。

**实现记录（2026-11-15，配对模块）**：① Along Agent 接口层（`src/along/api.ts`）在信封到达 inbox 之前显式拒绝自报身份（`identity_in_body`，接口侧 400）——该路径不落 Inbox rejected 行（落行是 inbox 的 a0，inbox 对直接调用保留同款检查）；② 配对注册的幂等重试=启动既有绑定、/pair 成功、新端点调用时若尚未注册成功则先补注册（不依赖 ALONG_EVENT_INGEST 开关）；③ 桥接凭证随 `x-along-bridge-token` 附着到全部 Host→Along Agent 调用（含情境评估专用 URL 的调用）。

### 2.5 worklink 模块（Along Agent）

**职责**：业务对象 ↔ Ticket/Assignment 映射；DSH thread 命名；D9 派生事件编号约定；锁定「健康事件不恢复人工停止工单」在 Along 事件下不被破坏。

**文件所有权**：

- 拥有：`src/along/worklink.ts`（域事件订阅 + `recordWorkLink`；`threadFor(envelope)` 命名函数）
- 扩展：`src/sources/along.ts`（thread 命名落点：`envelopeForTrigger` 的 `threads` 字段来自本模块函数）
- 只读参照、不修改核心：`src/core/tickets.ts`（`ticket.created:55`、`ticket.resumed:269`、`ticket.ended:361`、`assignment.ended:389`）、`src/core/assignments.ts`（`assignment.started:42`）、`src/core/evals.ts`（`decision.recorded:337`）、`src/core/intake.ts`（`trigger.received:60`；`:41-47` human-stopped/暂停语义）
- 测试：`tests/along-worklink.spec.ts`

**对外接口**（本模块导出；类型 owner：`WorkLinkInput`/`WorkLinkRow` → `src/along/worklink.ts`）：`onDomainEvent(event: DomainEvent): void`（宿主分发入口，§2.5.1）、`threadFor(envelope): string`（thread 命名，§2.5.4）、`deriveTrigger(event, goalId, purpose): Trigger`（D9 编号，§2.5.6）、`openWorksForGoal(goalId): WorkLinkRow[]`（§2.5.5）、`workScopeForTicket(ticketId): CommitScope`（供 `along_changes_commit` 的宿主绑定 scope 反查，§2.3.6；返回值除 `userId/allowedGoalId` 外携带工作上下文 `ticketId/assignmentId/workId/triggerEventId`——前两项与 workId/triggerEventId 分别取自 WorkLink 行与 ticket.origin，**`triggerEventId` = `work_link.event_id`（Inbox 事件号）而非 `work_link.trigger_id`（DSH Trigger id，带前缀需解析），§2.3 对外接口**；`CommitScope` 类型 owner 是版本模块，此处 type-only import）。

**实现要点**：

1. **订阅机制**：Along Agent 已有完整域事件（`src/core/ports.ts:86-102` `DomainEvents`）；`Runtime` 构造 Engine 的 `emit` 回调（`runtime.ts:138`）追加分发：`this.store.afterCommit(() => along.onDomainEvent(event))`。**必须在 `afterCommit` 里**：emit 发生在 Engine 事务内，直接写 along.sqlite 会在 Engine 回滚时留下脏行；`store.ts:159-162` 的 `afterCommit` 恰好「事务回滚则丢弃」。RunRecord 模块同样经此入口（§2.6）。
2. **映射写入**：`ticket.created` → `recordWorkLink({ticket_id, work_id, goal_id?, thread_key, kind:'ticket', trigger_id, event_id})`；`ticket.resumed` → kind=`resume`（同一 ticket 行更新 work_id/thread）；`assignment.started/ended` → 更新 `assignment_id` 列；`ticket.ended` → 记录 ended（清除在途标记）。`work_id` 服务端生成（`w_` + 12 hex），`thread_key` 唯一（§3 UNIQUE）。`decision.recorded` 暂只记入追踪日志，不建行。
3. **业务 ID 与执行 ID 独立**（001 §2）：WorkLink 是唯一映射点；goal/task 查询不依赖 DSH Session 存活。goal_id 来源：Trigger meta（`envelopeForTrigger` 按事件绑定的 goal_id；无 goal 的健康事件为 NULL，阶段 C 拆分后逐目标回填）。
4. **thread 命名**（001 §7.2，`tests/along-phase0.spec.ts:21-25` 的 `goal/exercise/work/<id>` 形态演化）：
   - 有在途工作且消息按服务端记录的关联（`causation_id`/`reply_to`）指向该工作 → `along:goal/<goal_id>/work/<work_id>`；
   - 无 work_id 的新消息（新目标/新要求）→ `along:goal/<goal_id>/request/<event_id>`（已知 goal）或 `along:inbox/<user_id>/<event_id>`（无 goal）；
   - 健康摘要 → `along:health/<user_id>/<event_id>`（阶段 C 再合并进在途工作线程）。
   001 §7.1 约束写进实现注释：一个 goal 的消息不全部进同一 Thread；健康更新 `human=false` 永不伪装（`along-phase0.spec.ts:100-118` 已有非人工健康事件探针，阶段 A 继续锁定）。
5. **写入资格查询**：`openWorksForGoal(goalId): WorkLinkRow[]`（join DSH ticket open 状态经 `worklink` 行的 ended 标记），供 Router/评估判断「合并进在途工作 vs 新建工作」（001 §7.3）；硬保证仍是版本检查（§2.3.1），本查询只做路由参考。
6. **D9 派生事件编号**：`deriveTrigger(event, goalId, purpose)` **由本模块拥有**（`src/along/worklink.ts` 导出，单测归 `tests/along-worklink.spec.ts`；依赖表 worklink 只依赖存储，不依赖 inbox）→ Trigger id `<event_id>::g/<goal_id>::<purpose>`（purpose ∈ `replan|notify|fact`），编号含 goal_id 与用途（001 §7.4）；阶段 A 落函数与映射约定，逐目标拆分评估在阶段 C。
7. **回归锁定**：`tests/along-worklink.spec.ts` 用 `tests/fixtures/host.ts` 的 `startRuntime` 构造「human-stopped ticket + 注入健康事件」场景，断言 ticket 不被恢复、暂停不解除（003 §3；`intake.ts:41-47` 既有语义在 Along 事件下不被破坏）。BC-08-06（同一目标两个工作不重复处理同一句话）的机制=Intake fanout 去重（disposition.fanout，`intake.ts:49-55`）+ 每句一线程设计，本模块以测试锁定：同一 event_id 二次 receive → `duplicate`，不产生第二个 Ticket。

**错误路径**：`recordWorkLink` 抛错只记运行日志与 health entry（`along` kind 声明 `health: ['delivery','records']`），不反噬 DSH 事务（afterCommit 回调错误按 `store.ts:151` 的 report 模式处理，不失败已提交事务）；thread 命名冲突（同 key）→ 断言失败即测试问题，运行时 UNIQUE 约束兜底报错。

### 2.6 记录模块（Along Agent）

**职责**：Worker 结束时宿主自动登记执行记录（D7：不调用模型）；执行记录幂等；**系统侧执行说明消息（outbound）落行的 owner**（§2.6.2）；复盘不做（阶段 E 定时批量）。

**文件所有权**：

- 拥有：`src/along/runrecord.ts`（域事件订阅 + `recordRunRecord`）
- 只读参照、不修改核心：`src/core/engine.ts`（`EngineForExecutor` 事实接口，`engine.ts:174-246,269-270`）、`src/executor/dsh.ts`（`workerSessionId:24`、每 Ticket 一个常驻 Worker Session 与工作目录）、`src/app/sessions.ts`
- 测试：`tests/along-runrecord.spec.ts`

**实现要点**：

1. **纯域事件驱动，不改核心**：`assignment.started` → 确保行（status=running）；`assignment.ended` → 终结行：从 orchestrator Store 只读取 `store.tickets.get(ticketId)` 的最新 `Assignment.report`（`src/core/model.ts:336` `latestReport`）与 `latestAssignment`，补 `ended_at`。`inputsDelivered/turnEnded` 等无域事件的中间事实不落（RunRecord 只需可复盘的登记粒度，阶段 E 复盘读取 DSH Store 明细）。
2. **登记内容**（BC-05-01 字段）：Assignment（ticket_id/assignment_id）、触发事件（经 WorkLink 反查 goal/task/event）、**prompt 版本**（读 `KV.sessions.prompts(workerSessionId)`，`kv.ts:35` 是「各 Session 工作过的 prompt revision 序号」——阶段 A 无 Along Skill，`run_record.prompt_revisions` 列为 Skill 版本的占位口径，阶段 E 接手时扩展为 Skill 版本链，勿按列名误读）、工具轨迹引用（worker Session id + assignment id，引用 DSH 会话记录不复制内容）、结果（report state/summary）、关联 ChangeSet（`changeset.work_id` 反查——commit 时由 `CommitScope.workId` 写入，§4.4）。写入走 `store.recordRunRecord`，`UNIQUE(ticket_id, assignment_id)` 幂等（§3）——宿主重启后 `assignmentInterrupted`（`engine.ts:245-247`）与正常结束并发登记不会重复。**本模块同时是系统侧消息的写入 owner**：`assignment.ended` 时把执行说明（report state/summary 摘要）落一条 `direction='outbound'`、`role='assistant'` 消息行并 `appendSync({kind:'message'})`，使 BC-08-11 的「完整对话」在阶段 A 含用户消息 + 执行说明两个半边；模型聊天答复的直接落行随阶段 B 接线。
3. **红线**：登记只由宿主在域事件回调里完成，全程无模型调用。阶段 A 的「未调用模型」硬判定用**代理口径**：fixtures host 无真实模型调用路径，以 `controller.create`（会话创建，`tests/fixtures/host.ts:171` 的 `vi.fn`）结束前后计数差 0 + 无新增 relay/prompt 投递为断言；business-test-cases §1.2 要求的 DSH 模型调用计数在阶段 E 复盘接线时换真实计数复核。日志不记录 Token（003 §3）。
4. 复盘/记忆提取/Skill 整理是阶段 E 定时批量（D7），本模块不实现调度。

**错误路径**：登记失败不重试阻塞（health entry `records` 报 error），下一条事件仍会为同一 assignment 重写（UNIQUE 幂等 + `assignment.ended` 事件保留在 Store 可重放）。

**实现记录（2026-11-15，记录模块）**：① 终结事实按 Engine 事件清单落位——正常结束路径（report ready/dropped → 工单结束、人工停止）Engine 不逐 Assignment 发 `assignment.ended`（`src/core/tickets.ts:353-357` 直接置 ended 并只发 `ticket.ended`），该事件只在 retry/restart 路径发出（`tickets.ts:172,319`）——RunRecord 终结行挂双事件：`ticket.ended` 终结 `latestAssignment`（读 `latestReport` 补 report、按 work_id 反查 ChangeSet、落执行说明），`assignment.ended` 终结被替换的 Assignment；两路收敛到同一 `UNIQUE(ticket_id, assignment_id)` 行，验收口径不变（每个 Worker 结束都有且只有一行）。`ticket.ended` 只终结已确保过行（`assignment.started` 已发生）的 Assignment，未启动过的 pending Assignment 不登记。② 执行说明落行（§2.6.2）以 `store.atomic()` 整批落（消息行 + `message_goal_link` derived 关联 + `appendSync({kind:'message'})`），出站事件号约定 `out:<ticket_id>:<assignment_id>`（消息 id `msg:<user>:out:<ticket>:<assignment>`，确定性幂等）；悬空 goal 引用时整条说明原子回滚、错误进 `records` health 不阻塞，同一 assignment 的下一条事件重写补齐。③ 「未调用模型」代理断言口径细化：`deliveries` 全量计数在工单结束会被宿主自身的主 Session 回执通知（Effects 队列）污染，断言收窄为 `controller.create` 计数差 0 + worker 会话零新增投递 + candidate 投递零新增（`tests/along-runrecord.spec.ts`）。④ `RunRecordInput` 类型按存储模块已实现现状留在 `store.ts:99`，`runrecord.ts` re-export 作为记录模块契约面（§4.3 的 owner 归属以此为准），未搬类型避免越界改 `store.ts`。

**职责**：装配进两仓库运行时、端到端联测、迁移备份、红线回归、文档与版本号联动。

**文件所有权**：

- Along Agent：`src/app/runtime.ts`（装配 AlongStore/门面/域事件分发；`localDeployment` 判定已在 `src/app/setup.ts:16`）、**`src/along/api.ts`（本模块拥有**：`/along-source/api/*` 回环路由注册与 bridge token 校验——§2.4 只定义契约，避免「以为对方实现」）、`src/deployment.ts`（新增**可选**配置键 `alongStateDir`、`alongBridgeTokenFile`，`absolute()` 模式校验）、`src/app/http.ts` 为路由注册模式参照（`http.ts:230-249`）、`scripts/along-backup.mjs`（拟新增）
- Along Agent 测试：`tests/along-phase0.spec.ts` 扩展为阶段 A 骨架复用、`tests/along-phaseA.spec.ts`（拟新增，端到端）
- along：`host/server.mjs` 与 `host/agent-host.mjs` 的装配与启停顺序（server.mjs 现仅 30 行静态开发服务器，手机入口是 agent-host）；`docs/` 实现文档落 Along Agent `docs/along/`（按 AGENTS.md §3 先文档后实现，本文为唯一设计源，Along Agent 侧只写实现记录不重定方案）
- 门禁：Along Agent `pnpm check`（typecheck + vitest + tsdown build，`package.json:52`）；along `npm run check`（`web/`、`host/` 语法检查 + `test/*.test.mjs`，AGENTS.md §3）

**实现要点**：

1. **Along Agent 装配顺序**（`runtime.ts` 构造函数内，Store 之后）：`localDeployment`（along enabled + github disabled，`src/app/setup.ts:16`）成立时——读 `machine.alongStateDir`/`alongBridgeTokenFile`（**可选配置键**，此时缺省即启动失败并给出配置指引；不成立时不读这两个键，现有 GitHub profile 零影响）→ fail-fast 断言不在 `executionRoot` 之下（§1.3）→ `lockSync(alongStateDir)`（Runtime 持锁，§2.1.2）→ `new AlongStore(join(alongStateDir,'along.sqlite'))` → 组合 inbox/changeset 工厂成门面（§2.1）→ 注册回环路由（`ctx.webServer.register({kind:'prefix', path:'/along-source', handler})`，与 `/orchestrator` 并列，webServer 本就强制 loopback `http.ts:235`）→ `ready` 后 `startDeliveryPump`。停机逆序：停泵 → 关 AlongStore → 关 Store → 释放两把目录锁（`runtime.ts:230-253` 模式）。
2. **域事件分发**：`runtime.ts:138` `emit` 回调改为先 `this.store.afterCommit(() => along.onDomainEvent(event))` 再执行原 notice 逻辑（顺序不影响 notice）；`quiet` 语义不变。
3. **E2E 主验收**（`tests/along-phaseA.spec.ts`，复用 `tests/fixtures/host.ts` 的 `startRuntime/acceptedTicket/runTool` 与 `configuredProbe()/trigger()` 模式，`along-phase0.spec.ts:27-39`）：注入信封 → 断言回执与 along.sqlite 三表（Inbox/业务记录/Delivery）同事务落库 → 投递 → 评估（替身 route accept）→ Ticket + WorkLink → `along_changes_commit`（经 `runTool` 注入 Worker 工具调用）→ applied + 版本推进 + sync_outbox → `assignment.ended` → RunRecord → 重启 Runtime（`stop()` 后再 `startRuntime`，seed 由文件库承载）→ 回环查询完整对话/目标/任务（BC-08-11 端到端）。重复事件注入 → `duplicate` 回执 + 工作计数不变（BC-08-03）。**E2E 前须扩展夹具**：`tests/fixtures/host.ts:238` 的 `webServer.register` 只保留最后一个 handler（`/along-source` 会覆盖 `/orchestrator`，`api()` 只打 `/orchestrator/api`），需改为按前缀分发；`tests/fixtures/deployment.ts` 的 `testMachine` 需补 `alongStateDir`/`alongBridgeTokenFile` 字段。**重启能力**：`startRuntime` 每次都 `mkdtempSync` 新建临时目录（`host.ts:136`）、`stop()` 整目录删除（`host.ts:291`），按现状写不出真重启——须给夹具加 `reuseDir` 选项：`startRuntime(seed?, { reuseDir })` 跳过 mkdtemp 直接在固定目录开 Runtime、对应 `stop()` 跳过 `rmSync`；BC-08-11 的重启 E2E 用同一 stateDir 先 `stop()` 再以 `reuseDir` 重开，断言数据来自沿用的 `along.sqlite`/orchestrator.sqlite 文件（禁止用 seed 重新注入后再断言——那是假绿），重启后按回环查询完整对话/目标/任务（003 §2 验收①）。
4. **迁移备份**（BC-09-01/07）：`scripts/along-backup.mjs` 流程——提示/执行协调停写（Host `ALONG_EVENT_INGEST=off` 且 Along Agent 进程已停止，或经管理端确认 idle）→ 业务库与 orchestrator.sqlite 用 `VACUUM INTO '<备份目录>/…'`（一致性快照，不是文件复制——BC-09-07 明确「不把直接复制写入中的 SQLite 当备份」）→ **DSH stateDir 其余内容一并归档**：工单目录（默认 `<stateDir>/work`，`docs/006-deployment.md:99` 明示「Ticket directories in `work`… Back it up」）与 worker 会话记录（`RunRecord.tool_trace_ref` 引用的 Session 记录属 dsh-session-persistence 持久化，不在 orchestrator.sqlite 内，缺了恢复后轨迹引用悬空、执行现场缺失；**其落盘根目录由 harness 运行时装配，Along Agent 仓与 node_modules 内不可证**——`dsh-session-persistence/lib/index.js` 未暴露存储根路径，实施时须在运行中的 stateDir 实测确认会话记录目录后再按实测路径登记归档，若不在 stateDir 内则把该目录单独加入备份清单）→ Hy-Memory 目录（`~/.along/memory/`，停机时复制）与配置（profile 配置目录、pairing.json、bridge-token 文件）→ 产出清单与各文件 sha256；清单中 BC-09-01 的「Skill 版本」一项显式登记为**阶段 A 不适用**（无 Skill 版本链，prompt 版本已随 orchestrator.sqlite 覆盖），避免验收核对缺项。恢复演练在 BC-09-06（阶段 E），阶段 A 验「备份可用且完整」。
5. **红线回归**（BC-07-01 复检口径）：沿 `along-phase0.spec.ts:120-135` 模式扩展——凭证不进 Worker 的三层保证：① `scrubbedParentEnv` 的**固定敏感名模式**（`/KEY|PASSWORD|SECRET|TOKEN/i` + 剔除 `DSH_` 前缀变量，dsh-subprocess `lib/index.js:32,50-56`，无登记扩展点）自动命中 `ALONG_BRIDGE_TOKEN_FILE` 等 TOKEN 形态变量名——新凭证**按此命名约定命名**即被过滤；② Worker 环境变量只来自 `environmentOf` 白名单（`execution-environment.ts:27-36`），凭证路径/值本就不可达；③ 提示词装配与目录断言沿阶段 0 探针。004 §3.4 的「凭证检查随新增工具与凭证扩展」按此口径理解：扩展的是探针检查覆盖面（加新变量名），不是给依赖包登记名单。`along.sqlite` 与 `~/.along/memory/` 路径断言不在 `executionRoot` 内（BC-07-02 只断言目录不在工作目录内，**不夸大为沙箱**——兄弟目录可读性已被阶段 0 证明）。
6. **版本号联动**（AGENTS.md §2，仅当 web 文件内容变化时）：`web/event-envelope.mjs` 新增 + `agent-client.mjs` 修改 → `tools/build.mjs:3` files 追加 `event-envelope.mjs`、`web/sw.js:2` FILES 追加、`web/index.html` `?v=56→57`、`web/sw.js` `CACHE along-shell-v56→v57`、`ios/.../AlongShellView.swift:444` `build=56→57`；不重装 App 则不动 `Info.plist CFBundleVersion`。`host/*.mjs` 不进产物包，host-only 改动无需升版本号。
7. **已知抖动与版本差处置**：`tests/service-script.spec.ts` 并行时偶发 5 秒超时——全量门禁仅它超时而其余全绿时，先单独复跑该文件（`pnpm exec vitest run tests/service-script.spec.ts`）确认再判，不改超时阈值（004 §3:76）；开发依赖 0.2.1-alpha.2 vs 真实 Harness 0.2.2-rc.3 的工具执行 API 差异：以真实 Harness 为准、如实记录（§2.3.8）。**lib/ 产物同步**：typecheck/test 直接跑 `src/*.ts`，安装插件跑 `lib/`——改完 src 必须整跑 `pnpm check`（含 build），不能以 vitest 通过代替。

## 3. 数据模型（along.sqlite DDL）

单库、单写者（进程持目录锁）。命名 snake_case；时间一律 ISO-8601 UTC 字符串（`isoTime` 归一，字典序=时间序）；JSON 列以 `TEXT` 存储并在服务层 zod 解析。幂等键加 ★。

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,          -- 'schema_version' 等
  value TEXT NOT NULL
);

-- 用户与配对身份（业务归属层；授权名单在 DSH Policy sources.along.allowed，D1 单用户）
CREATE TABLE IF NOT EXISTS user (
  id         TEXT PRIMARY KEY,     -- 'u_xxxxxxxx'，由 Host 配对时生成
  name       TEXT,
  device_id  TEXT NOT NULL,        -- 'd_xxxxxxxx'
  created_at TEXT NOT NULL
);

-- 目标（当前态）
CREATE TABLE IF NOT EXISTS goal (
  id               TEXT PRIMARY KEY,            -- goal_id，服务端生成 'g_' + 12 hex；
                                                -- 幂等导入用固定映射（g_health/g_finance/g_custom）
  user_id          TEXT NOT NULL REFERENCES user(id),
  domain           TEXT NOT NULL,               -- health | finance | custom
  status           TEXT NOT NULL,               -- active | archived
  current_revision INTEGER NOT NULL DEFAULT 0,  -- 对象版本，单调
  origin_event_id  TEXT,                        -- 首次来源事件（导入行可为 NULL）
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_user_status ON goal(user_id, status, updated_at DESC);

-- 目标版本历史（只追加；「改回去」按历史快照生成新 ChangeSet，不改写历史）
CREATE TABLE IF NOT EXISTS goal_revision (
  goal_id     TEXT NOT NULL REFERENCES goal(id),
  revision    INTEGER NOT NULL,                 -- 与 goal.current_revision 对应
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,                    -- ≤80 非空（对齐 validateGoalReply）
  metric      TEXT,                             -- JSON {type,target,unit,period}；target 范围按 domain
  context     TEXT,                             -- JSON 情境/约束数组，可含带期限情境
  status      TEXT NOT NULL,                    -- active | archived
  basis_changeset TEXT,                         -- 生成依据 ChangeSet id（首建/导入为 NULL）
  origin_event_id TEXT,                         -- 来源消息 event_id
  created_at  TEXT NOT NULL,
  PRIMARY KEY (goal_id, revision)
);

-- 用户任务（当前态）；未收到完成反馈不记为未完成（001 §5.1）
CREATE TABLE IF NOT EXISTS user_task (
  id               TEXT PRIMARY KEY,            -- task_id，服务端生成 't_' + 12 hex
  goal_id          TEXT NOT NULL REFERENCES goal(id),
  user_id          TEXT NOT NULL,
  status           TEXT NOT NULL,               -- open | done | cancelled
  content          TEXT NOT NULL,               -- ≤120（对齐 validateTaskReply）
  scheduled_at     TEXT,                        -- 计划时间，可空
  completed_feedback_event_id TEXT,            -- task.completed 事件（事实反馈，D4）
  current_revision INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_goal ON user_task(goal_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS task_user_open ON user_task(user_id, scheduled_at) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS task_revision (
  task_id     TEXT NOT NULL REFERENCES user_task(id),
  revision    INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  goal_id     TEXT NOT NULL,
  content     TEXT NOT NULL,
  status      TEXT NOT NULL,
  scheduled_at TEXT,
  basis_changeset TEXT,                         -- Agent 变更的 ChangeSet id；事实反馈（task.completed，§2.2.6）为 NULL
  origin_event_id TEXT,                         -- 生成来源事件：Agent 变更=触发事件，事实反馈=completed 事件号
  created_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
);

-- 消息（完整对话原文；seq 是唯一因果顺序，BC-08-07）
CREATE TABLE IF NOT EXISTS message (
  id           TEXT PRIMARY KEY,                -- 确定性：'msg:<user_id>:<event_id>' ★幂等（锚定事件，重传不新落行）
  user_id      TEXT NOT NULL,
  event_id     TEXT NOT NULL,                   -- 来源 Inbox 事件（出站系统消息为出站 id）
  role         TEXT NOT NULL,                   -- user | assistant | system
  direction    TEXT NOT NULL,                   -- inbound（手机来）| outbound（系统写下，记录模块落执行说明）
  text         TEXT NOT NULL,                   -- 原文，不存模型隐藏推理
  seq          INTEGER NOT NULL,                -- 服务端接收顺序，per-user 单调 ★
  occurred_at  TEXT,                            -- 客户端声明发生时间，仅展示，不参与排序
  received_at  TEXT NOT NULL,
  timezone     TEXT,
  message_id   TEXT,                            -- 客户端稳定消息号（可空；仅关联与展示，不参与主键——
                                                -- task.completed/feedback 与原消息共用 message_id 时各落一行，§2.2.6）
  causation_id TEXT,                            -- 关联原消息/前置事件（追踪与防循环，001 §4.2）
  reply_to_message_id TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS message_user_seq ON message(user_id, seq);
CREATE INDEX IF NOT EXISTS message_user_client ON message(user_id, message_id)
  WHERE message_id IS NOT NULL;                  -- 回复链反查（非唯一：反馈与原消息可共用 message_id）

-- 消息↔目标多对多（一条消息关联多个目标不复制正文，BC-08-08）
CREATE TABLE IF NOT EXISTS message_goal_link (
  message_id TEXT NOT NULL REFERENCES message(id),
  goal_id    TEXT NOT NULL REFERENCES goal(id),
  user_id    TEXT NOT NULL,
  relation   TEXT NOT NULL,                     -- direct（聊天原文）| derived（健康派生关联）
  PRIMARY KEY (message_id, goal_id)
);
CREATE INDEX IF NOT EXISTS mgl_goal ON message_goal_link(goal_id, message_id);

-- 变更集（状态只有 applied/conflicted/invalid，无待批准；D3）
CREATE TABLE IF NOT EXISTS changeset (
  id             TEXT PRIMARY KEY,              -- 'cs_' + 12 hex
  user_id        TEXT NOT NULL,
  goal_id        TEXT,                          -- goal.create 首操作时为 NULL，应用后回填
  status         TEXT NOT NULL,                 -- applied | conflicted | invalid
  base_revision  INTEGER NOT NULL,              -- 提交时声称的 goal 版本（create 为 0）
  input_version  INTEGER NOT NULL,              -- 提交时看到的输入版本
  applied_revision INTEGER,                     -- applied 后的 goal revision
  idempotency_key TEXT NOT NULL,                -- ★ UNIQUE(user_id, idempotency_key)（BC-02-04）
  trigger_event_id TEXT,                        -- 触发事件
  work_id TEXT, ticket_id TEXT, assignment_id TEXT,   -- 执行来源：commit 时由宿主注入的 CommitScope 写入（§4.4）
  reason         TEXT NOT NULL,                 -- 变更说明（≤300，给手机展示）
  ops            TEXT NOT NULL,                 -- JSON 操作数组（§4.4）
  derived_from_changeset TEXT,                  -- 「改回去」指向被恢复版本
  created_at     TEXT NOT NULL,
  result         TEXT                           -- 应用摘要 JSON（对齐报告用）
);
CREATE UNIQUE INDEX IF NOT EXISTS changeset_idem ON changeset(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS changeset_goal ON changeset(goal_id, created_at);

-- 健康摘要（只收汇总；每份一行全量可追溯，当前值按 user/type 最新未取代行）
CREATE TABLE IF NOT EXISTS health_summary (
  id                 TEXT PRIMARY KEY,           -- 确定性：'hs:<user_id>:<event_id>:<type>' ★
  user_id            TEXT NOT NULL,
  type               TEXT NOT NULL,              -- steps|workout|active_energy|weight|resting_heart_rate|
                                                 -- wrist_temperature|sleep（D5 七类）
  metric_version     TEXT NOT NULL,              -- 读数版本（客户端摘要器）
  window_start       TEXT, window_end TEXT,      -- 窗口（sleep 为睡眠日）
  timezone           TEXT,
  unit               TEXT, statistic TEXT,       -- sum | latest | nightly 等
  value              TEXT,                       -- JSON 汇总值；无值时 NULL
  availability       TEXT NOT NULL,              -- ok | no_permission | unavailable | not_synced
                                                 -- （实际为零 = ok + value 0，四态可区分）
  summarizer_version TEXT NOT NULL,
  adapter            TEXT NOT NULL,              -- known | pending；服务端按 D5 七类清单派生，不采信客户端
                                                 -- （未知类型不进模型上下文，§2.2.4）
  event_id           TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  superseded         INTEGER NOT NULL DEFAULT 0  -- 阶段 C 筛选层维护
);
CREATE UNIQUE INDEX IF NOT EXISTS health_event_type ON health_summary(user_id, event_id, type) ★;
CREATE INDEX IF NOT EXISTS health_current ON health_summary(user_id, type, superseded, received_at DESC);

-- 记忆治理状态（阶段 A 只落表与服务层读写；提取召回在阶段 D，D6/D13/D16）
CREATE TABLE IF NOT EXISTS memory (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  status           TEXT NOT NULL,               -- active | withdrawn | candidate
  scope            TEXT,                        -- JSON 适用范围
  evidence_message_id TEXT,                    -- 来源消息（撤回不删聊天，D13）
  expires_at       TEXT,
  current_revision INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_user_status ON memory(user_id, status);
CREATE TABLE IF NOT EXISTS memory_revision (
  memory_id  TEXT NOT NULL REFERENCES memory(id),
  revision   INTEGER NOT NULL,
  content    TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, revision)
);

-- 事件 Inbox（★ PK 即幂等键；同号同内容 duplicate、不同内容 conflict）
CREATE TABLE IF NOT EXISTS event_inbox (
  user_id        TEXT NOT NULL,
  event_id       TEXT NOT NULL,                 -- 客户端稳定事件号
  schema_version TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  kind           TEXT,
  device_id      TEXT NOT NULL,                 -- 服务端从配对会话绑定，不信任请求体
  goal_id        TEXT, task_id TEXT,
  occurred_at    TEXT, received_at TEXT NOT NULL, timezone TEXT,
  message_id     TEXT, causation_id TEXT, base_revision INTEGER,
  payload        TEXT NOT NULL,                 -- JSON
  payload_hash   TEXT NOT NULL,                 -- sha256(客户端声明字段的稳定序列化，§2.2.8)（冲突判定）
  status         TEXT NOT NULL,                 -- accepted | rejected（duplicate/conflict 不落新行，只在
                                                -- accepted 行上判定；rejected 行同号重试返回 rejected）
  reject_reason  TEXT,                          -- invalid_envelope | client_goal_mutation | identity_in_body
                                                -- | ownership | unsupported_kind | …（对外响应统一 not_found/rejected 口径）
  trigger_id     TEXT,                          -- 送入 DSH 的稳定 Trigger id（accepted 后回填）
  created_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS inbox_type_time ON event_inbox(user_id, event_type, received_at DESC);

-- 待投递（业务库内队列；★trigger_id UNIQUE；至少一次送 DSH，DSH 按 Trigger id 去重）
CREATE TABLE IF NOT EXISTS delivery (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  trigger_id  TEXT NOT NULL,                    -- 'along:<user_id>:<event_id>' 或派生编号
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | failed（慢节奏续试）| filtered（终态：scope 拒绝）
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,             -- 下次重试的到期时间（epoch ms）；泵的唯一到期判定来源，
                                                -- 也是派发租约（claim 后预置 now+30s，§2.2.2）
  last_attempt_at TEXT,                         -- 上次尝试时刻（观测）
  last_error  TEXT,
  delivered_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_trigger ON delivery(trigger_id);
CREATE INDEX IF NOT EXISTS delivery_due ON delivery(status, next_attempt_at, seq);

-- WorkLink（业务对象 ↔ 执行 ID；业务历史不依赖 DSH Session 存活，001 §2）
CREATE TABLE IF NOT EXISTS work_link (
  ticket_id     TEXT PRIMARY KEY,               -- ★ 一工单一行
  assignment_id TEXT,
  work_id       TEXT NOT NULL,                  -- 'w_' + 12 hex ★ UNIQUE
  goal_id       TEXT,                           -- 可空（健康事件未定位目标）
  task_id       TEXT,
  event_id      TEXT,                           -- Inbox 事件号（CommitScope.triggerEventId 来源，§2.3）
  trigger_id    TEXT,                           -- DSH Trigger id 'along:<user>:<event>'（投递去重键，§2.2.2）
  thread_key    TEXT NOT NULL,                  -- 'along:goal/<goal_id>/work/<work_id>' 等 ★ UNIQUE
  kind          TEXT NOT NULL,                  -- ticket | resume
  ended_at      TEXT,                           -- ticket.ended 时回填（在途判断）
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS worklink_work ON work_link(work_id);
CREATE UNIQUE INDEX IF NOT EXISTS worklink_thread ON work_link(thread_key);
CREATE INDEX IF NOT EXISTS worklink_goal ON work_link(goal_id) WHERE ended_at IS NULL;

-- 执行记录（Worker 结束宿主登记，不调模型；★(ticket,assignment) 幂等）
CREATE TABLE IF NOT EXISTS run_record (
  id            TEXT PRIMARY KEY,               -- 确定性：'rr:<ticket_id>:<assignment_id>' ★
  ticket_id     TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  user_id       TEXT, work_id TEXT, goal_id TEXT, task_id TEXT,   -- 经 WorkLink 反查
  trigger_event_id TEXT,
  prompt_revisions TEXT,                        -- JSON：Session 工作过的 prompt revision 序号（kv.ts:35）；
                                                -- 阶段 A 为 Skill 版本占位口径，阶段 E 扩展为 Skill 版本链
  tool_trace_ref TEXT,                          -- worker Session id + assignment id（引用不复制）
  report_state  TEXT, report_summary TEXT,
  changeset_id  TEXT,
  ended_at      TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS run_record_assignment ON run_record(ticket_id, assignment_id);

-- 每目标输入版本（用户新聊天立即提升；旧输入的结果不能提交，001 §7.4；goal.create 时随 goal 行插入 version=1）
CREATE TABLE IF NOT EXISTS input_version (
  goal_id    TEXT PRIMARY KEY REFERENCES goal(id),
  user_id    TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  raised_by  TEXT,                              -- 提升来源 event_id
  updated_at TEXT NOT NULL
);

-- 同步出站（「手机已收到」单独记录；BC-00-05 离线补取）
CREATE TABLE IF NOT EXISTS sync_outbox (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,                    -- goal_updated | task_updated | changeset_note |
                                                -- message | delivery_failed
  goal_id TEXT, task_id TEXT, message_id TEXT, changeset_id TEXT,
  payload     TEXT NOT NULL,                    -- 展示载荷（不含模型隐藏推理）
  created_at  TEXT NOT NULL,
  delivered_at TEXT                             -- 手机 ack 后回填（001 §4.3 三态之一）
);
CREATE INDEX IF NOT EXISTS sync_pending ON sync_outbox(user_id, seq) WHERE delivered_at IS NULL;
```

幂等键汇总：`(user_id,event_id)`（Inbox 主键；duplicate/conflict 仅对 accepted 行判定，rejected 行重试返回 rejected）、`delivery.trigger_id`、`changeset(user_id,idempotency_key)`、`run_record(ticket_id,assignment_id)`、`message.id`（`msg:<user_id>:<event_id>`，确定性 ID）、`health_summary(user_id,event_id,type)`、`work_link.ticket_id/work_id/thread_key`、导入路径的稳定 ID `ON CONFLICT DO NOTHING`。

## 4. 跨模块接口契约

### 4.1 事件信封 Schema（`src/along/envelope.ts` 与 `web/event-envelope.mjs` 同一语义）

```ts
export const EVENT_SCHEMA_VERSION = '1'
export const EVENT_TYPES = ['along.user_message', 'along.health_summary_updated', 'along.message'] as const
export const MESSAGE_KINDS = ['task.completed', 'task.feedback', 'authorization.changed'] as const
// authorization.changed：接受并记录、不投递、不当作失败（D15；与 src/sources/along.ts:6 口径一致，§2.2.1b/f）

const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/)
const ISO = z.string().refine(v => Number.isFinite(Date.parse(v)))

export const EventEnvelopeSchema = z.object({
  event_id: ID,                                   // 重试同号
  schema_version: z.literal('1'),
  event_type: z.enum(EVENT_TYPES),
  kind: z.enum(MESSAGE_KINDS).optional(),          // 仅 along.message；authorization.changed 为空业务载荷
  goal_id: ID.optional(), task_id: ID.optional(),  // 服务端做归属检查；健康事件可不带 goal_id
  occurred_at: ISO,                                // 仅展示；排序不信任（BC-08-07）
  timezone: z.string().min(1).max(64),
  message_id: ID.optional(),                       // 关联对话与展示；不参与 message 主键（§2.2.6）
  causation_id: ID.optional(),                     // 关联原消息/前置事件（防循环）
  base_revision: z.number().int().min(0).optional(),   // 提交时看到的业务版本（可空）
  payload: z.discriminatedUnion('event_type', [
    z.object({ event_type: z.literal('along.user_message'),
               text: z.string().min(1).max(800) }).strict(),                    // 原话
    z.object({ event_type: z.literal('along.health_summary_updated'),
               summaries: z.array(HealthSummaryPayloadSchema).min(1).max(20) }).strict(),
    z.object({ event_type: z.literal('along.message'), kind: z.enum(MESSAGE_KINDS),
               task_id: ID.optional(), completed_at: ISO.optional(),
               note: z.string().max(500).optional(),
               reply_to_message_id: ID.optional() }).strict(),                  // task.* 反馈；
  ]).refine(FeedbackPayloadRefine).refine(EnvelopeCrossRefine),                 // authorization.changed 允许空 payload
}).strict()                                        // user_id/device_id/adapter 不在信封内：服务端绑定/派生
// FeedbackPayloadRefine：kind='task.completed'|'task.feedback' → task_id 必填；kind='authorization.changed'
//   → task_id/completed_at/note/reply_to_message_id 必须缺省（D15：无业务载荷）
// EnvelopeCrossRefine（跨字段一致性，TS 与 web/event-envelope.mjs 同步，两端静态用例向量各补错配样本）：
//   ① payload.event_type === 顶层 event_type——防「顶层 user_message 配 health 载荷」类错配信封
//     通过 zod 后按顶层类型走业务分支、因 text/summaries 缺失才抛错（拒绝安全但原因误导）；
//   ② 仅 event_type='along.message' 可携带 kind，且 envelope.kind === payload.kind；
//     其余 event_type 的 kind 必须缺省（杂散 kind 拒绝）
// HealthSummaryPayload：{ type, metric_version, unit?, statistic?, window?{start,end}|night,
//   timezone, value?, availability: 'ok'|'no_permission'|'unavailable'|'not_synced',
//   summarizer_version }，zod strict——原始样本字段与 adapter（服务端派生，§2.2.4）一律拒绝
```

`payloadHash` 输入为信封中**客户端声明的全部字段**（`event_id/schema_version/event_type/kind/goal_id/task_id/occurred_at/timezone/message_id/causation_id/base_revision/payload`，§2.2.8）按 key 排序的稳定 JSON 序列化；同号同 hash → duplicate，异 hash → conflict（仅对 accepted 行，§2.2.1d）。`web/event-envelope.mjs` 为同一 Schema 的 JS 移植，两端以静态用例向量（fixtures JSON，含合法/越界/未知类型/越权/authorization.changed 各若干条）对齐，任一端改协议必须先改向量（SD-1 对齐机制）。

### 4.2 Host↔Along Agent 回环接口（`/along-source/api/*`，SD-2）

认证：`x-along-bridge: 1` + `x-along-bridge-token: <hex>`（timingSafeEqual 常数时间比较）；仅 loopback（webServer 已强制）。**校验覆盖全部 `/along-source/api/*` 路由，含存量旧端点**（`/along-source/api/goals|tasks` 等，Host 侧经 `superAgentCall` 调用）——Host 启动读一次 `ALONG_BRIDGE_TOKEN_FILE` 后统一追加 token 头（§2.4.3），否则旧链路在新契约下 401、破坏「旧链路照旧」。身份：Host 以 header `x-along-user`、`x-along-device` 传入服务端绑定身份，Along Agent 对信封 Body 中出现的身份字段一律拒绝。

| 端点 | 方法 | 语义 |
| --- | --- | --- |
| `/along-source/api/events` | POST | 事件接收：校验→事务（Inbox+业务+Delivery）→回执。200 `{status:'accepted',received_seq}` / 200 `{status:'duplicate'}` / 409 `conflict` / 400 `rejected{reason}` |
| `/along-source/api/pairing` | POST | 配对注册：`{user_id, device_id}` → 幂等 upsert user 行并把 user_id 加入 Policy `sources.along.allowed`（§2.4.1） |
| `/along-source/api/goals?user_id=&cursor=` | GET | 目标列表（含 current_revision/domain/status） |
| `/along-source/api/goals/:goal_id` | GET | 目标详情：当前 revision + 任务 + 最近变更说明（分页游标） |
| `/along-source/api/goals/:goal_id/messages?before_seq=&limit≤50` | GET | 按目标分页完整对话（001 §5.3） |
| `/along-source/api/goals/:goal_id/changesets?cursor=` | GET | 变更历史（「改回去」依据）；分页随 §4.3 的 keyset `PageCursor`（实现口径：`before_seq` 只用于 messages） |
| `/along-source/api/tasks?user_id=&status=&cursor=` | GET | 任务列表（稳定 ID/状态/版本） |
| `/along-source/api/sync?user_id=&after_seq=&limit=` | GET | 手机同步拉取（sync_outbox 游标） |
| `/along-source/api/sync/ack` | POST | `{seqs:[]}` → 回填 delivered_at |
| `/along-source/api/goals/along-status-probe` | GET | 现状探测端点落为真实 200（`agent-host.mjs:70` 现容忍 404） |

查询参数中的 `user_id` **必须与绑定身份一致，不一致一律 403**——不采信调用方自报身份（BC-07-05 的接口侧防线）。手机侧端点固定 `POST`（iOS 桥 `agentRequest` 硬编码 `request.httpMethod = 'POST'`，`AlongShellView.swift:888`，不改桥语义）；表内 GET 仅指 Host→Along Agent 回环。

错误语义（统一口径，防存在性泄露）：401 bridge token 缺失/错；403 绑定身份头缺失/非法或 query 身份与绑定不一致；404 **目标/任务不存在与不属于绑定用户同一响应**（§2.1 错误路径与 §6 BC-07-05 同码）；400 Schema/参数与事件 `rejected`（对外 reason 统一 `not_found`/`rejected`，内部 Inbox 行记精确原因供「拒绝原因可查」）；409 conflict（仅 accepted 行，§2.2.1d）；503 ingest 开关关闭或服务未就绪。全部响应不含 Token。旧 `/along-source/api/goals|tasks` 的旧版 POST 形态（Host 现调用的 goal 运行接口）保持兼容到阶段 B 迁移完成，由集成模块联调核对（003 §1）。

### 4.3 服务层签名（唯一签名源；存储模块提供，全部同步、事务内安全）

**类型 owner**（各模块不得自行重定义）：`Page`/`PageCursor`/`GoalRow`/`TaskRow`/`MessageRow`/`AppendMessageInput`/`DeliveryRow`/`SyncItemInput`/`TaskFilter` → `src/along/store.ts`（存储）；`EventEnvelope`/`BoundIdentity`/`EventReceipt` → `src/along/envelope.ts`（inbox）；`ChangeSetInput`/`ChangeSetResult`/`CommitScope` → `src/along/changeset.ts`（版本）；`WorkLinkInput`/`WorkLinkRow` → `src/along/worklink.ts`（worklink）；`RunRecordInput` → `src/along/runrecord.ts`（记录）；`Trigger`/`DomainEvent` → `src/core`（不改）。

```ts
type Page<T> = { items: T[]; nextCursor?: string }
type PageCursor = { beforeSeq?: number; limit: number }        // limit ≤ 200
type TaskFilter = { goalId?: string; status?: 'open'|'done'|'cancelled' }

class AlongStore {
  atomic<T>(work: () => T): T                                   // savepoint 包裹，不向外暴露 tx 句柄
  assertUser(userId: string): void
  assertGoalOwner(userId: string, goalId: string): GoalRow      // 归属不符抛 OwnershipError（回环层统一 404）
  assertTaskOwner(userId: string, taskId: string): TaskRow
  currentRevision(kind: 'goal'|'task', id: string): number
  inputVersion(goalId: string): number
  raiseInputVersion(userId: string, goalId: string, eventId: string): number
  appendMessage(input: { userId, eventId, role, direction, text, occurredAt?, timezone?,
    messageId?, causationId?, replyToMessageId? }): MessageRow  // id='msg:<user>:<event>'，seq 事务内分配
  linkMessageToGoals(messageId: string, goalIds: readonly string[], relation: 'direct'|'derived'): void
  listGoals(userId: string, cursor?: PageCursor): Page<GoalRow>                    // goal_user_status 索引
  goalDetail(userId: string, goalId: string): GoalDetail                           // 当前 revision+任务+最近变更说明
  listTasks(userId: string, filter?: TaskFilter, cursor?: PageCursor): Page<TaskRow> // task_goal 索引
  messagesByGoal(userId: string, goalId: string, cursor?: PageCursor): Page<MessageWithLinks>
  changeSetsByGoal(userId: string, goalId: string, cursor?: PageCursor): Page<ChangeSetRow>
  saveHealthSummary(envelope: EventEnvelope, adapter: 'known'|'pending'): void
  acceptEvent(envelope: EventEnvelope, identity: BoundIdentity): EventReceipt   // 门面入口（inbox 工厂实现）
  commitChangeSet(input: ChangeSetInput, scope: CommitScope): ChangeSetResult   // 门面入口（版本工厂实现）
  enqueueDelivery(eventId: string, triggerId: string): void     // INSERT OR IGNORE（★trigger_id）
  claimDueDeliveries(now: number, limit: number): DeliveryRow[]   // 到期判定=status IN(pending,failed) 且
                                                                  // next_attempt_at<=now（§3），领取即置 30s 租约
  markDelivered(triggerId: string, at: string): void
  recordDeliveryFailure(triggerId: string, at: string, error: string): { attempts: number; status: 'pending'|'failed' }
                                                                  // 回填 next_attempt_at 退避值；≥12 转 failed（慢节奏续试）
  markDeliveryFiltered(triggerId: string, at: string, reason: string): void
  recordWorkLink(link: WorkLinkInput): void
  recordRunRecord(record: RunRecordInput): void
  appendSync(item: SyncItemInput): void
  syncPage(userId: string, afterSeq: number, limit: number): Page<SyncItem>
  markSynced(userId: string, seqs: readonly number[]): void
}
// 门面 AlongService 由 Runtime 装配组合（§2.1）；acceptEvent/commitChangeSet/saveHealthSummary 是
// 门面入口，inbox/changeset 工厂只 import AlongStore 类型，无循环 import。
// 读取方法（listGoals/goalDetail/listTasks/messagesByGoal/changeSetsByGoal/syncPage）一律收 userId
// 参数并在方法内部先做归属检查（goal/task.userId === userId 否则 OwnershipError）——BC-07-05 红线
// 收进存储层，调用点（§4.2 端点、§4.5 工具）不得依赖外部先断言。
```

### 4.4 ChangeSet 提交与校验接口（版本模块）

```ts
const ChangeSetInputSchema = z.object({
  idempotency_key: z.string().min(1).max(128),
  goal_id: ID.optional(),                          // goal.create 时缺省；否则必填且==宿主绑定目标
  base_revision: z.number().int().min(0),
  input_version: z.number().int().min(1),
  reason: z.string().min(1).max(300),              // 变更说明，用户可见
  derived_from_changeset: ID.optional(),
  ops: z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('goal.create'), domain: z.enum(['health','finance','custom']),
               title: z.string().trim().min(1).max(80),
               metric: MetricSchema.nullable(), context: ContextArray.nullable() }).strict(),
    z.object({ op: z.literal('goal.update'), fields: z.object({
               title: TitleOpt, metric: MetricOpt, context: ContextOpt }).strict() }).strict(),
    z.object({ op: z.literal('goal.archive') }).strict(),
    z.object({ op: z.literal('task.create'), content: z.string().trim().min(1).max(120),
               scheduled_at: ISO.optional(), task_client_id: ID.optional() }).strict(),
    z.object({ op: z.literal('task.update'), task_id: ID, base_revision: z.number().int().min(0),
               fields: z.object({ content: ContentOpt, scheduled_at: ISO.nullableOpt(),
                 status: z.enum(['open','done','cancelled']).optional() }).strict() }).strict(),
    z.object({ op: z.literal('task.cancel'), task_id: ID, base_revision: z.number().int().min(0) }).strict(),
  ]).min(1),
}).strict())
// MetricSchema：{type: string ≤64, target: int, unit: string ≤16, period: string ≤32}
// target 范围按 domain：health 1..10080，其余 1..10000000（对齐 goal-agent-core.mjs:158）
// goal.update 不允许改 domain；goal.archive 与 task 状态反馈分开（完成反馈来自客户端事件，非 ChangeSet）
```

校验顺序与拒绝码：`invalid_schema`（含：`domain='custom'` 时 metric 必须 null，对齐 `goal-agent-core.mjs:159`；**指派一致性 `target_mismatch`**——`scope.triggerEventId`（宿主注入，§2.3 对外接口；取 Inbox 事件号，取原文键为 `message.id = msg:<user_id>:<event_id>`）指向 `along.user_message` 时服务端取该 Inbox 消息原文、用对齐 `requestedTargetFromMessage`（`goal-agent-core.mjs:76`）的实现比对 `goal.create/goal.update` 的 `metric.target`，与旧链路 `validateGoalReply`（`goal-agent-core.mjs:166-167`、`host/agent-host.mjs:153`）同强度，校验只能加严；scope 无 `triggerEventId` 的提交跳过该项、在 `changeset.result` JSON 列记 `basis:'no_message'`）→ `invalid_relation`（goal/task 不存在、不属绑定 user、task 不属 goal、goal_id ≠ 绑定目标、archive 后再更新）→ `conflicted_input`（input_version 不符；**`goal.create` 跳过本层与下一层**，要求 `base_revision=0`，`input_version` 忽略并记 1，应用时插入 `input_version(version=1)`）→ `conflicted_revision`（base_revision 或任一 task base_revision 不符）→ applied。applied 时把 `scope` 的工作上下文（`ticketId/assignmentId/workId/triggerEventId`）写入 changeset 行的执行来源列（§3），RunRecord 反查与 003 §3 追踪链依赖它；`ChangeSetInputSchema` 本身不含这些字段——宿主注入，模型不可指定。result 返回给 Worker 的字段：`status/changeset_id/goal_revision/reused/reason`。**layout 不进 ChangeSet 协议**（SD-7）：模型不能提交 UI 布局；手机展示布局由服务端在 sync 载荷生成时套用 `safeAdaptiveLayout` 校验后输出。

### 4.5 Along 工具契约（注册进 Worker Session，WORK_TOOLS 追加）

| 工具 | 输入 Schema（strict） | 输出 |
| --- | --- | --- |
| `along_goal_read` | `{goal_id?: ID, include_revisions?: bool}` | `{goal, tasks?, revisions?}` |
| `along_conversation_read` | `{before_seq?: int, limit?: int ≤50}` | `{messages:[{seq,role,text,at}], next_before_seq?}` |
| `along_task_list` | `{status?: 'open'|'done'|'cancelled'}` | `{tasks:[{task_id,status,revision,content,scheduled_at}]}` |
| `along_health_read` | `{type?: enum 7类}` | `{summaries:[{type,value,window,timezone,availability,metric_version}]}`；`pending` 类型不返回 |
| `along_changes_commit` | ChangeSetInputSchema 去 goal_id（宿主注入） | ChangeSetResult |

宿主绑定规则（BC-07-04）：scope = `workScopeForTicket(ticketId)`（worklink 模块提供，§2.5 对外接口，含工作上下文四项，§2.3 对外接口）；无绑定 goal 的 ticket 仅当首个 op 为 `goal.create` 时放行（应用后回填绑定）。schema 中不声明 `user_id` 参数，模型传入即 zod strict 拒绝。

### 4.6 域事件订阅与 Trigger 映射契约

```ts
// Trigger 映射（envelopeForTrigger；发往 SourceContext.receive）
{
  id: `along:${userId}:${eventId}`,                 // ★稳定：重投同 id → intake 'duplicate'（intake.ts:23）
  source: 'along',
  threads: [{ source: 'along', id: threadId }],     // §2.5.4 命名
  actor: { source: 'along', id: userId },
  human: event_type === 'along.user_message',       // task.completed/feedback 阶段 A 恒 false（SD-6），
                                                    // addressed 不设 → 走 admission 推断行，不构成 explicit 请求
  ...(event_type === 'along.user_message' ? { addressed: 'direct' } : {}),
  at: received_at,
  text: user_message ? payload.text : summaryText(payload),   // 评估可读的最小内联上下文
  meta: { event_type, kind?, goal_id?, task_id?, message_id?, causation_id?, schema_version },
}
// 派生事件（D9，阶段 A 落约定）：deriveTrigger(event, goalId, purpose) —— worklink 模块拥有
//   （src/along/worklink.ts，§2.5.6；依赖表 worklink 只依赖存储）
//   id = `${eventId}::g/${goalId}::${purpose}`，purpose ∈ 'replan'|'notify'|'fact'
// 域事件分发：Runtime emit → store.afterCommit(() => along.onDomainEvent(event))
//   事件清单见 src/core/ports.ts:86-102；消费方：worklink（ticket.created/resumed/ended、
//   assignment.started/ended）、记录（同上 + decision.recorded 日志）
// 类型 owner：BoundIdentity/EventEnvelope/EventReceipt → src/along/envelope.ts（inbox）；
//   WorkLinkInput/WorkLinkRow → worklink.ts；RunRecordInput → runrecord.ts；详见 §4.3
```

### 4.7 配置键与凭证清单

| 键/文件 | 位置 | 说明 |
| --- | --- | --- |
| `alongStateDir` | Along Agent profile 配置（deployment Config，**可选键**） | 绝对路径；localDeployment 时 fail-fast 必填（§2.7.1），默认建议 `~/.along/along-data`；GitHub profile 不受影响 |
| `alongBridgeTokenFile` | 同上 | 绝对路径；localDeployment 时 fail-fast 必填；指向 0600 文件 |
| `ALONG_BRIDGE_TOKEN_FILE` | Host 进程环境 | 指向同一文件；缺失 → 新端点 503 |
| `ALONG_EVENT_INGEST` | Host 进程环境 | `off`（默认）/`on`，新旧链路单消费开关 |
| `pairing.json` | `~/.along/agent-host/` | 扩展 `{hash,user_id,device_id}`，0600 |
| `bridge-token` | `~/.along/along-data/` | 32B hex，0600；首次启动生成 |

## 5. 技术选型及理由（含放弃的备选）

| # | 决策 | 选择 | 理由 | 放弃的备选 |
| --- | --- | --- | --- | --- |
| SD-1 / SG-1 | ChangeSet 校验共享方式 | **Along Agent 内 TS 重写适用的检查**（长度/范围/custom=null/指派一致性等全部对齐项，§2.3.1）+ 静态用例向量对齐（fixtures JSON，两端同跑） | ① 重叠项少（长度/范围/指派一致性），复制成本低；② along 仓库无打包器（AGENTS.md §2），Along Agent 是 pnpm/TS 仓，跨仓共享需私有包或 submodule，构建耦合违背「简单是第一需求」；③ 加严红线以 Along Agent Schema 为主，web 实现是基准不是依赖——指派一致性（`validateGoalReply` 的 `goal-agent-core.mjs:166-167`）必须同强度落进 Along Agent 校验，不得比现有基线更弱 | 抽共享 npm 包（两仓发布/安装链路都要改）；Along Agent 直接 import along 仓库 `.mjs`（tsdown 打包路径与双运行时约束冲突） |
| SD-2 / SG-2 | Host↔Along Agent 接口形态 | **沿用 `/along-source/api` 路径族** + 新回环凭证（`x-along-bridge-token`，文件 0600） | Host 侧已按该路径族与 `x-along-bridge:1` 调用（`agent-host.mjs:70,215,220,240,246`），改路径族是无谓破坏；凭证文件先例已有（`ALONG_CONTEXT_REVIEW_TOKEN_FILE`，`agent-host.mjs:46-47`） | 复用手机配对 token（它已发 iPhone，泄露面不同，红线禁止）；Unix socket（绕开 DSH webServer，改动大、无先例） |
| SD-3 / SG-3 | 阶段 A 工具范围 | **5 件**：4 读取 + `along_changes_commit`；记忆工具推迟阶段 D | 004 §4「业务工具按阶段 A 推进」指业务读写基座；记忆检索/撤回依赖 Hy-Memory 与治理召回（D6），阶段 A 无可检索对象，落了也是空壳 | 阶段 A 一并落 `along_memory_search/forget`（无 Hy-Memory 支撑，违反「不为假想需求预留」） |
| SD-4 / SG-4 | 客户端队列边界 | **队列落 web 层**（localStorage + `agent-client.mjs` 协议层），iOS 只加路径白名单 | web 页面跑在 WKWebView、网络全走 iOS 桥（`agent-client.mjs:10-15`）；队列逻辑在 web 层可用 `test/` 的 dom-stub 模式单测，且页面/UI 零改动；iOS 侧只需白名单+超时参数 | 队列落 iOS 原生（要新增原生存储与桥协议，触碰面大、难测，且阶段 A 无 UI 接线需求） |
| SD-5 / SG-5 | 业务库与 Hy-Memory 目录 | **`~/.along/along-data/`（业务库+bridge-token）与 `~/.along/memory/`**，经 Along Agent 配置键显式传入并 fail-fast 校验不在 executionRoot 下 | ① 001 §5.2「数据目录放在 Mac 的 Along 状态目录下」，`~/.along` 即该目录（agent-host、verification 已在）；② 本轮不迁移 `~/.along/agent-host/`，平级新目录零迁移；③ 必须整体在 DSH stateDir 外——默认工单目录就是 `<stateDir>/work`（`execution-environment.ts:18`），放 stateDir 内直接违反 BC-07-02，且 stateDir 属 DSH 备份语义（docs/006-deployment.md:99）；④ 单一 `~/.along` 树便于 001 §5.4 统一备份 | 放 DSH stateDir 内（违反红线）；放 Along Agent 仓内（随代码走，非数据）；硬编码路径（拒绝配置校验） |
| SD-6 | `task.completed/feedback` 的 `human` 标记 | 阶段 A 恒 `human=false`、不设 `addressed`，走 admission 推断行；阶段 B 随 Skill 复核 | 任务完成反馈是事实（D4），不应凭它恢复 ended ticket 或获得 explicit 授权；阶段 0 探针已锁定「非人工健康事件不标人工」同款口径 | `human=true`（会通过 followup 语义恢复工单，越过人工停止保护） |
| SD-7 | 展示布局（adaptive layout） | 不进 ChangeSet 协议；sync 载荷由服务端生成并过 `safeAdaptiveLayout` | 模型输出先过校验再生效（红线）：布局是展示派生物，交给模型提交等于新增一条绕过面；`validateGoalReply`/`safeAdaptiveLayout` 的适用项保留在服务端输出侧 | ChangeSet 携带 layout 字段（扩大校验面，与 D3「校验拒绝坏数据」目标不符） |
| SD-8 | 投递机制 | **业务库 `delivery` 表 + 进程内计时器泵** | BC-08-01 要求 Inbox+业务记录+待投递同一事务——队列必须在 along.sqlite；DSH receive 幂等使至少一次安全；进程内计时器是阶段 0 选定调度方式 | DSH Effects 队列（在 orchestrator 库，无法与 Inbox 同事务）；收到即投（无持久重试，重启丢工作） |
| SD-9 | 业务库引擎 | **node:sqlite DatabaseSync**（照 orchestrator Store 模式） | 零新依赖；`store.ts:2,58-64` 已验证 WAL/FULL/chmod/savepoint 全套模式可复制 | better-sqlite3（新增运行时依赖，还要进 tsdown neverBundle 权衡，无收益） |
| SD-10 | 备份方式 | `VACUUM INTO` + 停机复制目录 | 一致性快照、单文件输出、SQLite 内建；BC-09-07 明确排除直接复制写入中的库 | 文件复制热库（被 BC-09-07 判无效）；backup API（node:sqlite 版本可用性待核，实施时若可用可替换，语义相同） |

## 6. 测试计划（BC 用例 → 测试方式）

测试落点约定：Along Agent 用 vitest（`tests/*.spec.ts` 自动收集），along 用 node:test（`test/*.test.mjs` 自动收集，`npm run check`）。涉及计数的断言写具体数字（business-test-cases §1.2）。

| BC 用例 | 断言要点 | 测试方式与落点 |
| --- | --- | --- |
| BC-08-01 | 回执前三表同事务；失败无回执且全回滚 | Along Agent `along-inbox.spec.ts`：`acceptEvent` 半途抛错 → 库内无任何行；成功 → inbox/message/delivery 三行齐；along `test/event-queue.test.mjs`：回执到达才从待同步队列删除 |
| BC-08-02 | 失败保留、同号重试、成功才删 | along `test/event-queue.test.mjs`（桥替身两次失败一次成功；`400 rejected`/`409 conflict` 属终态处置——删除本地项并记失败状态，`401/404/5xx` 与网络失败保留重试，§2.2.7）；Along Agent 侧重试同 `event_id` → duplicate |
| BC-08-03 | 重复事件不重复工作、重复回执 | Along Agent `along-phaseA.spec.ts` E2E：同信封两次注入 → Ticket/Assignment 计数 1、`{status:'duplicate'}`；`along-worklink.spec.ts` 锁定 WorkLink 行数 1 |
| BC-08-04 | 旧 base_revision → conflicted、状态不变 | Along Agent `along-changeset.spec.ts`：先 commit 推进版本，再旧版本提交 → `conflicted`，goal/task 行内容与 revision 不变 |
| BC-08-05 | 新聊天提升输入版本，旧输入不能提交 | Along Agent `along-changeset.spec.ts`：commit 后 `raiseInputVersion`，再用旧 input_version 提交 → `conflicted_input`（不靠提示词，纯服务层断言） |
| BC-08-06 | 同一目标两个工作不重复处理同一句话 | Along Agent `along-worklink.spec.ts`：按**结果断言**、覆盖两条路径（§2.5.4 线程设计）——① 两个在途工作 + 全新消息：走独立请求线程（无订阅者，`intake.ts:49-58` fanout=0 → Eval 单判），最终只产生一个新 Ticket/一条 Decision→Ticket 链，既有两个工作都不处理该句；② 回复按服务端关联进入在途工作线程（fanout=1）：仅该工作处理，另一工作不重复处理。两路径下该目标的任务数与 ChangeSet 数均不变 |
| BC-08-07 | 补传不按客户端时间重排 | Along Agent `along-store.spec.ts`：两条消息 A(早 occurred_at)、B，按服务端顺序入；补传 A（occurred_at 更早）→ A.seq > B.seq，按目标查询顺序为 B、A；`occurred_at` 仅展示字段 |
| BC-08-08 | 一消息多目标不复制正文 | Along Agent `along-store.spec.ts`：`linkMessageToGoals` 两目标 → message 行 1 条、link 行 2 条、两处查询正文一致 |
| BC-08-09 | 同一目标并发第二次写入被拒 | Along Agent `along-changeset.spec.ts`：同 input_version 两次 commit（串行进程内模拟并发）→ 第二次 `conflicted`；版本计数只 +1 |
| BC-08-11 | 完整对话跨重启可查、含版本基元 | Along Agent `along-phaseA.spec.ts` E2E：`stop()` → 重启 → 回环 `messages`/`goals`/`tasks` 查询内容一致；无模型隐藏推理字段。阶段 A 断言口径：对话=inbound 用户消息 + 记录模块落行的 outbound 执行说明（§2.6.2）；模型聊天答复的直接落行随阶段 B 接线，验收记录写明该口径 |
| BC-07-01 | 三类凭证不进 Worker 环境/目录/提示词 | Along Agent `along-phaseA.spec.ts` 扩展 `along-phase0.spec.ts:120-135` 模式：KIMI/配对/DSH 管理 + bridge token 合成值，断言 Worker env、cwd、prompt 装配均不含（三层保证：scrubbedParentEnv 固定敏感名模式 + environmentOf 白名单 + 探针断言，§2.7.5） |
| BC-07-02 | 业务库/记忆目录不在 Worker 工作目录内 | Along Agent `along-store.spec.ts`：构造 settings 使 executionRoot 为 `<tmp>/work`、alongStateDir 为 `<tmp>/along-data` → 启动成功；反转（inside）→ 启动抛错；只断言路径包含关系，不夸大为沙箱。**判定口径收窄**：business-test-cases 原文「Worker 不能直接改写业务库文件」按「目录放置 + 唯一写入通道」实现口径解释并登记（§7 风险 4） |
| BC-07-03 | 业务状态只认 Along 工具提交 | Along Agent `along-phaseA.spec.ts`：Worker 场景绕过 Along 工具的写入尝试（如对无关路径写文件、经 shell 造行）后断言业务行不变；`along_changes_commit` 通过校验 → 变化。**判定口径收窄**：不按 business-test-cases 原文「对 along.sqlite 直接执行 SQL」构造（Worker 与库同账号同权限，文件系统层面不可满足），按「唯一写入通道 + 版本校验」口径断言并登记（§7 风险 4） |
| BC-07-04 | 模型不能指定身份与目标 | Along Agent `along-changeset.spec.ts`：scope.allowedGoalId=A 时提交 goal B → `invalid_relation`；带 `user_id` 字段 → `rejected(identity_in_body)`；Along Agent `along-inbox.spec.ts`：信封带 user_id → 同 reason（显式判定先于 zod，§2.2.1a0） |
| BC-07-05 | A 的凭证请求 B 的目标被拒不泄露 | along `test/along-bridge.test.mjs`：替身 Host 构造 user A 会话请求 B 的 goal → **404**（与「不存在」同码防存在性泄露，§4.2）且响应体无 B 的任何字段；Along Agent `along-inbox.spec.ts` 同断言（OwnershipError → not_found 路径） |
| BC-07-08 | Worker 保留外部能力、副作用受 Mandate/Policy | Along Agent `along-phaseA.spec.ts`：沿用 `along-phase0.spec.ts:137-159`（WORK_TOOLS 与 Along 工具共存、restrict/guard 生效）；未授权外部操作沿 DSH 既有 Mandate 断言（阶段 0 已验，不重复造） |
| BC-09-01 | 迁移前完整备份 | Along Agent `scripts/along-backup.mjs` 冒烟（集成模块联测时人工执行并记录）：VACUUM INTO 产物可打开、表计数与源一致、含 DSH stateDir 其余内容（工单目录；worker 会话记录按运行中 stateDir 实测路径登记，§2.7.4）、Hy-Memory 目录与配置清单；「Skill 版本」项登记为阶段 A 不适用（§2.7.4） |
| BC-09-02 | 稳定 ID 幂等导入并核对 | Along Agent `along-store.spec.ts`：合成旧导出 JSON 两次 `importLegacy` → 目标/任务/消息计数不变、内容 hash 一致、核对报告字段齐 |
| BC-09-03 | 新旧适配器不同时消费 | along `test/along-bridge.test.mjs`：`ALONG_EVENT_INGEST=on` 时旧 `/super-agent/goals` DSH 分支 409、新端点通；`off` 时反向 |
| BC-09-04 | 回退不删库 | 同上 + Along Agent：切回 off 后 delivery/along.sqlite 行保留、无清库路径（代码审查断言 + 测试确认服务重启数据在） |
| BC-09-07 | 不把热复制当备份 | 集成联测记录：对运行中库执行文件复制并尝试打开（演示失败/校验不通过），备份脚本用 VACUUM INTO 并校验；写在 `docs/along` 实现记录 |
| BC-00-05 | 离线期间变更生效、重连取回 | Along Agent `along-phaseA.spec.ts`：不拉 sync 的场景下 commit → applied；再 `syncPage` → 变更与说明在列；ack 后 delivered_at 回填。真机复验随阶段 B 接线 |
| 回归：健康事件不恢复人工停止工单 | intake 语义在 Along 事件下不破坏 | Along Agent `along-worklink.spec.ts`：human-stopped ticket + 健康事件注入 → ticket 不恢复、暂停不解除（`intake.ts:41-47`） |
| 003 §2 验收：Worker 结束有记录且未调模型 | 模型调用计数硬判定 | Along Agent `along-runrecord.spec.ts`：`assignment.ended` 前后 `controller.create` 计数差 0 + 无新增 relay/prompt 投递（**代理口径**，§2.6.3——business-test-cases §1.2 要求的 DSH 真实模型调用计数在阶段 E 复盘接线时换真计数复核）；RunRecord 行内容齐（prompt_revisions/轨迹引用/ChangeSet 关联） |
| 003 §3 追踪 | 事件→筛选理由→Decision→输入版本→ChangeSet→同步 | Along Agent `along-phaseA.spec.ts` E2E 断言链路各表行存在且互链（inbox.trigger_id → disposition → decision → changeset.trigger_event_id → sync_outbox）；日志无 Token 断言复用凭证探针 |

## 7. 验收对照与风险

**对照 003 §2 阶段 A 验收**：① 重启后能查目标、任务和完整对话 → BC-08-11（Along Agent E2E + 回环查询）；② 重复事件不产生重复工作 → BC-08-03（Inbox 去重 + Trigger id 去重 + WorkLink 唯一映射三层）；③ 每次 Worker 结束都有执行记录且未调用模型 → 记录模块计数断言。阶段 A 全部 P1 用例见 §6 映射；P2（BC-08-07/08、BC-09-03/04/07）同阶段执行不豁免。

**风险与已知边界**（实施中如实记录，不硬绕）：

1. **DSH 版本兼容**（004 §5）：工具执行按真实 Harness 0.2.2 批量 API 实现（`along-worker-probe.mjs:16`）；peerDependencies 仍 0.2.1-alpha.2——补验结论记录到 `docs/along/004`，不阻塞开工。
2. **`service-script.spec.ts` 抖动**：全量门禁仅它超时而其余全绿时，单独复跑 `pnpm exec vitest run tests/service-script.spec.ts` 再判，不改阈值（004 §3:76）。
3. **lib/ 产物同步**：单独 vitest 通过 ≠ 已安装插件更新；交付前必须整跑 `pnpm check`（含 tsdown build）。
4. **目录隔离不是沙箱**：红线靠放置位置 + Along 工具唯一写通道 + 校验实现。business-test-cases.md BC-07-02/03 的原文措辞（「Worker 不能直接改写业务库文件」「通用写入不改变目标与任务状态」）在文件系统层面不可满足——Worker 与库同用户同权限（0600 挡不住同账号写，阶段 0 已实证兄弟目录可读）。**阶段 A 交付记录必须显式登记这两条的判定口径收窄**：目录不在工作目录内（路径断言）+ 业务写入只认 Along 工具（绕过工具的写入路径业务行不变，由服务层与版本校验保证）+ 版本检查；并建议阶段 B 更新 business-test-cases.md 的措辞对齐实现口径，避免验收时按原文判失败。
5. **旧链路兼容**：阶段 A 保留旧 `/super-agent/goals|tasks` 链路与输出校验（`agent-host.mjs:146-175`）不动；新旧单消费由 `ALONG_EVENT_INGEST` 保证；阶段 B 迁移 UI 后旧端点下线。
6. **本设计未验证项**：本文为方案，所有断言以 §6 测试执行为准；`node:sqlite` 在 Node 22 的 backup API 可用性未核（SD-10 已给等价替代）；Along Agent 侧 `/along-source` 路由与 Host 新端点的真实联调（真机 HTTPS + 配对）在集成模块执行时完成，本阶段交付物为 Along Agent/along 测试全绿 + 联测记录。
