# deploy/ — Along 云端部署产物

对应设计 `docs/cloud-deploy-multi-user.md`（拓扑 §3.1、本模块 §4-M5、验收 #5/#10、Runbook §6.4）。**上线步骤以 Runbook §6.4 为准**，本文只写产物自身的口径与自检。

## 文件清单

| 文件 | 内容 |
| --- | --- |
| `Dockerfile.host` | Host 镜像包含 Node 22、生成证书所需的 OpenSSL、锁文件锁定的 npm 生产依赖、Host 模块与 web 共享依赖。 |
| `Dockerfile.agent` | agent 镜像：node:24-bookworm-slim + `@deepseek-ai/dsh@0.2.2-rc.5`（版本写死 pin，engines node>=24.9.0）；携带 `deploy/agent-runner.mjs`（M3）与其 import 的 `web/{super-agent,goal-agent-core,contextual-planning}.mjs`；经 `additional_contexts` 预置 along bundle |
| `Dockerfile.superagent` | Tier 2 长驻镜像：同一个 node:24 摘要与同一份 dsh 锁文件；携带 **bundle 编译产物** `lib/`（V-1 的 ERR_MODULE_NOT_FOUND 根因就是只配层不装包）；入口 `deploy/superagent-start.sh` |
| `docker-compose.yml` | 编排：host 443→4176、agent `agent:3088` 仅 compose 内网（不发布端口）、bind 卷 `../../data/host:/data`、compose secrets（runner-token 两服务共用） |
| `superagent-start.sh` | Tier 2 启动脚本：铺 profile、把 bundle 链进 `profile/node_modules`、绑 `127.0.0.1:3082`、播种设置，然后 exec 常驻 dsh |
| `superagent-seed.mjs` | Tier 2 设置播种：第一次 boot 之前把「Along Source 开、GitHub Source 关」写进编排库（`assembleAlong` 读的是已存好的设置）；已有设置时不覆盖 |
| `superagent-preset-lockdown.mjs` | Tier 2 读取面收紧：推导出去掉文件/shell/终端/文档/子代理能力后的 preset 覆盖行（读上游自己的 patch 推导，不抄一份）；推导结果为空即拒绝启动 |
| `env.example` | environment 段非敏感参考值（必改项：`ALONG_TLS_CN` 换真实域名） |
| `../.dockerignore` | 两个主构建上下文都用仓库根目录的白名单，只放行 npm 清单、Host 模块及任务协议、web 模块和 runner 入口。 |
| `agent-runner.mjs` | 内网 HTTP runner，使用 Along 专用 DSH profile；模块自检 `node --check deploy/agent-runner.mjs` |
| `agent-dsh/` | dsh 安装清单：`package.json` + `package-lock.json` 锁定 `@deepseek-ai/dsh@0.2.2-rc.5`，镜像内 `npm ci --ignore-scripts` 安装。升级 dsh 版本时在本目录 `npm install --package-lock-only --ignore-scripts` 重新生成 lock 并入库，同时同步 `Dockerfile.agent` 的 pin 与 compose 的 `ALONG_DSH_VERSION` |

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

两个镜像的构建输入都取
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
