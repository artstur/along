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
