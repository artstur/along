# Along Host 云端部署经验（Linux，阿里云 ECS）

> 2026-11-23 实测。环境：阿里云 ECS（2 核 / 3.5 GB / 40 GB 磁盘），Alibaba Cloud Linux 4，Docker 29.10.0 / Compose v5.8.0。
> **本文只记录实测事实与踩过的坑，不重复部署编排** —— 编排在本轮新增的
> `deploy/docker-compose.cloud.yml`（锚点 + superagent + host + embeddings 垫片）、
> `deploy/Dockerfile.host.cloud`、`deploy/Dockerfile.superagent`、`deploy/netns-proxy.mjs`、
> `deploy/superagent-profile.patch.yml`；
> Super Agent 侧的前置实测见[Superagent 云端部署经验](superagent-cloud-deploy.md)。
>
> 与[云端部署与多用户方案](cloud-deploy-multi-user.md)的关系：那份是设计（§3.5 的 Tier 1/Tier 2 划分
> 保留为历史设计），本文是 Linux 上真正跑起来的那一版。
>
> 仓库的规范布局是 `/opt/along/{along,along-superagent,data,secrets}`；本文的实测机把两个仓库放在
> `/home/ecs-user/workspace/` 下，命令按实测路径写。

## 1. 结论

**云端栈跑通了。** 一句自然语言（"我想改善睡眠，希望每晚睡够七小时"）经 iPhone → Host →
Along Agent → MiniMax 后，自动建出目标《改善睡眠，每晚睡够七小时》、拆出 3 个任务、约了每天
22:30 的睡前提醒，并回了一条说明消息。目标、任务、消息在容器重建后仍在（bind 卷持久化）。

成品的形状是三个容器 + 宿主 nginx：

```
iPhone ──https──▶ 宿主 nginx:10531（Let's Encrypt IP 证书）
                     └─▶ 127.0.0.1:4176 ─▶ along-host（私 CA 自签 HTTPS，对内）
                                          └─▶ 127.0.0.1:3082 ─▶ along-superagent
                                                                        └─▶ 阿里云百炼 / MiniMax（模型与向量）
```

外加一个 `along-netns` 锚点容器，只为持有共享网络命名空间（见 §2.3）。

DSH 管理面板另有入口：宿主 nginx 的 10530 → 锚点跳板 3083 → 容器内 DSH 的回环 3082
（2026-11-23 已放行到公网；面板要 `?token=` 登录）。

## 2. 三个硬约束，以及各自绕不过去的解法

这三处都不是"改个配置就能过"，每一条都有代码或运行时上的硬要求，绕过就等于破坏仓库的安全边界。

### 2.1 对外与对内必须用两套证书

Host 的云端证书校验器（`host/tls-material.mjs:183` 的 `leaf.verify(root.publicKey)` 与 `:185-189`
的链校验）要求**根证书直接签叶证书**，且证书链逐级可验、链尾自签。Let's Encrypt 的 IP 证书链是
「叶 ← LE YE2 ← ISRG Root YE ← ISRG Root X2」，根并不直接签叶——整条塞进 Host 必然在监听前被拒启。

解法是内外分两层：

- **对外**：宿主 nginx 用现成的 Let's Encrypt **IP 证书**（`/etc/letsencrypt/live/8.155.140.214/`，
  SAN 含 `IP:8.155.140.214`，iOS 系统原生信任）终结 TLS，反代到 Host；
- **对内**：Host 用自签私 CA 叶证书，材料按仓库契约摆好
  （`<stateDir>/tls/releases/<serial>/{fullchain.pem,key.pem,root.crt}` + `tls/current` 符号链接，
  目录 0700、私钥 0600），nginx 反代时 `proxy_ssl_verify off`。

根私钥签完即删，**不留在服务器上**（仓库设计：`docs/iphone-ca-profile-design.md` §3.1）。

顺带的收益：Host 容器因此**不需要 openssl**（云端形态的证书是预签发材料，由 `node:crypto`
加载校验，全程不调 openssl；只有 Mac 本地自签路径才需要它）。所以云端镜像可以跳过
`apt-get install openssl`——这台机到 `deb.debian.org` 的下载慢到 20 分钟装不完
（[Superagent 云端部署经验](superagent-cloud-deploy.md) §3）。

### 2.2 桥接端点必须是回环地址

