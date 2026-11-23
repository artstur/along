# Along Host 云端部署经验（Linux，阿里云 ECS）

> 2026-11-23 实测。环境：阿里云 ECS（2 核 / 3.5 GB / 40 GB 磁盘），Alibaba Cloud Linux 4，Docker 29.10.0 / Compose v5.8.0。
> **本文只记录实测事实与踩过的坑，不重复部署编排** —— 编排在本轮新增的
> `deploy/docker-compose.cloud.yml`、`deploy/Dockerfile.host.cloud`、`deploy/netns-proxy.mjs`；
> Super Agent 侧的前置实测见[Superagent 云端部署经验](superagent-cloud-deploy.md)。
>
> 与[云端部署与多用户方案](cloud-deploy-multi-user.md)的关系：那份是设计（§3.5 的 Tier 1/Tier 2 划分
> 保留为历史设计），本文是 Linux 上真正跑起来的那一版。

## 1. 结论

**云端栈跑通了。** 一句自然语言（"我想改善睡眠，希望每晚睡够七小时"）经 iPhone → Host →
Along Agent → MiniMax 后，自动建出目标《改善睡眠，每晚睡够七小时》、拆出 3 个任务、约了每天
22:30 的睡前提醒，并回了一条说明消息。目标、任务、消息在容器重建后仍在（bind 卷持久化）。

成品的形状是三个容器 + 宿主 nginx：

```
iPhone ──https──▶ 宿主 nginx:10531（Let's Encrypt IP 证书）
                     └─▶ 127.0.0.1:4176 ─▶ along-host（私 CA 自签 HTTPS，对内）
                                          └─▶ 127.0.0.1:3082 ─▶ along-superagent
```

外加一个 `along-netns` 锚点容器，只为持有共享网络命名空间（见 §3.3）。

## 2. 三个硬约束，以及各自绕不过去的解法

这三处都不是"改个配置就能过"，每一条都有代码或运行时上的硬要求，绕过就等于破坏仓库的安全边界。

### 2.1 对外与对内必须用两套证书

Host 的云端证书校验器（`host/tls-material.mjs:182-188`）要求**根证书直接签叶证书**，且证书链
逐级可验、链尾自签。Let's Encrypt 的 IP 证书链是「叶 ← LE YE2 ← ISRG Root YE ← ISRG Root X2」，
根并不直接签叶——整条塞进 Host 必然在监听前被拒启。

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
cd /opt/along/along
docker compose -f deploy/docker-compose.cloud.yml up -d --force-recreate anchor superagent host
```

## 3. 修掉的两个真 bug

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
| superagent 容器（跑真实模型时） | 348 MiB / 上限 1.5 GiB |
| along-host 容器 | 23 MiB / 上限 512 MiB |
| along-netns 锚点 | 1.5 MiB / 上限 64 MiB |
| 整机内存 | 3.5 GiB，已用 1.6 GiB，可用 1.9 GiB |
| 磁盘 | 40 GB，剩 17 GB（宿主镜像 4.3 GB + 构建缓存） |
| 一条用户消息 → 目标 + 3 任务 + 提醒 + 回复 | 分钟量级（模型多步规划） |
| 对外入口 | `https://8.155.140.214:10531`，LE 链验证通过（`ssl_verify_result=0`） |

## 6. 已知限制（本轮未覆盖 / 不适用）

- **iOS 是否信任 LE 的新根**（ISRG Root YE / X2）取决于手机系统版本。宿主 CA 验证是 OK 的，
  老 iOS 可能不认；退路是仓库原生的私有 CA 描述文件方案
  （`tools/ca-profile.mjs profile` 生成 `.mobileconfig` 装到手机），材料已备好。
- **经 nginx 后 Host 看到的客户端 IP 是 127.0.0.1**：`host/agent-host.mjs` 只用 socket 地址，
  不读 `X-Forwarded-For`。所以 `/pair` 的按来源失败分桶实际上是全局的。单用户自用无妨。
- **没配 Hy-Memory**（走 SQLite 降级）、**没配 APNs**（没有远程推送）、
  **面板 10530 未放行到公网**（只在本机可达）。
- **worker 的 bash 沙箱在 Linux 上未验证**：研究型任务的实际派工执行还没跑过。
- **网页 UI 不在云端形态内**：`host/agent-host.mjs` 只提供 API，静态页面由 `host/server.mjs`
  提供（Mac 形态）。iPhone App 是自带 UI 的原生壳，不依赖网页。
- **模型仍是 DeepSeek 语义之外的第一方适配**：`dsh-llm-pi-ai` 这条路可用，但 MiniMax 的
  工具调用与长上下文行为没有系统验收，只验证了目标/任务创建这条主链路。

## 7. 运维命令

```sh
cd /opt/along/along

# 启 / 更新
docker compose -f deploy/docker-compose.cloud.yml up -d

# 锚点被动过之后（一次性重建三个，理由见 §2.3）
docker compose -f deploy/docker-compose.cloud.yml up -d --force-recreate anchor superagent host

# 配对码（8 位一次性码，15 分钟有效，不进容器日志）
docker exec along-host node host/pair-code.mjs u_1a2b3c4d

# 吊销某用户的绑定
docker exec along-host node host/pair-code.mjs --revoke u_1a2b3c4d

# 看状态 / 日志
docker compose -f deploy/docker-compose.cloud.yml ps
docker logs -f along-host
```
