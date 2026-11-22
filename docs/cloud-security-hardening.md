# Along 云端公网安全加固设计

> **2026-11-21 TLS 决策修订**：用户已选定 [iPhone CA 描述文件与系统完全信任](iphone-ca-profile-design.md)，云端目标移除旧叶指纹钉扎，改为系统链/主机名/时间/ATS 校验。本篇仍负责应用准入、会话与容器加固；CA 专项方案负责信任迁移、根分发、轮换和撤信。同日实施轮次已落地服务端证书加载与启动前校验、iOS 系统信任评估委托与连接 v2、以及描述文件制作/核验工具；真机安装、完全信任、撤根与双手机验收仍未执行（见 CA 方案 §8 覆盖情况）。

> 2026-11-21（评审修订版 v2：吸收方案评审 16 条意见，见 §7 决策与 §5 残差记录）。补篇于 `docs/cloud-deploy-multi-user.md`（下称「部署设计」）：云端部署形态已拍板（一台云主机 + Docker Compose、2 个静态用户、每用户一次性配对码），本文针对安全缺口清单（G-1～G-22，定义与证据见附录 A——清单本体此前只在会话材料中，按 AGENTS.md §3「先写文档再实现」现并入本仓库）给出加固机制的设计、实现模块与验收标准。北极星：**公网上只有这 2 个用户能用——扫描者进不来，也耗不动资源**。本文不放宽任何红线（AGENTS.md §5）；与部署设计冲突的决策记录按 §7 修订。所有改动只留在工作区，不 commit。**2026-11-21 实施完成**：M1–M6 六个模块全部落地（机制与 §3 一致，逐条偏差见 §8），测试断言由统一测试轮补齐并改写受影响的既有测试（落点见 §3 模块表）；最终全量门禁 `npm run check` 通过——实跑 682 条测试、681 过、0 失败、1 条双来源环境断言在本机探测不到第二来源自动跳过（§8.1）。

基线：`npm run check` 通过（v1 设计后已运行：`node --check` 全部 `web/*.mjs`、`web/sw.js`、`host/*.mjs`、`tools/build.mjs` + `node --test test/*.test.mjs` 全绿 623 条）。设计依据的代码行号以当前工作树为准。

## 0. 目标

1. 公网入口（along-host 容器 443）对未认证流量有连接级与请求级的资源防护：扫描者的慢连接、握手洪水、`/pair` 垃圾码都不能长期占用资源，也不能阻断两位合法用户的配对与使用。
2. 认证后的运行链路有并发/频率上限：单个已配对用户无法耗尽整机资源或刷爆两人共用的 DeepSeek 额度；runner 的 429 以原状态码与文案透传到客户端，而不是被折叠成 502。
3. 绑定与配对的生命周期完整：token 可过期、可吊销，配对事件可审计且审计写入有速率上限，异常绑定可被发现与处置。
4. 传输与容器面按最小暴露收敛：host 容器补齐 agent 容器已有的加固三件套，镜像构建可复现，云主机不携带 Mac 时代的密钥库与明细数据。
5. 红线在云端两条运行输出通道上全部闭合：任务信封补上与目标路径对等的输出契约校验。
6. Mac 本地模式完全保留且行为不变，**本轮明确列出的加严例外（逐项标注）**：(a) tasks 路径 context 清洗扩到 finance/custom 域（§3.1-(9)，Mac 收到的提示词内容随之变化）；(b) `readBridgeToken` 与 Kimi token 读取加 0600 校验（§3.4-(1)/(2)，权限过宽等同未配置/显式报错）；(c) codex 子进程 env 剔除 `ALONG_*` 与错误文案固定（§3.4-(3)）。

## 1. 范围（明确不做什么）

- **本篇应用加固模块不改 UI 渲染文件**：G-16/G-17 仍按 §5 的原迁移边界处理。用户另行选定的 CA 信任迁移需要调整云端连接表单、Web/原生桥及 fingerprint 消费点，按专项方案 §7 独立安排；不能沿用本篇的旧 UI 限制而漏改连接契约。本轮只写设计，不实施任何运行文件。
- **不引入反代/公共 CA/CDN**：TLS 仍由 Host 端到端提供；云端目标为 CA 描述文件 + 系统信任，不再保留叶钉扎。限流做在 host/runner 应用内（§7 SD-H1），不把服务器 CA 当作客户端准入。
- **不新增配置开关与管理入口**：新上限全部是代码/编排内的常数（§3 各节给出数值与理由），不给 `env.example` 加新键（`ALONG_PAIR_FAIL_LIMIT` 语义不变，只改作用域）；评审后不设 `--reset-window` 清窗命令（§7 SD-H2）。
- **不引入新的采用/确认/审批环节**：吊销是管理员 CLI 命令（`host/pair-code.mjs --revoke`），不构成用户侧审批；目标「只能通过聊天改变」等红线不动。
- **本篇不改证书算法**：叶密钥继续以 RSA 3072 为方案基线；CA 的显式扩展、短期轮换及根保管按专项方案。目标系统信任下，同根同域换叶不强制重配对；连接上限不能替代实际握手负载验收。
- **不做**动态扩缩容、多实例、WAF：单机 2 用户形态，常数上限 + 资源上限即够（§7 SD-H9）。
- **不迁移、不清除** Mac 本地数据；云端启动守卫只拒绝携带，不代删（§6 手动步骤）。

## 2. 现状核实（本轮逐条验证过的证据）

缺口清单 22 条全部为 verified；本轮对其中承担设计前提的条目复核如下（其余条目的行号证据见附录 A）：

| 核实点 | 证据 |
| --- | --- |
| Node 22 服务器默认超时无防护 | 本机 node v22.22.3 实测：`https.createServer` 的 `requestTimeout=300000`、`headersTimeout=60000`、`maxConnections=undefined`、`timeout=0`（G-3 成立） |
| https 服务能在 TCP 层按连接计数 | 本机实测：`https.Server` 对未完成 TLS 握手的连接也触发 `'connection'` 事件（TLS 失败握手下 `connection=1, secureConnection=0`）→ 按 IP 连接上限在 TLS 之前生效可行 |
| runner 429 会被折叠成 502 | `host/agent-host.mjs:96` 对任何非 ok 响应硬编码 `new HostError(result?.error||…,502)`——v1 设计声称「429 原样透传」不成立，须改 runnerCall（本版已并入 M1，§3.1-(7)） |
| 客户端轮询节奏 | `web/app.mjs:2815` 任务状态每 4s 轮询、`:2821` 目标运行轮询 → **限流只能限 start 端点，不能限 status 端点**（合法高频），host 侧限流定为 10 次/分钟/start 端点（§3.1-(7)） |
| tasks 任务的 context 来源 | `web/app.mjs:603` `context:currentSummary()`：health=scopedSnapshot、finance=`{saved}`、custom=`{}` → host 侧按域白名单清洗不会丢合法业务字段（G-20 修复可行）；清洗发生在 Kimi/runner 分流（`host/agent-host.mjs:486-488`）之前，**同样作用于 Mac 本地 bridge 路径**——属 §0-(6)(a) 标注的 Mac 行为变化 |
| 绑定表是启动时一次性读入 | `host/agent-host.mjs:67` `let pairings=loadPairings(dir)`，`authorized()`（:146-149）与 `stillPaired`（:236-238）全用内存表 → 吊销/过期需要改读盘（G-5） |
| 绑定条目无有效期 | `host/agent-host.mjs:401` `entry={hash,user_id,device_id}`；`host/pairing.mjs:70` 升级时剥掉未知字段 → 需要透传 `expiresAt`（G-5） |
| OKX vault 文件形态 | `host/okx-connection.mjs:59`（`master.key`）与 `:81`（vault 文件名 `/^[0-9a-f]{64}\.json$/`）→ 启动守卫用同一模式识别（G-9） |
| runner 无并发上限 | `deploy/agent-runner.mjs:230-243`：新键即 spawn，仅完成记录 LRU 200（:54、:225）→ 上限加在 runner（G-1） |
| 任务信封无校验 | `deploy/agent-runner.mjs:133-148` result 整体 spread；host `runnerTaskStart/Status`（`host/agent-host.mjs:129-136`）原样透传，对照目标路径 `:516-518/:523-525` 都过 `normalizeGoalRun`（G-7 成立） |
| tasks 路径只清洗 health 域 | `host/agent-host.mjs:484-485` `if (dshInput.goal?.domain==='health') dshInput.context=agentHealthSnapshot(...)`（G-20 成立） |
| /pair 无 Content-Type/Origin/来源检查、无审计 | `host/agent-host.mjs:388-412` 无相关代码；同仓库旧静态服务有先例 `host/server.mjs:15-16`（Origin host 校验）；失败窗口全局单计数器在 `host/pairing.mjs:158-179`，发码清窗 `:150`（G-4/G-12/G-14/G-15 成立） |
| OKX history 与 summary 在同一次原子 publish | `docs/okx-trade-history.md` §Device wire：「optional private `history` included in same atomic grant/sequence/event/digest」；`host/device-source-gateway.mjs:95` 的 publish 指纹含 `digest(summary,history)`、`:156-158` 持久化时绑定校验——**逐字段剥离 history 不可行**（摘要发布会被一起打断），云端拒收必须伴随用户指引（§3.5） |
| iOS 端 /pair 请求形态 | `ios/AlongHealth/Sources/AlongHealth` `agentRequest`（`AlongShellView.swift`）固定 `Content-Type: application/json`，URLSession 不发送 Origin/Referer → G-14 的预检不会误伤合法客户端 |
| G-16/G-17 锚点 | `web/app.mjs:906`（「采用调整后的安排」按钮）、`:1144`（proposal-preview/accept-goal 入口）、`:1756`（accept-goal 处理器）、`:2437`（ticket `status:'proposed'`）、`:1195-1216`（applyGeneratedGoal 把 `item.proposal` 直接展开写入）→ 与清单一致，判为范围外（UI 文件约束） |
| compose 端口映射与源 IP | `deploy/docker-compose.yml:11` `ports:["443:4176"]`：外部 IPv4 经 DNAT 源 IP 保留；**经 docker-proxy 的连接（宿主 localhost 映射、无 ip6tables 的 IPv6）源 IP 是网关地址**——本机无 Docker daemon 无法实测（`test/deploy-orchestration.test.mjs` 头注同口径），该前提列入 §6 冒烟验证项并给出缓解（§3.1-(3)） |
| 相邻仓库备份/恢复与桥接 token | `../along-superagent/scripts/along-backup.mjs` 目前只有备份（`:11`「恢复演练（BC-09-06）在阶段 E」，无恢复代码）；本机实测 node v22.22.3 `fs.cpSync` 保留 0600 权限位（src 600 → dst 600）。恢复链路落地时须补恢复后 chmod（§6 移交注记） |
| codex 测试现状 | `test/` 目录无 `codex-agent.test.mjs`（本轮 ls 核实）；既有 CODEX_BIN 桩在 `test/host-multi-user-isolation.test.mjs:177`（宿主进程 env 注入）——M4 验收需要新测试文件承载（§3.4） |
| codex env 依赖 | codex 的认证/代理/证书 env（如 `OPENAI_API_KEY`、`HTTPS_PROXY`、`SSL_CERT_FILE`、`CODEX_HOME`）无法穷举——env 白名单会弄坏真实 codex（`/goal/event` 是 Mac 真实功能），故 §3.4-(3) 改为**剔除 `ALONG_*`** 而非白名单（评审意见采纳） |