`host/source-event-bridge.mjs:135` 硬校验桥接 URL 必须是 `localhost` / `127.0.0.1` / `[::1]`
（`private_loopback_required`），否则 Host 启动即拒启。这条不是"建议"：`/along-source/api/*`
本身不校验来源（实测带任意 `Host` 头返回 200），但 Host 启动就按 URL 形状拒。

因此 **`ALONG_SUPERAGENT_URL=http://along-superagent:3083` 这种 docker DNS 名走不通**，
Host 与 Super Agent 必须共用一个网络命名空间，双方都看见 `127.0.0.1:3082`。

### 2.3 命名空间必须由第三方容器持有（这条最隐蔽）

如果命名空间由 `host` 或 `superagent` 持有，**对方一重启就掉链，而且不报任何错**。

实测：重启 `superagent` 容器后，它换了新的网络命名空间，而 Host 还留在旧命名空间里——

- 宿主 `127.0.0.1:4176` 的端口映射失效（TLS 握手直接失败，curl 报 `SSL connect error`）；
- Host 的桥接打到旧命名空间里的回环，超级 Agent 已经不在那里（`ECONNREFUSED`）；
- 容器日志只有一行"源状态同步暂不可用"，没有任何指明"谁被落下了"的线索。

解法与 tier2 分支同款：**第三个与两者都无关的锚点容器持有命名空间**，Host 与 Super Agent
都用 `network_mode: service:anchor` 加入。这样任一方单独重建，命名空间不变，另一方不受影响。

配套还做了两件事：

1. 锚点里跑一个 8 行的裸 TCP 跳板（`deploy/netns-proxy.mjs`）：`0.0.0.0:3083 → 127.0.0.1:3082`。
   DSH 的管理面硬性绑回环（`along-superagent/src/app/http.ts:234`），宿主与外部容器都够不着；
   宿主 nginx 面板（10530）要可达，就得在同一命名空间里有一路对外入口。宿主原来的 socat
   转发目标（写死旧容器 IP）随容器重建失效，改为直接反代锚点跳板。
2. **命名空间探针**：两个服务的健康检查除了探自己的服务，再探一次锚点里的跳板
   （`fetch('http://127.0.0.1:3083/')`，只判"有没有响应"）。跳板在锚点的命名空间里，
   只有与锚点同处一个命名空间时才够得着——所以一旦被落下，docker 会重启该容器把它拉回来。
   没有这条探针时，这种故障是静默的。

锚点被动过之后（手动重启、被 OOM kill），一次性重建三个：

```sh
cd /home/ecs-user/workspace/along      # 这台机的布局；仓库的规范布局是 /opt/along/along
docker compose -f deploy/docker-compose.cloud.yml up -d --force-recreate anchor superagent host
```

## 3. 修掉的真 bug 与踩到的配置陷阱

### 3.1 `host/tls-material.mjs` 的 IP SAN off-by-one

`sanNames()` 解析 IP SAN 时用 `text.slice(10)` 取值，而 `"IP Address:"` 是 **11** 个字符
（`IP` 2 + 空格 1 + `Address` 7 + 冒号 1）——切少了 1 位，取出来的值带着前导冒号
（`:8.155.140.214`），于是**任何 IP SAN 都匹配不上**，只有 DNS SAN 能用。

云端部署的 `ALONG_TLS_CN` 就是公网 IP，正好踩中：启动报
`云端 TLS 叶证书的 SAN 不覆盖 8.155.140.214`。仓库原有测试只覆盖 DNS SAN，
`certificateCoversHost(leaf,'127.0.0.1')===false` 在有 bug 的实现下也成立，所以没暴露。

已修为 `text.slice('IP Address:'.length)`，并补了一条签 IP SAN 叶证书的用例
（`test/ca-tls-material.test.mjs`）。`node --test test/ca-tls-material.test.mjs` 23 项全过。

### 3.2 DSH profile patch 的两处格式要求（不是 bug，是配置陷阱）

- **`name:` 单独一行会被整个 patch 拒掉**：`patch: id is required for non-insert patches`。
  非 insert 的 patch 行必须带 `id:`。
- **base 组合里没有的插件，要用 `insert:` 往根上插**：

  ```yaml
  - insert:
      - id: llm-pi-ai
        name: '@deepseek-ai/dsh-llm-pi-ai'
        config: {...}
  ```

  写错的后果是静默的：插件没挂上，模型请求报
  `no adapter registered for provider "minimax"`（`NO_ADAPTER`），
  而 `/orchestrator/api/models` 里的 `default` 仍显示配好的 minimax——**看起来配好了，其实没生效**。
  验配置用 `dsh --profile <profile> --dump-config`。

