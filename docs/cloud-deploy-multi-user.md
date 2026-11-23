# Along 云端部署与多用户方案（2 人）

> **2026-11-21 TLS 决策修订，尚未实施**：用户已选择 [iPhone 安装 CA 描述文件并启用系统完全信任](iphone-ca-profile-design.md)。云端目标改为 Along 专用根签发短期 SAN 叶、URLSession 系统信任评估，取代十年自签叶指纹钉扎和此前 App 内专用锚建议。本文的现状代码、历史测试与 Compose 快照不表示新路线已实现；首次信任、旧连接迁移、安装/移除、换证及失窃恢复以该专项方案为准。生产域名、根保管和双手机切换条件仍待确定，本轮只更新设计，不生成密钥或部署。

> 2026-11-20。把 host 与 agent 链路从「Mac 本机单用户」迁到「云服务器 + Docker Compose」，并支持 2 个用户。部署形态已拍板：一台云主机（如阿里云 ECS）+ Docker Compose，本文档产出全部代码与配置的设计，实际登录用户云服务器执行部署不在本轮范围（由 Runbook §6.4 交给用户手动执行）。本文不放宽任何红线（AGENTS.md §5）；对规格未拍板的点以 `SD-n` 编号给出决策与理由（§7），实施中方案有变化须回写本文（AGENTS.md §3）。
>
> 设计基线（2026-11-20，行号以当前 `main` 工作树为准）：`along` 仓库本目录、`along-superagent` 相邻仓库。基线门禁：`npm run check` 通过（node --check 全部 `web/*.mjs`、`web/sw.js`、`host/*.mjs`、`tools/build.mjs` + `node --test test/*.test.mjs`，509 条测试全绿，本轮已实际运行）。

## 固定公网 IPv4 直连