## 3. 机制设计（按模块）

模块制：每个模块独占自己的文件，模块之间不共享文件（两个机制要改同一个文件就合成一个模块）。总体划分：

| 模块 | 独占文件 | 关闭缺口 |
| --- | --- | --- |
| M1 `host-admission` | `host/agent-host.mjs`、`host/pairing.mjs`、`host/pair-code.mjs`；测试落点：新增 `test/security-host-admission.test.mjs`（设计期名 `test/cloud-host-admission.test.mjs`），`test/host-multi-user-pairing.test.mjs`、`test/pairing-multi-user-acceptance.test.mjs` 由测试轮改写（§8.1） | G-1(host 侧+429 透传)、G-3、G-4、G-5、G-7、G-9、G-12、G-14、G-15、G-18、G-20 |
| M2 `runner-guard` | `deploy/agent-runner.mjs`；测试落点：新增 `test/security-runner-guard.test.mjs`（`test/agent-runner-contract.test.mjs` 保持不动、全绿，§8.7） | G-1(runner 侧)、G-6 |
| M3 `deploy-hardening` | `deploy/Dockerfile.host`、`deploy/Dockerfile.agent`、`deploy/docker-compose.yml`、`.dockerignore`、新增 `deploy/agent-dsh/package.json`、`deploy/agent-dsh/package-lock.json`、`test/deploy-orchestration.test.mjs`；测试另落新增 `test/security-deploy-hardening.test.mjs` | G-2、G-8、G-1/G-3(资源上限)、G-6(镜像/编排配合) |
| M4 `credential-hygiene` | `host/along-bridge.mjs`、`host/kimi-code-agent.mjs`、`host/codex-agent.mjs`；测试落点：新增 `test/codex-agent.test.mjs`、`test/security-credential-hygiene.test.mjs`，`test/along-bridge.test.mjs` 由测试轮改写（`test/kimi-code-agent.test.mjs` 不动，§8.7） | G-11、G-13 |
| M5 `cloud-source-guard` | `host/device-source-gateway.mjs`；测试落点：新增 `test/security-cloud-source-guard.test.mjs`（`test/device-source-gateway.test.mjs` 保持不动、全绿，§8.7） | G-19(代码半) |
| M6 `docs-sync` | `docs/cloud-deploy-multi-user.md`、`README.md`、`deploy/README.md`、`test/docs-cloud-runbook-agreement.test.mjs`；测试另落新增 `test/security-docs-sync.test.mjs` | G-19(文档半)、G-21(文本)、G-1/G-3/G-4/G-9 决策与口径修订 |

G-10 与 G-16/G-17 不由模块关闭：G-10 经评审拍板接受为残差（§5）、G-16/G-17 范围外（§5）。实施顺序：M1→M2 相互独立可并行；M3 独立；M4 独立；M5 独立；M6 最后（文档反映最终语义）。实施期每个模块只改独占文件并重跑 `npm run check` 回归（在途期间他人模块文件的失败不算本模块，§8.7）；M1/M2/M4/M5 按编排分工不写测试，断言由统一测试轮补齐，最终全量门禁一次通过（AGENTS.md §3）。

### 3.1 M1 `host-admission`：公网唯一入口的准入、限流与输出闸门

全部改动在 `host/agent-host.mjs`、`host/pairing.mjs`、`host/pair-code.mjs`。

**(1) 状态目录权限自愈（G-18）**：`host/agent-host.mjs:28` 的 `mkdirSync` 后无条件补 `chmodSync(dir,0o700)`（与三个子目录的既有自愈同款）。部署者漏跑 Runbook `chmod 700` 时启动即收紧，Runbook 步骤保留为纵深。

**(2) OKX 密钥库启动守卫（G-9）**：在 `multiUser` 判定（`host/agent-host.mjs:34`）之后、创建 `okxConnection`（`:37`）之前：`multiUser` 且 `join(dir,'okx-connections')` 内存在任何 `/^[0-9a-f]{64}\.json$/` 文件（与 `okx-connection.mjs:81` 的 vault 识别同一模式；只有 `master.key` 的空库不算——没有密文可解）→ 抛错拒启，文案含「云端多用户形态不允许携带 OKX 密钥库，请清空 /data/okx-connections/ 后重启」。不设豁免开关（AGENTS.md：不为假想需求预留配置）；Mac 本地形态（`localHost`）不受影响。配套把部署设计 §6.2 第 2 条的「拷贝不移动」改为「device-sources/、okx-connections/、source-events/、kimi-runs.json 一律不拷贝上云」（M6）。

**(3) 连接级防护（G-3）**：`host/agent-host.mjs` 的 `createServer`（`:384`）补三项常数内置防护，两种形态一致生效（2 用户 + 容器健康检查 + 管理员 curl 的合法并发远低于上限）：

- `server.headersTimeout=15_000`、`server.requestTimeout=60_000`（收请求的时限；不含响应时长，不影响 `/goal/event` 的 105s 服务端处理）。60s 也覆盖将来 Tier 2 打开时 `/sources/device` 2.2MB 慢速上传。
- `server.maxConnections=64`；并挂 `server.on('connection', socket)`（实测在 TLS 握手前触发）按 `socket.remoteAddress` 计数（`::ffff:` 前缀归一化），单 IP 并发 ≥24 即 `socket.destroy()`，`'close'` 时递减。攻击者占满自己 IP 的 24 个槽位后，其余连接被立即销毁——新连接在握手开始前就被掐断，RSA-3072 握手 CPU 同时段最多只有 24 个握手在算，不足以成为瓶颈（这也是不换 ECDSA 的依据，§7 SD-H8）。残余风险：攻击者与合法用户同 IP（同 NAT）时仍可挤占——带外缓解见 §6。
- **源 IP 语义与前提**：分桶与连接上限都 key 在 `req.socket.remoteAddress` 上。外部 IPv4 经 Docker DNAT（`ports:["443:4176"]`）源 IP 保留；两类退化必须封死：宿主 localhost 经 docker-proxy 的连接与「无 ip6tables 的 IPv6 客户端」源 IP 是网关地址。缓解：Runbook 域名**只配 A 记录、不配 AAAA**（公网流量全走 IPv4 DNAT），宿主 localhost 只有健康检查与管理员 curl（量小且共享一个桶不影响公网分桶）；冒烟必须断言**两个不同外部来源在审计日志中得到不同的 `来源` 值**（§6 步骤 8；`test/security-host-admission.test.mjs` 的双来源断言先探测可用来源——127.0.0.2/127.0.0.3 回环别名或本机局域网 IPv4——探测不到即自动跳过该条：macOS 开发机无 root 加不了回环别名，等价断言在能构造双来源的环境运行，ECS 冒烟兜底，§8.1）。证书算法不变（rsa:3072，评审拍板）。

**(4) /pair 准入预检与按来源失败窗口（G-14、G-4、G-12）**：

- 预检（`/pair` 处理器最前，读体之前）：`content-type` 不以 `application/json` 开头 → 400「配对请求格式无效」；`origin` 或 `referer` 头存在 → 403「配对请求来源无效」（合法客户端只有 iOS 原生与管理员 curl，两者都不发这两个头；同仓库先例 `host/server.mjs:15-16`）。两种预检都**不计入**失败窗口。浏览器跨站 text/plain 简单请求从此进不了验码逻辑（G-14 的众包放大器拆除）。
- 失败窗口按来源分桶（`host/pairing.mjs`）：`pairing-codes.json` 的 `failures` 从全局 `["ISO",…]` 改为 `{<source>:["ISO",…]}`（`source`=`req.socket.remoteAddress` 归一化后的连接 IP，旧数组格式读到即视为空——15 分钟 TTL 使迁移无意义）。`consumeUserCode(dir,code,limit,now,source)`：满窗时对**该来源**统一拒绝（返回 `{ok:false,reason:'window_full'}`，不验码、不写盘，保持码未消费——SD-7 语义按来源成立）；未命中才把失败计入该来源桶；命中消费成功时只清**该来源**自己的桶。桶键数上限 128（FIFO 淘汰最旧来源），文件体积有界。单源攻击者最多占用自己的桶，两位合法用户的配对不再被全局占满阻断。
- 发码不再清窗（G-12）：删除 `issuePairingCode` 里的 `state.failures=[]`（`host/pairing.mjs:150`）。**不设清窗命令**（评审砍掉 `--reset-window`，§7 SD-H2）：按来源分桶后，「发码清窗刷新攻击者配额」的问题不复存在（攻击者只能烧自己的桶）；与攻击者同 IP 的合法设备最长等 15 分钟窗口自然过期——码空间 ~9×10⁷，安全性只升不降，省一个管理入口。
- `ALONG_PAIR_FAIL_LIMIT` 语义不变（默认 10、只许调严），作用域变为**每来源**。

**(5) /pair 审计日志，写入速率有界（G-15）**：多用户形态下 `/pair` 事件向容器日志写一行、不落码与 token 内容（§3.7 红线）：成功记 `配对成功 user=<userId> 来源=<IP>（ISO）`——成功次数天然受配对码约束（15 分钟 TTL、管理员发放）；失败/预检拒绝记 `配对失败 原因=window_full|unknown|user_missing|格式无效|来源无效 来源=<IP>（ISO）`（`consumeUserCode` 返回值增加 `reason` 字段供日志区分）。**拒绝类日志按来源限速**：内存表记录每来源上次拒绝日志时间，同一来源 60 秒内至多一行（表上限 256 个来源，超限 FIFO 淘汰）——攻击者高频刷预检或打满窗口不会把 10m×3 轮转里的真实审计挤出窗口（评审意见：v1 的「每次尝试一行」写入速率无界，SD-H12 已修正）。本地单用户形态不加日志（Mac 行为不变）。