### 3.3 profile 的 patch 层与 bundle 软链都属于「接缝」，得由启动保证

两处接缝曾经让容器**看起来正常、实际不可用**，而且都不报错：

- **bundle 软链**：bundle 装在 dsh CLI 的 node_modules 树里，profile 必须链到**同一个真实路径**。
  换镜像后软链仍指着上一版镜像的路径 → 插件加载报
  `Cannot find package 'dsh-superagent'`（`ERR_MODULE_NOT_FOUND`），而容器健康检查照样通过。
- **profile 的 patch 层**：它本身是**运行时状态**（在 DSH home 卷上）。只存在于那台机器上的话，
  部署就不可复现——「改配置 → 重启 → 生效」依赖手工编辑状态目录。

解法是把 patch 层变成**仓库里的规范副本** `deploy/superagent-profile.patch.yml`，容器启动时
复制进 profile 目录，**并在同一条命令里建好 bundle 软链**。两条接缝都由启动保证，
不再依赖任何历史手工步骤。

### 3.4 容器里的文件权限：`cap_drop: ALL` 下的两条规则

容器开了 `cap_drop: ALL` → 容器里的 root **没有 `CAP_DAC_OVERRIDE`**，读不了别人拥有的文件：

- **挂进容器的文件必须 644**：0600 且属主是宿主普通用户时，容器里的 root 读不了
  （`EACCES`）——实测在挂进容器的脚本上踩过（`deploy/netns-proxy.mjs` 等）。
- **secret 文件必须 root 拥有**：compose 的 file secret 是 bind mount，宿主文件属主不是 root 时，
  容器里的 root 同样读不到 → 统一 `chown root:root`（权限仍 0600）。

## 4. 把模型从 DeepSeek 换成 MiniMax（DSH 侧四步）

沿的 Super Agent 走 DSH 的 LLM 抽象层，换供应商不碰业务代码：

1. **凭证**：写进 DSH 凭证存储（`$DSH_HOME/.credentials.yaml` 的 `refs` 段），不进环境变量、
   不进 patch、不进日志：

   ```yaml
   version: 1
   refs:
     MINIMAX_API_KEY: sk-…
   ```

2. **路由**：profile patch 里插一行 pi-ai 适配器（`@deepseek-ai/dsh-llm-pi-ai`），声明
   `apiKeyEnv` / `baseURL` / `api: openai-completions` / 模型清单。MiniMax 的 OpenAI 兼容端点是
   `https://api.minimaxi.com/v1`（`api.minimax.io` 用同一把 key 返回 401），模型 id 就是
   `MiniMax-M3.1-Flash`。
3. **默认模型**：`agent-default-model` 一行（`provider: minimax` / `model: MiniMax-M3.1-Flash`）。
   这一行 base 组合里已有，用 `id:` 打补丁即可，不用 `insert:`。
4. **重启 Super Agent**，然后 `GET /orchestrator/api/models` 看 `default`。

Worker（`settings.executor.model`）留空时跟随默认模型。

## 5. 实测数据

| 项 | 值 |
| --- | --- |
| superagent 容器（跑真实模型时） | 366 MiB / 上限 1.5 GiB |
| along-host 容器 | 36 MiB / 上限 512 MiB |
| along-netns 锚点 | 6 MiB / 上限 64 MiB |
| 记忆的 python 进程 | **按需拉起、用完即退**（不常驻），峰值约 230 MiB（Mac 实测口径） |
| 整机内存 | 3.5 GiB，已用 1.8 GiB，可用 1.8 GiB |
| 磁盘 | 40 GB，已用 21 GB，剩 17 GB（hy-memory 依赖树 778 MB 不在镜像里，是独立卷） |
| 一条用户消息 → 目标 + 3 任务 + 提醒 + 回复 | 分钟量级（模型多步规划） |
| 一条含长期偏好的消息 → 记忆提取与治理 | 分钟量级（批次 processed=1、saved=2、attempts=1） |
| 记忆向量 | 百炼 `qwen3.7-text-embedding` / 1024 维（Chroma 集合 `agent_memories_1024`） |
| 对外入口 | `https://8.155.140.214:10531`，LE 链验证通过（`ssl_verify_result=0`） |
| 面板入口 | `https://8.155.140.214:10530`，LE 链验证通过；未带 token 时 401 |

