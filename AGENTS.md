# Along 项目约定

这里只写代码里看不出来、做错就会出问题的事。产品说明见 `README.md`，iPhone App 见 `ios/README.md`，接口和参数以代码为准。

## 1. 简单是第一需求

页面已经花了大量时间重构和简化。默认做减法，不做加法。

- 加任何入口、开关、说明、状态或页面前先问：用户没有它会做不成事吗？不会，就不加。
- 一屏只服务一个主要任务。
- 能改现有的就不新建；不为假想需求预留配置、模式或分支。
- 改动会让页面明显变复杂时，先问用户。

## 2. 一份源码，两份产物

没有打包器。`web/` 是前端唯一源码，`host/` 是 Mac 和云端共用的服务，`test/` 是测试，`tools/` 是构建与图标脚本。`npm run build` 按 `tools/build.mjs` 的 `files` 白名单，把 `web/` 里的文件复制到 `dist/`（GitHub Pages）和 `ios/AlongHealth/Web/`（App 内置页面）。

- 不要手改这两个产物目录，改了会被下次 build 覆盖。
- 新增前端文件放进 `web/`，并同时登记到 `tools/build.mjs` 的 `files` 和 `web/sw.js` 的 `FILES`。漏登记会导致产物缺文件，或者离线时打不开。`web/` 内保持平铺：产物目录也是平铺的，App 和 Service Worker 都按平铺路径取文件。
- `host/` 会从 `../web/` 引用共享校验逻辑（`goal-agent-core.mjs`、`adaptive-ui.mjs`、`super-agent.mjs`、`loop.mjs`）。这些文件必须同时能在浏览器和 Node 里运行，不要在里面引入 Node 专用模块。
- 用户可见的改动要让旧缓存失效，下面几处版本号要一起提高：`web/index.html` 的 `?v=`、`web/sw.js` 的 `CACHE`、`ios/AlongHealth/Sources/AlongShellView.swift` 的 `build=`；需要重新安装 App 时，还要提高 `ios/AlongHealth/Info.plist` 的 `CFBundleVersion`。漏掉一处，手机上就可能还是旧页面。

## 3. 怎样算改完

- 先写文档，再实现：新增功能、调整行为或修 bug 前，先在仓库文档中写清目标、范围、实现方案和验收标准，再开始改代码。优先更新已有文档；实现中方案有变化，同步更新文档。
- 修 bug 走 `docs/bugfix-goal-prompt.md` 里的流程（复现 → 独立核实 → 修复 → 回归验证 → 交付）。那份文档同时是跨轮次的记忆：第 7 节记着这个仓库已经踩过的坑，PR 描述的遗留清单记着还没修的——**开工前先读这两处，别重犯、别重修**。
- 跑 `npm run check`，这是 CI 用的检查（语法检查加全部测试）。`npm test` 只跑全部测试，不能替代它。
- `check` 按目录匹配：`web/`、`host/` 下的 `.mjs` 自动做语法检查，`test/*.test.mjs` 自动运行。新文件放对目录即可，不用改 `package.json`。
- 推送 `main` 不会自动部署：GitHub Pages 只能手动触发；iPhone 要先 build，再在 Xcode 里重新安装。

## 4. 运行时

- Agent 工程统一称为 **Along Agent**；本地目录沿用 `../along-superagent/`，包名与插件 ID 沿用 `dsh-superagent`。