**(6) 绑定生命周期：滑动过期 + 吊销 + 热生效（G-5）**：

- `pairings.json` 条目增加 `expiresAt`（毫秒）：`loadPairings` 升级时透传该字段（`host/pairing.mjs:70` 不再剥掉）；`/pair` 成功写入 `expiresAt=Date.now()+BINDING_TTL_MS`（`BINDING_TTL_MS=30 天`，pairing.mjs 导出常数）。**不回填既有条目**（无 `expiresAt` 的绑定永不过期=现状，管理员可吊销后重配）。**缺字段与显式非法要分开**（复核修订）：字段缺失 → 永不过期（grandfathered，历史兼容）；字段存在但不是有限数值（`"not-a-number"`、`null`、字符串、`NaN`）→ 该条目不进表，请求按未命中处理（401），重新发码配对自愈。旧实现把非法值「丢弃成没有」，等于把显式错误读成了宽容。
- 滑动续期：成功请求在剩余寿命 <`BINDING_RENEW_AHEAD_MS`（7 天）时把 `expiresAt` 续到 now+30d（写盘走锁，见下；活跃用户约每 23 天才写一次，无写放大）。过期 token 一律按未命中处理 → 401「请先配对这台 Mac」。过期与续期**只在多用户形态生效**（`multiUser` 门控），Mac 本地行为不变。
- **后台泵同样过滤过期**：`dispatchNotifications`（`host/agent-host.mjs:286`）与 source 事件泵（`:551-553`）逐用户迭代时共用同一个「绑定有效」判定（存在 + 未过期）——过期绑定不再接收 APNs 派发与泵事件（评审补齐的定义）。
- 吊销：新导出 `revokePairing(dir,userId)`——删除该用户绑定条目**与该用户未消费的配对码**；CLI `node host/pair-code.mjs --revoke <userId>`（`--revoke` 是本 CLI 唯一新增子命令）。被吊销 token 的下一个请求即 401，无需重启。**未消费码必须一并吊销**（复核修订）：只删绑定表的话，吊销前发给该用户、还没用掉的码仍能换出一枚新 token——实测可复现，等于吊销没有真正生效（`docs/iphone-ca-profile-design.md` §6「服务端吊销该用户 token 及未消费配对码」、§8 T18）。两个文件各自原子替换，顺序是先码后绑定：中途失败最多留下「码已删但绑定还在」的保守状态（需重新发码），而不是「绑定已删但码还能用」的漏状态。
- **绑定表改为每请求读盘**（取消内存缓存）：模块级 `let pairings` 由 `refreshPairings()`（`host/agent-host.mjs:119`）维护——`authorized()` 在每个请求入口、两个后台泵在每轮、`/pair` 在写入后调用它，内部用新的纯读函数 `readPairings(dir)` 从盘上重读（读 `pairings.json`，ENOENT/损坏按 `[]` 处理——fail-closed，全部 401）并按「绑定有效」判定过滤过期条目；`stillPaired()`/`currentBinding()` 读刷新后的表，不各自直读盘（§8.1 偏差 1：与设计「一律直调 `readPairings`」的字面不同，可观察行为一致——每请求/每轮读盘、文件即唯一事实来源、吊销/过期即时生效、误删全 401）。文件仅数百字节，每请求一次 readFileSync 可忽略；这与 `pairing-codes.json`「每次调用重读，不在启动时缓存」的既有纪律（部署设计 §3.2）一致。**写侧全部走同一把跨进程锁**：新增 `withPairingsLock`（proper-lockfile，参数与 `withCodeStateLock` 相同——`host/pairing.mjs:116-129`），`/pair` 绑定写入、滑动续期写入、`revokePairing` 都先取锁再「锁内重读→改→原子替换」，消除「host 内存表 vs CLI 改盘」的读写竞态（bugfix-goal-prompt §7「原子替换不能保护跨进程的读改写」）。
- **语义回退（评审指出的相对现状差异，显式记录）**：现状内存表能在 `pairings.json` 被误删后写回其余用户绑定；改每请求读盘后文件即唯一事实来源，被删除 → 所有绑定丢失，各用户需重新发码配对（`pairing-codes.json` 缺失时本来就是同语义）。不做内存兜底——兜底快照会让吊销/过期无法即时生效（本机制的核心目标）；删除文件是需要 root 的运维事故，恢复路径 = 重新发码配对（§7 SD-H15）。

**(7) 运行链路限流与 429 透传（G-1 host 侧）**：`/super-agent/goals` 与 `/super-agent/tasks`（只限这两个 start 端点；`goals/status`、`tasks/status` 每 4s 轮询是合法高频，不限）在鉴权后、上游调用前做**每用户滑动窗口限流**（实现为 `host/agent-host.mjs:629` 的一行路由级判定覆盖两个 start 端点，不进各处理器内部，§8.1 偏差 2）：60 秒窗口内最多 10 次 start（`RUN_START_LIMIT=10`、`RUN_START_WINDOW_MS=60_000`，内存 Map<userId,时间戳[]>，重启即清——runner 侧并发上限是持久兜底），超限抛 `HostError('Along 请求过于频繁，请稍后再试',429)`（`statusForError` 按整数 status 透传，`host/host-error.mjs:11-15`）。**runner 的 429 必须原样到达客户端**：`runnerCall`（`host/agent-host.mjs:96`）现状把任何非 ok 响应折叠成 502（v1 设计声称透传与本行代码不符，评审纠正）——改为保留 429 状态码（`response.status===429` 时 `new HostError(result?.error||…,429)`，其余非 ok 仍 502），用户看到的是 429 + runner 原文案而不是 502。只在多用户形态启用限流（Mac 行为不变；合法用户聊天/任务节奏远低于 10 次/分钟）。

**(8) 任务信封输出契约 `normalizeTaskRun`（G-7）**：在 `host/agent-host.mjs` 的 `normalizeGoalRun`（`:354`）旁新增对称函数：`run.result` 为 null（working 等中间态）原样放行；非 null 时白名单校验 `{summary,next}`——两者都必须是非空字符串（纯空白也判失败，`!text.trim()`——比设计字面「非空」略严，校验只加严，§8.1 偏差 3）、summary ≤300 字、next ≤300 字、出现任何其他键即拒绝；未过闸落终态 `{status:'blocked',statusLabel:'输出需要重试',result:null,error:'DSH 已完成，但输出校验失败：…'}`（与目标路径同一手法与文案口径）。`runnerTaskStart`/`runnerTaskStatus`（`:129-136`）在 `runnerRun` 元数据守卫之后强制执行。范围说明：只覆盖 DSH runner 任务路径（缺口所在）；Kimi 任务信封本就无 `result` 字段（`host/kimi-code-agent.mjs:310`），无需处理。模型输出的任意形状 JSON 从此无法原样进入运行信封与客户端存储，「先校验后生效」在两条输出通道上闭合。

**(9) tasks 路径 context 全域清洗（G-20）**：把 `host/agent-host.mjs:484-485` 的 `if (domain==='health') …` 改为按域强制：`dshInput.goal?.domain` 在 `['health','finance','custom']` 内 → `dshInput.context=cleanSnapshot(dshInput.context,domain)`（复用目标路径的同一个白名单函数 `:182-211`：health→`agentHealthSnapshot`（与现状逐字节一致，tasks 无 planning）、finance→`{saved,source:'演示数据'}`、custom→`{source:'暂无连接'}`）；无合法域 → `context={}`。**本条是 §0-(6)(a) 标注的 Mac 行为变化**：清洗在 Kimi/runner 分流（`:486-488`）之前，Mac 本地 bridge 路径同样生效——finance 任务 context 从 `{saved}` 变 `{saved,source:'演示数据'}`、custom 从 `{}` 变 `{source:'暂无连接'}`，本地 DSH 收到的提示词内容随之变化；这是红线方向的加严而非回归（health 域现状本就清洗，finance/custom 收敛到同款白名单）。Kimi 分支与 `kimi-runs.json` 落盘（`kimi-code-agent.mjs:224` 持久化 `entry.input`）都收到清洗后的 context——非汇总健康数据无法从任何域出站到模型或落盘。client 自由文本（message/task.detail）本来就会进模型提示词，属用户自己的内容，不在本机制范围。

### 3.2 M2 `runner-guard`：runner 并发上限与降权

全部改动在 `deploy/agent-runner.mjs`。

**(1) 并发硬上限（G-1 runner 侧）**：常数 `MAX_RUNS_PER_USER=2`、`MAX_RUNS_TOTAL=4`（2 用户各 2 并发的资源上界：4 × dsh node 进程 ≈ 数百 MB～1GB，配 M3 的 mem_limit）。`execute()`（`deploy/agent-runner.mjs:230-243`）在**同键幂等检查之后**、spawn 之前检查 `inflight.size` 与每用户在途数：超限不 spawn，`POST /run` 直接回 `429 {error:'模型运行并发已达上限，请稍后再试'}`（客户端可见性由 M1 的 runnerCall 429 透传保证，§3.1-(7)）；未超限才记入 `inflight`/每用户计数，`.finally()` 里同步递减。同键重提交不受上限影响（幂等优先）。

**(2) 最小特权：runner 降权 + secret 文件权限校验（G-6）**：

- 读入两个 secret 时经 `readSecretFile` 加 statSync 校验（对齐 `host/apns.mjs:12` 口径）：校验作用于 `ALONG_RUNNER_TOKEN_FILE`/`ALONG_MODEL_API_KEY_FILE` 指向的文件（compose 中即 `/run/secrets/runner-token` 与 `model-credentials`，`test/deploy-orchestration.test.mjs` 锁定该映射，§8.2 偏差 2），若 `mode&0o077 !== 0` → 拒绝启动，报错只含路径不含内容（读取失败文案「<标签>文件无法读取：<路径>」；compose file secret 是 bind mount，容器内权限=宿主权限，Runbook 已要求 0600；§6 冒烟步骤核实）。现状 `deploy/agent-runner.mjs:59-63` 只读不校验。
- 读入 secret 之后、`server.listen` 之前，把**整个 runner 进程**降权：`process.setgid('node'); process.setuid('node')`（node 官方镜像自带 uid 1000 的 `node` 用户，无需建新用户；仅当 root 且平台支持时执行——实现为 `typeof process.getuid!=='function'||process.getuid()!==0` 的直译守卫，开发机/测试非 root 时跳过）。降权后 runner 与它拉起的每个 `dsh` 子进程（`:179` spawn 继承 uid）都是 uid 1000，而 `/run/secrets/*` 仍为 root 0600 → **dsh 与 runner 都再读不到任何 secret 文件**；tmpfs `/tmp`（mode=1777）下的 mkdtemp 工作目录、DSH home、清理（rm）全部以 node uid 自洽完成，不需要 chown/cap 编排。`process.setuid` 抛错（镜像缺用户）→ 拒绝启动并提示。残余面：`DEEPSEEK_API_KEY` 仍在 dsh 进程 env 里（模型调用的功能必需）——逐字回显检查维持现状（:204-208），编码变形集经评审砍掉（§5 残差、§7 SD-H13）。