## 6. Hy-Memory 接通（真实模型下跑通）

上一轮只验证了「管道能跑」（offline 探针用合成 HTTP 响应，真实模型质量未验）。本轮把它真正接上，
并用真实模型跑完了一轮记忆提取与治理。

### 6.1 接法

`dsh-superagent` 插件的配置项是 `alongMemory: {python, dataDir, envFile}`：superagent 自己拉起一个
Python 进程跑 bundle 里的 `scripts/along-memory-service.py`（JSONL over stdio）。三件事都要解决：

| 接线点 | 做法 |
| --- | --- |
| python 解释器 | hy-memory 2.0.16 的依赖树是 **cp312 wheel**，Debian 12 只有 3.11 → 镜像里并存 node 与 python3.12：解释器从 `python:3.12-slim-bookworm` **拷运行时**（编译期前缀 /usr/local，拷到同路径即无需 PYTHONHOME），扩展模块缺的三个系统库（libexpat1 / libsqlite3-0 / libgomp1）apt 装，走阿里云镜像 |
| 依赖树 | 778 MB 不进镜像，作为只读卷挂在**解释器的 site-packages** 上：`/usr/local/lib/python3.12/site-packages`。**不能靠 PYTHONPATH**——记忆服务的 spawn 环境是白名单（`PATH/HOME/TMPDIR/LANG/LC_ALL/SSL_CERT_FILE`），`PYTHONPATH` 不会继承，只能挂到解释器默认会找的位置 |
| 供应商配置 | 0600 的 envFile（只放行 `MEMORY_*` 前缀）：LLM 走 MiniMax（chat/completions 本来就是 OpenAI 形状，直接指过去）；embedder 走**阿里云百炼** `text-embedding-v4`（同样原生 OpenAI 形状） |

### 6.2 embedder 用阿里云百炼，天然不需要翻译层

第一版接的是 MiniMax 自己的 `embo-01`，为此写过一个形状翻译垫片（`deploy/embed-shim.mjs`，
本轮已删除）：MiniMax 的 embeddings 是自家形状（请求体要 `texts`、响应是 `vectors`），而
hy-memory 的 embedder **只走 OpenAI 形状**（请求体 `input`、响应 `data[].embedding`）——实测用
`input` 直接报 `missing required parameter texts`。

换成**阿里云百炼**后垫片整个删掉了（容器、文件、compose 服务、令牌 secret 四样）。百炼的
`/compatible-mode/v1` 本来就是 OpenAI 形状，hy-memory 直连。

四个候选的实测对照（同一组样本，本机实测；维度都取 1024）：

| | 协议 | 维度 | 单请求行数 | 1 条延迟 | 单价 | 检索 Top1 | 平均 margin | 最小 margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **百炼 qwen3.7-text-embedding** | OpenAI 兼容 | 1024–2560 可调 | **20** | **159ms** | 0.0005 元/千 Token | **10/10** | 0.359 | **+0.076** |
| 百炼 text-embedding-v4 | OpenAI 兼容 | 64–2048 可调 | 10 | 224ms | 0.0005 元/千 Token | 9/10 | 0.343 | −0.023 |
| 百炼 qwen3.7-text-embedding-flash | OpenAI 兼容 | 固定 1024（要更大维度**静默退回 1024**） | ≥21 | 134ms | 0.000125 元/千 Token | 9/10 | 0.276 | −0.042 |
| MiniMax embo-01 | 自家形状，要翻译层 | 固定 1536 | 512 | 374ms | 公开文档查不到 | 9/10 | 0.637 | −0.229 |

检索的 Top1 与 margin 用同一组 10 组问答算（每组 1 条相关文档 + 3 条干扰，看相关文档是否排在
无关文档前面、差多少）。结论：

- **取 `qwen3.7-text-embedding`**：唯一 10/10 且**最小 margin 为正**（每组都排对，没有贴脸翻车），
  同价、同 1024 维（索引不用重建）、更快、批量上限翻倍。
- **不取 flash**：最便宜，但四个里最弱（平均 margin 最低且有一组翻车）；而且它请求更大维度时
  **静默退回 1024**（官方只支持 1024/768/512/256）——这种静默降级比报错更危险。
- **MiniMax 均值最漂亮但不稳**：平均 margin 0.637 最高，却有一组 −0.229（错得最狠）。均值好看
  不等于每次都对，而记忆检索错一次就等于把一条无关记忆注入对话。
