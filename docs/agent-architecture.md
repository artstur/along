# Along 架构与开发入口

## 工程命名与整理范围（2026-11-16）

- **目标**：产品工程称为 Along，Agent 工程在文档、代码注释和测试描述中统一称为 **Along Agent**。
- **范围**：整理两仓库的开发入口、实现状态和跨仓引用；DSH 核心机制与 Along 扩展规范分别保留，后者集中在相邻工程的 `docs/along/`。
- **实现**：替换用来指代工程的旧称及测试替身变量名；保留本地目录 `../along-superagent/`、包名与插件 ID `dsh-superagent`、远端地址、API、运行时、环境变量和数据目录。Git 仓库派生、进程派生等技术含义仍使用原术语。
- **验收**：两仓库不再用旧称指代 Agent 工程；启动与跨仓路径仍可解析；文档区分已实现、历史记录与未验收事项；Along 的 `npm run check` 与 Along Agent 的 `pnpm check` 通过，构建产物由脚本生成。

## 当前实现与规范

> 2026-11-16 核对。Along Agent 位于相邻 `../along-superagent/`，当前源码、方案与验证记录在该仓库 `main`；历史阶段记录仍保留当时的分支与测试结果。完整架构尚未全部完成；以下实现状态与历史验收记录分开阅读。