固定公网 IPv4 部署按 [公网 IP 运维步骤](../deploy/README.md#固定公网-ipv4-直连) 执行。iPhone 配对、前台请求与后台同步共用原生 HTTPS 入口校验，公网 IPv4 由系统核验 IP SAN、证书链与有效期。原有 RFC1918 叶指纹钉扎和 DNS 系统信任连接继续沿用。

Tier 2 追加 Compose 叠加文件，由 Along 独立 nginx 终止 TLS。公网 TCP 80 仅用于 HTTP-01，HTTPS 转发通过仅 Host 和 nginx 挂载的 Unix socket，Host 按 nginx 覆写的来源地址继续分配配对失败窗口。公网 IP 证书使用 Let’s Encrypt 的 `shortlived` profile。签发和 nginx 当前证书分别存放；定期续期后先校验证书、测试 nginx 配置，再重载并从 HTTPS 入口核验叶证书。失败保留上一份已加载的有效证书并记录告警。

隔离验收覆盖原生连接守卫、同 IP 换叶后原配对可用、证书与重载失败回退、HTTP-01 路径以及 Host 内部端口未对外发布。公共 CA、真 iPhone 前后台同步和实际续期由部署环境另行验收。

## 0. 目标

1. 2 个用户各自用 iPhone（App 内置页面）连到**同一台云主机**上的 Along 服务，互不干扰：各自的配对 token、目标空间、每日委托索引、通知登记、OKX 连接缓存彼此隔离。
2. agent 聊天链路在云端可用：目标对话 → 模型输出 → `validateGoalReply`/`safeAdaptiveLayout` 校验 → 自动生效，不新增采用/审批环节。
3. Mac 本地模式的既有私网连接能力保留（`npm run activate` / `npm run agent-host`），作为回退路径，不要求给 Mac 路径安装 iPhone 系统根；云端与本地共用源码。CA 迁移的共享连接存储升级需单独回归，不新增用户安全模式开关。

### 上线前 P1 修复

1. 公网配对在比对验证码前执行按来源（连接 IP）的失败窗口检查。某来源窗口满时对该来源统一拒绝，包括有效码，保持码未消费；其他来源不受影响。发码不清窗，同 IP 噪音最长 15 分钟自然过期自愈，无清窗入口。验收覆盖达到上限、窗口恢复、成功清空和两用户各自配对。Mac 仍使用本地启动时发放的码。
2. Runner 启动时从 Compose secret 读取模型密钥，按固定版本 headless 的契约传给子进程。Runner 内网令牌和其他父进程环境不继承给 DSH。每次运行使用独立的临时工作目录和 DSH 状态目录，退出后清理，Docker 中的临时目录使用 tmpfs。固定版本的规划配置需停用工具执行能力。验收覆盖密钥缺失、子进程环境白名单、两个用户的工作区互不重叠、退出清理，以及实际 CLI 的配置解析。
3. 云端目标运行保留 Host 已校验的情境输入，提交和查询共用同一道输出校验。完整情境只在服务端用于校验，回给 iPhone 的运行记录维持最小字段。验收覆盖合法重评保留结果，及携带目标变更的重评在提交和查询都进入 `blocked`。
4. 已配对用户从当前连接区重新配对；云端 DNS 路径按 CA 方案安装/信任根后输入地址与验证码，不再输入叶指纹，Mac 私网路径保留指纹。切换到另一台 Host 时，Keychain 保存成功后才启用新绑定。云端 DSH 提示随绑定保存；切换后释放旧工作区和迟到回写。同 origin、同 token 的 CA 升级先以系统信任验证原会话，再原子迁移，不强制重新发码。
5. 云端目标聊天的通过 Host 校验的变更自动写入当前目标。沿用已有目标写入函数和隐私保护，按同一轮请求去重，仅对匹配当前连接和请求的结果执行。Mac 兼容链路的存量行为保持一致。验收覆盖已有目标、首次新建、校验拒绝和迟到旧回执。

本轮修复上述 P1，并接好云端配对后的 DSH 选择与就绪检查。验收以 §5 与 §6.4 的实际流程为准。

### `b29483d` 审核后的修复与验收

修复云端双用户候选版的运行恢复、配对和部署缺陷，保住已使用 Mac 版的配对、运行和通知状态。沿用现有表单、运行轮询、结果校验和两种部署形态。本轮在本地用临时状态和模型替身验证，ECS、真实模型密钥和双真机验收仍按 §6.4 执行。

| 范围 | 实现 | 验收 |
| --- | --- | --- |
| 云端目标与任务 | Runner 接单后立即返回可查询的 `working` 记录，完成后按原 `userId+requestId` 返回终态。保留接单时间、原始校验情境和在途去重。Host 提交和查询共用原有校验。App 恢复同一连接下的目标运行。不确定是否收到首个回执时按原编号查询，有限期内明确收敛。 | 用受控延迟的模型替身跑真实 Host 和 Runner，先收到 `working`，再读到 `done` 或 `blocked`。同号不会再次拉起模型。复开 App 后可继续查询并只生效一次，迟到的旧连接结果不能写回。 |
| Runner 请求解码 | 按既有 64 KiB 字节上限收集请求，合并后统一解码 UTF-8。 | 中文字符跨分块仍原样送到模型，超上限请求仍被拒绝。 |
| 配对 | 云端 Runner 已配置时，缺失或无效用户表阻止启动。Mac 通用码保留成功即耗尽、五次失败锁定和 15 分钟时限。CLI 发码与 Host 消费码、记录失败共用跨进程互斥，绑定持久化失败不启用新 token。 | 缺用户表的云端不监听、不打印通用码。已配对 Mac 的本地码不能重新配对。临时目录中验证两进程并发不会丢发码或复活已消费的码。 |
| Mac 升级与来源同步 | 将旧 Kimi 运行和 APNs 登记归到唯一已验证的本地绑定，保留现有新记录和通知游标。来源工作按用户独立串行。 | 带旧文件启动，原请求继续可查且旧通知队列可投递。两用户同时进泵，各自推进，同一用户不重复执行。 |
| 构建与手册 | 将 Docker 白名单放置在实际构建上下文，保留 Agent 源码目录结构。迁移手册先读新版绑定表，证书轮换重建容器并读回指纹。D19 明确云端可公网配对及本地约束。 | 核对构建输入及 COPY 路径，跑 Compose 配置和两项目检查。若有 Docker daemon，再构建镜像并验证容器启动。 |

本地验收通过。Along `npm run check` 623 项（含 Compose 配置），Along Agent `pnpm check` 1,848 项。iOS 模拟器构建通过，Web 缓存与原生页面标记同为 83，安装版本为 74。固定版本 DSH 接本地模型替身，两个用户均从 `working` 查到终态。Linux 容器启动、真实模型与双真机验收留在 §6.4。

## 1. 范围（明确不做什么）

- **不做**公网注册、计费、管理后台、动态扩缩容：用户数固定为 2，身份由服务端静态用户表（`users.json`）+ 每用户配对码提供（SD-2）。
- **不做**微服务化/多实例/负载均衡：单台主机、单进程 host、单容器 agent，持久化全在本机卷。
- **不做**新链路数据面上云（Tier 2，见 §3.5 与 §5 验证项 V-1）：`/events`、`/sync`、`/sync/ack`、`/notifications/*`、`/sources/*` 的 agent 侧持久化依赖**长驻** DSH 运行时 + along bundle（along.sqlite、投递泵、ChangeSet 原子写入）。已核实的官方 Linux 发行物 `@deepseek-ai/dsh` 是 headless 一次性形态（无监听端口、每调用一个进程退出），承载不了长驻数据面。云端 v1 这些端点维持既有开关语义返回 503（`ALONG_EVENT_INGEST` 关闭，`host/agent-host.mjs:162-167`），健康事件与 OKX 设备上报仍走 Mac 本地模式。这不降低红线：云端的目标聊天链路照样全量过校验（§3.6）。
- **不做** 无关 UI 视觉改动。CA 迁移仅调整云端连接表单的叶指纹要求及信任失败恢复指引，沿用现有连接入口；具体见 [CA 方案 §2/§7](iphone-ca-profile-design.md)。涉及 Web 代码仍须按 AGENTS.md §2 联动版本，不能把当前历史版本号直接覆盖到并行工作树。
- **不做** Kimi 运行时上云：Kimi Code Web Server（`kimi web`，`host/kimi-code-agent.mjs:9-10` 默认 `127.0.0.1:58627`、token 在 `~/.kimi-code/server.token`）是 Mac 本机登录态服务，无云端等价物。云端它按现状自然降级为不可用（选择 Kimi 运行时时报「未找到 Kimi Code Web Server token」，与 Mac 上没启动 `kimi web` 的表现一致，`host/kimi-code-agent.mjs:143-147`），UI 的运行时切换按钮不动。预留 `ALONG_KIMI_CODE_URL` 指向可达服务即可启用，不改代码。
- **不做** Codex 路径上云：`/goal/event` 依赖本机 Codex 二进制（`host/codex-agent.mjs:9-14`），云端镜像不安装 codex，该端点按既有语义优雅失败（「Along 暂时不可用」）；`web/` 无任何调用 `/goal/event` 的代码（本轮全库 grep 无命中），属休眠路径，上线验收时不得误判为故障（验收 #10）。
- **不做** Hy-Memory 记忆服务上云：云端 profile 不配置 `alongMemory`，agent 仓库文档明确「Omit `alongMemory` to retain local governance and explicit SQLite fallback; this does not silently disable conversations」（`along-superagent/docs/006-deployment.md:35`），符合 D6 的降级语义（`along-superagent/docs/along/000-decisions.md:40-44`）。
- **不迁移**新链路业务历史库（along.sqlite）到云端：云端 v1 没有 along 数据面，目标空间在手机本地（旧链路语义，见 §6.2）。

## 2. 现状结论（本轮已在代码中逐条核实）

### 2.1 链路现状

- **host**：`npm run agent-host` → `host/agent-host.mjs`，Node 原生 HTTPS，默认绑 en0 局域网 IPv4、端口 4176（`host/agent-host.mjs:67-68`）；启动时 openssl 现场生成 30 天自签证书并打印 SHA-256 指纹（`:37-43`）与 8 位一次性配对码（`:44-45`，仅进程内存，15 分钟，5 次失败锁死 `:296-298`）。
- **配对与鉴权是单例**：`pairing.json` 只有一组 `{hash,user_id,device_id}`（`:47-65`，`/pair` 新配对覆盖旧绑定，`:299-307`）；`authorized()` 只对这一个 tokenHash 做 timingSafeEqual（`:87-90`）。
- **全局串行点**：模块级 `busy` + `runExclusive` 只包住 `/goal/event`（`:66、153-158、422`）——调研材料「整个 host 一次只处理一条请求」不准确，以代码为准：其余路由不互斥，多用户互阻点仅此一处。
- **上游假设同机回环**：DSH 默认 `http://127.0.0.1:3082`（`:69`），情境评估凭证禁止发非本机地址（`:71-72`）；桥接凭证 `ALONG_BRIDGE_TOKEN_FILE` 启动读一次（`host/along-bridge.mjs:16-22`）；source 事件桥硬校验 endpoint 必须 loopback（`host/source-event-bridge.mjs:133`，`private_loopback_required`）。
- **Kimi/Codex 是本机资源**：Kimi 运行记录 `kimi-runs.json` 默认在 `~/.along/agent-host/`（`host/kimi-code-agent.mjs:11`，注意不跟随 `ALONG_AGENT_STATE_DIR`，`host/agent-host.mjs:78` 未传 `statePath`）；Codex 是本机二进制（`host/codex-agent.mjs:9-14`），缺失时 `/goal/event` 报「Along 暂时不可用」优雅失败，且当前 `web/` 无任何调用 `/goal/event` 的代码（全库 grep 无命中），是休眠路径。
- **每用户隔离已有基础**：设备来源/OKX 缓存按 `userId+goalId` 哈希分文件（`host/device-source-gateway.mjs:31`）；每日委托索引按配对 token 哈希分键（`host/daily-action-history.mjs:33-51`）；归属校验 `goal.userId===who.userId`（`host/source-access.mjs:14-27`）。**单例残留**：通知设备登记单文件单槽位 + `same(who,identity())`（`host/task-notifications.mjs:71-101`）；Kimi 运行记录只按 requestId 键（`host/kimi-code-agent.mjs:180`）；`identity` 是模块级单例，被 `deviceSourceRoute`、`sourceConnections`、`notifications`、source 事件泵共享注入（`host/agent-host.mjs:31、79-83、196、429-433`）。
- **校验链**：`normalizeGoalRun` = `validateGoalReply`（`web/goal-agent-core.mjs`）+ `safeAdaptiveLayout`（`web/adaptive-ui.mjs`），校验失败落终态 `blocked` 不重试（`host/agent-host.mjs:262-291`）；Kimi 同款校验在 `host/kimi-code-agent.mjs:113-127`。新旧链路单消费开关 `ALONG_EVENT_INGEST` 默认 off，on 时旧 DSH 分支 409（`host/agent-host.mjs:162-167、371、385`），回退=改回 off（BC-09-03/04）。
- **客户端**：`web/` 前端不发网络请求，全部经 `window.AlongAgentBridge.request` 由 iOS 原生转发（`web/agent-client.mjs:22-27`）；连接三要素（baseURL+64hex 指纹+token）来自配对表单，存 localStorage `along.agent.v1` 并镜像 Keychain（`web/app.mjs:110-117、1099、1702-1733`）。iOS 原生把 baseURL 锁死为 https + RFC1918 私网 IPv4 且 4 段数字（`ios/AlongHealth/Sources/AlongShellView.swift:430-447`，`agentRequest` 同款校验 `:945-951`），路径白名单 12+4 条（主路径 12 + 通知 2 + 设备来源 2，逐项清点 `ios/AlongHealth/Sources/AlongShellView.swift:958-959`），叶子证书 SHA-256 钉扎、禁重定向、强制 DIRECT（`:975-978、1208-1229`）；`build=80`（`:452`）、`Info.plist CFBundleVersion=71`。web 默认运行时 Kimi（`web/app.mjs:48`），与 AGENTS.md §4 一致。
- **agent 侧多用户已支持**：`policy.sources.along.allowed` 是数组，配对注册幂等追加 `{id:userId}`（`along-superagent/src/along/api.ts:154-164、168、184`）；身份只来自 `x-along-user`/`x-along-device` 头（`api.ts:88-90`）。**agent 核心运行时是 macOS 专属桌面发行物**：`dsh` 是 `DeepSeek Harness.app` 内置 CLI（`~/.local/bin/dsh` symlink；`ELECTRON_RUN_AS_NODE=1` 执行 Mach-O arm64 Electron 二进制加载 app.asar 里的 `@deepseek-ai/dsh-desktop-host/lib/cli.js`；`runtime.json` 明确 `platform: darwin, arch: arm64`；`app.asar.unpacked` 含 darwin-arm64 原生模块；该包公共 npm 404）。`along-superagent` 只是加载进 DSH 的插件 bundle，不含核心运行时。**已有官方 Linux 可运行发行物：公共 npm 包 `@deepseek-ai/dsh`（0.2.2-rc.5，engines node>=24.9.0，无 os/cpu 限制），官方服务器形态为 headless profile：不挂 browser/HTTP runtime、不开监听端口，一次性执行「提交任务 → 等待静默 → stdout 输出最终答案 → exit 0/1」**（结论经用户确认，来源 npm 与 deepseek-harness 官方仓库 apps/cli）。

### 2.2 与「上云 + 2 用户」正面冲突的点（按代码）

| # | 冲突点 | 代码位置 | 云端处置 |
| --- | --- | --- | --- |
| C1 | 单份配对绑定，第二人配对顶掉第一人 | `host/agent-host.mjs:47-65、299-307` | M1：`pairings.json` 多绑定表 + `users.json` 静态用户表 + 每用户配对码 |
| C2 | 鉴权只认一个 tokenHash | `:87-90` | M1：`authorized()` 按表查找，返回请求自己的绑定 |
| C3 | `identity` 模块级单例被四处共享 | `:31、79-83、196、429-433` | M2：改为每请求解析绑定，后台泵按用户迭代 |
| C4 | 通知登记单文件单槽位 | `host/task-notifications.mjs:71-101` | M2：按用户分文件 |
| C5 | Kimi 运行记录按 requestId 全局键、状态文件不随 `ALONG_AGENT_STATE_DIR` | `host/kimi-code-agent.mjs:11、180` | M2：键加 userId 前缀、`statePath` 接到 host 状态目录（云端休眠，本地兼容受益） |
| C6 | `/goal/event` 全局互斥锁 | `host/agent-host.mjs:66、153-158、422` | M2：按用户分锁 |
| C7 | 旧叶指纹钉扎导致重签后全体重配对 | `:37-43` | M4 目标改为短期 SAN 叶及 iPhone 系统信任；同根同域轮换不改绑定，旧十年参数仅属实现基线 |
| C8 | 早期 iOS 只收 RFC1918 私网 IPv4；当前已扩展合法 DNS 域名 | `AlongShellView.swift` 的 hostAccepted | M6 继续保留地址约束，DNS 改系统信任，私网 Mac 保留旧 pin；公网数字 IP 仍不开放 |
| C9 | DSH 核心运行时无 Linux 长驻形态 | §2.1 已核实 | M3/M5：云端走 `@deepseek-ai/dsh` headless 一次性调用 + host 侧校验链（§3.5） |
| C10 | 新链路数据面依赖长驻 agent | `host/agent-host.mjs:159-252` | 云端 v1 维持 `ALONG_EVENT_INGEST=off` 的 503 语义；上云列为验证项 V-1 |

### 2.3 调研/文档与代码不符处（以代码为准，M7 修正文案）

1. **「配对 token 不发给 iPhone」（AGENTS.md §5、README.md:212）与代码不符**：`/pair` 响应返回 token，iPhone 存 Keychain（`host/agent-host.mjs:307`；`ios/AlongHealth/Sources/AlongShellView.swift` 连接存储）。可执行口径（`docs/stage-a-tech-design.md:262` SD-2）：配对 token 一次性经钉扎 TLS 发给配对设备、服务端只存哈希；红线禁止的是把配对 token 复用为回环凭证、写进运行结果或日志。**M7**（非 M6——M6 是 iOS 连接模块，不碰文档）统一 AGENTS.md/README 措辞为「Kimi/模型/桥接/APNs 凭证只留在服务端安全存储，绝不发给 iPhone 或网页；配对 token 只在配对响应出现一次」；其中 AGENTS.md §5 的修订受 SD-6 用户确认门控。
2. **「Mac 本地状态存 `~/.along/agent-host/`」（AGENTS.md §4）只在直接 `npm run agent-host` 时成立**；`npm run activate` 实际用 `~/.along/phone-test/{host,dsh,data}`（`tools/activate.mjs:212、285`）。迁移清单两者都收（§6.2）。
3. **「全局单飞锁阻塞整个 host」不准确**：`runExclusive` 只包 `/goal/event`（§2.1）。

## 3. 总体方案

### 3.1 部署拓扑与 Docker Compose 结构

```text
                         ┌─────────────────── 云主机（ECS，Linux，Docker Compose）───────────────────┐
 iPhone A ──HTTPS:443──▶ │  [host 容器]  host/agent-host.mjs:4176（容器内），端口映射 443→4176        │
 （安装根并系统验证）      │    卷 /opt/along/data/host（TLS 叶/key、pairings/users/codes、             │
 iPhone B ──HTTPS:443──▶ │        daily-actions、kimi-runs…，0700/0600）                              │
                         │        │ compose 内网 DNS: agent                                          │
                         │        ▼                                                                  │
                         │  [agent 容器] node:24 + @deepseek-ai/dsh@0.2.2-rc.5（headless）            │
                         │    deploy/agent-runner.mjs 监听 agent:3088（仅 compose 内网，不发布端口）   │
                         │    每次调用拉起一个 dsh headless 进程，stdout 取最终 JSON                   │
                         │    secrets: 模型 API Key（env/文件，不进镜像）                              │
                         └───────────────────────────────────────────────────────────────────────────┘
 web 静态页仍由 GitHub Pages 与 App 内置产物提供，host 不服务网页。
```

- **TLS 与入口**：沿用 Host 端到端 TLS，本期不引入反代；TLS 由 host 端到端提供并由 iPhone 系统信任评估校验（云端叶证书由预签发的 Along CA 签发，根证书经描述文件安装并开启完全信任，链、SAN/主机名、有效期和 ATS 必须通过，失败不降级旧叶钉扎；终态以 [CA 方案](iphone-ca-profile-design.md) 为准），反代终止 TLS 会破坏这一信任锚。Mac 私网旧连接仍用叶指纹钉扎，作为本地兼容路径，不作为云端降级路径。单一服务也不需要虚拟主机；限流在 host/runner 应用内实现（连接上限、超时、`/pair` 按来源失败窗口与运行链路限流，见 `docs/cloud-security-hardening.md`），不引入反代。CA 不提供客户端准入。
- **compose 结构快照**（当前 `deploy/docker-compose.yml` 的旧叶钉扎实现；其中 ALONG_TLS_DAYS=3650 和自签探活不是 CA 目标配置，实施时按 [CA 方案 §3/§7](iphone-ca-profile-design.md) 迁移，本轮不编辑运行配置）：

```yaml
# 相对路径基准：compose v2 的 project directory = 本文件所在目录（deploy/）。
# 因此 volumes/secrets 用 ../../ 指向仓库外层 /opt/along/{data,secrets}（§6.4 第 1 步布局），
# build.context 用 .. 指向仓库根 /opt/along/along；additional_contexts 的相对路径同样以
# project directory（deploy/）为基准，写 ../../along-superagent 即相邻仓库布局（M5 施工实测：
# compose v5.8.0 config 解析为 <仓库根>/../along-superagent，写 ../along-superagent 会指向
# /opt/along/along/along-superagent 不存在的路径）。注意手工命令 docker build --build-context
# 从 cwd=仓库根解析，写 ../along-superagent，与 compose 基准不同。全部相对路径与 §6.4 的绝对布局一一对应，不得混用其他基准。
services:
  host:
    build: {context: .., dockerfile: deploy/Dockerfile.host, tags: [along-host:local]}
    image: along-host:local
    container_name: along-host
    ports: ["443:4176"]
    environment:
      ALONG_AGENT_STATE_DIR: /data
      ALONG_AGENT_HOST: "0.0.0.0"                 # 必配：容器内没有 en0，缺省回退 127.0.0.1，443 映射打不通（host/agent-host.mjs:68）
      ALONG_AGENT_PORT: "4176"
      ALONG_DSH_RUNNER_URL: http://agent:3088     # 云端 agent 上游（§3.5）
      ALONG_RUNNER_TOKEN_FILE: /run/secrets/runner-token   # M3 实现拍板：host 读同一份 runner-token secret，未设则拒绝启动
      ALONG_TLS_CN: along.example.com             # 换成用户域名
      ALONG_TLS_DAYS: "3650"
      ALONG_EVENT_INGEST: "off"                   # 云端 v1 不开新链路（§1）
      # ↓ 可选：不部署远程通知时，删除这三个 env、下方 host 服务的 secrets 列表里的 apns-key
      #   与顶层 secrets.apns-key 定义（file secret 缺失是 docker compose up 的硬错误），
      #   provider 未创建只是远程通知不可用（host/apns.mjs:8-14），其余功能不受影响；
      #   runner-token 两项引用必须保留（host 分流必需）。
      ALONG_APNS_KEY_FILE: /run/secrets/apns-key
      ALONG_APNS_TEAM_ID: "XXXXXXXXXX"
      ALONG_APNS_KEY_ID: "XXXXXXXXXX"
    secrets: [apns-key, runner-token]             # 不部署远程通知时把 apns-key 从两处一并删除；runner-token 两服务共用
    volumes: ["../../data/host:/data"]            # → /opt/along/data/host（§6.4 第 1 步）
    restart: unless-stopped
    logging: {driver: json-file, options: {max-size: "10m", max-file: "3"}}   # 日志留存上限（§3.7）
    healthcheck: {test: ["CMD","node","-e","process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';fetch('https://127.0.0.1:4176/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval:30s}
  agent:
    build:
      context: ..
      dockerfile: deploy/Dockerfile.agent
      additional_contexts: {along: ../../along-superagent}   # → /opt/along/along-superagent（相邻布局）；相对路径以 project directory（deploy/）为基准，见上方注释与 §6.4 第 5 步
    image: along-agent:local
    container_name: along-agent
    read_only: true
    tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777"]
    environment:
      ALONG_RUNNER_TOKEN_FILE: /run/secrets/runner-token
      ALONG_MODEL_API_KEY_FILE: /run/secrets/model-credentials
      ALONG_DSH_VERSION: "0.2.2-rc.5"             # 与 Dockerfile 里的 pin 一致，记录用
    secrets: [runner-token, model-credentials]
    restart: unless-stopped
    logging: {driver: json-file, options: {max-size: "10m", max-file: "3"}}
    healthcheck: {test: ["CMD","node","-e","fetch('http://127.0.0.1:3088/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval:30s}
secrets:
  apns-key:          {file: ../../secrets/apns-key.p8}    # → /opt/along/secrets/…；不部署远程通知时删除本行
  runner-token:      {file: ../../secrets/runner-token}
  model-credentials: {file: ../../secrets/model-credentials}
```

- **卷与持久化**：host 全部状态在 `/opt/along/data/host`（compose 经 `../../data/host` bind mount 到容器 `/data`，0700，对应 `ALONG_AGENT_STATE_DIR`，`host/agent-host.mjs:26`；该目录在 git 仓库**外层**，杜绝误提交）；agent 容器无状态（headless 一次性进程 + runner 内存缓存），无卷。APNs key、模型凭证、runner 内网令牌用 compose `secrets`（文件来源 `/opt/along/secrets/*`，0600，同样在仓库外层），密钥只进服务端，不进镜像、不进 git。**路径按 §6.4 布局**：secret 文件缺失会让 Compose 启动失败。Host 配置了云端 Runner 且 `/data/users.json` 缺失或无效时，在监听前退出。不部署远程通知时按 Compose 注释移除 APNs 三处引用。
- **TLS 证书目标**：云端读取状态目录 `tls/current` 的预签发 fullchain/key，缺失或链、SAN、用途、有效期、权限不合法则在监听前拒启，不现场自签兜底。根私钥仅在离线保管链中。现有本地自签及 ALONG_TLS_* 参数行为留作 Mac 兼容；云端不再靠延长天数避免换证，参数语义与目录契约见 CA 方案 §3。
- **监督与重启**：`restart: unless-stopped` 在容器主进程退出时由 Docker 重启。健康检查只报告健康状态。
- **端口占用 preflight**：443（对外）、3088（容器内）不得与宿主机其他服务冲突；ECS 安全组只开 22/443。

### 3.2 多用户模型与数据隔离

- **用户模型**：`users.json`（host 状态目录，0600，静态由部署者写入）声明用户：`[{"userId":"u_xxxxxxxx","label":"…"}]`。无注册入口、无自助建号（D1 修订见 §7 SD-2）。`u_` 前缀沿用现有身份形状（`host/agent-host.mjs:54`）。
- **配对**：复用现有表单和 `/pair`，已连接设备也可从连接区重新配对。云端成功响应附带 DSH 运行时提示，Mac 的响应继续只含 token。
  - 发码：部署者在服务器上执行 `docker exec along-host node host/pair-code.mjs <userId>` → 为该用户生成 8 位一次性码（15 分钟有效，写入状态目录 `pairing-codes.json`，0600），通过私下渠道发给对应的人。
  - **码状态**：`pairing-codes.json`（0600，原子替换）保存按来源（连接 IP）分桶的失败时间戳（`{<source>:[ISO,…]}`）和 `[code,userId,expiresAt]` 数组。发码 CLI 和 Host 复用已有 `proper-lockfile` 锁，持锁读、改、写。配对成功即消费验证码。锁争用超时返回 503，管理员可稍后重试。
  - **公网按来源失败窗口**：每次 `/pair` 先剔除 15 分钟前的失败和已过期码。失败按来源（`req.socket.remoteAddress` 归一化后的连接 IP）分桶记录；某来源桶内失败已达 `ALONG_PAIR_FAIL_LIMIT` 次时，该来源的提交在比对验证码前统一返回 403，保留尚有效的码，其他来源的配对不受影响。低于限额时，失败计入该来源自己的桶；成功消费命中的码并只清该来源的桶。默认限额 10，只许调低。**发码不清窗，无清窗入口**——与攻击者同 IP 的合法设备最长 15 分钟窗口自然过期自愈（SD-7 经 `docs/cloud-security-hardening.md` SD-H2 修订）。
  - **云端启动保护**：配置 `ALONG_DSH_RUNNER_URL` 时必须有可读、有效的 `users.json` 和 Runner 令牌。多用户形态只认每用户码，启动不生成或打印通用码。
  - `/pair` 按码解析用户，持久化 `{hash,user_id,device_id}` 后再更换现役绑定并返回 token。多用户 Host 每次验码重新读用户表。管理员移除用户后，该用户的待配对码不被消费；表缺失或损坏时暂拒配对。绑定文件写入失败时保留当前绑定，云端已消费的码由管理员重发。
  - **本地兼容**：未配置云端 Runner 且启动时无用户表，Mac 使用 15 分钟启动码。成功一次或错误五次后锁定，重启后重新发码。旧 `pairing.json` 迁移成 `pairings.json`，保留身份和 token 哈希。
- **鉴权**：`authorized()` 从「比对单例 tokenHash」改为「在 pairings 表中按 SHA-256 查找」，返回该请求的绑定 `{userId,deviceId,hash}`；未命中一律 401（文案不变）。
- **每请求身份**：M2 把 `identity` 单例改为每请求解析：`/sources/*`、`/notifications/*`、`/events`、`/sync` 的 `identity===who` 复查改为「该绑定仍然在表中且 device/user 一致」。单例守卫实体分布在三个文件，必须一并改，漏一处隔离即落空：`host/device-source-routes.mjs:9、15、19、24、29、43-45`（`createDeviceSourceRoute` 的 `who=identity()` 与多处 `identity()!==who`；`deviceAwareSourceConnection.who(args)` 比较 `identity()` 与 `args.userId`，且被无请求语境的后台路径复用）与 `host/source-event-bridge.mjs:142、249、256-261`（`active=who=>identity()===who`、`pump()` 直接取 `identity()`、宿主桥的归属复查）；后台泵（source 事件、通知派发）按绑定列表逐用户处理。请求体自称 user_id/device_id 的拒绝不变（`host/agent-host.mjs:176-179`）。
- **数据隔离清单**：
  | 数据 | 现状 | 云端 |
  | --- | --- | --- |
  | 配对绑定 | 单份 `pairing.json` | `pairings.json` 每用户一条（M1） |
  | 通知设备 | 单文件单槽位 | `notification-device.<userId>.json`（M2） |
  | Kimi 运行记录 | requestId 全局键 | `${userId}:${requestId}`（M2；云端休眠，本地兼容） |
  | `/goal/event` 互斥 | 全局一把 | 每用户一把（M2） |
  | 每日委托索引 | 按配对 token 哈希分键 | 键设计不变、天然隔离（`host/daily-action-history.mjs:33-51`）；但取值方的 recipient 必须随 M2 改为**请求自身绑定**的 tokenHash——现状取自单例（`host/agent-host.mjs:310、342、398、403`），M1 多绑定后单例不再代表任何一人，漏改会 A/B 互相污染 |
  | 设备来源/OKX 缓存 | 按 userId+goalId 分文件 | 不变（`host/device-source-gateway.mjs:31`） |
  | 目标空间（云端 v1） | 手机本地，键含 userId 或按手机天然隔离 | 不变（`web/event-workspace.mjs:196`；两人各用各的 iPhone） |
  | agent 侧 allowed 列表 | 数组幂等追加 | 两用户各一条（`along-superagent/src/along/api.ts:154-164`；云端 v1 不触达，本地模式受益） |
- **并发**：host 单进程、每用户一把 `/goal/event` 锁；runner 按「每次调用一个 dsh 进程」天然并行（用户之间互不阻塞）；同一用户并发第二条 `/goal/event` 仍返回现有 429 文案。运行链路另有资源防护（`docs/cloud-security-hardening.md` §3.1-(7)/§3.2）：host 对 `/super-agent/goals` 与 `/super-agent/tasks` 两个 start 端点做每用户滑动窗口限流（60 秒窗口内最多 10 次，超限 429；`status` 轮询端点不限）；runner 并发硬上限为每用户 2、全局 4 个 dsh 进程（超限回 429，host 原样透传给客户端）。

### 3.3 认证与密钥

| 凭证 | 存放 | 出现位置 | 红线延续 |
| --- | --- | --- | --- |
| 配对 token（64hex） | 服务端只存 SHA-256（`pairings.json` 0600）；iPhone Keychain | 仅 `/pair` 响应一次 | 与现状同口径（§2.3-1）；不进日志、不进运行结果、不复用为内网凭证 |
| 每用户配对码 | 服务端 `pairing-codes.json` 0600，15 分钟有效且使用后删除 | 部署者用 `docker exec` 取码，私下交付 | 公网限额在验码前生效。码和 token 均不进容器日志 |
| runner 内网令牌 | compose secret（`/run/secrets/runner-token`），host 与 agent 两服务共用；host 侧经 `ALONG_RUNNER_TOKEN_FILE` 读取（M3 实现拍板，读取手法同 `ALONG_BRIDGE_TOKEN_FILE`），设置了 `ALONG_DSH_RUNNER_URL` 而缺该文件 → host 启动即抛错不服务 | 仅 host↔agent compose 内网请求头（头名 `runner-token`） | 服务端内部凭证，绝不下发 |
| 模型 API Key | Compose secret `model-credentials`，一行纯 DeepSeek API Key | runner 启动时读取文件，仅向 DSH 子进程传入 `DEEPSEEK_API_KEY` | 不向客户端下发，不进镜像、日志或运行结果 |
| APNs key | compose secret（可选） | 仅 host 容器 | 同上 |
| Kimi token / 桥接凭证 | 云端不使用 | — | 云端无此凭证即无泄露面；本地模式口径不变（SD-2/`docs/stage-a-tech-design.md:262`） |
| OKX API Key | 只在 iPhone Keychain（现状） | 不变 | 「密钥只留采集设备」红线原样保持；云端 host 只收三字段摘要，多用户形态 gateway 拒收 `trading_history` 成交/账单明细（`host/device-source-gateway.mjs`，用户指引见 §6.4 第 9 步） |

- 「Token 只留在 Mac」在云端形态的等价表述：**「凭证只留在服务端（云主机）安全存储（卷/secrets/env），绝不发给 iPhone 或网页，也不写进运行结果和日志」**。云端传输面目标是系统验证的 TLS + Bearer；内网面是 compose 私网 + runner 令牌；公网面只有 443 一个端口。公开根证书可以安装到手机，根/叶私钥和模型/桥接/APNs/runner 凭证不可下发；配对 token 的一次性响应与只存哈希规则不变。

### 3.4 web/iOS 客户端连接迁移

- **Web 连接**：沿用现有连接/重新配对入口；DNS 系统策略不再要求叶指纹，Mac 私网路径保留。跨 Host 切换与 token 持久化仍遵循 Keychain 成功后启用、迟到回执隔离和云端 DSH 提示持久化。CA 同端升级与换端分开处理，不把叶换证误当换用户。
- **iOS 改动目标**：域名 HTTPS 使用 URLSession 系统信任和 ATS，移除云端 PinnedAgentDelegate 放行逻辑；规范化地址、无凭证/path/query/fragment、路径白名单、禁重定向和 DIRECT 策略保留。连接 v2、Mac 私网 pin 兼容、Web/原生桥、健康/设备来源/通知的 fingerprint 消费点须一起迁移，详见 [CA 方案 §2](iphone-ca-profile-design.md)。安装系统根不会让旧 App 自动完成这些修改。
- **版本联动**：当前候选 Web 版本为 82，App `CFBundleVersion` 为 73；`index.html`、Service Worker 缓存名和内置页 URL 同步更新。iPhone 需要安装新版本。
- **健康事件 outbox 迁移口径**：outbox 绑定哈希含 baseURL（`ios/AlongHealth/Sources/HealthKitReader.swift:786-790`），换地址会归档旧 outbox 并按新绑定重建（`:819-827`）；OKX 绑定不含 baseURL（`ios/AlongHealth/Sources/PhoneSourceCoordinator.swift:513-516`，注释明写「Mac 地址变更是传输层不是新配对」）。云端 v1 不开新链路，outbox 场景仅在回退 Mac 模式时出现；Runbook 顺序把「切换前先在旧端同步清空 outbox」列为步骤（§6.4 第 8 步）。

### 3.5 agent 链路上云（Linux 运行时事实与两级形态）

**已核实事实**：agent 核心（DSH/DeepSeek Harness）桌面运行时是 darwin/arm64 专属（§2.1），`along-superagent` 是插件 bundle。官方 Linux 可运行发行物为公共 npm 包 `@deepseek-ai/dsh`（0.2.2-rc.5，node>=24.9.0），官方服务器形态是 **headless profile：一次性进程，无监听端口，stdout 输出最终答案**（用户确认）。因此：

- **Tier 1（云端 v1，本轮实现并验收）**：目标聊天链路上云，旧链路语义。
  - **agent 容器** = `node:24` + `@deepseek-ai/dsh@0.2.2-rc.5`（版本写死在 `deploy/Dockerfile.agent`）+ `deploy/agent-runner.mjs`（极小 HTTP 服务，仅 compose 内网监听 3088）。
  - **Runner 契约**：`POST /run {userId,requestId,kind,input}` 立即返回 `{run}`，新记录状态为 `working`，同键重提交返回原记录。`GET /run/:requestId` 使用 `x-along-user` 查询同一个运行的在途或终态，两个端点都使用 `runner-token`。已完成记录 LRU 上限为 200。在途记录独立保留，接单时间与请求身份贯穿同一轮。DSH 无结果、超时或输出无效时落 `blocked`。`GET /health` 供 Compose 探活。
  - **提示词契约归一共享层**：把 `GOAL_OUTPUT_INSTRUCTIONS`（目标输出 JSON 形状，现内嵌 `host/kimi-code-agent.mjs:38-40`）上移到 `web/goal-agent-core.mjs` 导出，Kimi 与 runner 共用；情境评估复用既有 `REASSESSMENT_INSTRUCTIONS`（`web/contextual-planning.mjs`，两条运行时已共用）。这落实「两条运行时对同一契约必须同结论、归一放共享层」的既有纪律（`docs/bugfix-goal-prompt.md` §7）。
  - **Host 分流与校验**：设置 `ALONG_DSH_RUNNER_URL` 时，DSH 的目标、任务、状态和连接检查走 runner；未设置时继续使用 Mac bridge。提交和查询都校验回执类型和请求编号；目标回执再经过现有的目标、布局和情境变更校验。已校验的情境输入只在 Host 与 runner 之间传递，客户端只收到最小运行信封。校验通过的目标聊天由 Host 标记后在客户端自动生效，健康情境重评沿用单独的结果路径。
  - **客户端恢复**：同一云端连接的在途目标即使换页或重开 App，也按原编号查询。首回执丢失后，只有 Runner 确认记录不存在且接单宽限已过，才立即提示重发。临时网络错误继续遵循运行超时。
  - **执行边界**：runner 通过 stdin 把提示交给固定版本的 `dsh --profile along-headless`，使用显式模块集且无模型可见工具。每次调用新建私有工作目录和 DSH home，完成后清理。云端 agent 容器根文件系统只读，临时目录位于有上限的 tmpfs，运行子进程只接收必要的环境变量及模型密钥。
  - **开关语义不变**：云端 v1 `ALONG_EVENT_INGEST` 不设置（off）→ 新链路端点 503、旧链路 DSH 分支正常（`host/agent-host.mjs:162-167`）；情境评估凭证/桥接凭证不配置 → 相关守卫自然跳过（`:71-75`）。
- **Tier 2（新链路数据面上云，验证项 V-1）**：**V-1 已通过**，路线定为「常驻 DSH profile + 兼容适配」。along bundle 以可解析包形态装进 `@deepseek-ai/dsh` CLI 的 node_modules 树（不是只配 bundle 层——那会 ERR_MODULE_NOT_FOUND），长驻承载 `/along-source/api/*`、`along.sqlite` 与投递泵。compose 侧：新增 `superagent` 服务（挂 `tier2` profile）、`bridge-token` secret、持久卷（`data/superagent` + `data/dsh-home`）。两种结果都只动配置与开关，不改协议（BC-09-03/04 回退语义原样适用）。**就绪契约**：既有路径 `/along-source/api/goals/along-status-probe`——就绪 `200 {"service":"along-source","ready":true}`，未就绪 `503 {"error":"along_source_not_ready"}`；不另造 `/ready` 路径（那会 404 并被当成「旧版没契约 → 就绪」，恰好把要防的启动窗口放回去）。

  **网络拓扑**：superagent 与 host **共享网络命名空间**（`network_mode: "service:host"`），且**不发布任何端口**——Super Agent 侧两处硬性要求 `webserver.host === '127.0.0.1'`，共享命名空间 + 只监听回环天然满足「管理面仅本机可达」，宿主机与外网都连不上 3082。

  **形态开关**：Tier 2 用叠加文件 `deploy/docker-compose.tier2.yml` 表达（`ALONG_EVENT_INGEST=on`、`ALONG_SUPERAGENT_URL`、`ALONG_BRIDGE_TOKEN_FILE` + 两侧挂同一份 `bridge-token` secret），主 compose 保持 Tier 1 默认形态。桥接凭证是 file secret，宿主文件缺失会让 `up` 硬失败——写在主 compose 里会让没部署凭证的 Tier 1 部署连 `up` 都跑不了。

### 3.6 红线在云端形态的等价延续

| 红线（AGENTS.md §5） | 云端落法 |
| --- | --- |
| Token 只留在 Mac 上 | 改述为「凭证只留在服务端安全存储」：Kimi/模型/桥接/APNs/runner 凭证只进云主机的卷/secrets/env（§3.3 表）；配对 token 服务端只存哈希、响应只出现一次；不写运行结果与日志。M7 修正 AGENTS.md/README 文案（§2.3-1；§5 红线文字修订须用户确认，SD-6） |
| Agent 输出先校验后生效，校验只能加严 | runner 返回一律过 `normalizeGoalRun`（`validateGoalReply`+`safeAdaptiveLayout`+`validateReassessment`）；失败落 `blocked` 终态；本轮不放宽任何校验函数，只新增共用形状常量（M3） |
| 目标只能通过聊天改变 | 云端 v1 无新链路写入口，目标空间只在客户端由校验过的 run 自动写入（`web/app.mjs` applyGoalRun 旧链路语义）；无任何直接编辑入口 |
| 健康数据只发汇总值 | 云端 v1 不接收健康事件（端点 503）；旧链路聊天快照仍走 `cleanSnapshot`/`agentHealthSnapshot` 白名单（`host/agent-host.mjs:123-152、373`），原始样本不出手机 |
| 数据优先在授权设备采集、密钥留采集设备 | OKX 仍由 iPhone 原生只读采集（Tier 2 才涉及服务端持久化，本轮不动）；`/sources/*` 云端 503 不构成绕过 |
| 校验后自动生效、不新增采用/审批 | 云端链路无采用环节；`/pair` 多用户不构成审批（是既有配对流程的按用户实例化） |

### 3.7 云端日志与留存红线

云端把日志从「终端会话」变成「云主机持久留存」，必须把留存面收敛到与 Mac 现状同级或更小：

- **运行内容不落日志**：dsh headless 的 stdout/stderr 就是运行结果（含用户消息与模型输出），runner 只解析、不写日志（M3）；host 既有代码本就不打印请求体与模型输出，本轮新增代码延续同一纪律（AGENTS.md §5「不写进运行结果和日志」）。
- **配对码不落容器日志**：`users.json` 存在时启动不生成、不打印通用码（§3.2）；每用户码经 `docker exec`（输出进管理员终端，不进容器日志）+ 私下渠道交付。
- **凭证不落日志**：secrets/env 值不打印；启动横幅只打印地址、证书指纹与到期时间（M4）。
- **留存上限**：compose 两个服务都配 `logging: json-file max-size/max-file` 轮转（§3.1），云端不留无限增长日志。验收 #5 覆盖以上各条。

## 4. 分模块实现清单

每个模块 = 一次施工 + 一次测试 + 一次 `npm run check` 门禁（语法检查 + 全部测试）。按依赖排序。

### M1 配对多绑定与用户表

- **目标**：`pairings.json` 支持两位静态用户各自绑定。发码 CLI 按用户签发一次性码，`/pair` 在读取到达限额的按来源失败窗口后直接返回 403。设备更换只替换该用户自己的绑定。
- **涉及文件**：新增 `host/pairing.mjs`（绑定表读写/升级/查找/校验 + 配对码文件与按来源失败窗口计数）、`host/pair-code.mjs`（CLI：`node host/pair-code.mjs <userId>` 写 `pairing-codes.json` 0600）；修改 `host/agent-host.mjs`（`/pair` 限速语义、`authorized()`、配对码加载）；测试：新增 `test/host-multi-user-pairing.test.mjs`（含防枚举限速断言），回归 `test/pairing-host-verify.test.mjs`（真实进程 + HTTPS 全链路，`USER_B` 脚手架已存在）。
- **依赖**：无。

### M2 请求级身份与每用户隔离

- **目标**：消除 `identity` 模块级单例：每请求解析自己的绑定；`/sources/*`、`/notifications/*`、`/events`、`/sync` 的绑定一致性复查、后台泵逐用户；通知登记按用户分文件；Kimi 运行键加 userId 前缀且 `statePath` 接到 host 状态目录；`/goal/event` 按用户分锁；每日委托 recipient（`/super-agent/daily-delegation` 与 `/super-agent/goals` 的 include/remember/pair 参数）改为请求自身绑定的 tokenHash。
- **涉及文件**：`host/agent-host.mjs`、`host/task-notifications.mjs`、`host/device-source-routes.mjs`（`identity()` 单例守卫，`:9、15、19、24、29、43-45`）、`host/source-event-bridge.mjs`（`:142、249、256-261`）、`host/kimi-code-agent.mjs`；测试：新增 `test/host-multi-user-isolation.test.mjs`；回归 `test/host-task-notifications.test.mjs`、`test/kimi-run-convergence.test.mjs`、`test/kimi-state-recovery.test.mjs`、`test/device-source-routes.test.mjs`、`test/source-access.test.mjs`、`test/source-event-bridge.test.mjs`、`test/host-daily-delegation.test.mjs`。
- **依赖**：M1。

### M3 云端 agent 适配层（runner + host 分流 + 契约归一）

- **目标**：新增 `deploy/agent-runner.mjs`（内网 HTTP 服务：按调用拉起 `dsh` headless、stdout JSON→运行信封、按 userId+requestId 缓存、runner-token 鉴权、`/health`）；`host/agent-host.mjs` 的 DSH 分支支持 `ALONG_DSH_RUNNER_URL` 分流（未设置=Mac bridge，行为不变）；`GOAL_OUTPUT_INSTRUCTIONS` 上移 `web/goal-agent-core.mjs` 供 Kimi 与 runner 共用；runner 返回一律过 `normalizeGoalRun` 校验链；信封 `runtime` 固定 `'dsh-superagent'`（§3.5）。该模块使 `web/goal-agent-core.mjs` 进入产物变化，按 SD-5 同步提高 `web/index.html` 的 `?v=` 与 `web/sw.js` 的 `CACHE`。
- **涉及文件**：新增 `deploy/agent-runner.mjs`、`test/host-runner-agreement.test.mjs`（信封过 `safeGoalSuperAgentRun` 白名单 + 校验失败落 blocked + 两条运行时同契约断言）；修改 `host/agent-host.mjs`、`host/kimi-code-agent.mjs`（改为 import 共享常量）、`web/goal-agent-core.mjs`（导出常量）、`web/index.html`（`?v=` 80→81）与 `web/sw.js`（`CACHE` along-shell-v80→v81，与目标行和 SD-5 一致）；回归 `test/kimi-code-agent.test.mjs`、`test/host-runtime-agreement.test.mjs`、`test/host-goal-run-terminal.test.mjs`。**施工记录**：`test/host-multi-user-rebind.test.mjs` 切片 `/super-agent/goals` 处理器的 VM 上下文补了 `dshRunnerURL:null`（M3 分支在该切片关闭，runner 路径由新测试覆盖）；M5 的 compose 必须按 §3.1 给 host 服务加 `ALONG_RUNNER_TOKEN_FILE` + `secrets` 里的 `runner-token` 引用。
- **依赖**：M2（运行键/身份约定）。M3 完成后额外运行 `node --check deploy/agent-runner.mjs`（deploy/ 不在 check 目录规则内，属模块内自检）。

### M4 云端 TLS 与启动参数

- **目标**：旧实现已支持 ALONG_TLS_DAYS/CN 与到期横幅，作为本地兼容基线保留；云端目标改为预签发短期 SAN 叶、固定证书版本目录及启动前检查，不允许缺证自签兜底。服务器证书加载、轮换及健康检查目标按 CA 方案 §3/§6/§7 实施；监听端口映射保持不变。
- **涉及文件**：`host/agent-host.mjs`；新增 `test/host-cloud-tls.test.mjs`（临时状态目录 + env 启动真实进程，断言 cert CN/notAfter 与指纹打印）；回归 `test/pairing-host-verify.test.mjs`。
- **依赖**：M3（同文件顺序施工）。

### M5 Docker 编排与部署产物

- **目标**：两个镜像 + compose 编排可构建可启动：`deploy/Dockerfile.host`（node:22-bookworm-slim + openssl，COPY host/ 与共享的 web/*.mjs——镜像必须携带 host→web 的**完整 import 闭包**且平铺保持仓库布局。本轮以 `grep -rn "from '../web/" host/*.mjs` 实测闭包为准：`goal-agent-core.mjs`、`adaptive-ui.mjs`（→goal-agent-core）、`super-agent.mjs`、`contextual-planning.mjs`、`loop.mjs`（→health.mjs、goal-agent-core）、`health.mjs`（→contextual-planning）、`task-results.mjs`（`host/task-notifications.mjs:4` 直接导入，不在其他任何共享文件的依赖链里，漏掉即启动 MODULE_NOT_FOUND）；闭包随代码演进会变，M5 施工时以当次 grep 为准，上述文件均已登记在 `tools/build.mjs:2`）、`deploy/Dockerfile.agent`（node:24 + `@deepseek-ai/dsh@0.2.2-rc.5` pin；经 compose `additional_contexts` 引 `../../along-superagent`（基准=project directory deploy/，§3.1 施工修正），把 along bundle 复制进镜像为 V-1 预置，§3.1/§6.4）、`deploy/docker-compose.yml`（§3.1）、`deploy/env.example`、`deploy/README.md`（构建与本地冒烟）。
- **涉及文件**：新增 `deploy/Dockerfile.host`、`deploy/Dockerfile.agent`、`deploy/docker-compose.yml`、`deploy/env.example`、`deploy/README.md`、仓库根 `.dockerignore`。Host 镜像用锁文件安装生产依赖，Agent 镜像保留相邻 bundle 的各源目录。模块内自检：`node --check deploy/agent-runner.mjs`、`docker compose -f deploy/docker-compose.yml config` 通过；`npm run check` 保持绿（deploy/ 不在 check 目录规则内）。
- **依赖**：M3、M4。

### M6 iOS 连接地址迁移与版本联动

- **目标**：DNS 连接使用系统信任；原子迁移连接 v2 及稳定绑定作用域；Mac 私网能力回归不变。新 App 必须与 profile 安装及服务端叶切换协调，不以历史 80→81/71→72 覆盖当前版本号。
- **涉及文件**：AlongShellView.swift、Info.plist、HealthKitReader.swift、PhoneSourceCoordinator.swift、EventTaskNotifications.swift、`web/agent-client.mjs`、`web/app.mjs` 及版本文件；完整范围和 T01–T21 见 CA 方案 §7/§8。
- **依赖**：本地开发可先用测试 CA；生产切换依赖 M4 的 CA 叶、两手机完成根信任和新版本就绪，不能仅按旧 M6 域名放行测试验收。

### M7 文档、决策与 Runbook 终稿

- **目标**：AGENTS.md §4 与 README 配置/隐私表按云端形态改写（含 §2.3 三处文案修正）；`docs/README.md` 索引登记本文档；本设计文档 §6 Runbook 定稿；agent 仓库决策记录追加 D1 修订条目（「云端单机 2 用户部署」扩展 D1，不推翻「对象保留 user_id 归属检查」）。**AGENTS.md §5 红线措辞的修订（「Token 只留在 Mac 上」→「凭证只留在服务端安全存储…」）须经用户明确确认后才可执行**（SD-6）；确认后新措辞必须完整保留实质约束：凭证不写运行结果与日志、配对 token 不复用为回环凭证、模型/桥接/APNs 凭证绝不下发 iPhone 或网页。
- **涉及文件**：`AGENTS.md`、`README.md`、`docs/README.md`、`docs/cloud-deploy-multi-user.md`、`../along-superagent/docs/along/000-decisions.md`。
- **依赖**：M1–M6 全部。
- **施工记录（2026-11-20）**：§5 红线措辞修订经派工指令明确确认后执行（SD-6；新措辞完整保留实质约束——凭证不写运行结果与日志、配对 token 不复用为服务端内部凭证、模型/桥接/APNs 凭证绝不下发 iPhone 或网页，且把「不发给 iPhone」加严为「不发给 iPhone 或网页」）。§2.3 三处文案修正的落点：修正 1 落 AGENTS.md §5 与 README 隐私表「凭证只留服务端」行；修正 2 落 AGENTS.md §4 与 README 配置段（两处状态目录口径）；修正 3（「全局单飞锁阻塞整个 host」）在 AGENTS.md/README/docs 现有文本中无落点（全库 grep 无该表述），以 §2.1 现状结论「以代码为准」承载，无需另行改文。README 配置表补齐 M1–M4 新增变量（`ALONG_AGENT_STATE_DIR`/`ALONG_TLS_*`/`ALONG_DSH_RUNNER_URL`/`ALONG_RUNNER_TOKEN_FILE`/`ALONG_PAIR_FAIL_LIMIT`，默认值按实现核对）；README「连接凭证的哈希」一段的 `pairing.json` 过时路径改为 `pairings.json` 多绑定口径。遗留：`docs/bugfix-goal-prompt.md` 第 7 节前的红线清单仍沿用「Token 只留在 Mac」旧措辞（不在本模块文件清单内，未改），下轮触碰该文档时应同步为新口径。agent 仓库决策记录追加 D19（扩展 D1，不推翻）。

## 5. 验收标准（可测试）

门禁基线：`npm run check`（`node --check` 覆盖 `web/*.mjs`、`web/sw.js`、`host/*.mjs`、`tools/build.mjs` + `node --test test/*.test.mjs`）在本设计阶段已实际运行，509 条测试全绿；每个模块合入后**必须重跑**并保持全绿（评审未复跑不构成免跑理由）。

1. **多用户配对（M1）**：两个用户分别凭 CLI 发放的一次性码完成配对，两份 token 同时有效。同一用户重新配对只替换其自己的绑定。失败达到上限时，错误码和有效码统一返回 403，有效码保持未消费。覆盖按来源窗口自然恢复（发码不清窗，无清窗入口）、成功只清该来源的桶及本地通用码兼容。
2. **每用户隔离（M2）**：stub 上游断言 `/sync`、`/events` 转发头 `x-along-user` 等于请求者绑定；A、B 并发 `/goal/event` 都推进（各自锁），同一用户并发第二条得 429；`notification-device.<userId>.json` 互不覆盖；Kimi 运行键 `${userId}:${requestId}`，B 查 A 的 requestId 报「运行记录不存在」；**跨用户断言**：A 的绑定查不到 B 的每日委托索引（键含 pair 哈希，`host/daily-action-history.mjs:33-51`），A 的事件不会推到 B 的设备（ingest 对 `item.userId!==who.userId` 拒绝，`host/task-notifications.mjs:152`）。以上在 `test/host-multi-user-isolation.test.mjs` 断言。
3. **runner 契约（M3）**：`ALONG_DSH_RUNNER_URL` 指向 stub runner → `/super-agent/goals` 返回的 run 过 `normalizeGoalRun`；非法 JSON/校验失败 → `status:'blocked'` 终态不重试；run 信封通过 `safeGoalSuperAgentRun` 且 `runtime==='dsh-superagent'` 显式断言（不得误标 `kimi-code-swarm`）；不设该 env → 走 bridge 的现有测试全绿（两条运行时同契约回归）。
4. **TLS 与信任迁移（M4/M6）**：按 CA 方案 T01–T21 验收系统根安装/完全信任、链/SAN/时间/ATS、旧连接及后台作用域、换叶/撤根与私钥失窃；旧 ALONG_TLS_* 自签测试仅证明 Mac 兼容基线，不证明新云端路线通过。
5. **编排（M5）**：`docker compose -f deploy/docker-compose.yml config` 校验通过；两镜像在 Linux 上构建成功；`compose up` 后 host `/health` 200、agent `/health` 200、`docker logs along-host` 可读出证书指纹且启动横幅为 `https://0.0.0.0:4176`（`ALONG_AGENT_HOST=0.0.0.0` 生效——容器内无 en0，缺 env 会回退绑 127.0.0.1 导致 443 映射打不通，`host/agent-host.mjs:68`）；**路径一致性断言**：容器内 `/data/users.json` 与 Runbook 第 4 步写入的 `/opt/along/data/host/users.json` 是同一文件（`../../data/host` 基准 = deploy/ 目录，§3.1），缺失或无效时 Host 拒绝启动（§3.2）；**可选路径断言**：按 compose 注释删除 apns-key 三处引用后 `compose up` 仍成功（file secret 缺失不删引用则是硬错误）；secrets 文件内容不出现在任何镜像层（`docker history` 抽查）与日志；`deploy/env.example` 只含非敏感示例值（无真实凭证）；`docker logs` 中不出现请求体、运行内容（用户消息/模型输出）、配对码与凭证（§3.7）。
6. **iOS（M6）**：编译真实 Swift 的 `ios-connection-migration` 测试断言：`https://along.example.com` 通过；`http://`、带 user:password、带 path/query、非法域名段、非私网数字 IP 全部拒绝；私网 IPv4 行为不变。
7. **真机端到端（上线验收，§6.4 之后）**：两台 iPhone 各自配对并验证就绪，每人通过聊天新建目标、再修改已有目标，两次结果都在校验通过后自动生效，两台设备看不到对方的会话和目标。已有 Mac 配对的手机走一次切到云端并切回 Mac 的流程。
8. **红线回归**：`test/along-bridge.test.mjs`、`test/source-event-bridge.test.mjs`（loopback 守卫）、`test/device-source-gateway.test.mjs`、`test/goal-agent-core.test.mjs`、`test/adaptive-ui.test.mjs`、`test/event-queue.test.mjs` 全部不改语义通过——证明校验与守卫零放宽。
9. **验证项 V-1（Tier 2 门槛，不在本轮验收）**：在 Linux 容器内用 `@deepseek-ai/dsh` CLI 以层路径挂载 along bundle，能加载并能承载长驻 `/along-source` 服务 → 记录可行性与配置进本文档；不能 → 记录失败原因，云端维持 Tier 1。
10. **云端降级语义（M3/M5）**：`/goal/event` 在云端返回既有失败语义（镜像无 codex，`host/codex-agent.mjs:9-14`），属预期、不判故障；Kimi 运行时报「未找到 Kimi Code Web Server token」属预期（§1）。

## 6. 风险与迁移

### 6.1 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| headless 规划配置或模型凭证错误 | 目标聊天失败 | runner 启动时读入密钥。按 deploy/README.md 通过经过认证的 runner 进行一次真实模型冒烟，确认终态和结构化结果 |
| along bundle 在 npm CLI 下无法加载（V-1 失败） | 新链路数据面不上云 | 设计已按 Tier 1 收敛：云端 v1 只依赖 goal 聊天链路，不依赖 bundle；Mac 本地模式保留全部能力 |
| 叶过期、根失窃或手机未完成系统信任 | TLS 失败或仍信任被盗身份 | 按 CA 方案轮换/撤根；同根同域计划换叶不重配对，私钥失窃不能只部署新叶了事 |
| Runner 进程重启丢失内存中的运行 | 原运行无法续查 | App 通过原编号查询至终态或超时。必要时通过聊天重发 |
| 云主机持有配对哈希与每日委托索引 | 服务器被读 | 状态目录 0700/文件 0600 + ECS 加密盘（Runbook 步骤 1）；哈希不可逆；无原始健康样本、无 OKX 密钥、无模型凭证明文落盘（全在 secrets） |
| 两用户共用 DeepSeek API Key | 计费和额度共用 | Runner 进程为每轮分配独立临时目录，模型计费仍归同一账号 |
| `network` 内 runner 被宿主机其他进程访问 | 内网凭证泄露 | runner 只监听容器内网；宿主机上只有 docker0 桥，无发布端口；runner-token 校验兜底 |
| 公网配对失败达到上限 | 已发出的有效码暂时不可用 | 窗口按来源分桶：满窗只对该来源停止验码，其他用户照常；发码不清窗，15 分钟自然过期自愈，无清窗入口 |
| 管理员发码进程与 Host 同时更新配对状态 | 并发状态写入 | 共用跨进程锁，锁内完成读改写 |
| Compose 路径错位或 secret 缺失 | Host 或 Compose 拒绝启动 | 固定 §6.4 路径，冒烟核对容器内 `/data/users.json` 与启动横幅 |

### 6.2 Mac 本地数据怎么迁

云端 v1 **不迁移业务历史库**（along.sqlite 属 Tier 2 数据面；云端 v1 目标空间在手机本地延续）。当前 `persistAgentConfig` 仍按 token/指纹变化清背景模板并撤销每日委托；CA 同端升级须按专项方案先验证同一绑定并映射稳定 scope，不能因叶指纹消失误撤授权。真正跨 Host 的迁移/重建如下：

1. **用户身份**：从实际在用的 Mac 状态目录读取 `pairings.json` 中现役绑定的 `user_id`，仅把该值写入云端 `users.json`。直接 `npm run agent-host` 默认用 `~/.along/agent-host/`，`npm run activate` 默认用 `~/.along/phone-test/host/`。旧版还未迁移时可读 `pairing.json` 的 `user_id`。旧文件只有哈希时，先用当前 Host 启动完成迁移再读。用户 B 使用新 `u_` 号。
2. **可选历史快照**：如需在云端可见旧聊天记录，仅迁移手机本地数据（换地址自动保留）；服务器侧 `device-sources/`、`okx-connections/`、`source-events/`、`kimi-runs.json` **不拷贝上云**（原 Mac 数据保留用于回退，回退零成本）——`okx-connections/` 是可解密的 OKX 凭证库，云端多用户形态启动守卫发现它即拒绝启动（`docs/cloud-security-hardening.md` §3.1-(2)）。
3. **通知登记**：新端重新登记（App 首次连接后自动上报 APNs token，`/notifications/device`，云端 v1 也可先不配 APNs key）。
4. **健康事件 outbox**：切换前在旧端把待同步队列清空（打开 App 等同步完成），换址后 outbox 按新绑定重建（§3.4）；云端 v1 该链路 503，原始摘要仍只在手机与 Mac。
5. **每日委托授权随换端失效（要提前告知用户）**：重新配对（token/指纹变化）触发 `persistAgentConfig` 的 `revokeDaily()`（`web/app.mjs:111-115`），健康目标的每日委托授权被撤销；换到云端后如需情境评估的每日委托，须在新端重新确认授权——这是既有安全语义（授权跟绑定走），不是缺陷，Runbook 第 9 步后向两位用户说明。

### 6.3 迁移期间如何回退

- **回退到 Mac**：原 Mac 数据仍在原地。用 `npm run activate` 启动原服务，在 iPhone 当前连接区选择重新配对，填写 Mac 的局域网 HTTPS 地址、证书指纹和新码。
- 云端侧回退更简单：`docker compose down` 即停止服务，卷数据保留。
- 代码层回退：未设置 `ALONG_DSH_RUNNER_URL` 时使用 Mac bridge；未设置 `ALONG_TLS_*` 时沿用本机证书默认值。

### 6.4 上线 Runbook（由用户手动执行）

> **2026-11-20 定稿**：命令以本节与 deploy/README.md 为准。真实模型冒烟经过配置好的 runner，覆盖模型凭证、规划配置和隔离工作目录。

> **2026-11-21 修订门槛**：先完成 CA 专项方案的代码、测试材料及真机验收准备；当前运行配置仍是旧自签实现，不能仅照此文档启动就宣称 CA 已上线。实际执行还需生产输入和部署授权，本轮均未操作。

前置：一台 ECS（建议 2C4G 起，Ubuntu 22.04/24.04）、一个域名、两台已装当前候选 App 的 iPhone（`CFBundleVersion=74`）。

1. **主机初始化**：安装 Docker（≥24）与 compose v2；安全组只开 22/443；建议启用 ECS 云盘加密；`mkdir -p /opt/along/{data/host,secrets}`（`deploy/` 由第 2 步 clone 自带；这两个目录在 git 仓库**外层**，compose 经 `../../` 相对路径引用，基准=compose 文件所在目录 deploy/，§3.1）并收紧权限：`chmod 700 /opt/along/data/host /opt/along/secrets`（默认 umask 建出的是 0755，与 §3.1 的 0700 声明不符；第 3 步的密钥文件另须 0600）。
2. **取代码**：`git clone` 本仓库与 `along-superagent` 保持相邻布局（`/opt/along/along` + `/opt/along/along-superagent`）；`cd /opt/along/along`。
3. **写密钥**（全部 0600，绝不进 git/镜像；路径写死 `/opt/along/secrets/`，与 compose `../../secrets/…` 解析结果一致，§3.1；写完 `chmod 600 /opt/along/secrets/*`）：`/opt/along/secrets/runner-token`（`openssl rand -hex 32`）、`/opt/along/secrets/model-credentials`（一行纯 DeepSeek API Key，末尾可有换行）、可选 `/opt/along/secrets/apns-key.p8`（从 Mac 环境变量同值迁移，并同步记下 `ALONG_APNS_TEAM_ID`/`ALONG_APNS_KEY_ID` 两个非敏感值写入 compose env——`host/apns.mjs:8-14` 要求三件齐全才会创建 provider，只挂文件不配 env 通知会静默失效；不部署远程通知则不写该文件，并按 §3.1 注释删除三处引用）。**密钥统一用下述形态写入**：`umask 077` 预设权限、`HISTFILE=/dev/null`（或执行前 `set +o history`）不落 shell 历史、`install -m 600 /dev/null` 预建空文件、`read -rs` 静默读入再重定向——杜绝 key 明文出现在命令行参数里进历史与进程列表（`docs/cloud-security-hardening.md` §6 步骤 2）：

   ```sh
   umask 077
   HISTFILE=/dev/null   # 本条会话不落历史（或执行前 set +o history）
   install -m 600 /dev/null /opt/along/secrets/runner-token
   read -rs -p "runner-token(留空自动生成): " v; [ -n "$v" ] || v=$(openssl rand -hex 32); printf '%s\n' "$v" > /opt/along/secrets/runner-token; unset v
   install -m 600 /dev/null /opt/along/secrets/model-credentials
   read -rs -p "DeepSeek API key: " v; printf '%s\n' "$v" > /opt/along/secrets/model-credentials; unset v
   ```

   恢复或手工搬运 secret 文件后统一 `chmod 600`（相邻仓库备份脚本只有备份链路、恢复未实现，手工 `cp`/`mv` 可能改变权限位；权限过宽会被 0600 校验拒绝启动）。
4. **写用户表**：按 §6.2 读取 Mac 用户 A 的现役 `user_id`，在 `/opt/along/data/host/users.json` 写入 `[{"userId":"<Mac 的 user_id>","label":"A"},{"userId":"u_<新8hex>","label":"B"}]` 并 `chmod 600`。写入其他路径会导致云端 Host 拒绝启动。
5. **构建与启动**：`docker compose -f deploy/docker-compose.yml build`（构建口径统一由 compose 的 `build` 段承载：context `..` 以 deploy/ 为基准解析到仓库根，agent 经 `additional_contexts: {along: ../../along-superagent}` 预置 bundle（相对路径以 project directory 为基准，与手工 --build-context 从 cwd 解析不同）——手工等价命令（cwd=仓库根 `/opt/along/along`）`docker build --build-context along=../along-superagent -f deploy/Dockerfile.agent . -t along-agent:local`，位置参数必须是 `.`（仓库根），写 `..` 会以 `/opt/along` 为 context 导致 COPY 找不到 host/ 且把相邻仓库与 secrets/ 整包送进 context）；`docker compose -f deploy/docker-compose.yml up -d`（若不部署远程通知，先按 §3.1 注释删除 apns-key 三处引用再 up，否则 file secret 缺失直接报错）；冒烟：`docker logs along-host` 看到 `Along 服务: https://0.0.0.0:4176` + 证书指纹 + 证书到期时间（M4 起横幅打印到期，`host/agent-host.mjs:538`；`ALONG_AGENT_HOST=0.0.0.0` 必须生效：容器内没有 en0，缺 env 会回退绑 127.0.0.1、443 映射打不通，`host/agent-host.mjs:68`；多用户形态下横幅**不打印**配对码，发码走第 7 步），`docker exec along-host sh -c 'ls /data/users.json'` 可见（挂错卷会阻止 Host 启动，§3.1），`docker exec along-agent node -e "fetch('http://127.0.0.1:3088/health').then(r=>r.json()).then(console.log)"` 返回 ready；按 [部署冒烟](../deploy/README.md#冒烟验收-5runbook-64-第-5-步) 通过已认证的 runner 完成一次真实模型调用。
6. **DNS、证书与手机根信任**：域名**只配 A 记录**指向 ECS 公网 IPv4，**不配 AAAA**——IPv6 客户端经 docker-proxy 会让源 IP 退化为网关地址，`/pair` 按来源失败分桶与单 IP 连接上限都会失效（指无法达到逐外部来源隔离的目标；当前编排的源 IP 前提仍须实测，`docs/cloud-security-hardening.md` §3.1-(3)，不以 DNS 代替网络检查）。先按 CA 方案 §4 带外核验 profile 及根摘要，两手机分别安装并开启完全信任；服务端按 §3 预置证书版本。用带 CAfile、SNI 和 verify_hostname 的 TLS 探针检查实际链与 SAN；不能只核对 CN 或沿用关闭 TLS 验证的探活结论。**预置证书版本这一步必须做，否则 Host 直接拒启**（`host/tls-material.mjs` 缺证即抛错，不回退自签）：把签发好的叶材料放进 `/opt/along/data/host/tls/releases/<serial>/`（`fullchain.pem`、`key.pem`、公开 `root.crt`），再把 `tls/current` 原子切到该版本。注意宿主机上的属主必须与容器内 Host 进程的 uid 一致——compose 的 host 服务按 SD-H5 不加非 root `USER`，进程 uid 为 0，所以宿主机放置材料时要 `chown root:root`（若管理员以其他账号放置，Host 会因「所有者不是 Host 用户」拒启），私钥 0600、目录 0700：

   ```sh
   # LEAF_SERIAL 使用签发版本号。三个 *_PEM 变量是已校验材料的本地源文件。
   tls=/opt/along/data/host/tls
   release="$tls/releases/${LEAF_SERIAL:?请指定签发版本号}"
   install -d -m 700 -o root -g root "$release"
   install -m 644 -o root -g root "${FULLCHAIN_PEM:?}" "$release/fullchain.pem"
   install -m 644 -o root -g root "${ROOT_PEM:?}" "$release/root.crt"
   install -m 600 -o root -g root "${LEAF_KEY_PEM:?}" "$release/key.pem"
   # 相对链接在容器 /data 挂载内仍有效。同文件系统 rename 原子切换。
   staged="$(mktemp -d "$tls/.switch.XXXXXX")"
   ln -s "releases/$LEAF_SERIAL" "$staged/current"
   mv -Tf "$staged/current" "$tls/current"
   rmdir "$staged"
   ```

7. **发码配对**：TLS 及新 App 就绪后，同端原 token 有效则先迁移验证；确需新配对时才对该用户 `docker exec along-host node host/pair-code.mjs u_xxx`，私下交付「`https://<域名>` + 8 位一次性码」（15 分钟）。根摘要在安装阶段核验，不作为 App 叶指纹输入。
8. **切换前旧端收尾**：在 iPhone 上连旧 Mac 服务打开 App，等健康/事件同步清空待发队列，旧 Mac 服务可停可不停。
9. **iPhone 迁移/配对**：两台新版本 App 按 CA 方案 §5 切换；云端 DNS 不填写叶指纹。只有真正换端或原 token 失效才重新配对，Keychain 保存成功后启用。分别确认前后台连接、聊天修改目标自动生效及用户隔离；真正换端按原规则重新授权，同根同端换叶不误撤授权。**向两位用户说明 OKX 采集口径**：云端使用期间 iPhone 的 OKX 连接保持「仅账户摘要」，勿开启成交/账单明细采集——多用户形态 gateway 拒收明细，且明细与摘要在同一次原子发布里，开启后发布会持续失败、连接无法就绪；需明细复盘时在 Mac 本地模式操作（`docs/cloud-security-hardening.md` §3.5）。
10. **观察与轮换**：观察 24 小时。同根同域换叶后原配对继续使用。证书材料按第 6 步切换。Tier 1 执行 `docker compose -f deploy/docker-compose.yml up -d --no-deps --force-recreate host`。Tier 2 按 §6.5 保留叠加文件重建。旧自签材料 `/opt/along/data/host/cert.pem` 与 `/opt/along/data/host/key.pem` 可离线备份到 0700 目录。换域名按换端处理。验证失败时恢复上一可信叶版本并按当前形态重建 Host，或让用户切回 Mac。根失窃按 CA 方案逐台撤根。

<a id="tier2-runbook"></a>

### 6.5 Tier 2 开启与回退（§3.5，验证项 V-1 通过后）

Tier 2 与 Tier 1 的差别只在**开关与编排**，不改协议：回退是「新链路停用」，不是「数据回滚」。

**上游来源是钉死的提交**。两个镜像（`agent` 与 `superagent`）的构建输入都取
`${ALONG_SUPERAGENT_SOURCE:-https://github.com/artstur/along-superagent.git#<40 位提交>}`：
相邻 checkout 的 HEAD 是可变的，而旧版探针恒答 `200 {ready:true}`，Host **侦测不到装错版本**——
镜像里若是没有就绪修复的 bundle，重启时已到期的待投递行仍会被终结为
`filtered / source_not_installed`。本地对着未推送的提交调试时用 `ALONG_SUPERAGENT_SOURCE`
指向相邻 checkout（§6.4 第 5 步）。

**会话权限**。启动时只启用上游 Worker 和 Router 两套 preset。读取上游配置生成覆盖层，再用 DSH 合成的配置校验注册表、两套必需 preset、嵌套插件与全局工具。通用会话、工作流、Shell、文件、终端和配置管理入口关闭。校验失败时拒绝启动。Along 业务工具由应用按用户与任务绑定授权。

**开启**（在 §6.4 第 1 步的 `/opt/along` 布局上执行）：

```sh
# 1. 写桥接凭证（0600 的 32 字节 hex；权限过宽 = 未配置，Host 与 Super Agent 都会拒用）
install -m 600 /dev/null /opt/along/secrets/bridge-token
read -rs TOKEN; printf '%s\n' "$TOKEN" > /opt/along/secrets/bridge-token   # 32 字节 hex

# 2. 模型密钥（0600 单行；长驻服务的真实模型回合要它。权限过宽 = 拒绝启动）
install -m 600 /dev/null /opt/along/secrets/model-credentials
read -rs MODEL_KEY; printf '%s\n' "$MODEL_KEY" > /opt/along/secrets/model-credentials

# 3. 叠加 Tier 2 形态并启动（superagent 服务挂在 tier2 profile 下）
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.tier2.yml --profile tier2 up -d

# 4. 使用实际 ALONG_TLS_CN 配置的域名做 HTTPS 验收
ALONG_TIER2_TLS_HOST=along.example.com deploy/tier2-stack.sh verify
```

`verify` 检查两个服务使用同一个 `netns`、私有回环可达，以及 Host 的 HTTPS 健康端点通过 CA 与域名校验。再用原配对连接检查 `/connection/status`。只有上游返回 `200 {"service":"along-source","ready":true}` 才算就绪，`404` 归入 `503`。

**维护锚点**。Tier 2 的 443 由 `netns` 发布。Docker 以锚点的容器 ID 绑定 Host 和 Super Agent。更换锚点时，一次重建三个容器，等待校验通过。

```sh
ALONG_TIER2_TLS_HOST=along.example.com deploy/tier2-stack.sh rebuild-anchor
```

**回退到 Tier 1**。先停长驻服务，再停占用 443 的锚点，最后用主 Compose 重建 Host。

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.tier2.yml --profile tier2 stop superagent
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.tier2.yml --profile tier2 stop netns
docker compose -f deploy/docker-compose.yml up -d --no-deps --force-recreate host
```

回退后先验 HTTPS `/health`，再用原配对凭证检查 DSH `/connection/status` 返回 `200`，确认 Tier 1 runner 可达。`/events` 应返回 `503`。保留 `ALONG_DSH_RUNNER_URL`、业务库、编排库与 DSH 持久卷，重新启用 Tier 2 时从原数据恢复。

**同根同域换叶**。按 §6.4 第 6 步原子切换 `tls/current`，保留 Tier 2 叠加文件，只重建读取证书的 Host。

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.tier2.yml --profile tier2 \
  up -d --no-deps --force-recreate host
ALONG_TIER2_TLS_HOST=along.example.com deploy/tier2-stack.sh verify
```

核对实际服务端叶指纹、SAN 与有效期，并用原配对确认 `/connection/status` 就绪。

## 7. 方案内决策记录（SD）

- **SD-1 专用 CA 描述文件 + iPhone 系统信任（2026-11-21 用户已选定，待实现）**：根经带外核验安装，并在系统设置开启完全信任；云端短期叶显式带 SAN/用途，URLSession 默认系统评估替代旧叶指纹钉扎，不设置 App 内锚、不失败降级。接受系统信任范围扩大及手工撤根成本；完整契约见 [CA 专项方案](iphone-ca-profile-design.md)。沿用 Host 端到端 TLS，不因该选择强制引入反代；公共 CA 与钉扎并非技术上互斥。旧十年自签方案只作为历史实现基线。
- **SD-2 多用户 = 静态用户表 + 每用户配对码，不做注册/审批**：2 人固定；发码即授权，码走私下渠道（SSH + IM），信任模型与「看终端抄码」（`host/agent-host.mjs:435-439`）同级。D1 的「不建设注册/计费/多租户运维」原样保留，只在 agent 仓库决策记录追加「云端单机 2 用户」扩展条目。
- **SD-3 云端 agent 用 headless 一次性进程 + host 侧校验链**：官方 Linux 发行物只有 headless 形态（§2.1/§3.5）；把「模型输出→校验→自动生效」收敛在 host 校验链上，与 Kimi 运行时同构，红线不因运行时形态降级。bundle 长驻加载列为 V-1 验证项而非承诺。
- **SD-4 云端 v1 新链路数据面 503 不是功能砍除而是开关语义复用**：`ALONG_EVENT_INGEST` 的 off/on 单消费语义（BC-09-03/04）本就是回退通道；云端复用它，Mac 本地模式保留全量能力。
- **SD-5 版本联动收敛**：M3 修改 `web/goal-agent-core.mjs`（前端运行代码，`web/app.mjs:4`、`web/loop.mjs:2`、`web/event-workspace.mjs`、`web/adaptive-ui.mjs:1` 均 import，且已登记 `tools/build.mjs:2` 与 `web/sw.js` 的 FILES）→ 合入即提高 `web/index.html` 的 `?v=`（80→81）与 `web/sw.js` 的 `CACHE`（along-shell-v80→v81）；iOS 原生改动（M6）→ `build=` 与 `CFBundleVersion` 必动（重装）；施工中若再波及其他 `web/` 文件，四处一并联动（AGENTS.md §2）。
- **SD-6 红线文件措辞修订需用户确认**：M7 对 AGENTS.md §5 的改述（「Token 只留在 Mac 上」→「凭证只留在服务端安全存储」）不放宽任何实质约束（§3.6 逐条对照），但红线文件是用户钦定约束，改文字前须用户明确拍板（见交付 openQuestions）；未确认前 M7 只改 README/索引/本文档与 agent 仓库决策记录，不动 AGENTS.md §5。
- **SD-7 公网配对限额**：同时限制有效和无效提交，窗口满时在验码前拒绝。窗口按来源（连接 IP）分桶，满窗只对该来源拒绝；发码不清窗（「发码清窗刷新攻击者配额」随分桶消解），无清窗入口——被噪音阻塞的同 IP 合法设备最长 15 分钟窗口自然过期自愈（`docs/cloud-security-hardening.md` SD-H2 修订）。