- 价格不是决策因素（每天几十条消息，一年在几分钱），**「Top1 稳不稳」和「账单能不能核实」才是**。

检索按排序工作、默认无分数阈值（`score_threshold=0.0`），余弦基线高低不影响排序；
`merge_threshold=0.95` 只管 **Entity Store**（mem0 风格实体集合，包内没有调用方且 graph 已关），
不是记忆去重路径——所以上面这些差异不落在业务语义上。

### 6.3 端到端验证结果

一句含长期偏好的话（"我习惯 23 点睡，早上 6 点起，家里养了一只猫叫豆豆"）→ 拨快记忆调度
（`maintenance_schedule.next_due_at`）→ 维护批次用真实模型跑完 → 提取出两条长期事实：

```
"我习惯 23 点睡，早上 6 点起"
"家里养了一只猫叫豆豆"
```

批次 `status=done`（processed=1、saved=2），两条记忆都带 `evidence_message_id`（治理分类要求有真实
消息证据才成立）。Hy-Memory 的向量库落盘在 `data/superagent/memory/data/`（1.4 MB）。

换成百炼（v4、`qwen3.7-text-embedding` 各一轮）后用同一句话再跑，结果相同：同样两条事实、同样带
证据、批次 `attempts=1`（第一轮因镜像缺 git 失败过，见 §6.4）。**向量库那一层的直接证据**：
Chroma 集合名是 `agent_memories_1024`、维度 1024（MiniMax 那轮是 1536）→ 确认向量确实来自百炼。

### 6.4 顺带修掉的一个真问题：worker 沙箱没有 git

worker 派工一启动就失败：`Error: spawn git ENOENT`。node 基础镜像里没有 git，而 worker 准备工作目录
时要 spawn 它。**这条与 Hy-Memory 无关，但挡住了所有派工**（上一轮那个「研究型任务」其实也是这么
失败的，只是当时被当成模型问题查了半天）。修法：镜像里 `apt-get install --no-install-recommends git`。

## 7. 远程推送：本部署不启用，走本地提醒 + 前台补收

**结论：不启用 APNs，这是账号能力问题，不是缺个文件。**

Apple 的推送能力（`aps-environment` entitlement）只在**付费的 Apple Developer Program** 团队里
才有。免费 personal team 签出来的描述文件里没有这一项，App 调 `registerForRemoteNotifications()`
拿不到 device token（`ios/AlongHealth/Sources/EventTaskNotifications.swift:86` 每 30 秒重试一次）。
所以这条路在付费之前根本不存在，不是「配一下就能通」。

### 7.1 手机侧现在的实际语义

| 提醒类型 | 现在能不能准点收到 | 机制 |
| --- | --- | --- |
| 每日续排提醒、任务到期提醒 | ✅ 能 | App 自己排程的**本地通知**（`UNUserNotificationCenter`，`ios/AlongHealth/Sources/AlongShellView.swift:963`），与苹果账号无关 |
| 服务器新产生的推荐 / 任务结果 | ❌ 挂起时收不到 | 要靠服务器推送（APNs）；现在等你**下次打开 App 同步时补收** |

同步页里的 `remoteNotifications` 字段就是这条语义的标志：`host/task-notifications.mjs:121` 用
`active(who)` 回答「远程通道有没有」，`web/event-workspace.mjs:411` 据此决定这条提醒是服务器推、
还是 App 本地补一条。本部署实测：同步页返回 `remoteNotifications: false` → App 走本地排程 ✓。

### 7.2 配 APNs 需要的，和为什么绕不开

三样东西都在 Apple Developer 后台，不在 Along 里：`.p8` 私钥（**只能下载一次**）、Key ID、Team ID。
而且 `.p8` 必须和**签 AlongHealth 那个 App 的团队是同一个**——`host/apns.mjs:6` 的 topic 硬编码
`com.artstur.along`，需要与签名包的 Bundle ID 匹配。

**第三方推送服务（个推 / 极光 / OneSignal / 阿里云移动推送）也绕不开**：它们在 iOS 上同样是转手
APNs，只是替你做签名、token 管理、失效重注册与送达回执——那 $99 省的只是开发量，不是费用。

### 7.3 将来开了付费账号怎么接（步骤已经写好）