- `ALONG_EVENT_INGEST=on` 的事件工作区使用 Along Agent，App 配对后自动协商。仅旧 Host 兼容路径有 `dsh-superagent` / `kimi-code-swarm` 双运行时，前端未选过时默认 Kimi；定义在 `web/super-agent.mjs`，Host 路由在 `host/agent-host.mjs`。
- 状态目录由 `ALONG_AGENT_STATE_DIR` 决定，默认 `~/.along/agent-host/`（直接 `npm run agent-host`）；`npm run activate` 用 `~/.along/phone-test/`；云端部署用挂载卷（`/opt/along/data/host`）。环境变量见 `README.md` 与 `deploy/env.example`。
- 云端部署形态（一台云主机 + Docker Compose、2 个静态用户、每用户一次性配对码）的设计、决策与上线 Runbook 见 `docs/cloud-deploy-multi-user.md`；先从 `deploy/README.md` 选编排。云端与本地共用同一套源码，不新增模式开关。Mac 本地 Host 保留用于开发与旧版客户端。iPhone Build 95 起只配对云端 HTTPS。
- 线上是**一套**栈（compose 项目 `deploy`：`anchor` + `superagent` + `host`），443 与 10531 两个入口都指向它；不要另起一套"个人栈"——同一份业务库只能有一个写端。
- **构建输入有三处来源，按形态各用各的，别混用**：基础编排 `deploy/docker-compose.yml` 默认取**远端 pin 的 Super Agent 提交**（`ALONG_SUPERAGENT_SOURCE` 的默认值，可覆盖）；独立 Linux 云端编排 `deploy/docker-compose.cloud.yml` 默认取**相邻 checkout 的工作区**——工作区有未提交改动或前移到别的提交，重建出的镜像就与仓库不一致，而镜像标签不带 revision，**漂移没有任何提示**，复现时要显式给提交；**线上那一份由 `deploy/auto-deploy.sh` 定时构建**：它把当轮固定的两个提交展开成干净源码树再构建，构建输入不再取工作区，镜像标签带两个 SHA，漂移能被查出来。手工重建线上那一份仍按老规矩：先把两个工作区清干净停在目标提交；要在编排里钉住 Agent 提交，`ALONG_SUPERAGENT_SOURCE` 要写**完整的 Git URL**（`https://github.com/artstur/along-superagent.git#<40 位 SHA>`）或本地 checkout 路径，**不能只写裸 SHA**——裸 SHA 会被 compose 当成相对 project directory（`deploy/`）的本地路径，解析成 `deploy/<SHA>` 这种不存在的目录，构建直接失败。这个变量**只固定 Agent（Along Agent）的构建上下文**，Along 源码仍由所用的 Along checkout 决定（`build.context` 是 `..`）；线上那一份的两个提交由 `auto-deploy.sh` 展开钉住，要复现某一轮用 `ALONG_DEPLOY_ALONG_SHA` / `ALONG_DEPLOY_SUPERAGENT_SHA`。
- **查线上跑的是哪一版用部署器，不靠文档**：`/usr/local/libexec/along/auto-deploy.sh status`（成功版本、上一成功版本、运行中的镜像与探活），探活用 `verify`，回退用 `rollback`。本仓记录的 2026-11-27 那次 hourly 自动部署切到 Along 仓库 `944da99`、Along Agent 仓库 `d16a98b`——那是有日期的历史记录，不是当前值。
- 每份个人工作区只允许一个业务写端；旧源退役后不得恢复写入。
- 事件工作区已按校验后自动生效实现，目标只能通过聊天改变。「采用」、待采用提案和目标编辑入口仅用于旧 Host 兼容；不要在新链路增加采用、确认或审批环节。

## 5. 红线

- 凭证只留在服务端安全存储（Mac 或云主机的卷/secrets/env）：Kimi、模型、桥接、APNs、runner 等凭证绝不发给 iPhone 或网页，也不写进运行结果和日志；配对 token 服务端只存哈希、只在配对响应里出现一次，不复用为服务端内部凭证。
- Agent 的输出必须先通过校验才能生效：经过 `validateGoalReply`、`safeAdaptiveLayout` 及对应的变更校验，通过后自动写入目标空间，不等用户采用；用户不认可时通过聊天纠正。校验只能加严，不能为了让结果通过而放宽。
- 目标只能通过聊天改变：界面不提供直接编辑或删除目标的入口。
- 健康数据只发汇总值，不发原始 HealthKit 样本。
- 数据优先在用户授权且实际可达的设备采集；密钥只留在采集设备安全存储，不进入网页、Agent、日志或同步数据。设备采集、Host校验与持久来源事件、Agent按能力读取遵循 `docs/device-data-sources.md`；不能把按钮点击当数据就绪。
- 理财默认使用演示数据；用户明确授权的 OKX 连接由 iPhone 原生采集真实账户摘要，API Key 实际权限必须仅只读。旧 Mac 密钥只清理不下发手机；禁止转账和交易。