### 3.3 M3 `deploy-hardening`：镜像可复现与编排加固

改动在 `deploy/Dockerfile.host`、`deploy/Dockerfile.agent`、`deploy/docker-compose.yml`、`.dockerignore`，新增 `deploy/agent-dsh/{package.json,package-lock.json}`。

**(1) host 容器补齐加固三件套（G-2）**：`docker-compose.yml` host 服务增加与 agent（`:45-47`）同款并按需加严：

```yaml
read_only: true
tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777"]
security_opt: ["no-new-privileges:true"]
cap_drop: ["ALL"]
mem_limit: 512m
cpus: "1.0"
pids_limit: 128
```

以 root 运行但 `cap_drop: ALL`：host 只需写 `/data`（属主 root）、spawn openssl（同 uid）、绑 4176（>1024），全部不需要能力位；`no-new-privileges` 封死 setuid 提权路径；只读根文件系统封死落盘持久化（唯一可写面是 /data 卷与 /tmp tmpfs，与现状语义一致）。**不加非 root USER**：compose file secret 是 bind mount、`uid/gid/mode` 长语法不生效（§2 已核实），非 root 容器读不到 0600 的 `/run/secrets/*` 必然起不来；root + cap_drop ALL + 只读 + NNP 已拿走提权与持久化路径（§7 SD-H5）。

**(2) agent 容器补齐资源上限与降权能力（G-1/G-3/G-6 编排配合）**：agent 服务增加：

```yaml
cap_drop: ["ALL"]
cap_add: ["SETUID", "SETGID"]    # runner 读入 secrets 后整进程降权到 node 用户（M2）
mem_limit: 2g
cpus: "1.5"
pids_limit: 192
```

`SETUID/SETGID` 仅为 M2 的降权保留（`no-new-privileges` 不拦截 syscall 降权）；mem/cpus/pids 上限把 G-1 的资源耗尽面钉死在 2C4G ECS 的安全区间（4G = host 512m + agent 2g + Docker/系统余量；数值为常数初值，冒烟后可调，§7 SD-H9）。

**(3) 镜像来源与构建可复现（G-8）**：

- 两个 Dockerfile 的 `FROM` 按 digest pin：`FROM node:22-bookworm-slim@sha256:<64hex>`、`FROM node:24-bookworm-slim@sha256:<64hex>`（digest 已于 2026-11-21 用 `docker buildx imagetools inspect` 取值并记录在两个 Dockerfile 的头注释——`deploy/README.md` 是 M6 独占文件不承载 digest 值，其文件清单表新增的 agent-dsh 行承载 dsh 锁文件升级流程，§8.3 偏差 1；升级 = 改一行 + 更新头注释记录，§6）。apt 不锁版本：基础镜像 digest 已固定起始层，锁 openssl 版本会让 Debian point release 后构建直接失败，残差（Debian 源经 TLS+签名）记录在案（§7 SD-H11）。
- dsh 安装改锁文件 + 禁脚本：新增 `deploy/agent-dsh/package.json`（`{"private":true,"dependencies":{"@deepseek-ai/dsh":"0.2.2-rc.5"}}`）与 `deploy/agent-dsh/package-lock.json`（维护者用 `npm install --package-lock-only --ignore-scripts` 生成后入库，升级 dsh 版本时重新生成）。`Dockerfile.agent` 删除 `npm install -g`，改为：

```dockerfile
COPY deploy/agent-dsh/package.json deploy/agent-dsh/package-lock.json deploy/agent-dsh/
RUN npm ci --prefix deploy/agent-dsh --omit=dev --ignore-scripts --no-fund --no-audit \
 && ln -s /app/deploy/agent-dsh/node_modules/.bin/dsh /usr/local/bin/dsh
```

`--ignore-scripts` 已核实不破坏 dsh（该版本 `scripts:{}`），能挡传递依赖在构建期以 root 执行 postinstall；传递依赖由 lock 文件固定。`.dockerignore` 白名单追加 `!deploy/agent-dsh/package.json`、`!deploy/agent-dsh/package-lock.json`（构建上下文白名单语义不变）。compose 的 `ALONG_DSH_VERSION` 与 `deploy/agent-dsh/package.json` 版本保持跨文件一致（沿用现有测试口径）。

### 3.4 M4 `credential-hygiene`：凭证读取校验与错误卫生

改动在 `host/along-bridge.mjs`、`host/kimi-code-agent.mjs`、`host/codex-agent.mjs`。

**(1) secret 读取 0600 校验（G-13）**：`readBridgeToken`（`host/along-bridge.mjs:16-22`）读前加 `statSync(file).mode&0o077` 检查，不过宽即返回 null——沿用该函数既有的「缺失/读不到 → null」语义：Mac 旧链路照发不带 token、云端因 `ALONG_DSH_RUNNER_URL` + null token 在启动时拒绝（`host/agent-host.mjs:33`），即权限过宽等同未配置凭证，fail-closed 且不破坏两模式。`KimiCodeAgent.authToken`（`host/kimi-code-agent.mjs:181-185`）同款校验，不过则抛「Kimi token 文件权限过宽（须 0600）」——Mac 上这是功能性凭证，显式报错好过静默不可用。口径与 `host/apns.mjs:12`、`host/okx-connection.mjs` 的 privateRead 对齐（不引入 O_NOFOLLOW，保持三处同款最简口径）。云主机侧由 M2 覆盖 runner 的两份 secret。**备份/恢复注意**（评审核实项）：相邻仓库 `along-backup.mjs` 目前只有备份、无恢复链路（`:11`「恢复演练在阶段 E」），且本机实测 `fs.cpSync` 保留 0600 权限位；恢复链路落地或任何手工搬运 secret 文件后必须统一 `chmod 600`（§6 移交注记），否则按本机制 fail-closed——云端拒启、Mac 新端点 503。

**(2) Kimi token 0600 校验**：见 (1)。Kimi 输出凭证扫描**不做**（评审砍掉，§5 残差）：Kimi token 只走 Authorization 头（`host/kimi-code-agent.mjs:189`）、从不进入模型上下文，且 Kimi 是云端不用的 Mac 本地路径——该闸门防的是不存在的泄漏路径。

**(3) codex 错误与 env 卫生（G-11，Mac 本地路径加严）**：`host/codex-agent.mjs:24-31`：

- stderr 停止拼进错误文案：非零退出统一 reject `Error('Along 暂时不可用')`，stderr 直接丢弃（实现用 `stdio:['pipe','ignore','ignore']`，无管道缓冲风险；spawn `error`——如 codex 二进制缺失——路径保持原样不包固定文案，设计只规定非零退出路径，§8.4），服务端只记一行无内容的 `console.warn('Along 任务代理异常退出（码 N）')`。`deploy/README.md:91` 与「Along 暂时不可用」表述不符的问题随本机制自然消解（M6 顺手核对该行）。
- 子进程 env **剔除 `ALONG_*`** 而非白名单（评审纠正：白名单会丢掉 codex 认证/代理/证书 env——`OPENAI_API_KEY`、`HTTPS_PROXY`、`SSL_CERT_FILE`、`CODEX_HOME` 等，弄坏 `/goal/event` 这个 Mac 真实功能）：`env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('ALONG_')))`。缺口证据里的泄漏路径正是 `ALONG_KIMI_CODE_TOKEN` 经 `env:process.env` 进入子进程（`host/kimi-code-agent.mjs:159` 从 process.env 读取）——剔除本 host 自己的凭证命名空间即闭合该路径，其余 env 原样继承保证 codex 功能不变。真实 codex 冒烟列入 §6（Mac 本地回归）。

### 3.5 M5 `cloud-source-guard`：云端形态拒收 OKX 明细

改动在 `host/device-source-gateway.mjs`。`createDeviceSourceGateway`（`host/device-source-gateway.mjs:27`）在创建时判定多用户形态：父状态目录（`resolve(dir,'..')`）存在 `users.json` 即 cloud（与 `host/agent-host.mjs:34` 的形态判定同源；测试直构时无 users.json → Mac 语义原样）。cloud 形态下：

- `publish` 输入含 `history` 键（`host/device-source-gateway.mjs:92` 的 `validOkxHistory` 放行处）→ 一律 `invalid_request`（400）——iPhone 原生采集的 ≤2MB 成交/账单明细不再可能落 `device-sources/<hash>.json`，云端只收三字段摘要（tradingEquityUsd/assetCount/positionCount），与部署设计 §3.3 的隐私口径一致（该行文档同步修订，M6）。
- 读路径 fail-closed：cloud 形态下任何已存记录含 `history`（如被误拷贝的 Mac 文件）按 `validRecord` 不过处理（`storage_unavailable`），与损坏记录同通道，错误显性化而不是静默剥字段。
- **行为边界与用户指引（评审核实的连带影响）**：`docs/okx-trade-history.md` §Device wire 明确 history 与 summary 在**同一次原子 publish**（同一 grant/sequence/event/digest），且 publish 指纹/持久化校验绑定 `digest(summary,history)`（`host/device-source-gateway.mjs:95`、`:156-158`）——逐字段剥离 history 不可行，拒收意味着**开启了成交/账单明细采集的云端用户，publish 会持续 400「设备数据请求无效。」、连摘要一起失败，连接永远到不了 connected**。iOS 本轮不许动，因此指引走文档（M6）：迁移到云端前/云端使用期间，用户在 iPhone 的 OKX 连接上**保持明细采集关闭**（只用账户摘要能力）；已开启的用户关掉明细采集后恢复正常。Mac 本地形态（无 users.json）行为逐字节不变（回归既有 gateway 用例）。

### 3.6 M6 `docs-sync`：文档、决策记录与 Runbook 同步