1. App 用**带推送能力的描述文件**重签并安装（免费 profile 不行）；
2. Apple 后台建一把 APNs key → 下载 `.p8` → 放到 `secrets/apns-key.p8`（0600）；
3. 编排里加回三处引用（`deploy/docker-compose.cloud.yml` 的 host 服务）：

   ```yaml
   ALONG_APNS_KEY_FILE: /run/secrets/apns-key
   ALONG_APNS_TEAM_ID: "<10 位>"
   ALONG_APNS_KEY_ID: "<10 位>"
   # 并把 apns-key 加进该服务的 secrets 列表（file secret 缺失会让 compose up 直接报错）
   ```

4. 重启 Host → 验收：App 启动后 `data/host/notification-device.<userId>.json` 出现 token →
   定时任务到期时手机弹「Along 任务提醒」。

**注意 `environment` 必须与 App 的签名环境一致**（开发包 `development`、发布包 `production`）——
沙箱与正式是两条独立链路。另外 `Info.plist` 的 `UIBackgroundModes` 只有 `fetch`、没有
`remote-notification` → **alert 推送能弹横幅，但静默推送（后台唤醒 App）不工作**。

## 8. 已知限制（本轮未覆盖 / 不适用）

- **iOS 是否信任 LE 的新根**（ISRG Root YE / X2）取决于手机系统版本。宿主 CA 验证是 OK 的，
  老 iOS 可能不认；退路是仓库原生的私有 CA 描述文件方案
  （`tools/ca-profile.mjs profile` 生成 `.mobileconfig` 装到手机），材料已备好。
- **经 nginx 后 Host 看到的客户端 IP 是 127.0.0.1**：`host/agent-host.mjs` 只用 socket 地址，
  不读 `X-Forwarded-For`。所以 `/pair` 的按来源失败分桶实际上是全局的。单用户自用无妨。
- **APNs 未启用且不是缺凭证**：Apple 的推送能力要付费开发者团队，免费 personal team 的描述文件里
  没有 `aps-environment`，App 拿不到 device token（详见 §7）。现在的缺口只有一类：**服务器新产生
  的推荐 / 任务结果在 App 挂起时收不到**，要等下次前台同步补收；App 自己排程的每日提醒与到期提醒
  不受影响。
- **Hy-Memory 已接上，但只验过一轮**：单条消息、两个事实的规模。真实模型下的**记忆质量**
  （分类是否准确、有没有把临时表述误当长期偏好、冲突与更正的裁决）没有系统验收——仓库口径里
  记忆治理的判定标准很严，本轮只证明「链路通、结果合理」。
- **Hy-Memory 的 python 进程按需拉起**（用完即退），不是常驻；峰值 ~230 MB（Mac 实测口径），
  所以本机内存仍有余量，但它与定时维护批次同时跑时要注意。
- **embedder 的选择理由与百炼无关的部分**：百炼的 `text-embedding-v4` 每次最多 10 条（记忆服务脚本
  的 `batch_size=10` 正是照它调的），单请求超 10 条会报 `batch size is invalid`；量大时要改批次策略。
- **百炼的向量质量只验过 10 组样本**：测的是 Top1 排序与 margin，没做过规模化检索压测，也没测过
  中文长文本与多轮对话语境下的表现。
- **网页 UI 不在云端形态内**：`host/agent-host.mjs` 只提供 API，静态页面由 `host/server.mjs`
  提供（Mac 形态）。iPhone App 是自带 UI 的原生壳，不依赖网页。
- **worker 的 bash 沙箱在 Linux 上只验过启动**：git 缺失已修，但真实的文件/命令执行行为没有系统验收。

## 9. 运维命令

```sh
cd /home/ecs-user/workspace/along      # 这台机的布局；仓库的规范布局是 /opt/along/along

# 启 / 更新
docker compose -f deploy/docker-compose.cloud.yml up -d

# 锚点被动过之后（一次性重建三个，理由见 §2.3）
docker compose -f deploy/docker-compose.cloud.yml up -d --force-recreate anchor superagent host

# 配对码（8 位一次性码，15 分钟有效，不进容器日志）
docker exec along-host node host/pair-code.mjs u_1a2b3c4d

# 吊销某用户的绑定
docker exec along-host node host/pair-code.mjs --revoke u_1a2b3c4d

# 立即跑一次记忆维护（平时是每天 03:00）：把调度拨到过去
docker exec along-superagent node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("/var/lib/along/data/along.sqlite");
db.prepare("UPDATE maintenance_schedule SET next_due_at=? WHERE user_id=?")
  .run(new Date(Date.now()-60000).toISOString(),"u_1a2b3c4d");'

# 看状态 / 日志
docker compose -f deploy/docker-compose.cloud.yml ps
docker logs -f along-host
```

