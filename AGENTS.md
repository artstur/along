# Along 项目约定

这里只写代码里看不出来、做错就会出问题的事。产品说明见 `README.md`，iPhone App 见 `ios/README.md`，接口和参数以代码为准。

## 1. 简单是第一需求

页面已经花了大量时间重构和简化。默认做减法，不做加法。

- 加任何入口、开关、说明、状态或页面前先问：用户没有它会做不成事吗？不会，就不加。
- 一屏只服务一个主要任务。
- 能改现有的就不新建；不为假想需求预留配置、模式或分支。
- 改动会让页面明显变复杂时，先问用户。

## 2. 一份源码，两份产物

没有打包器。`web/` 是前端唯一源码，`host/` 是 Mac 上运行的服务，`test/` 是测试，`tools/` 是构建与图标脚本。`npm run build` 按 `tools/build.mjs` 的 `files` 白名单，把 `web/` 里的文件复制到 `dist/`（GitHub Pages）和 `ios/AlongHealth/Web/`（App 内置页面）。

- 不要手改这两个产物目录，改了会被下次 build 覆盖。
- 新增前端文件放进 `web/`，并同时登记到 `tools/build.mjs` 的 `files` 和 `web/sw.js` 的 `FILES`。漏登记会导致产物缺文件，或者离线时打不开。`web/` 内保持平铺：产物目录也是平铺的，App 和 Service Worker 都按平铺路径取文件。
- `host/` 会从 `../web/` 引用共享校验逻辑（`goal-agent-core.mjs`、`adaptive-ui.mjs`、`super-agent.mjs`、`loop.mjs`）。这些文件必须同时能在浏览器和 Node 里运行，不要在里面引入 Node 专用模块。
- 用户可见的改动要让旧缓存失效，下面几处版本号要一起提高：`web/index.html` 的 `?v=`、`web/sw.js` 的 `CACHE`、`ios/AlongHealth/Sources/AlongShellView.swift` 的 `build=`；需要重新安装 App 时，还要提高 `ios/AlongHealth/Info.plist` 的 `CFBundleVersion`。漏掉一处，手机上就可能还是旧页面。

## 3. 怎样算改完

- 修 bug 走 `docs/bugfix-goal-prompt.md` 里的流程（复现 → 独立核实 → 修复 → 回归验证 → 交付）。那份文档同时是跨轮次的记忆：第 7 节记着这个仓库已经踩过的坑，PR 描述的遗留清单记着还没修的——**开工前先读这两处，别重犯、别重修**。
- 跑 `npm run check`，这是 CI 用的检查（语法检查加全部测试）。`npm test` 只跑全部测试，不能替代它。
- `check` 按目录匹配：`web/`、`host/` 下的 `.mjs` 自动做语法检查，`test/*.test.mjs` 自动运行。新文件放对目录即可，不用改 `package.json`。
- 推送 `main` 不会自动部署：GitHub Pages 只能手动触发；iPhone 要先 build，再在 Xcode 里重新安装。

## 4. 运行时

- Agent 有两种运行时，在 `web/super-agent.mjs` 里定义：`dsh-superagent` 和 `kimi-code-swarm`。用户没选过时，前端默认用 Kimi。Host 的路由在 `host/agent-host.mjs`。
- Mac 本地状态存在 `~/.along/agent-host/`，环境变量见 `README.md`。

## 5. 红线

- Token 只留在 Mac 上：Kimi token 和配对 token 不发给 iPhone，也不写进运行结果。
- Agent 的输出不能直接生效：先经过 `validateGoalReply` 和 `safeAdaptiveLayout` 校验，用户点「采用」后才改变目标空间。
- 健康数据只发汇总值，不发原始 HealthKit 样本。
- 理财只用演示数据：不接真实账户，不转账，不交易。

## 6. Router 与执行分工

当前用户沟通聊天承担 Along 项目的 Router 角色。用户在这里派活，Router 负责理解需求、拆分任务、启动执行 agent、处理依赖、协调集成与验收，并汇总结果。

- 每项执行工作按 `agent`、`data`、`ui`、`client`、`idea`、`release` 分类，进入独立执行聊天（session）或归并到职责和上下文合适的已有执行聊天。用户已授权 Router 按任务需要主动创建执行聊天、启动 agent 和向相应执行聊天派发任务。
- 分派前先核对已有执行聊天的范围与进度。相关工作归并到合适的执行聊天，独立任务另行拆分，并明确负责人、依赖、交付物和用户可观察的验收条件。
- 当前 Router 聊天用于需求沟通、任务路由、进度跟踪、依赖协调、验收证据审查和交付汇报。代码开发、调试、构建、测试、部署和具体集成操作均交给执行聊天或 agent 完成。跨任务集成与发版安排给 `release` 执行任务。
- Router 对派出的任务持续跟进，处理阻碍，核对产出及端上证据，直至满足用户的验收条件。向用户说明任务归属、执行聊天、当前进展和最终结果。
- 执行聊天及 agent 按收到的任务范围交付并回报 Router。本节对 Router 的分派职责由承担该角色的聊天履行。

| 分类 | 负责内容 |
|---|---|
| agent | 目标分解、编排、模型与 Mac Host 运行时、工单及能力调用 |
| data | 数据来源、授权范围、摘要结构、状态归属与兼容迁移 |
| ui | 页面内容、交互、可见状态、旧页面回归 |
| client | iPhone 原生桥、HealthKit 读写边界、系统通知、连接、签名和安装 |
| idea | 待选择的产品方案、场景与验收假设 |
| release | 跨任务集成、发布、逐端验证、发版记录和分支收尾 |
