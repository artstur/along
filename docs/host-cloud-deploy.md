# Along Host 云端部署经验（Linux，阿里云 ECS）

> 2026-11-23 实测。环境：阿里云 ECS（2 核 / 3.5 GB / 40 GB 磁盘），Alibaba Cloud Linux 4，Docker 29.10.0 / Compose v5.8.0。
> **本文只记录实测事实与踩过的坑，不重复部署编排** —— 编排在本轮新增的
> `deploy/docker-compose.cloud.yml`（锚点 + superagent + host + embeddings 垫片）、
> `deploy/Dockerfile.host.cloud`、`deploy/Dockerfile.superagent`、`deploy/netns-proxy.mjs`、
> `deploy/embed-shim.mjs`、`deploy/superagent-profile.patch.yml`；
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

成品的形状是三个容器 + 一个翻译垫片 + 宿主 nginx：

```
iPhone ──https──▶ 宿主 nginx:10531（Let's Encrypt IP 证书）
                     └─▶ 127.0.0.1:4176 ─▶ along-host（私 CA 自签 HTTPS，对内）
                                          └─▶ 127.0.0.1:3082 ─▶ along-superagent
                                                                  └─▶ 127.0.0.1:3090 ─▶ along-embed-shim
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
  （`EACCES`）——实测在 `deploy/netns-proxy.mjs` 与 `deploy/embed-shim.mjs` 上各踩一次。
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
| along-embed-shim 垫片 | 13 MiB / 上限 64 MiB |
| along-netns 锚点 | 6 MiB / 上限 64 MiB |
| 记忆的 python 进程 | **按需拉起、用完即退**（不常驻），峰值约 230 MiB（Mac 实测口径） |
| 整机内存 | 3.5 GiB，已用 1.8 GiB，可用 1.8 GiB |
| 磁盘 | 40 GB，已用 21 GB，剩 17 GB（hy-memory 依赖树 778 MB 不在镜像里，是独立卷） |
| 一条用户消息 → 目标 + 3 任务 + 提醒 + 回复 | 分钟量级（模型多步规划） |
| 一条含长期偏好的消息 → 记忆提取与治理 | 分钟量级（批次 processed=1、saved=2） |
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
| 供应商配置 | 0600 的 envFile（只放行 `MEMORY_*` 前缀）：LLM 走 MiniMax（chat/completions 本来就是 OpenAI 形状，直接指过去）；embedder 见下 |

### 6.2 MiniMax 的 embeddings 要一层翻译

hy-memory 的 embedder **只走 OpenAI 形状**（请求体 `input`、响应 `data[].embedding`），
MiniMax 的 embeddings 是自家形状（请求体要 `texts`、响应是 `vectors`）——实测用 `input` 直接报
`missing required parameter texts`。`embo-01` 的向量是 **1536 维**。

解法是一个只做形状翻译的垫片（`deploy/embed-shim.mjs`）：`{model, input}` → MiniMax
`{model:'embo-01', texts, type:'db'}` → `{object:'list', data:[...]}`。它与 superagent 同在锚点的
命名空间里，只监听回环 3090，不对外发布；调用令牌与 MiniMax key 分开存（embedder 侧的 API key 是
垫片令牌，垫片自己再拿真 key 去调上游）。

### 6.3 端到端验证结果

一句含长期偏好的话（"我习惯 23 点睡，早上 6 点起，家里养了一只猫叫豆豆"）→ 拨快记忆调度
（`maintenance_schedule.next_due_at`）→ 维护批次用真实模型跑完 → 提取出两条长期事实：

```
"我习惯 23 点睡，早上 6 点起"
"家里养了一只猫叫豆豆"
```

批次 `status=done`（processed=1、saved=2），两条记忆都带 `evidence_message_id`（治理分类要求有真实
消息证据才成立）。Hy-Memory 的向量库落盘在 `data/superagent/memory/data/`（1.4 MB）。

### 6.4 顺带修掉的一个真问题：worker 沙箱没有 git

worker 派工一启动就失败：`Error: spawn git ENOENT`。node 基础镜像里没有 git，而 worker 准备工作目录
时要 spawn 它。**这条与 Hy-Memory 无关，但挡住了所有派工**（上一轮那个「研究型任务」其实也是这么
失败的，只是当时被当成模型问题查了半天）。修法：镜像里 `apt-get install --no-install-recommends git`。

## 7. 已知限制（本轮未覆盖 / 不适用）

- **iOS 是否信任 LE 的新根**（ISRG Root YE / X2）取决于手机系统版本。宿主 CA 验证是 OK 的，
  老 iOS 可能不认；退路是仓库原生的私有 CA 描述文件方案
  （`tools/ca-profile.mjs profile` 生成 `.mobileconfig` 装到手机），材料已备好。
- **经 nginx 后 Host 看到的客户端 IP 是 127.0.0.1**：`host/agent-host.mjs` 只用 socket 地址，
  不读 `X-Forwarded-For`。所以 `/pair` 的按来源失败分桶实际上是全局的。单用户自用无妨。
- **没配 APNs**（没有远程推送）：要 Apple Developer 的 p8 私钥 + 10 位 team id + 10 位 key id，
  topic 硬编码 `com.artstur.AlongHealth`，且 iOS App 必须带推送 entitlement 重新签名。
- **Hy-Memory 已接上，但只验过一轮**：单条消息、两个事实的规模。真实模型下的**记忆质量**
  （分类是否准确、有没有把临时表述误当长期偏好、冲突与更正的裁决）没有系统验收——仓库口径里
  记忆治理的判定标准很严，本轮只证明「链路通、结果合理」。
- **Hy-Memory 的 python 进程按需拉起**（用完即退），不是常驻；峰值 ~230 MB（Mac 实测口径），
  所以本机内存仍有余量，但它与定时维护批次同时跑时要注意。
- **embeddings 只能走 MiniMax**：垫片只翻译形状，不做缓存与降级；MiniMax 的 embeddings 接口形状或
  模型名变了，垫片要跟着改。
- **网页 UI 不在云端形态内**：`host/agent-host.mjs` 只提供 API，静态页面由 `host/server.mjs`
  提供（Mac 形态）。iPhone App 是自带 UI 的原生壳，不依赖网页。
- **worker 的 bash 沙箱在 Linux 上只验过启动**：git 缺失已修，但真实的文件/命令执行行为没有系统验收。

## 8. 运维命令

```sh
cd /home/ecs-user/workspace/along      # 这台机的布局；仓库的规范布局是 /opt/along/along

# 启 / 更新
docker compose -f deploy/docker-compose.cloud.yml up -d

# 锚点被动过之后（一次性重建四个，理由见 §2.3）
# 垫片也在锚点的命名空间里（它只监听回环 3090），锚点换了命名空间它同样会被落下
docker compose -f deploy/docker-compose.cloud.yml up -d --force-recreate anchor superagent host embed-shim

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