## 10. 每小时检查主干并自动部署（2026-11-27 实测）

在这台机（`ecs-user@8.155.140.214`）上跑一个 systemd 定时器，每小时检查
`artstur/along` 与 `artstur/along-superagent` 的 `main`；有更新就拉取、构建、切换，
没更新就什么都不做。产物在 `deploy/auto-deploy.sh` 与同目录的单元文件，
装法与运维命令见 [deploy/README.md 的定时自动部署一节](../deploy/README.md#定时自动部署每小时检查主干并部署)。

### 现场的既有形态（先只读核对过）

| 项 | 实测值 |
| --- | --- |
| 工作区 | `/home/ecs-user/workspace/{along,along-superagent,data,secrets}` |
| Compose 项目名 | `deploy`（project directory 是 `deploy/`，项目名取目录名） |
| 容器 | `along-host`（`along-host:cloud`）、`along-superagent`（`along-superagent:local`）、`along-netns`（锚点） |
| 凭证 | `secrets/{runner-token,memory-env}` 与 `data/superagent/along/data/bridge-token`，file secret，root 属主 0600 |
| 仓库访问 | `ecs-user` 的 `~/.ssh/id_ed25519` 能读两个仓库（`git ls-remote` 实测通过） |
| 调度 | 装之前机器上只有 `dnf-makecache` / `logrotate` 等系统定时器，没有别的 Along 调度 |

### 装好之后的位置

| 位置 | 内容 |
| --- | --- |
| `/usr/local/libexec/along/auto-deploy.sh` | 部署器本体（root 属主，0755） |
| `/etc/systemd/system/along-auto-deploy.{service,timer}` | 单元（`User=ecs-user`） |
| `/etc/along-auto-deploy.env` | 配置（只有路径与版本来源，没有凭证） |
| `/home/ecs-user/workspace/.auto-deploy/` | 成功版本记录、版本台账、部署锁 |
| `/home/ecs-user/workspace/release/<两个 SHA 前 12 位>/` | 每个版本的干净源码树 |

### 实测口径

| 项 | 值 |
| --- | --- |
| 定时器 | `OnCalendar=hourly` + 随机延迟 5 分钟；实测下一次触发 `06:02:12 CST` |
| 一轮完整部署（缓存命中时） | 约 70 秒：构建 ~60 秒，切换 ~30 秒，探活 ~30 秒 |
| 无更新的一轮 | 只做 fetch 与 `ls-remote`（约 15 秒），不构建不重启 |
| 磁盘 | 每个 Super Agent 镜像约 2.41 GB；发布目录与镜像按版本台账保留两份 |

### 三个必须知道的点

**一、锚点每轮都会被重建，这不是副作用。** 编排里的相对路径（`./netns-proxy.mjs`、
`./superagent-profile.patch.yml`）落在发布目录上，与现场 checkout 的路径不同，
compose 的配置指纹因此变了，锚点本来就会被重建。而命名空间跟着持有它的容器走
（§2.3），所以锚点与两个使用方必须在同一次操作里一起重建——
`up -d --no-build --force-recreate anchor superagent host` 就是 §2.3 那条命令。
实测顺序：锚点 → Super Agent → Host，三个都起来后探活通过。

**二、镜像必须带标签，否则回退就断了。** 第一版用 `docker image prune --filter
until=2h` 清悬空镜像，结果把**上一成功版本**的镜像一起删了——它们没有标签就是悬空的。
现在改成：每个版本在台账里记镜像 ID 与版本化标签，清理时**只按台账删自己的镜像**，
不跑全局 prune（同机还有 Multica 的镜像，不能连坐）。这条是踩出来的。

**三、卷与凭证一个字节都没动，靠的是发布目录里的符号链接。** `release/<id>/data` 与
`release/<id>/secrets` 是指向工作区真实目录的符号链接，所以 compose 的 `../../data`、
`../../secrets` 落在同一份持久卷与凭证上；清理发布目录时 `rm -rf` 不会跟着符号链接
删到真实数据（实测确认过）。切换前还会把 `docker compose config` 解析出来的卷、凭证、
构建输入路径逐条核对一遍——相对路径配错是静默降级，不能靠肉眼。