| 范围 | 当前状态与入口 |
| --- | --- |
| A：业务基座 | 存储、配对、事件队列与版本机制已实现；[阶段 A 设计](stage-a-tech-design.md)与[集成记录](https://github.com/artstur/along-superagent/blob/main/docs/along/005-phase-a-integration.md) |
| B：聊天闭环 | 最小聊天、自动建目标与聊天纠正已实现；[阶段 B 实施与启动](stage-b-tech-design.md) |
| C：健康跟进 | 前后台摘要队列、逐目标筛选、自动派工与任务调整已实现；[阶段 C](stage-c-tech-design.md)；需重新安装 App，真机后台机会仍待验收 |
| D：长期记忆 | Runtime、工具与 SQLite 降级已接通；[记忆实施](https://github.com/artstur/along-superagent/blob/main/docs/along/006-memory-implementation.md)；扩大质量集与长期稳定性待验收 |
| E：批量作业 | [定时记忆维护](https://github.com/artstur/along-superagent/blob/main/docs/along/008-scheduled-maintenance.md)已接通，可配置 `alongMaintenanceTime`；完整复盘、Skill 自动发布及回退待实现 |

## 文档分工

完整导航见[文档索引](README.md)。

本仓库记录手机、Web 与 Host 的设计及验收；Along Agent 的 `docs/along/` 保存系统规范与服务端实施记录。远端链接沿用实际仓库地址，本地按相邻目录查阅。

- [决策记录](https://github.com/artstur/along-superagent/blob/main/docs/along/000-decisions.md)：已定边界与原因，含记忆更新的 D18。
- [本地 Agent 系统架构](https://github.com/artstur/along-superagent/blob/main/docs/along/001-architecture.md)：目标架构；具体完成范围以上表及实施记录为准。
- [记忆与技能](https://github.com/artstur/along-superagent/blob/main/docs/along/002-memory-and-skills.md)：记忆治理、批处理与 Skill 版本设计。
- [实施与验收](https://github.com/artstur/along-superagent/blob/main/docs/along/003-implementation.md)：阶段范围、验收门槛和迁移边界。
- [业务测试用例](business-test-cases.md)：业务验收标准与执行记录，未执行项不等于已通过。
- [阶段 0 验证](https://github.com/artstur/along-superagent/blob/main/docs/along/004-phase0-validation.md)：前置验证快照，后续接线以上表各阶段记录为准。
- [目标与 Agent 技术链路](goal-agent-flow.md)：新链路入口和旧 Host 兼容路径说明。
- [离线恢复历史方案](offline-health-review-plan.md)：旧 Host 兼容路径的参考草案。

## 交互边界

目标与任务校验后自动生效，目标只能通过聊天改变。明确行动意图才自动建目标；仅描述现象先回应，缺少意图才询问。普通变化只在目标里展示，需要用户回答、近期安排有实质变化或执行受阻时才通知。「忘记这件事」撤回对应记忆，不删除历史聊天，也不能从旧聊天重新激活该记忆；不因此自动取消目标或重排现有任务。

多目标冲突优先遵守用户明确的优先级和硬约束，其余由 Agent 自动协调，无法同时满足硬约束时才询问。首期不做额外的健康授权撤回及关联历史数据清理流程，不设应用侧每日预算或累计模型用量上限。

采用流程、目标直接编辑与首次建目标的特殊处理仅属于旧 Host 兼容路径，不作为新事件链路规范。

## 工程命名整理的历史验收（2026-11-16，302 项测试快照）

- 全仓核对文档、代码注释、测试描述与替身名称，统一工程称呼为 Along Agent；保留 Git 仓库及进程派生等技术术语，以及现有目录与 `dsh-superagent` 标识。
- 更新两工程 README、实现状态与历史方案标记；本地文档链接目标均存在（提示词中的 `actual link` 是写法示例）。
- Along `npm run check`：302 项通过；Along Agent `VITEST_MAX_WORKERS=4 pnpm check`：80 个文件、1532 项通过，类型检查与构建通过。
- Along `npm run build`：18 个文件与 `dist/`、iOS 内置资源逐字节一致；两仓库 `git diff --check` 通过。本次未部署或进行真机验收。


## Agent 提醒计划与统一通知通道（2026-11-16）

主分类 agent / client，依赖 [Along Agent PR #5](https://github.com/artstur/along-superagent/pull/5) 的 reminder-plan 协议（最终合并后补完整 SHA），主仓独立分支负责消费、系统排程和回执。验收条件：用户用自然语言说明行动与节奏后，Agent 同时安排未来提醒、时区与重复规则；原任务上可读其安排及理由，iPhone 系统待发与原任务身份一致。

现有职责无需新建独立 Notification 服务：Along Agent 负责语义编排与合法 ChangeSet；任务调度负责到期工单、复查和沿既有委托续排；host/task-notifications.mjs、web/event-workspace.mjs 与 EventTaskNotifications.swift 组成统一投递模块，负责持久路由意图、幂等、重试、改期/撤销、系统回读和深链。keep 不产生额外即时通知。此次不为模块命名搬迁已有代码。

合同：任务沿用 scheduledAt 作为首个/当前 occurrence，可选 reminderPlan 为 scheduled（source:user/agent、explanation、repeat:once/daily/weekly、timezone:IANA、weekly 时 weekday:ISO1–7）、needs_time（question）或 off（reason:opt_out/untimed）。缺少计划或时区的旧快照仍按原一次性 scheduledAt 处理，不推断重复。计划数据由 Agent 校验后提供，Web 再验证并保留离线缓存。对现有任务补排经真实用户消息/Agent 工单和合法 task.update，保留原任务身份及正文；禁止直接写正式 SQLite。

Web 将计划传至已有原生桥。iOS 在首个时刻与系统下一次重复触发相符时，按原时区创建每日/每周 calendar trigger，App 不打开也保留重复。首个时刻更晚时先一次排程，避免提前触发；系统真实触发时间及 repeats 均独立回读。一次/每日/每周、跨午夜/时区、首时刻过去、重启、改期/取消和完成均需覆盖。完成/取消/关闭提醒撤回系统队列，同步重放不重复增加。通知点击仍定位原 goal/task。

Host 排程回执沿用原 expectedUserId 与 reminders，每行含 goalId/taskId/revision/scheduledAt；可选 repeat（daily/weekly）、timezone、weekly 的 weekday 和 firstScheduledAt；可选 wallTime 保留原民用钟点的 ISO 锚点。scheduledAt 必须来自系统实际 nextTriggerDate，firstScheduledAt 是有效开始锚点。Host 仅在时区、民用钟点、周几与锚点一致时据此抑制后续已在手机排程的同 occurrence，不将 Agent 计划等同系统排程。accepted/pending、delivered 和 opened 分开记证。

交付验证使用隔离合成数据，不回灌旧目标或演示内容。正式验证只补用户授权的现有两任务，并分别读取 Agent 原工单、合法 ChangeSet、系统 pending/下次时刻/重复规则。近未来验收通知只证明通道及点击，不替代真实任务排程。APNs 签名与服务凭据仍缺时，如实保留远程新决策即时送达待验。公开 Web、Host、iPhone 源版本、构建/部署/安装/启动和实际用户观察分别登记到工作区发版台账。


本次源码验证：完整 check 371 项通过，18 个 Web 资源由 build 同步到 dist 与 iOS。固定 c019515 的独立复核 50 项和 7 项原生回读条件通过，generic iOS 无签名编译通过。回归发现并修复了首次迟到登记误抑制、DST 跳时/重复钟点、系统秒精度、矛盾 wallTime、过期锚点误标下次，以及重复请求未实际入系统仍确认的缺陷。真机与正式 Agent 结果在工作区发版台账另行记录；这些源码检查不代替系统 pending、实际送达或用户点击。