改动在 `docs/cloud-deploy-multi-user.md`、`README.md`、`deploy/README.md`。**约束**：`test/docs-cloud-runbook-agreement.test.mjs` 逐字断言了 §6.4/§6.1/M7 施工记录与 README 的多处原文（含「2026-11-20 定稿」「通过已认证的 runner 完成一次真实模型调用」「docker exec along-host node host/pair-code.mjs」「Along 服务: https://0.0.0.0:4176」「多用户形态下横幅**不打印**配对码」、cert.pem/key.pem 迁移命令、禁 `docker compose restart host` 等）——修订必须保留这些断言的原文或在本模块内同步更新该测试。

修订点（对应 §7 的决策修订）：

1. **部署设计 §3.1**（`:102`）「单一服务也不需要虚拟主机/限流」→ 修订为「限流在 host/runner 应用内实现（`docs/cloud-security-hardening.md`），不引入反代」；**§3.2 并发行**（`:191`）补 runner 并发上限（每用户 2/全局 4）与 host 每用户 start 限流（10 次/分钟）。
2. **部署设计 §3.2 公网失败窗口**（`:15`/`:174`）与 **SD-7**（`:368`）→ 「全局失败窗口」改「按来源（连接 IP）失败窗口」，补「发码不清窗；同 IP 噪音最长 15 分钟自愈，无清窗入口」。
3. **部署设计 §6.2 第 2 条**（`:332`）→ 「拷贝不移动」改为明确「device-sources/、okx-connections/、source-events/、kimi-runs.json 不拷贝上云（原 Mac 保留用于回退）」；**§3.3 OKX 行**（`:203`）→ 「云端 host 只收三字段摘要；多用户形态 gateway 拒收 trading_history 明细（`host/device-source-gateway.mjs`）」。
4. **部署设计 §6.4 第 3 步**（`:351`）→ 补密钥安全写入命令规范（§6 引用同款命令）；**deploy/README.md 凭证红线段**（`deploy/README.md:105-112`）→ 补 umask/历史注意事项、`deploy/agent-dsh` 锁文件的再生成说明与「恢复/搬运 secret 后统一 chmod 600」；**deploy/README.md:91** 随 M4 核对错误文案口径。
5. **README.md**：配置表 `ALONG_PAIR_FAIL_LIMIT` 行（`README.md:207`）改「按来源（IP）」口径；隐私表（`README.md:218`）「全局失败限速」改「按来源失败限速」。
6. **用户指引（G-19 连带影响）**：部署设计 §3.3 或 §6.4 补一段——云端使用期间 OKX 保持「仅账户摘要」采集，勿开启成交/账单明细（否则 publish 持续失败、连接无法就绪）；Runbook 第 9 步后向用户说明。
7. **DNS 前提（源 IP 语义）**：Runbook 第 6 步补「域名只配 A 记录，不配 AAAA」与理由（IPv6 经 docker-proxy 源 IP 退化，§3.1-(3)）。
8. `docs/README.md` 索引与本设计文档互链（若索引断言要求，随测试一并更新）。

## 4. 验收标准（可测试；每个模块合入后 `npm run check` 全绿）

### M1 `host-admission`（新 `test/security-host-admission.test.mjs`；`test/host-multi-user-pairing.test.mjs`、`test/pairing-multi-user-acceptance.test.mjs` 由测试轮改写）

1. 状态目录以 0755 预建启动后，`statSync(dir).mode&0o777===0o700`（自愈）。
2. 多用户形态 + `okx-connections/` 内存在 64hex `.json` → 进程非 0 退出且输出含「OKX 密钥库」；目录为空/仅 `master.key`/不存在 → 正常监听；本地形态不受影响。
3. `/pair`：`content-type` 非 `application/json` → 400 且 `pairing-codes.json` 无新失败；带 `Origin` 或 `Referer` → 403 且不计失败；iOS 同款头（application/json、无 Origin）→ 正常进入验码。
4. 失败窗口按来源：来源 A（127.0.0.2）打满 limit → A 的有效码也 403（码未消费）；来源 B（127.0.0.3）同时用另一有效码成功，且审计行显示两个来源 IP 不同；成功只清 B 的桶；窗口过期自然恢复；`issuePairingCode` 后失败桶不变。
5. `--revoke <userId>`：被吊销 token 的下一个请求 401（host 不重启），其他用户不受影响，`pairings.json` 该条消失；CLI 缺参/未知用户 exit 1；CLI 无 `--reset-window` 子命令（评审砍项的负断言）。
6. 滑动过期（注入时钟）：过期 token 401；剩余<7 天时成功请求续期到 now+30d；剩余充足不写盘；无 `expiresAt` 旧条目不过期；过期绑定在 `dispatchNotifications` 与 source 泵的每用户迭代中被跳过。
7. 限流与透传：60s 内第 11 次 `/super-agent/goals` 与 `/super-agent/tasks` → 客户端收到 **429**（文案「请求过于频繁」）；stub runner 对 `/run` 回 429 时客户端同样收到 **429** + runner 原文案（`runnerCall` 透传，不再折叠 502）；两个 status 端点不受限；本地单用户形态不启用。
8. `normalizeTaskRun`：`result={summary,next}` 合法原样；缺任一/空串/超长/多键/非字符串 → `blocked` 终态、`result:null`、error 含「输出校验失败」；`result:null` 中间态透传；start 与 status 两条路径都执行。
9. tasks context：finance `{saved:123,junk}` → 上游收到的 context 仅 `{saved:123,source:'演示数据'}`；custom → `{source:'暂无连接'}`；health 与 `agentHealthSnapshot` 一致；无合法域 → `{}`；**Mac bridge 路径**（无 ALONG_DSH_RUNNER_URL）同样收到清洗后 context；Kimi 分支与 `kimi-runs.json` 落盘不含原始 context。
10. 连接级防护（真实进程行为级）：同 IP 第 25 个 TCP 连接被销毁、前 24 个可用；源码切片断言 `maxConnections=64`、`headersTimeout=15_000`、`requestTimeout=60_000`。
11. 审计与限速：多用户 `/pair` 成功/失败/预检拒绝各产生一行含来源 IP 的日志且不含码与 token；同一来源 60s 内连发 ≥30 次预检拒绝只产生 ≤1 行拒绝日志（成功与计入窗口的失败不受限速影响）；本地形态无新增日志行。
12. 绑定文件即事实来源：删除 `pairings.json` 后所有绑定 401、重新配对即恢复（负路径语义断言，防内存兜底复活）。
13. 回归：改写后的两个配对测试全绿；`npm run check` 全绿。

### M2 `runner-guard`（新 `test/security-runner-guard.test.mjs`；`test/agent-runner-contract.test.mjs` 保持不动全绿）

1. 并发上限：stub dsh 挂起时，同用户第 3 个 `/run` → 429；两用户各 2 成功、全局第 5 个 → 429；上限满时同键重提交仍返回原记录（幂等优先）；完成释放后可再提交。
2. 降权：注入 stub（getuid=0，记录 setgid/setuid 调用）→ 先 `setgid('node')` 后 `setuid('node')` 且发生在任何 spawn/listen 之前；非 root 环境（getuid≠0）不调用、正常启动；setuid 失败 → 启动失败且提示含「降权」。容器内真实 uid 由 §6 冒烟核实（`docker top`）。
3. secret 权限：0600 启动成功；0644/0666 → 非零退出、输出含「权限过宽」、不含 secret 内容。
4. 回显检查维持现状：逐字回显（既有用例）与 JSON 转义形态仍被 blocked；不做编码变形集（评审砍项的负断言——变形集不进代码）。
5. 回归：`DEEPSEEK_API_KEY` 不继承、prompt 契约、LRU、body 上限等既有断言全部不变通过。

### M3 `deploy-hardening`（改写 `test/deploy-orchestration.test.mjs` + 新 `test/security-deploy-hardening.test.mjs`）

1. compose：host 服务新增 `read_only:true`、tmpfs（noexec,nosuid,nodev）、`security_opt:["no-new-privileges:true"]`、`cap_drop:["ALL"]`；agent 服务新增 `cap_drop:["ALL"]`、`cap_add:["SETUID","SETGID"]`；两服务 `mem_limit/cpus/pids_limit` 为正值；`docker compose config`（有 CLI 时）通过且 apns 删除变体仍通过。
2. Dockerfile.host：`FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}`；COPY 闭包等既有断言不变。
3. Dockerfile.agent：`FROM node:24-bookworm-slim@sha256:[0-9a-f]{64}`；无 `npm install -g`；`npm ci … --ignore-scripts` 于 `deploy/agent-dsh`；`ln -s` 建 dsh；`ALONG_DSH_VERSION` 与 `deploy/agent-dsh/package.json` 版本一致。
4. `deploy/agent-dsh/package-lock.json` 存在，锁定 `@deepseek-ai/dsh@0.2.2-rc.5` 且 `packages` 含传递依赖条目（解析 lock 断言）。
5. `.dockerignore` 白名单数组更新（含两条 agent-dsh 清单放行）且语义不变（任意新文件不放行）。
6. 回归 `npm run check` 全绿。

### M4 `credential-hygiene`（`test/along-bridge.test.mjs` 由测试轮改写翻转 0644 fixture 断言；`test/kimi-code-agent.test.mjs` 不动；新 `test/codex-agent.test.mjs`、`test/security-credential-hygiene.test.mjs`）

1. `readBridgeToken`：0600 返回 token；0644/0666 返回 null（等同未配置，云端启动拒绝路径不变）；无文件 null。
2. Kimi token：0600 正常；0644 抛「权限过宽」。
3. codex（新 `test/codex-agent.test.mjs`，`CODEX_BIN` 假脚本注入）：子进程 env 中无任何 `ALONG_*` 键；非 ALONG_ 控制变量（如测试注入的 `ALONG_TEST_PROXY_STYLE_VAR` 之外的普通变量）原样透传；假脚本 exit 1 + stderr 含样文本 → 客户端收到的 message 恰为「Along 暂时不可用」且 stderr 内容不出现；console.warn 只含退出码。
4. Kimi 输出扫描不存在（评审砍项的负断言：正常含 token 形态文本的输出不被拦——扫描代码不进 `host/kimi-code-agent.mjs`）。
5. 回归两个既有测试文件全绿；npm run check 全绿。

### M5 `cloud-source-guard`（新 `test/security-cloud-source-guard.test.mjs`；`test/device-source-gateway.test.mjs` 保持不动全绿）

