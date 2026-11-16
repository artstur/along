# Along 新架构入口

2026-11-16：阶段 C 健康事件自动跟进已实现，覆盖原生前后台摘要队列、按目标筛选、自动派工和校验后的任务调整；需要重新安装 App，真机后台机会仍待验收。见 [阶段 C 设计与验收](stage-c-tech-design.md)。

2026-11-16：已实现记忆定时维护的 DSH 工单闭环，支持在 Superagent 的 Deployment / Plugin Manager 配置中设置 `alongMaintenanceTime`（Mac 本地时间，默认 `03:00`，保存后生效）。[设计与验收记录](https://github.com/artstur/along-superagent/blob/feature/along-phase0/docs/along/008-scheduled-maintenance.md)位于相邻仓库；不涉及手机页面或资源版本变更。

> 2026-11-16 更新。当前有效方案在相邻的 `along-superagent` 仓库 `feature/along-phase0` 分支；本页替代 2026-11-14 的云端、多用户与逐次复盘草案。阶段 A 基座与 B 最小聊天闭环已有实现，记忆已接入 Runtime 和定时维护；完整架构尚未完成，见 [阶段 B 实施范围](stage-b-tech-design.md)。

远端文档见以下链接；本地开发时，对应文件位于相邻的 `along-superagent/docs/along/`：

- [决策记录](https://github.com/artstur/along-superagent/blob/feature/along-phase0/docs/along/000-decisions.md)：已定边界与原因。
- [本地 Agent 系统架构](https://github.com/artstur/along-superagent/blob/feature/along-phase0/docs/along/001-architecture.md)：首期 Mac 单用户、事件接入、可靠同步、目标与任务自动维护。
- [记忆与技能](https://github.com/artstur/along-superagent/blob/feature/along-phase0/docs/along/002-memory-and-skills.md)：Hy-Memory、记忆治理、定时批量复盘与 Skill 自动发布。
- [实施与验收](https://github.com/artstur/along-superagent/blob/feature/along-phase0/docs/along/003-implementation.md)：阶段 0 到 E、数据迁移与验收条件。
- [业务测试用例](business-test-cases.md)：阶段 A–E 的业务验收场景，含 D1–D17 决策的硬判定。
- [技术验证记录与剩余项](https://github.com/artstur/along-superagent/blob/feature/along-phase0/docs/along/004-phase0-validation.md)：基础链路已做冒烟，版本兼容、记忆质量与稳定性、手机联调和完整恢复等尚未验收。

目标与任务校验后自动生效，目标只能通过聊天改变。明确行动意图才自动建目标；仅描述现象先回应，缺少意图才询问。普通变化只在目标里展示，需要用户回答、近期安排有实质变化或执行受阻时才通知。「忘记这件事」撤回对应记忆，不删除历史聊天，也不能从旧聊天重新激活该记忆；不因此自动取消目标或重排现有任务。

多目标冲突优先遵守用户明确的优先级和硬约束，其余由 Agent 自动协调，无法同时满足硬约束时才询问。首期不做额外的健康授权撤回及关联历史数据清理流程，不设应用侧每日预算或累计模型用量上限。

迁移前的代码行为见 [目标与 Agent 技术链路](goal-agent-flow.md)。其中的采用流程、目标编辑入口与首次建目标的特殊处理均是待迁移行为，不作为新架构规范。
