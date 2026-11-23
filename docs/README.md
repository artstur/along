# Along 文档索引

产品启动入口见[仓库 README](../README.md)，修改代码前读[项目约定](../AGENTS.md)。当前实现以 `main` 源码为准；文档里的设计方案、测试快照和真机验收分别记录。

## 当前使用与实现

| 需要了解什么 | 入口 | 阅读边界 |
| --- | --- | --- |
| 两工程分工、当前能力与待验事项 | [架构与开发入口](agent-architecture.md) | 实现状态的导航，不替代逐端验收 |
| 一条命令启动、事件聊天与自动生效 | [阶段 B](stage-b-tech-design.md) | 含运行步骤及当时的最小闭环验收 |
| 授权健康摘要、可靠补传与自动跟进 | [阶段 C](stage-c-tech-design.md) | 自动测试、合成模型与真机证据分列 |
| iPhone OKX 只读成交、账单与复盘口径 | [历史接入契约](okx-trade-history.md) | 明细私有、窗口与分页覆盖、分币种确定性报告 |
| 云端部署与 2 用户（host/agent 上云、配对多绑定、Runbook） | [云端部署与多用户](cloud-deploy-multi-user.md) | 设计与施工记录；上线按 Runbook §6.4 由用户手动执行 |
| 云端公网安全加固（应用准入、配对会话、容器与凭证面；G-1～G-22） | [云端安全加固](cloud-security-hardening.md) | 设计、实施偏差记录（§8）与上线手动步骤；CA 信任迁移另见下行 |
| iPhone 根证书描述文件、系统信任与旧叶指纹迁移 | [CA 描述文件与 TLS 迁移](iphone-ca-profile-design.md) | 用户已选路线；代码与自动化回归已完成（PR #42），真机安装/完全信任/撤根仍待执行，不能视为已部署 |
| iPhone 安装、桥接、HealthKit 与签名 | [iPhone README](../ios/README.md) | 系统和设备要求以当前工具链为准 |
| Agent 运行时、派工及长期记忆 | [Along Agent 当前运行图](https://github.com/artstur/along-superagent/blob/main/docs/along/009-current-runtime.md) | 在独立 Agent 仓库维护 |

## 设计与验收依据

- [阶段 A 设计](stage-a-tech-design.md)：骨架、存储及协议设计，保留设计时基线与行号。
- [业务测试用例](business-test-cases.md)：业务验收标准；未登记执行结果的项目不能视为已通过。
- [Along Agent 决策](https://github.com/artstur/along-superagent/blob/main/docs/along/000-decisions.md)、[目标架构](https://github.com/artstur/along-superagent/blob/main/docs/along/001-architecture.md)及[实施范围](https://github.com/artstur/along-superagent/blob/main/docs/along/003-implementation.md)：已定边界、设计目标与已实现范围分开查阅。

## 兼容与历史参考

- [技术链路与旧 Host 参考](goal-agent-flow.md)：开头列现行事件入口，第 1–8 节是旧双运行时及采用流程，不作为新协议规范。
- [健康评估离线恢复草案](offline-health-review-plan.md)：旧 Host 的历史方案；现行补传以阶段 A/B/C 为准。
- [新目标返回修复](bugfix-new-goal-back.md)：PR #16 的行为与验收标准；后续归档问题见本轮质量记录。

## 开发与质量流程

- [修 bug Goal Prompt](bugfix-goal-prompt.md)：复现、独立核实、回退检测、交付及已踩过的坑。
- [两仓库质量与文档整理 Goal](code-quality-goal.md)：可复用 Prompt、本轮方案与验证记录。

历史验收中的日期、构建号、提交和测试条数均保留原值。跨仓链接指向 GitHub 各自 `main`；本地开发仍采用 `Along/` 与 `along-superagent/` 相邻布局。