1. 父目录有 `users.json` 时：`publish` 带 `history` → `DeviceSourceError invalid_request`（400）；不带 history → accepted（摘要照常持久化）。
2. 同形态下读已存在的含 history 记录 → `storage_unavailable`（fail-closed，不静默剥字段）。
3. 无 `users.json`（Mac/测试形态）→ publish/read 行为与现状逐字节一致（既有用例不改语义通过）。
4. 回归 `npm run check` 全绿。

### M6 `docs-sync`（改写 `test/docs-cloud-runbook-agreement.test.mjs` + 新 `test/security-docs-sync.test.mjs`）

1. §3.1/§3.2/§6.2/§3.3/§6.4 修订点以 includes 断言落地（按来源失败窗口、runner/host 限流数值、不拷贝清单、trading_history 云端拒收、写入命令规范、指向 cloud-security-hardening.md、A 记录口径、OKX 明细采集指引）。
2. README 配置/隐私表新口径（原「全局失败限速」「满窗时停止验码，可将上限调低」断言同步为新措辞）。
3. 部署设计既有被测原文（Runbook 定稿、冒烟期望、发码命令、`--force-recreate` 等）保持不变；`npm run check` 全绿。

## 5. 范围外与评审后接受为残差的缺口

**待确认缺口：无。** 清单 22 条全部为 verified；承担设计前提的条目已在本轮重新读代码/实测确认（§2 表），无「确认不了」的条目。

**范围外（本轮不设计模块，不视为遗漏）：**

- **G-16**（云端健康情境重评仍走「采用调整后的安排」按钮，`web/app.mjs:906`、`:2437`；与部署设计 `:222`/`:237` 口径冲突）、**G-17**（`applyGeneratedGoal` 无 proposal 复验、旧 accept-goal 入口残留，`web/app.mjs:1144`、`:1756`、`:1195-1216`）。两者修复点都在 `web/app.mjs`——本轮硬性约束「UI 渲染文件不许动」，故不设计；且 AGENTS.md §4 已指明「采用流程」属待迁移旧行为、方案在 `../along-superagent/docs/along/`，属既有迁移线的范畴。当前无服务端消费方、写入前仍有 `validateAdaptiveLayout` 复验，不构成可利用漏洞；**风险提示**：任何后续代码开始消费 `run.result` 或未经 host 校验的 proposal 时，必须先完成该迁移（本设计的 `normalizeTaskRun` 已把 `run.result` 的任意形状堵在服务端）。

**评审后接受为残差（拍板不改，理由记录在案）：**

- **G-10**（回显检查可被编码/拆分绕过、Kimi 输出无等价检查）——v1 曾设计变形集 + Kimi 扫描，评审砍掉（§7 SD-H13）。分层理由：(a) 模型拿到凭证的前提已被 M2 堵住大半（降权后 dsh/runner 读不到任何 secret 文件；`DEEPSEEK_API_KEY` env 是模型调用功能必需，无法去掉）；(b) 若 harness 真被攻破到能拿到密钥，它同样可以做任意变换（加密/分片/字典编码），固定变形集（base64/hex/去空白）拦不住，反而给正常输出加误报面；(c) Kimi token 只走 Authorization 头（`host/kimi-code-agent.mjs:189`）、从不进入模型上下文，且 Kimi 是云端不用的 Mac 本地路径——扫描防的是不存在的泄漏路径。保留现状：runner 的逐字 + JSON 转义回显检查原样有效（`deploy/agent-runner.mjs:204-208`），逐字回显仍被拦。**残余风险**：模型进程若被外部包缺陷攻破，理论上可带走模型 key——记录在案，靠 M2 降权、无工具 profile、输出上限与 read_only 缩小该前提的成立面。

## 6. 上线手动步骤（用户在云主机/iPhone 上执行，不设计为模块）

按部署设计 Runbook §6.4 顺序执行，以下为**新增/修订**步骤（编号并入 Runbook 时由实施定）：

1. **SSH 加固（G-22，主机初始化步）**：
   ```sh
   # /etc/ssh/sshd_config：仅密钥登录、禁密码、禁空密码，然后 systemctl reload ssh
   sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/; s/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/; s/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
   sshd -t && systemctl reload ssh
   ```
   并在云控制台把安全组 22 端口的来源限定为管理员 IP（或安装 fail2ban）。此后全部管理面（发码、看日志、换证书）才不等于「对全网开放的口令强度」。
2. **密钥安全写入（G-21，写密钥步）**：统一用以下形态，杜绝 key 明文进 shell 历史：
   ```sh
   umask 077
   HISTFILE=/dev/null   # 本条会话不落历史（或执行前 set +o history）
   install -m 600 /dev/null /opt/along/secrets/runner-token
   read -rs -p "runner-token(留空自动生成): " v; [ -n "$v" ] || v=$(openssl rand -hex 32); printf '%s\n' "$v" > /opt/along/secrets/runner-token; unset v
   install -m 600 /dev/null /opt/along/secrets/model-credentials
   read -rs -p "DeepSeek API key: " v; printf '%s\n' "$v" > /opt/along/secrets/model-credentials; unset v
   ```
3. **secrets 挂载权限冒烟（G-6/G-13 配套）**：`docker compose up` 后执行 `docker exec along-host ls -l /run/secrets/` 与 `docker exec along-agent ls -l /run/secrets/`，确认均为 `-rw-------`（bind mount 保留宿主权限）；非 0600 会被新校验拒绝启动，按报错修正宿主文件权限即可。`docker top along-agent` 确认 runner 主进程 uid 为容器内 node 用户（1000）而非 root。**任何手工搬运/恢复 secret 文件后统一 `chmod 600`**（相邻仓库 `along-backup.mjs` 的恢复链路尚未实现——`scripts/along-backup.mjs:11`「恢复演练在阶段 E」；恢复落地时须补恢复后 chmod，移交注记；本机已实测 Node `fs.cpSync` 保留 0600，风险主要在手工 `cp`/`mv` 流程）。
4. **迁移不拷贝（G-9/G-19 配套，替代部署设计 §6.2 第 2 条旧措辞）**：从 Mac 迁移时**只**按 §6.2 第 1 条读 user_id 写 `users.json`；`okx-connections/`、`device-sources/`、`source-events/`、`kimi-runs.json` 一律留在 Mac。若已误拷贝：`rm -rf /opt/along/data/host/okx-connections`（host 会拒启提示）后 `docker compose up -d`；`device-sources/` 同理删除（gateway 读路径会 fail-closed）。
5. **DNS 只配 A 记录（源 IP 前提，G-3/G-4 配套）**：域名只建 A 记录指向 ECS 公网 IPv4，**不配 AAAA**——IPv6 客户端经 docker-proxy 会让源 IP 退化为网关地址，按来源分桶与单 IP 连接上限双双失效（§3.1-(3)）。
6. **镜像 digest 记录（G-8）**：首次 `docker compose build` 后执行 `docker image inspect along-host:local along-agent:local --format '{{.RepoDigests}}'` 记录到部署台账；基础镜像 digest 的获取与升级用 `docker buildx imagetools inspect node:22-bookworm-slim`（node:24 同理），改 Dockerfile `FROM` 行后重建（2026-11-21 的当前值已记录在两个 Dockerfile 头注释）。dsh 升版本时在 `deploy/agent-dsh/` 内 `npm install --package-lock-only --ignore-scripts` 重新生成 lock 并同步 `ALONG_DSH_VERSION`。
7. **资源上限生效确认（G-1/G-2/G-3）**：`docker stats --no-stream` 与 `docker inspect along-host along-agent --format '{{.Name}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}'`；宿主机 `ulimit -n` 不足时在 compose 加 `ulimits` 调高 nofile（实施时按实测补）。
8. **加固项冒烟（Runbook 第 5 步追加）**：
   - 用非 127.0.0.1 地址并发开 25 条 TCP 到 443：第 25 条立即被断，host/agent 两容器健康检查不受影响；
   - **源 IP 保留断言**：从两个不同外部网络（如手机热点 + 家里宽带）各发一次 `POST /pair`（垃圾码即可），`docker logs along-host` 的两行审计 `来源=` 值必须不同——相同即命中 docker-proxy 退化，按第 5 步排查；
   - 以 `text/plain` POST `/pair` → 400；带 `Origin` 头 → 403；两者都不产生 `pairing-codes.json` 失败记录；
   - 同一 token 60 秒内第 11 次 `POST /super-agent/goals` → **429**（不是 502）；runner 并发打满时同样 429；
   - `docker exec along-host node host/pair-code.mjs --revoke <userId>` 执行一次验证 401 立即生效；
   - `docker logs along-host` 核对 `/pair` 审计行（含来源 IP、不含码、拒绝类同一来源 60s 至多一行）。
9. **Mac 本地回归（M4 配套）**：有 codex 环境的 Mac 上跑一次 `/goal/event`（或等价的 codex 调用路径），确认剔除 `ALONG_*` env 后 codex 认证/代理仍工作、错误文案为固定值；确认 `~/.kimi-code/server.token` 与桥接 token 文件为 0600（过宽会被拒用，按报错 chmod）。
10. **OKX 明细采集用户指引（G-19 连带影响）**：Runbook 第 9 步后向两位用户说明——云端使用期间 iPhone 的 OKX 连接保持「仅账户摘要」，勿开启成交/账单明细采集（否则发布持续失败、连接无法就绪，§3.5）；需明细复盘时在 Mac 本地模式操作。

## 7. 方案内决策记录（SD-H，v2 经评审修订）

