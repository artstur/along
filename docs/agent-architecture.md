# Along 新架构入口

> 2026-11-15 更新。当前有效方案在相邻的 `along-superagent` 仓库；本页替代 2026-11-14 的云端、多用户与逐次复盘草案。方案尚未实现，不代表当前 App 能力。

两个仓库按同级目录检出后，可从以下文档阅读：

- [决策记录](../../along-superagent/docs/along/000-decisions.md)：已定边界与原因。
- [本地 Agent 系统架构](../../along-superagent/docs/along/001-architecture.md)：首期 Mac 单用户、事件接入、可靠同步、目标与任务自动维护。
- [记忆与技能](../../along-superagent/docs/along/002-memory-and-skills.md)：Hy-Memory、记忆治理、定时批量复盘与 Skill 自动发布。
- [实施与验收](../../along-superagent/docs/along/003-implementation.md)：阶段 0 到 E、数据迁移与验收条件。

目标与任务校验后自动生效，目标只能通过聊天改变。明确行动意图才自动建目标；仅描述现象先回应，缺少意图才询问。普通变化只在目标里展示，需要用户回答、近期安排有实质变化或执行受阻时才通知。「忘记这件事」撤回对应记忆，不删除历史聊天，也不能从旧聊天重新激活该记忆。

迁移前的代码行为见 [目标与 Agent 技术链路](goal-agent-flow.md)。其中的采用流程、目标编辑入口与首次建目标的特殊处理均是待迁移行为，不作为新架构规范。
