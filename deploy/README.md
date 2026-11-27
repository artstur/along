# deploy/ — Along 云端部署产物

先按目标选择编排，不把不同形态的证书、路径或版本来源混用：

- **Tier 1 兼容路径**：`docker-compose.yml`，事件接入关闭，按[多用户 Runbook §6.4](../docs/cloud-deploy-multi-user.md#64-上线-runbook由用户手动执行)。
- **Tier 2 事件工作区**：基础 Compose 加 `docker-compose.tier2.yml`，按[开启与回退 §6.5](../docs/cloud-deploy-multi-user.md#tier2-runbook)。固定公网 IPv4 按下文[独立运维步骤](#固定公网-ipv4-直连)。
- **Linux 实测栈**：`docker-compose.cloud.yml` 是独立三容器编排，不是叠加文件；其端口、宿主 nginx、证书与卷按 [Host 云端部署经验](../docs/host-cloud-deploy.md) 核对。该文件的 `ALONG_SUPERAGENT_SOURCE` 默认取相邻 checkout；复现时显式指定经验证的提交，不把本地 HEAD 当固定版本。

已有个人事件工作区要保全历史和待发时，按[冷交接契约](../docs/personal-workspace-handoff.md)处理；不要把初次发码和普通重新配对当成迁移步骤。

## 文件清单

| 文件 | 内容 |
| --- | --- |
| `Dockerfile.host` | Host 镜像包含 Node 22、生成证书所需的 OpenSSL、锁文件锁定的 npm 生产依赖、Host 模块与 web 共享依赖。 |
| `Dockerfile.agent` | agent 镜像：node:24-bookworm-slim + `@deepseek-ai/dsh@0.2.2-rc.5`（版本写死 pin，engines node>=24.9.0）；携带 `deploy/agent-runner.mjs`（M3）与其 import 的 `web/{super-agent,goal-agent-core,contextual-planning}.mjs`；经 `additional_contexts` 预置 along bundle |
| `Dockerfile.superagent` | Tier 2 长驻镜像：同一个 node:24 摘要与同一份 dsh 锁文件；携带 **bundle 编译产物** `lib/`（V-1 的 ERR_MODULE_NOT_FOUND 根因就是只配层不装包）；入口 `deploy/superagent-start.sh` |
| `docker-compose.yml` | 编排：host 443→4176、agent `agent:3088` 仅 compose 内网（不发布端口）、bind 卷 `../../data/host:/data`、compose secrets（runner-token 两服务共用） |
| `docker-compose.public-ip.yml`、`nginx/` | Tier 2 公网 IPv4 入口及 HTTP-01 |
| `public-ip-certificate.py` | 首次签发、定期续期、nginx 校验证书和失败回退 |
| `superagent-start.sh` | Tier 2 启动脚本：铺 profile、把 bundle 链进 `profile/node_modules`、绑 `127.0.0.1:3082`、播种设置，然后 exec 常驻 dsh |
| `superagent-seed.mjs` | Tier 2 设置播种：第一次 boot 之前把「Along Source 开、GitHub Source 关」写进编排库（`assembleAlong` 读的是已存好的设置）；已有设置时不覆盖 |
| `superagent-preset-lockdown.mjs` | Tier 2 读取面收紧：推导出去掉文件/shell/终端/文档/子代理能力后的 preset 覆盖行（读上游自己的 patch 推导，不抄一份）；推导结果为空即拒绝启动 |
| `env.example` | environment 段非敏感参考值（必改项：`ALONG_TLS_CN` 换真实域名） |
| `Dockerfile.host.cloud` | 云端 Host 镜像（Linux 实测形态）：node:24 基础镜像、**不装 openssl**（云端证书是预签发材料，由 `node:crypto` 加载校验）；整目录 COPY `web/` |
| `docker-compose.cloud.yml` | 云端栈编排（Linux 实测形态）：`anchor` + `superagent` + `host` 三服务。命名空间由**第三方锚点容器**持有，host 与 superagent 都加入它（桥接只接受回环端点；命名空间若由任一方持有，对方一重启就被静默落下）；两个服务的健康检查探锚点跳板，落下即自愈 |
| `netns-proxy.mjs` | 锚点里的裸 TCP 跳板：`0.0.0.0:3083 → 127.0.0.1:3082`，让宿主够得到绑回环的 DSH 管理面 |
| `nginx/along-10531.conf` | 云端对外入口：TLS 在宿主 nginx 用 Let's Encrypt IP 证书终结，反代到 Host（对内是私 CA 自签叶证书——`host/tls-material.mjs` 要求根直接签叶，LE 链不满足） |
| `superagent-profile.patch.yml` | Super Agent profile 的 patch 层**规范副本**：容器启动时复制进 profile 目录，所以「改配置 → 重启 → 生效」不依赖手工编辑状态目录。含 Hy-Memory 接线（`alongMemory`）与 MiniMax 路由 |
| `../.dockerignore` | 两个主构建上下文都用仓库根目录的白名单，只放行 npm 清单、Host 模块及任务协议、web 模块和 runner 入口。 |
| `agent-runner.mjs` | 内网 HTTP runner，使用 Along 专用 DSH profile；模块自检 `node --check deploy/agent-runner.mjs` |
| `agent-dsh/` | dsh 安装清单：`package.json` + `package-lock.json` 锁定 `@deepseek-ai/dsh@0.2.2-rc.5`，镜像内 `npm ci --ignore-scripts` 安装。升级 dsh 版本时在本目录 `npm install --package-lock-only --ignore-scripts` 重新生成 lock 并入库，同时同步 `Dockerfile.agent` 的 pin 与 compose 的 `ALONG_DSH_VERSION` |
| `auto-deploy.sh` | 部署器：检查 Along 与 Super Agent 的 `main`，有更新就构建并切换，切换后探活失败回退到上一成功版本。调度由 Multica 的每小时 wakeup 驱动，它调起目标机上的一次性入口。见下文[自动部署](#自动部署每小时检查主干并部署) |
| `auto-deploy-install.sh` | 把部署器装到目标机（脚本进 `/usr/local/libexec/along/`，unit 进 `/etc/systemd/system/`，配置进 `/etc/along-auto-deploy.env`）。**不装定时器**——调度归 Multica |
| `along-auto-deploy.service` | systemd 单元：一次性部署入口（`sudo systemctl start along-auto-deploy.service`）。**没有 timer**——调度归 Multica |
| `auto-deploy.env.example` | 部署器配置模板（路径与版本来源，不含凭证） |
| `../test/auto-deploy-integration.test.mjs` | 部署器的隔离集成验证（`ALONG_AUTO_DEPLOY_INTEGRATION=1` 开启）：部分切换回退、同秒等长改动、解包失败重试 |

## Tier 2：长驻 Super Agent（§3.5，验证项 V-1）

Tier 1 的 `agent` 服务跑**一次性** headless runner（每个目标聊天请求拉起一个 dsh 进程）。
Tier 2 增加 `superagent` 服务跑**长驻** DSH profile，承载新链路数据面：
`/along-source/api/*`、`along.sqlite`、投递泵。两个服务共用同一份 dsh 锁文件，版本不分叉。

### 网络

Host 和 Super Agent 共用 `netns` 的网络命名空间。锚点发布 443，Super Agent 只在回环 3082 监听。

### 持久卷与桥接凭证

| 路径 | 内容 |
| --- | --- |
| `../../data/superagent:/var/lib/along-superagent` | 编排库（`engine/orchestrator.sqlite`）与业务库（`along/along.sqlite`） |
| `../../data/dsh-home:/var/lib/dsh` | DSH home：profile、凭证文件、会话持久化 |

桥接凭证是**同一份** 0600 的 32 字节 hex 文件：Host 用 `ALONG_BRIDGE_TOKEN_FILE` 读，
Super Agent 用 profile 的 `alongBridgeTokenFile` 读，两侧必须指向同一个宿主文件。
compose 里两侧都挂 `bridge-token` secret（源文件 `../../secrets/bridge-token`），
容器内挂载点都是 `/run/secrets/bridge-token`。

**两侧 token 必须一致**：文件不存在时 Super Agent 会自己生成一份（`bridgeTokenOf` 的
ENOENT 分支），Host 那份就永远对不上，桥接调用全量 401。所以凭证本体由宿主文件提供，
容器不生成。

### 开启、锚点维护、换证与回退

按 [部署手册 §6.5](../docs/cloud-deploy-multi-user.md#tier2-runbook) 操作。开启时叠加 `docker-compose.tier2.yml`，以 `ALONG_EVENT_INGEST=on` 启用事件链路。维护锚点使用 `deploy/tier2-stack.sh rebuild-anchor`。换叶保留叠加文件，只重建 Host。回退先停 Super Agent 和锚点，再用主 Compose 重建 Host，恢复 `ALONG_EVENT_INGEST=off` 并保留持久卷。

### 就绪判定

Host 通过私有回环探测 `/along-source/api/goals/along-status-probe`，带桥接凭证和绑定身份。只发一次 GET，收到 `200 {"service":"along-source","ready":true}` 才就绪。上游 `404` 和其他未就绪结果归入 Host 的 `503`，`401/403` 附带配置提示。

### 上游来源是钉死的提交

基础 Compose 中两个镜像的构建输入都取
`${ALONG_SUPERAGENT_SOURCE:-https://github.com/artstur/along-superagent.git#<40 位提交>}`，
**不指向相邻 checkout 的工作区**：那个 HEAD 是可变的，运维切个分支镜像就跟着变，
而旧版探针恒答 200，Host 侦测不到装错版本——镜像里若是没有就绪修复的 bundle，
重启时已到期的待投递行仍会被终结为 `filtered / source_not_installed`。
本地对着未推送的提交调试时用 `ALONG_SUPERAGENT_SOURCE` 指向相邻 checkout。

### 会话权限

Tier 2 只启用 Along Worker 和 Router。启动脚本生成 preset 覆盖并校验最终 DSH 配置，失败即退出。应用继续按用户与任务约束 Along 业务工具。

### 命名空间锚点

Tier 2 叠加文件里的 `netns` 服务只持有一个网络命名空间，`host` 与 `superagent` 都加入它
（Super Agent 硬性要求 `webserver.host === '127.0.0.1'`，只能监听回环）。
锚点与两个服务都无关，所以**只重建 host 时 superagent 不会留在旧命名空间里**
（旧形态 `network_mode: "service:host"` 会：新 host 访问 `127.0.0.1:3082` 得到 `ECONNREFUSED`）。
443 的发布也声明在锚点上——加入他人命名空间的容器不能自己发布端口，
而命名空间是共享的，映射进的是同一个命名空间。

## 已知边界

- 本节的长驻编排已在隔离 Linux Compose 环境验证（合成双用户 + 隔离测试 CA）；
  真实模型回合、APNs、双 iPhone 与生产拓扑仍待验。
- `superagent` 服务目前不接模型密钥之外的凭证；模型密钥走 **file secret**
  （`model-credentials`，挂到 `/run/secrets/model-credentials`），由启动脚本读出后注入进程
  环境——不进 compose 的 `environment`（那会进 `compose config` 的输出与容器元数据）、
  不进镜像层、不进日志（§3.7）。权限过宽（组/其他可读）即拒绝启动。

### 怎么复现那次隔离验证

```sh
# 默认不跑（要构建镜像、起容器，耗时）。用环境变量显式开启：
ALONG_TIER2_INTEGRATION=1 node --test test/tier2-linux-integration.test.mjs

# 对着 Super Agent 的某个分支验（默认是相邻仓库）：
ALONG_TIER2_SUPERAGENT_REPO=/path/to/along-superagent \
  ALONG_TIER2_INTEGRATION=1 node --test test/tier2-linux-integration.test.mjs
```

用例覆盖：TLS 入口 → 双用户事件同步与隔离 → 后台投递到编排 Engine → 重启恢复
（重启前已到期的待投递行必须恢复投递，不得变成 `filtered`）。
失败时用 `ALONG_TIER2_KEEP=1` 保留现场（容器与库留在 `.tier2-integration/`）看日志。

该用例对 Super Agent 的「Source 注册前不领取队列」修复是**敏感的**：拿未修复的
Super Agent 跑，它会在重启恢复那一步失败并报 `filtered / source_not_installed`——
这正是 V-1 暴露的原始故障面。

## 路径基准（配错 = 静默降级，§3.1）

compose 的 project directory = 本文件所在目录 `deploy/`，因此：

- `../../data/host` → `/opt/along/data/host`（bind 到容器 `/data`）。**卷挂到空目录只会静默落空**：host 以本地单用户模式启动并在日志打通用码；冒烟时必须核对 `/data/users.json` 可见。
- `../../secrets/*` → `/opt/along/secrets/*`。file secret 指向不存在的文件是 `docker compose up` 的**硬错误**（不会静默降级）。
- `additional_contexts: {along: ../../along-superagent}` → 相邻仓库布局 `/opt/along/along-superagent`。注意 compose 对 additional_contexts 的相对路径按 project directory（deploy/）解析，与 volumes/secrets 同基准；手工 `docker build --build-context` 则从 cwd=仓库根解析（写 `../along-superagent`）。

## 构建与启动

```sh
cd /opt/along/along          # 仓库根；相邻有 ../along-superagent
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d
```

手工等价的 agent 构建（cwd=仓库根）：`docker build --build-context along=../along-superagent -f deploy/Dockerfile.agent . -t along-agent:local`——位置参数必须是 `.`（仓库根）。

**不部署远程通知**：先删 `docker-compose.yml` 里 apns-key 的三处引用（host `environment` 的 `ALONG_APNS_KEY_FILE`/`ALONG_APNS_TEAM_ID`/`ALONG_APNS_KEY_ID`、host `secrets` 列表的 `apns-key`、顶层 `secrets.apns-key` 定义），再 `up`；否则 file secret 缺失直接报错。provider 未创建只是远程通知不可用（`host/apns.mjs:8-14`），其余功能不受影响。

## 冒烟（验收 #5；Runbook §6.4 第 5 步）

1. `docker logs along-host`：看到 `Along 服务: https://0.0.0.0:4176`（`ALONG_AGENT_HOST=0.0.0.0` 生效——容器内没有 en0，缺 env 会回退绑 127.0.0.1、443 打不通）、证书 SHA-256 指纹与到期时间。云端形态另有一行「云端 CA 叶证书版本: `<serial>`」。**云端不再自签**：指纹是叶证书的公开摘要，不是 iPhone 配对表单的输入——手机按系统信任评估连入。
   - 上线前先确认证书材料已就位：状态目录下 `tls/current` 是指向 `tls/releases/<serial>/` 的符号链接，该目录含 `fullchain.pem`、`key.pem`（0600）、`root.crt`（公开根），目录 0700。缺证、SAN 不覆盖 `ALONG_TLS_CN`、链不可验签、私钥不匹配或权限过宽，Host 都会在监听前退出。
   - 描述文件与带外核验用 `node tools/ca-profile.mjs profile|verify`（见 [CA 方案](../docs/iphone-ca-profile-design.md) §3.2/§4.1）。根私钥不在这台机器上。
2. `docker exec along-host sh -c 'ls -l /data/users.json'`：可见（卷没挂错、多用户形态生效）。
3. 宿主机 `curl -k https://127.0.0.1/health`：200。
4. `docker exec along-agent node -e "fetch('http://127.0.0.1:3088/health').then(r=>r.json()).then(console.log)"`：返回 ready。
5. 通过 runner 发送一次无私密内容的任务，并查询该请求直到返回 `done`。此步骤覆盖实际读取模型凭证、启动 DSH 和接收模型结果。

   ```sh
   docker exec -i along-agent node <<'NODE'
   const {readFileSync} = require("node:fs");
   const {randomUUID} = require("node:crypto");
   const {setTimeout: delay} = require("node:timers/promises");
   const base = "http://127.0.0.1:3088";
   const userId = "smoke";
   const requestId = randomUUID();
   const headers = {"runner-token": readFileSync(process.env.ALONG_RUNNER_TOKEN_FILE, "utf8").trim()};

   async function readRun(path, options) {
     const response = await fetch(base + path, {...options, signal: AbortSignal.timeout(15000)});
     const {run} = await response.json();
     if (!response.ok || run?.requestId !== requestId) throw Error("Invalid run");
     return run;
   }

   async function smoke() {
     let run = await readRun("/run", {
       method: "POST",
       headers: {...headers, "content-type": "application/json"},
       body: JSON.stringify({
         userId, requestId, kind: "task",
         input: {requestId, task: {title: "列出一项简单的晨间整理任务"}}
       })
     });
     const deadline = Date.now() + 31 * 60000;
     while (run.status === "working" && Date.now() < deadline) {
       await delay(3000);
       run = await readRun("/run/" + requestId, {headers: {...headers, "x-along-user": userId}});
     }
     if (run.status !== "done" || !run.result?.summary) throw Error("Run did not complete");
     console.log("DSH smoke passed");
   }
   smoke().catch(() => {
     console.log("DSH smoke failed");
     process.exitCode = 1;
   });
   NODE
   ```

日志红线自查（§3.7）：`docker logs` 里不出现请求体、运行内容（用户消息/模型输出）、配对码与凭证；`users.json` 存在时启动横幅不打通用码。

## 环境变量

见 `env.example`（逐项注释）。补充口径：

- `ALONG_EVENT_INGEST=off` 是云端 v1 的预期值：新链路端点 503 属预期不是故障（验收 #10）；`/goal/event` 因镜像无 codex 报「Along 暂时不可用」、Kimi 运行时报「未找到 Kimi Code Web Server token」同为预期（§1）。
- 云端不配置 `ALONG_CONTEXT_REVIEW_*`、`ALONG_BRIDGE_TOKEN_FILE`、Kimi 相关 env，相关守卫自然跳过（§3.5 开关语义）。

## V-1 预置（Tier 2 验证项，验收 #9）

镜像从相邻 checkout 复制 Along bundle 的源码到 `/opt/along-superagent/`。其中 `src/`、`prompts/`、`skills/`、`locale/`、`scripts/` 各自保留目录，包清单、锁文件和构建配置保留在根目录。V-1 在独立临时容器内构建 `lib/`。

V-1 先在独立的临时容器里构建 bundle：

```sh
docker run --rm --entrypoint sh -w /opt/along-superagent along-agent:local \
  -c 'corepack pnpm install --frozen-lockfile && corepack pnpm build && test -f lib/index.js'
```

## 凭证红线（AGENTS.md §5）

- 三个 secret 文件 0600：`runner-token`、`model-credentials`、`apns-key.p8`。APNs key 额外要求 prime256v1 且权限严格 0600（`host/apns.mjs:12` 校验，不过则远程通知静默失效并打 warn）。
- **写入/更新 secret 用安全形态**，杜绝 key 明文进 shell 历史与进程列表：`umask 077` 预设权限、`HISTFILE=/dev/null`（或执行前 `set +o history`）、`install -m 600 /dev/null <目标文件>` 预建空文件、`read -rs` 静默读入后重定向写入。完整命令以 Runbook §6.4 第 3 步为准（`docs/cloud-security-hardening.md` §6 步骤 2）。权限过宽会被 0600 校验拒绝启动（host、runner 均为 fail-closed）。
- **恢复/搬运 secret 文件后统一 `chmod 600`**：相邻仓库备份脚本只有备份链路、恢复未实现（恢复演练在阶段 E）；手工 `cp`/`mv` 或未来的恢复链路都可能改变权限位，搬运后先核对再启动。
- `model-credentials` 只填一个 DeepSeek API key，可带结尾换行。runner 启动时读取；更新 secret 后重建 agent 容器。runner 只在启动 DSH 子进程时设置 `DEEPSEEK_API_KEY`。
- secrets 只经 compose 挂载进容器（`/run/secrets/*`），不进构建上下文（`.dockerignore` 白名单）、不进镜像层（可用 `docker history` 抽查）、不进日志。
- runner-token 是服务端内部凭证，只在 host↔agent 的 compose 内网请求头里走，绝不下发 iPhone/网页，不写运行结果。
- 每次 `dsh --profile along-headless` 都从 stdin 读取请求，使用独立的工作目录、`HOME` 和 `DSH_HOME`。该 profile 只加载模型与会话所需的插件，工具注册表为空。容器根文件系统只读，临时目录位于 `/tmp` 的 tmpfs，运行结束后清理。
- dsh 的 stdout/stderr 就是运行内容：runner 只解析、不落日志（`deploy/agent-runner.mjs` 头注释，§3.7）。

## 固定公网 IPv4 直连

此入口基于 Tier 2。手机填 `https://<固定公网 IPv4>` 和一次性配对码，使用支持公网 IP 的 Along iOS 构建（build 78 或更新）。TLS 由 nginx 终止，iOS 验证公共信任链、有效期及 IP SAN。HTTPS 地址和配对 token 相同的情况下，换叶证书后仍使用原配对。切换到另一个地址属于换入口，按原配对流程处理。

### 准备独立入口

- 为 Along 准备一个可由外网访问的固定公网 IPv4。HTTP-01 必须能从公网访问 **TCP 80**，HTTPS 客户端使用 **TCP 443**。80 只服务 `/.well-known/acme-challenge/`，其他路径返回 404。通过 EIP/NAT 转发时，将 TCP 80 和 443 都转到 Along 所绑定的宿主网卡。
- 以下编排假定 Along 独占该本地绑定地址的 80 和 443。若同机的 Multica 或其他服务已占用这两个端口，须为 Along 分配独立且未被占用的绑定地址，或在另一台主机部署。检查现有监听是否绑定了所有网卡。Along 单独使用 `/opt/along/edge`，含 Certbot 账号、续期配置、challenge Webroot 和 nginx 证书版本。
- 按 [Tier 2 Runbook](../docs/cloud-deploy-multi-user.md#65-tier-2-开启与回退35验证项-v-1-通过后) 准备 Host 数据、用户和 secrets。从 nginx 到 Host 只经专用 Unix socket，Host 与 netns 无发布端口。已有的 `/data/tls` 用于原部署形态，公网 IP 模式的证书存于 `edge/tls`。
- 部署机需要 Docker Compose（支持 `!override`）、Python 3.9+、OpenSSL（支持 `-verify_ip`）以及系统 CA 根证书。Compose 中的独立 ACME 服务运行固定版本的 Certbot 镜像，只挂载 Along 的 ACME 状态和 challenge 目录。Certbot 使用 [Let’s Encrypt IP 短期证书](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/) 的 HTTP-01 签发方式。

### 首次签发

以下命令在 Linux 部署机上以 root 执行。将 IP 和 ACME 邮件地址改成实际值，将仓库放在 `/opt/along/along`。

```sh
cd /opt/along/along
export ALONG_PUBLIC_IPV4='<公网 IPv4>'
export ALONG_ACME_EMAIL='<维护者邮箱>'
export ALONG_EDGE_DIR=/opt/along/edge
install -d -m 0700 "$ALONG_EDGE_DIR" "$ALONG_EDGE_DIR/tls" \
  "$ALONG_EDGE_DIR/tls/config" "$ALONG_EDGE_DIR/tls/releases" "$ALONG_EDGE_DIR/acme"
if [ ! -e "$ALONG_EDGE_DIR/tls/config/active.conf" ]; then
  install -m 0600 /dev/null "$ALONG_EDGE_DIR/tls/config/active.conf"
fi
install -d -m 0755 "$ALONG_EDGE_DIR/webroot" "$ALONG_EDGE_DIR/webroot/.well-known" \
  "$ALONG_EDGE_DIR/webroot/.well-known/acme-challenge"

export COMPOSE_FILE=deploy/docker-compose.yml:deploy/docker-compose.tier2.yml:deploy/docker-compose.public-ip.yml
export COMPOSE_PROFILES=tier2
export COMPOSE_PROJECT_NAME=along
docker compose up -d edge
# 从独立公网网络请求 HTTP-01 路径中的测试文件，校验内容正确后删除测试文件。
python3 deploy/public-ip-certificate.py bootstrap
docker compose up -d --build
ALONG_TIER2_COMPOSE_FILES='deploy/docker-compose.yml deploy/docker-compose.tier2.yml deploy/docker-compose.public-ip.yml' \
  deploy/tier2-stack.sh verify
```

在独立公网网络用 `curl --fail https://<公网 IPv4>/health` 验证 HTTPS。

如只绑定特定本地 IPv4，运行 Compose 之前设置 `ALONG_EDGE_BIND_IPV4`，并把 `ALONG_EDGE_PROBE` 设为该本地 IPv4 加 `:443`。探针仍用公网 IP 校验证书。默认探针为 `127.0.0.1:443`。生产环境沿用系统 CA 根。若从同机已有 Along TLS 容器切换，80/443 的监听交接应放在指定维护窗口完成。Tier 2 的锚点重建沿用同一组 Compose 文件及公网 IP 自检参数。

### 定期续期、失败告警与恢复

将 `ALONG_PUBLIC_IPV4`、`ALONG_EDGE_DIR`、`COMPOSE_PROJECT_NAME` 写入 `/etc/along-public-ip.env`，按需加入绑定及探针变量。首次签发与定时任务必须使用相同的 Compose 项目和目录。用下列同名 systemd 服务和定时器，每 6 小时检查一次。把服务的失败状态和日志中的 `ALONG TLS ALERT` 接到值班告警，另从独立公网网络监控 HTTPS 和证书剩余寿命。

```ini
# /etc/systemd/system/along-public-ip-renew.service
[Unit]
Description=Renew and verify Along public IPv4 TLS certificate
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/along/along
EnvironmentFile=/etc/along-public-ip.env
ExecStart=/usr/bin/python3 /opt/along/along/deploy/public-ip-certificate.py renew
```

```ini
# /etc/systemd/system/along-public-ip-renew.timer
[Unit]
Description=Check Along public IPv4 certificate every six hours

[Timer]
OnCalendar=*-*-* 00,06,12,18:20:00
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
```

写入单元后执行 `systemctl daemon-reload`，再用 `systemctl enable --now along-public-ip-renew.timer` 启动定时检查。手动验证用 `systemctl start along-public-ip-renew.service`，观察 `journalctl -u along-public-ip-renew.service`。脚本在 Certbot 续期后校验 IP SAN、证书链和私钥，从 nginx 容器内原子替换 `tls/config/active.conf`，配置引用只读的证书版本目录，执行 `nginx -t` 和 reload，再用信任校验及叶指纹确认 nginx 已提供新证书。每次检查都会核对 nginx 是否加载 Certbot 谱系中的证书，因此下一次可重试已签发但未加载的版本。

续期、证书校验、nginx 配置检查、重载或入口探针失败时，任务失败并记录告警，继续使用上一份仍在有效期内的证书。已经尝试重载的故障会恢复原配置、重新加载并核验旧叶。证书剩余不足 36 小时也触发告警。检查 HTTP-01 公网可达性、Certbot 日志和 nginx 日志，在旧叶过期前修复后重新启动续期服务。公网 IP 和公开信任链必须在修复后仍可通过验证。

部署验收时从两个独立公网来源确认 Host 配对审计分开记录各自的 IPv4，再记录一次实际续期，核对外部地址的叶指纹变化，并让原配对的 iPhone 分别验证前台连接和后台同步。隔离验收可运行 `ALONG_PUBLIC_IP_INTEGRATION=1 node --test test/public-ip-compose.test.mjs`，使用真实 nginx 和 Host、合成 CA 与 ACME 替身。

## 自动部署（每小时检查主干并部署）

**调度在 Multica，不在目标机上。** Multica 的每小时 wakeup 调起目标机上的**一次性
部署入口**：

```sh
sudo systemctl start along-auto-deploy.service
```

那一轮在目标机上检查 `artstur/along` 与 `artstur/along-superagent` 的 `main`；有更新
就拉取、构建、切换，没更新就什么都不做（不构建、不重启）。结果落在目标机 journal 里，
Multica 那一轮把摘要回报到工单——**工单上的评论就是运行记录**。

目标机上**不装 systemd timer**：两套调度同时跑会互相切换（各自切一次，线上版本与
台账可能对不上）。

### 为什么这么分工

构建、部署、健康检查与失败回退都要在目标机上做——那是唯一有 Docker、有卷、有
凭证的地方。调度交给 Multica：触发与运行记录都在平台侧可查，不需要在目标机上留
一个常驻定时器，也不用把部署身份交给 CI。代价是目标机要有两个仓库的读权限
（这台机用 `ecs-user` 的 SSH 密钥拉 `git@github.com:artstur/…`）。

### 一轮里做什么

### 一轮里做什么

| 阶段 | 做什么 | 为什么这么定 |
| --- | --- | --- |
| 锁 | `flock` 非阻塞；抢不到就跳过本轮 | 重复触发不能并发切换。**`flock` 不存在时直接报错**——当成"锁被占"会让每一轮都静默跳过，定时任务看着在跑其实什么都没做 |
| 取提交 | fetch 两个仓库到**部署专用引用** `refs/along-auto-deploy/<分支>`，从那里取本轮固定的那对提交 | 上游中途再推不影响本轮；两个 SHA 都进构建。**不用 `FETCH_HEAD`**：它是 checkout 里的全局可变文件，同一个 checkout 上任何一次别的 fetch（哪怕拉的是另一个分支）都会把它覆盖，本轮就会部署那个分支的提交。专用引用只有部署器自己会写 |
| 展开 | `git archive` 把两个提交展开成干净源码树，放在 `release/<两个 SHA 前 12 位>/` | 现场 checkout 可能有本地改动，构建不该被它们影响。**先展开到暂存目录，完整展开成功后才发布**——半成品目录不能被下一轮复用 |
| 隔离 mtime | 展开后把每个文件的 mtime 设成**该文件内容派生**的时间戳 | `git archive` 给的 mtime 是提交时间：同秒提交、同样字节长度的改动，路径+大小+mtime 三项都不变，构建的本地源同步会认为"什么都没变"，直接复用上一次的**内容**——镜像里留下旧代码，台账却记了新提交。`--no-cache` 救不了：旧的是源同步那一层，不是构建缓存层 |
| 核对 | `docker compose config` 解析出的卷、凭证、构建输入逐条比对预期路径 | 相对路径配错是静默降级（卷挂空目录、数据看着"配好了"其实没生效） |
| 构建 | `docker compose build`，产物打版本化标签（标签里带两个 SHA） | 运行中的镜像 ID 可反查到当轮固定的提交 |
| 核对产物 | 逐文件比对镜像里的产物与本轮钉住的源码 | 挡住"镜像里跑的是旧内容、台账记的却是新提交"。**在切换前做**——内容不对的镜像根本不该上线 |
| **核对台账** | **切换前**真写一个探针文件，检查状态目录与版本台账目录在**当前账号**下写得进去 | 台账写不进去时，容器已经切过去了、台账却还指着旧版本：线上跑的是新版本、台账说旧版本，下一轮的"变没变"判断全错。宁可在切换前就失败 |
| 切换 | `up -d --no-build --force-recreate anchor superagent host` | 锚点与两个使用方一起重建：命名空间跟着持有它的容器走，只重建一边会把另一边落在旧 netns 里（外部入口静默断掉，见 [Host 云端部署经验 §2.3](../docs/host-cloud-deploy.md#23-命名空间必须由第三方容器持有这条最隐蔽)） |
| 探活 | 两个容器 `healthy` + Host 的 HTTPS `/health` 200 + 锚点跳板可达 | 跳板在锚点的命名空间里，够不着就说明被落下 |
| 记录 | **两个服务都健康之后**才把这一对 SHA 写成成功版本 | 失败轮次不推进记录，下一轮可以重试 |

失败处理：切换前记下当前运行的镜像 ID 与编排文件。**切换返回非零**（compose up 可能
部分成功：锚点与 Super Agent 已重建、Host 容器没起来，此时线上入口是断的）与
**探活失败**都进同一条回退路径：把镜像标签打回旧 ID、按旧编排重建三个容器并重新探活。
**失败轮次不写成功记录**，上一成功版本保持健康或经恢复后重新健康。

对 checkout 跑 git 时一律带 `safe.directory=<那个 checkout>`：checkout 归服务账号所有，
而部署器可能以 root 跑（`sudo … bootstrap`、人工排查），git 见到属主不同就拒绝操作
（dubious ownership），root 跑时每一句 git 都会失败。

### 发布目录的形状是刻意的

```
release/<along 前 12 位>-<superagent 前 12 位>/
├── along/            # 从固定 SHA 展开的 Along 源码（构建上下文）
├── along-superagent/ # 从固定 SHA 展开的 Super Agent 源码（bundle 来源）
├── data    -> ../../data        # 符号链接
└── secrets -> ../../secrets     # 符号链接
```

compose 的 project directory 是 `release/<id>/along/deploy`，所以 `../../data`、
`../../secrets`、`../../along-superagent` 分别落到上面三个位置：前两个是指向工作区
**真实目录**的符号链接（持久卷与凭证仍是同一份，宿主 nginx 与 App 看到的还是老数据），
第三个就是当轮钉住提交的 Super Agent 源码。

### 安装

```sh
sudo deploy/auto-deploy-install.sh            # 安装（不装定时器：调度归 Multica）
sudo deploy/auto-deploy-install.sh --trigger-now   # 装完立刻跑一轮
```

安装器做三件事：把脚本装到 `/usr/local/libexec/along/`、装 unit、按实际探测到的账号
生成 `/etc/along-auto-deploy.env`（含 `ALONG_DEPLOY_STATE_USER`）并把状态目录归它所有。
机器上**已有的旧定时器会被停用并移除**——两套调度同时跑会互相切换。

装完先手动跑一轮看结果：

```sh
sudo systemctl start along-auto-deploy.service
journalctl -u along-auto-deploy.service -n 100 --no-pager
```

首次安装时把当前正在跑的版本登记成基线（否则第一轮会无条件重装一遍）：

```sh
sudo -u ecs-user /usr/local/libexec/along/auto-deploy.sh bootstrap
```

**必须以服务账号运行**（单元里的 `User=`）。状态目录与版本台账都归服务账号所有：root
建出来的目录服务账号写不进去，下一轮取锁直接 `Permission denied`，每一轮都失败。
以 root 跑也行——部署器读 `/etc/along-auto-deploy.env` 拿到服务账号，登记**之后**把整个
状态目录（含 `versions/` 台账与台账文件）`chown` 给它，并在登记完当场自检。

`bootstrap` 默认取现场 checkout 的 HEAD——只在"现场 HEAD 就是当前运行的版本"时成立；
否则显式给两个提交号：`bootstrap <along SHA> <superagent SHA>`。

**安装顺序**：装 → 以服务账号 `bootstrap` → 手动跑一轮看结果 → 再启用 Multica 调度。

### Multica 调度配置

调度是工单上的一个每小时 cron wakeup，它叫醒的目标会去调目标机上的一次性部署入口：

```sh
multica issue wakeup create <工单 ID> \
  --kind cron --cron "0 * * * *" --mode continuous \
  --instruction-file ./wakeup-instruction.md
```

`--instruction` 里写清"调起哪个入口、跑完回报什么"。Multica 那一轮跑完会把结果作为
评论发回工单——**工单上的评论就是运行记录**。

已建的调度：`multica issue wakeup list <工单 ID>`；手动触发一次：
`multica issue wakeup trigger <工单 ID> <wakeup ID>`；停用：`multica issue wakeup disable`。

### 日常操作

```sh
# 跑一轮（Multica 调的就是这个）
sudo systemctl start along-auto-deploy.service

# 状态：成功版本、上一成功版本、运行中的镜像与探活
/usr/local/libexec/along/auto-deploy.sh status

# 只探活
/usr/local/libexec/along/auto-deploy.sh verify

# 手工回退到上一成功版本
/usr/local/libexec/along/auto-deploy.sh rollback

# 卸载（调度在 Multica 侧另行停用）
sudo rm -f /usr/local/libexec/along/auto-deploy.sh \
  /etc/systemd/system/along-auto-deploy.service
sudo systemctl daemon-reload
```

### 配置与排障

配置在 `/etc/along-auto-deploy.env`（模板 `auto-deploy.env.example`），只有路径与版本
来源，**没有凭证**：模型与桥接凭证仍走目标机现有的 file secret。

| 变量 | 作用 |
| --- | --- |
| `ALONG_DEPLOY_WORKSPACE` | 工作区根目录（`data/`、`secrets/` 在它下面） |
| `ALONG_DEPLOY_ALONG_URL` / `ALONG_DEPLOY_SUPERAGENT_URL` | 两个仓库的地址 |
| `ALONG_DEPLOY_ALONG_CHECKOUT` / `ALONG_DEPLOY_SUPERAGENT_CHECKOUT` | 现场 checkout：只用来 fetch 与取对象，不作构建上下文 |
| `ALONG_DEPLOY_COMPOSE_REL` | 编排文件（相对发布目录里的 along/ 根） |
| `ALONG_DEPLOY_HEALTH_URL` | Host 的探活入口 |
| `ALONG_DEPLOY_HEALTH_TIMEOUT` / `ALONG_DEPLOY_BUILD_TIMEOUT` | 探活与构建的超时（秒） |
| `ALONG_DEPLOY_KEEP_RELEASES` | 保留几个版本（当前与上一成功版本必须留着，前者用于运行、后者用于回退） |
| `ALONG_DEPLOY_STATE_USER` | 定时任务的服务账号。状态目录与版本记录必须归它所有；以 root 跑 `bootstrap` 时据此 chown |
| `ALONG_DEPLOY_REF` | 部署专用引用（默认 `refs/along-auto-deploy/<分支>`）：本轮 fetch 的落点，别人的 fetch 覆盖不了 |
| `ALONG_DEPLOY_HOST_IMAGE` / `ALONG_DEPLOY_SUPERAGENT_IMAGE` | 两个镜像的标签（默认 `along-host:cloud` / `along-superagent:local`） |
| `ALONG_DEPLOY_HOST_CONTAINER` / `ALONG_DEPLOY_SUPERAGENT_CONTAINER` | 两个容器的名字（默认 `along-host` / `along-superagent`） |
| `ALONG_DEPLOY_PROBE_URL` | 锚点跳板的探活地址（默认 `http://127.0.0.1:3083/`） |
| `ALONG_DEPLOY_VERIFY_IMAGE` | 切换前核对镜像产物与源码（默认 `1`；关掉就只剩 mtime 隔离这一道防线） |
| `ALONG_DEPLOY_VERIFY_HOST_IMAGE` / `ALONG_DEPLOY_VERIFY_SUPERAGENT_IMAGE` | 核对规格：`镜像\|源码在发布目录下的相对目录\|镜像内路径:源码内路径`，逗号分隔 |
| `ALONG_DEPLOY_EXPECT_BINDS` / `_EXPECT_SECRETS` / `_EXPECT_CONTEXTS` / `_EXPECT_ADDCTX` | 路径核对的期望值（默认是线上那套；隔离环境换一份即可复用同一个脚本）。**显式设成空串**表示"不核对这一类"，只有没设才取默认值 |
| `ALONG_DEPLOY_ALONG_SHA` / `ALONG_DEPLOY_SUPERAGENT_SHA` | **钉住**当轮使用的提交，跳过远端查询。验收时用它模拟"只更新一个仓" |
| `ALONG_DEPLOY_DRY_RUN=1` | 只做计划：取提交、展开、核对路径，不构建不切换 |
| `ALONG_DEPLOY_BUILD_ONLY=1` | 只构建不切换，成功记录不变 |
| `ALONG_DEPLOY_TEST_FAULT` | **测试用**故障注入：`fetch` / `build` / `switch` / `health`。用来验证失败轮次不推进记录、回退可用 |

排障看 journal：`journalctl -u along-auto-deploy.service -n 200 --no-pager`。
每一行都带阶段前缀（`LOCK` / `FETCH` / `SHA` / `CHANGE` / `RELEASE` / `PATH-CHECK` /
`BUILD` / `VERIFY` / `SWITCH` / `HEALTH` / `RECORD` / `CLEANUP` / `ROLLBACK`），日志只记
版本、阶段和结果，不记凭证与请求内容。

### 隔离复测

部署器契约里有几件事单元测试锁不住：compose up 会不会**部分成功**、构建缓存会不会把
旧内容烤进镜像、解包失败会不会污染同 SHA 的下一轮、台账写不进去时会不会先切了再说。
这些要在隔离 Docker 环境里跑真实容器才验得了。

```sh
ALONG_AUTO_DEPLOY_INTEGRATION=1 node --test test/auto-deploy-integration.test.mjs
```

默认不跑（要构建镜像、起容器，耗时）；`npm run check` 不带这个变量，普通开发与 CI
不受影响。用例用两个本地 git origin 当上游、一套与生产同形状的三容器编排（锚点持
netns，host 与 superagent 加入它），逐条验：无更新跳过、同秒等长改动必须进到镜像里
且台账与镜像内容一致、解包失败不污染同 SHA 的下一轮、台账目录不可写时在切换前就失败、
同一 checkout 上并发 fetch 别的分支时本轮仍部署 main、compose up 部分失败时回退到
上一成功版本。

**按实际入口的端到端**（安装 → root 登记基线 → 服务账号首次更新）另在隔离 Linux 主机上
用真安装器跑：安装器生成 `/etc/along-auto-deploy.env`（含服务账号），以 root 跑
`bootstrap`（**不预先导出** `ALONG_DEPLOY_STATE_USER`），再以 unit 的服务账号
`systemctl start along-auto-deploy.service` 完成首次真实更新，核对双服务健康、运行镜像
ID 与成功台账一致。这条路径是"按手册装"的真实形状，配置文件的读取顺序必须对——
配置文件在参数解析**之后**才被 source 的话，配置文件里的服务账号、工作区全都不生效。