- **SD-H1 限流做在应用内，不引入反代**：Host/runner 内置常数上限及资源限制负责准入保护，真实负载与恢复能力仍需验收；不再以旧叶钉扎作为不引入反代的技术理由。CA 描述文件改变服务器信任方式，不消除公网 TLS/配对入口的资源风险。
- **SD-H2 失败窗口按来源分桶，不设清窗入口**（评审修订）：修订 SD-7 与 `docs:15/:174` 的「全局失败窗口」。按来源分桶后「发码清窗刷新攻击者配额」不复存在（攻击者只能烧自己的桶），v1 的 `--reset-window` 砍掉——对与用户同 IP 的持续攻击者清完即被填满、对攻击者停手场景窗口 15 分钟自然过期，入口不值得留（AGENTS §1 不加入口）；被噪音阻塞的同 IP 合法设备最长 15 分钟自愈。
- **SD-H3 绑定滑动过期 + 吊销只在多用户形态生效**：Mac 本地模式行为不变是 AGENTS.md 硬要求；公网暴露的过期/吊销风险只存在于云端。既有无 `expiresAt` 绑定不过期（grandfathered），管理员可吊销重配——避免一次性打破已部署绑定。后台泵与鉴权共用同一「绑定有效」判定（评审补齐）。复核修订：grandfathered 只覆盖「字段缺失」；显式写出的非法 `expiresAt` 拒绝授权（401），不按永不过期处理。吊销同时清掉该用户未消费的配对码。
- **SD-H4 绑定表每请求读盘、写侧共用一把锁**：与 `pairing-codes.json` 的「不在启动时缓存」同纪律；修 G-5 的同时消除「内存表 vs CLI 改盘」竞态（bugfix-goal-prompt §7 既有坑）。
- **SD-H5 容器不加非 root USER；dsh 隔离用「读入 secrets 后整进程降权」**：compose file secret 是 bind mount、`uid/gid/mode` 长语法不生效（docker/compose#9648），非 root 容器读不到 0600 secret 必然起不来；root + `cap_drop: ALL` + 只读根 + no-new-privileges 已封死提权与持久化路径，runner 启动读入 secret 后降到 node 用户，dsh 与 runner 从此读不到任何 secret 文件。`DEEPSEEK_API_KEY` 留在 dsh env 是模型调用功能必需，靠逐字回显检查与输出上限兜底，接受为残余风险。
- **SD-H6 任务信封在 host 侧补 `normalizeTaskRun`**：与 `normalizeGoalRun` 同处 `host/agent-host.mjs`（目标路径先例）、白名单 + 失败落 blocked 终态；只覆盖 DSH runner 任务路径（Kimi 任务信封无 result 字段）。未做客户端侧复验——客户端 `safeSuperAgentRun` 结构白名单已有，内容闸门属于服务端职责。
- **SD-H7 云端形态拒收 OKX 明细，连带影响用文档指引消化**：按 users.json 存在性判定形态（不新增开关）；publish 拒收 + 读路径 fail-closed。history 与 summary 在设备侧同一次原子 publish、digest 绑定（`docs/okx-trade-history.md`、`device-source-gateway.mjs:95`），剥离不可行——开启明细采集的云端用户 publish 会持续 400，指引「云端仅账户摘要」（iOS 本轮不动，M6/手动步骤承载）。
- **SD-H8 证书算法基线保留 RSA 3072**：本篇不引入 ECDSA 切换；握手负载与超时独立验证，不把 headersTimeout 当 TLS 握手超时。CA 专项方案选择系统信任后，叶轮换不再绑定全体重配对，证书生命周期按该方案实施。
- **SD-H9 上限数值为常数初值**：host 限流 10 次/分钟/start 端点（合法轮询 4s 一次的 status 端点不限）、runner 每用户 2/全局 4、compose mem 512m/2g、pids 128/192、cpus 1.0/1.5——2C4G 建议规格下的安全初值，冒烟后可在一处常数/一行 compose 调整，不做成配置项。
- **SD-H10 apt 不锁版本**：基础镜像 digest 已固定起始层；锁 openssl 版本会让 Debian point release 后构建失败，与「简单第一」冲突；残差（Debian 源 TLS+签名）记录在案。
- **SD-H11 G-16/G-17 移交既有迁移线**：UI 渲染文件本轮不动；两缺口无直接可利用路径，且 AGENTS.md §4 已有迁移归属。
- **SD-H12 日志新增面收口在「来源 IP + 事件类型」，写入速率有界**（评审修订）：`/pair` 审计与连接计数不落码、token、请求体（部署设计 §3.7 红线原文不变）；成功行天然受码约束，拒绝行按来源限速（同一来源 60s 至多一行、内存表上限 256 源）——v1「每次尝试一行」的无限写入速率已修正，轮转 10m×3 内的真实审计不会被噪音挤出。
- **SD-H13 G-10 接受为残差**（评审拍板）：变形集与 Kimi 输出扫描都不做。理由：模型拿到凭证的前提被 M2 降权堵住大半；真被攻破时任意变换能绕过任何固定变形集、只加误报面；Kimi token 从不进模型上下文且 Kimi 为 Mac 本地路径。逐字 + JSON 转义检查维持现状（逐字回显仍被拦）。见 §5。
- **SD-H14 codex env 用「剔除 `ALONG_*`」而非白名单**（评审修订）：白名单会丢掉 codex 认证/代理/证书 env（`OPENAI_API_KEY`/`HTTPS_PROXY`/`SSL_CERT_FILE`/`CODEX_HOME` 等，无法穷举），弄坏 `/goal/event` 这个 Mac 真实功能；缺口证据的泄漏路径正是本 host 自己的 `ALONG_KIMI_CODE_TOKEN` 经全量继承进入子进程——剔除本 host 的凭证命名空间即闭合该路径且零功能风险。stderr 不进错误文案（用户可见修复）保持不变。
- **SD-H15 `pairings.json` 是绑定的唯一事实来源**（评审记录的显式回退）：被删除 → 全部绑定丢失、各用户重新发码配对（与 `pairing-codes.json` 缺失同语义）。不做内存兜底——兜底快照会让吊销/过期无法即时生效（本机制核心目标）；删除是需要 root 的运维事故，恢复路径自愈。
- **SD-H16 源 IP 语义前提显式化**（评审修订）：分桶与连接上限依赖 Docker DNAT 保留外部 IPv4 源 IP；缓解 = 域名只配 A 记录不配 AAAA + 冒烟断言两个外部来源审计 IP 不同（§6 步骤 5/8）；宿主 localhost（健康检查/管理员）共享网关桶，量小不影响公网分桶。本机无 Docker daemon 无法实测该前提，列为 ECS 冒烟验证项而非断言。
- **SD-H17 runner 429 原样透传是 M1 的职责**（评审纠正 v1 的事实错误）：`host/agent-host.mjs:96` 现状把非 ok 一律折叠 502——机制清单补 `runnerCall` 保留 429 状态码这一条，验收从「runner 返回 429」收紧为「客户端收到 429 + 原文案」。

## 8. 实施记录与偏差（2026-11-21）

M1–M6 六个模块按 §3 并行实施完成。测试断言按编排分工由统一测试轮落库：新增 `test/security-host-admission.test.mjs`、`test/security-runner-guard.test.mjs`、`test/security-deploy-hardening.test.mjs`、`test/security-credential-hygiene.test.mjs`、`test/security-cloud-source-guard.test.mjs`、`test/security-docs-sync.test.mjs`、`test/codex-agent.test.mjs`；改写 `test/host-multi-user-pairing.test.mjs`、`test/pairing-multi-user-acceptance.test.mjs`、`test/along-bridge.test.mjs`（翻转 0644 fixture 断言）、`test/deploy-orchestration.test.mjs`（M3 自改）、`test/docs-cloud-runbook-agreement.test.mjs`（M6 自改）。最终全量门禁通过：本轮实跑 `npm run check`——`node --check` 全过 + 682 条测试 681 过、0 失败，1 条跳过（下文偏差 4 的双来源环境断言，探测不到第二来源时自动跳过）。实施与设计的出入逐条如下，均按「校验只加严、可观察行为等价」处置：

- **§8.1 M1 host-admission**：
  1. 绑定表读取形态：设计写「authorized/stillPaired/currentBinding/两个后台泵一律直调 `readPairings(dir)`」，实现为统一的 `refreshPairings()`（`host/agent-host.mjs:119`）——authorized 每请求入口、两个后台泵每轮、`/pair` 写入后调用，内部 `readPairings` 纯读盘并过滤过期；`stillPaired`/`currentBinding` 读刷新后的表。可观察行为与设计一致（每请求/每轮读盘、文件即唯一事实来源、吊销/过期即时生效、误删全 401）。
  2. 限流守卫是单行路由级判定（`host/agent-host.mjs:629`）覆盖两个 start 端点，不是各处理器内各一行——语义相同（鉴权后、上游调用前）。
  3. `normalizeTaskRun` 对纯空白字符串也判失败（`!text.trim()`，`host/agent-host.mjs:500`），比字面「非空」略严。
  4. 测试未按设计名 `test/cloud-host-admission.test.mjs` 落地，而是 `test/security-host-admission.test.mjs`；双来源断言先探测可用来源、探测不到自动跳过（macOS 无 root 加不了 127.0.0.2/127.0.0.3 回环别名，本轮跳过 1 条），ECS 冒烟（§6 步骤 8）兜底。
  5. 遗留脆弱点：`test/host-multi-user-isolation.test.mjs:178` 的 CODEX_BIN 桩仍用 `ALONG_TEST_CODEX_DELAY` 制造 800ms 并发窗口，而 M4 已剔除子进程全部 `ALONG_*` env——桩延迟实际为 0，`/goal/event` 并发 429 断言（`:302`）依赖时序（本轮全量门禁实测通过，但属稳定翻转风险）。该文件不在本轮任何模块独占清单内；后续轮次应把桩改为读非 `ALONG_*` 变量。
- **§8.2 M2 runner-guard**：模型密钥读取失败文案定为「模型密钥文件无法读取：<路径>」（`deploy/agent-runner.mjs:64`，统一走 `readSecretFile` 含路径便于运维定位）；0600 校验作用于 env 指向的文件而非硬编码 `/run/secrets/*`（compose 映射被 `test/deploy-orchestration.test.mjs` 锁定）；降权平台守卫实现为 `typeof process.getuid!=='function'||process.getuid()!==0`；`test/agent-runner-contract.test.mjs` 未改动（行为先以一次性脚本验证，再由测试轮落库）。
- **§8.3 M3 deploy-hardening**：基础镜像 digest 记录位置与设计不同——设计写「记录进 `deploy/README.md`」，实际记录在两个 Dockerfile 的头注释（digest 值、日期、再解析命令）；`deploy/README.md`（M6 独占）由 M6 在文件清单表新增 agent-dsh 行承载锁文件升级流程。其余与设计一致：apt 不锁版本（SD-H10 残差）、不加非 root USER（SD-H5）。
- **§8.4 M4 credential-hygiene**：stderr 丢弃用 `stdio:['pipe','ignore','ignore']`（完全丢弃，无管道缓冲风险）；spawn `error`（codex 二进制缺失等）路径保持原样未包固定文案——设计只规定非零退出路径；Kimi 输出凭证扫描未实现（评审砍项，§5/SD-H13），负断言由测试轮落库；`test/kimi-code-agent.test.mjs` 未改动（既有用例全走 constructor token，全绿）。
- **§8.5 M5 cloud-source-guard**：未按设计改写 `test/device-source-gateway.test.mjs`——云端断言由测试轮以 `test/security-cloud-source-guard.test.mjs` 落地（原文件不动、既有用例全绿）；注意 cloud fixture 必须在创建 gateway 之前写入 `users.json`（形态在创建时一次性判定，与 agent-host 先 loadUsers 再建 gateway 的顺序一致）。
- **§8.6 M6 docs-sync**：修订点 8（`docs/README.md` 索引互链）设计为条件项「若索引断言要求」——索引本无 hardening 断言，M6 按条件未动；文档同步轮在索引补了 hardening 行（可读性补充，完成该修订点的意图）。agent-dsh 锁文件再生成说明放在 `deploy/README.md` 文件清单表新增行而非凭证红线段正文（非凭证事项，贴合表格用途）。超出修订点清单的三处一致性等价更新：部署设计 §4-M1 两处、§5 验收 #1、§6.1 风险行的「全局失败窗口」措辞改按来源口径（无测试断言这些段落）。
- **§8.7 测试与门禁归属**：实施期各模块只改独占文件、不写测试（M3/M6 在独占测试文件内自改除外）；实施中 `npm run check` 的失败全部是其他模块的在途文件（failures 形状、0600 fixture、桩延迟），随各自模块收敛；最终由测试轮补齐全部断言后，全量门禁一次通过（数字见本节开头）。

## 附录 A：安全缺口清单（G-1～G-22，本体并入仓库）

> 来源：方案评审前的独立安全审计（每条 status=verified）。`where` 行号以审计时点工作树为准；「处置」列指向本设计的模块/手动步骤/范围外/残差。

- **G-1（多用户隔离与会话，medium）** `host/agent-host.mjs:480-519、214-219、538；deploy/agent-runner.mjs:230-243、180；deploy/docker-compose.yml:6-57` —— 认证后 DSH 运行链路无并发/频率防护：runner 对每个新 (userId,requestId) 无上限拉起 dsh 子进程，两容器无 mem/cpu/pids 上限；单个已配对用户可耗尽整机资源并刷掉两人共用的 DeepSeek 额度。**处置**：M1（每用户 start 限流 + runnerCall 429 透传）+ M2（runner 并发硬上限）+ M3（compose 资源上限）。
- **G-2（容器与主机加固，medium）** `deploy/Dockerfile.host:1-17、deploy/Dockerfile.agent:1-21、deploy/docker-compose.yml:7-34（对照 :45-47、:28）` —— 两容器都以 root 运行，host 服务无 read_only/tmpfs/no-new-privileges/cap_drop，与 agent 容器不对称；host 持 TLS 私钥、绑定表、全部状态卷与 secrets。**处置**：M3（host 补三件套 + cap_drop ALL；不加 USER，SD-H5）。
- **G-3（网络暴露与传输，medium）** `host/agent-host.mjs:384、388-399、53、554；host/request-body.mjs:7-12` —— 公网唯一入口未设 maxConnections/requestTimeout/headersTimeout、无每 IP 连接限制，未认证慢连接/握手洪水可长期占用 fd 与 CPU；`/pair` 是唯一鉴权前读体路由。**处置**：M1（超时 + 连接上限 + 源 IP 语义）+ M3（资源上限）；证书算法不改（SD-H8）。
- **G-4（网络暴露与传输，medium）** `host/pairing.mjs:158-179、131-136、23-27` —— `/pair` 失败窗口是全局 10 次/15 分钟单一计数器、无按来源限流；攻击者 ~0.01 QPS 垃圾码即可永久占满窗口，阻断两位合法用户的配对。**处置**：M1（按来源分桶）。
- **G-5（多用户隔离与会话，medium）** `host/agent-host.mjs:400-404、146-149、416-418；host/pairing.mjs:83-90、53-75` —— 配对 token 永不过期且无吊销机制：泄露 token 无限可用，唯一失效途径是同用户重配对覆盖。**处置**：M1（滑动过期 + `--revoke` + 每请求读盘）。
- **G-6（凭证与密钥，medium）** `deploy/agent-runner.mjs:164-179（配合无 USER、compose:49-52）` —— dsh 模型子进程与 runner 同为 root：可读 `/run/secrets/runner-token` 与 model-credentials；输出路径仅有逐字回显检查、1MB stdout 上限等非权限层屏障。**处置**：M2（0600 校验 + 整进程降权到 node 用户）+ M3（SETUID/SETGID 保留）。
- **G-7（Agent 校验与目标通道，medium）** `host/agent-host.mjs:129-135、487、493；deploy/agent-runner.mjs:103-110、136、146` —— 云端 DSH 动态任务运行整条链路无输出形状契约校验，模型返回的任意 JSON 原样进运行信封与客户端（目标路径的 normalizeGoalRun 闸门证明这是遗漏而非取舍）。**处置**：M1（normalizeTaskRun）。
- **G-8（容器与主机加固，medium）** `deploy/Dockerfile.host:4-5、8；deploy/Dockerfile.agent:4-5` —— 基础镜像浮动 tag 无 digest pin、apt 不锁版本；agent 镜像 `npm install -g` 缺 --ignore-scripts 且传递依赖无锁。**处置**：M3（digest pin + agent-dsh 锁文件 + --ignore-scripts）。
- **G-9（健康数据与隐私，medium）** `host/agent-host.mjs:37、434、139；host/okx-connection.mjs:77-88；docs/cloud-deploy-multi-user.md:320、332` —— 云端 Host 无条件实例化旧 Mac OKX vault 且无启动期守卫；§6.2「拷贝不移动」措辞含混，诱导把可解密的 OKX 凭证落公网主机。**处置**：M1（启动守卫）+ M6（措辞）+ §6 手动步骤。
- **G-10（凭证与密钥，low）** `deploy/agent-runner.mjs:75、204-208；host/kimi-code-agent.mjs:112-126` —— 回显检查只匹配 JSON 转义后逐字子串（编码/拆分绕过）；Kimi 路径无等价检查。**处置**：接受为残差（§5、SD-H13）——逐字检查保留，变形集与 Kimi 扫描经评审砍掉。
- **G-11（凭证与密钥，low）** `host/codex-agent.mjs:24-31（回传链 host/host-error.mjs:7-9 → agent-host.mjs:538→543）` —— codex 非零退出把 stderr 末 600 字符拼进错误文案回给客户端，spawn env 全量继承；暴露面在 Mac 本地模式。**处置**：M4（固定文案 + 剔除 `ALONG_*` env，SD-H14）。
- **G-12（凭证与密钥，low）** `host/pairing.mjs:150` —— 每发一个新码清空全局失败窗口，给枚举者刷新配额。**处置**：M1（发码不清窗；按来源分桶后该问题消解，无清窗入口，SD-H2）。
- **G-13（凭证与密钥，low）** `host/along-bridge.mjs:16-22、host/kimi-code-agent.mjs:181-185（对照 host/apns.mjs:12）` —— 桥接凭证与 Kimi token 读取不校验 0600，与 APNs/OKX 口径不一致。**处置**：M4（0600 校验）+ M2（runner secrets 同款）+ §6 步骤 3/9。
- **G-14（网络暴露与传输，low）** `host/agent-host.mjs:143-144、388-390` —— `/pair` 不校验 Content-Type 也不做 Origin/Referer 检查：恶意网页可众包消耗全局失败窗口。**处置**：M1（预检，不计窗口）。
- **G-15（多用户隔离与会话，low）** `host/agent-host.mjs:388-413；host/pairing.mjs:169、175` —— 多用户 `/pair` 成功/失败均无审计日志，码被私下转发无从发现。**处置**：M1（审计日志，拒绝类按来源限速，SD-H12）。
- **G-16（Agent 校验与目标通道，low）** `web/app.mjs:2437-2441、906、2610-2657；docs:222、237` —— 云端健康重评仍走「采用」旧路径，与红线「校验通过后自动写入」冲突。**处置**：范围外（UI 渲染文件约束，§5）。
- **G-17（Agent 校验与目标通道，low）** `web/app.mjs:1207、1210-1216、1144、1756-1768、748、1228-1238` —— 客户端 applyGeneratedGoal 对 proposal 不做二次校验，旧 accept-goal 入口与草稿自动采用残留。**处置**：范围外（同上）。
- **G-18（健康数据与隐私，low）** `host/agent-host.mjs:28` —— 状态目录顶层缺 chmod 0700 自愈，与三个子目录的处理不一致。**处置**：M1-(1)。
- **G-19（健康数据与隐私，low）** `host/device-source-gateway.mjs:86-92、156-159；docs:203` —— 文档称「云端只收三字段摘要」而 gateway 实际接受 ≤2MB 成交/账单明细。**处置**：M5（云端拒收 history）+ M6（口径与用户指引）+ §6 步骤 4/10。
- **G-20（健康数据与隐私，low）** `host/agent-host.mjs:484-485（对照 :500）` —— tasks 路径只对 health 域 context 做白名单清洗，custom/finance 原样透传进模型 prompt 与 Kimi 落盘。**处置**：M1-(9)（全域清洗，标注 Mac 行为变化）。
- **G-21（容器与主机加固，low）** `docs/cloud-deploy-multi-user.md:351、deploy/README.md:105-112` —— Runbook 写密钥步骤缺防落盘细节（内联 key 的命令会进 shell 历史）。**处置**：M6（命令规范）+ §6 步骤 2。
- **G-22（容器与主机加固，low）** `docs:349（步骤 1）、:353/:355/:358` —— Runbook 主机初始化对 SSH 无加固要求，22 端口对全网开放。**处置**：§6 步骤 1（手动）。

## 附：外部来源

- Docker Compose file secrets 的 bind mount 与 `uid/gid/mode` 不生效：docker/compose#9648、#25035，[Compose secrets 文档](https://docs.docker.com/reference/compose-file/secrets/)、[Compose secrets how-to](https://docs.docker.com/compose/how-tos/use-secrets)、[Stack Overflow: How to use 'mode' with docker secrets mounted with files](https://stackoverflow.com/questions/73471106/how-to-use-mode-with-docker-secrets-mounted-with-files)。
- `@deepseek-ai/dsh@0.2.2-rc.5` 元数据（scripts 为空、bin=lib/bin.js）：npm registry（本轮实测抓取）。
- 其余「本轮实测」条目见 §2 表（本机 node v22.22.3、openssl、真实 https 连接实验、`fs.cpSync` 权限位实验、iOS/App/host/相邻仓库源码行号）。
