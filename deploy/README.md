# deploy/ — Along 云端部署产物

对应设计 `docs/cloud-deploy-multi-user.md`（拓扑 §3.1、本模块 §4-M5、验收 #5/#10、Runbook §6.4）。**上线步骤以 Runbook §6.4 为准**，本文只写产物自身的口径与自检。

## 文件清单

| 文件 | 内容 |
| --- | --- |
| `Dockerfile.host` | host 镜像：node:22-bookworm-slim + openssl（启动现场生成自签证书必需，`host/agent-host.mjs:45`）；携带 `host/` 全目录 + host→web 共享闭包 7 个文件（`goal-agent-core`、`adaptive-ui`、`super-agent`、`contextual-planning`、`loop`、`health`、`task-results`，2026-11-20 按 `grep -rn "from '../web/" host/*.mjs` 实测，平铺保持 `../web/*` 相对路径） |
| `Dockerfile.agent` | agent 镜像：node:24-bookworm-slim + `@deepseek-ai/dsh@0.2.2-rc.5`（版本写死 pin，engines node>=24.9.0）；携带 `deploy/agent-runner.mjs`（M3）与其 import 的 `web/{super-agent,goal-agent-core,contextual-planning}.mjs`；经 `additional_contexts` 预置 along bundle |
| `docker-compose.yml` | 编排：host 443→4176、agent `agent:3088` 仅 compose 内网（不发布端口）、bind 卷 `../../data/host:/data`、compose secrets（runner-token 两服务共用） |
| `env.example` | environment 段非敏感参考值（必改项：`ALONG_TLS_CN` 换真实域名） |
| `.dockerignore` | 主 context 白名单：只放 `host/`、`web/`、`deploy/` 进构建上下文，其余（.git、node_modules、dist、out、output、任何将来落进仓库的密钥/状态文件）永不进镜像层 |
| `agent-runner.mjs` | 内网 HTTP runner，使用 Along 专用 DSH profile；模块自检 `node --check deploy/agent-runner.mjs` |

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

1. `docker logs along-host`：看到 `Along 服务: https://0.0.0.0:4176`（`ALONG_AGENT_HOST=0.0.0.0` 生效——容器内没有 en0，缺 env 会回退绑 127.0.0.1、443 打不通）、证书 SHA-256 指纹与到期时间。指纹是 iPhone 配对表单的输入。
2. `docker exec along-host sh -c 'ls -l /data/users.json'`：可见（卷没挂错、多用户形态生效）。
3. 宿主机 `curl -k https://127.0.0.1/health`：200。
4. `docker exec along-agent node -e "fetch('http://127.0.0.1:3088/health').then(r=>r.json()).then(console.log)"`：返回 ready。
5. 通过 runner 发送一次无私密内容的任务，确认返回 `done`。此步骤覆盖实际读取模型凭证、启动 DSH 和接收模型结果。

   ```sh
   docker exec along-agent node -e '
     const {readFileSync} = require("node:fs");
     const {randomUUID} = require("node:crypto");
     const requestId = randomUUID();
     fetch("http://127.0.0.1:3088/run", {
       method: "POST",
       headers: {
         "content-type": "application/json",
         "runner-token": readFileSync(process.env.ALONG_RUNNER_TOKEN_FILE, "utf8").trim()
       },
       body: JSON.stringify({
         userId: "smoke", requestId, kind: "task",
         input: {requestId, task: {title: "列出一项简单的晨间整理任务"}}
       })
     }).then(async response => {
       const {run} = await response.json();
       if (!response.ok || run?.status !== "done" || !run.result?.summary) process.exitCode = 1;
       console.log(process.exitCode ? "DSH smoke failed" : "DSH smoke passed");
     }).catch(() => {
       console.log("DSH smoke failed");
       process.exitCode = 1;
     });
   '
   ```

日志红线自查（§3.7）：`docker logs` 里不出现请求体、运行内容（用户消息/模型输出）、配对码与凭证；`users.json` 存在时启动横幅不打通用码。

## 环境变量

见 `env.example`（逐项注释）。补充口径：

- `ALONG_EVENT_INGEST=off` 是云端 v1 的预期值：新链路端点 503 属预期不是故障（验收 #10）；`/goal/event` 因镜像无 codex 报「Along 暂时不可用」、Kimi 运行时报「未找到 Kimi Code Web Server token」同为预期（§1）。
- 云端不配置 `ALONG_CONTEXT_REVIEW_*`、`ALONG_BRIDGE_TOKEN_FILE`、Kimi 相关 env，相关守卫自然跳过（§3.5 开关语义）。

## V-1 预置（Tier 2 验证项，验收 #9）

along bundle 以 **git 跟踪文件的源码形态**预置进镜像 `/opt/along-superagent/`（`src/`、`prompts/`、`skills/`、`locale/`、`scripts/`、`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`、构建配置）。`lib/` 是 tsdown 构建产物且被 `.gitignore`（fresh clone 不存在），COPY 它会让部署机构建硬失败，所以镜像里**不含 lib**——Tier 1（目标聊天链路）不依赖 bundle，不受影响。

V-1 验证可在独立的临时容器里构建和加载 bundle，使用同一镜像：

```sh
docker run --rm --entrypoint sh -w /opt/along-superagent along-agent:local \
  -c 'corepack pnpm install --frozen-lockfile && corepack pnpm build'
```

## 凭证红线（AGENTS.md §5）

- 三个 secret 文件 0600：`runner-token`、`model-credentials`、`apns-key.p8`。APNs key 额外要求 prime256v1 且权限严格 0600（`host/apns.mjs:12` 校验，不过则远程通知静默失效并打 warn）。
- `model-credentials` 只填一个 DeepSeek API key，可带结尾换行。runner 启动时读取；更新 secret 后重建 agent 容器。runner 只在启动 DSH 子进程时设置 `DEEPSEEK_API_KEY`。
- secrets 只经 compose 挂载进容器（`/run/secrets/*`），不进构建上下文（`.dockerignore` 白名单）、不进镜像层（可用 `docker history` 抽查）、不进日志。
- runner-token 是服务端内部凭证，只在 host↔agent 的 compose 内网请求头里走，绝不下发 iPhone/网页，不写运行结果。
- 每次 `dsh --profile along-headless` 都从 stdin 读取请求，使用独立的工作目录、`HOME` 和 `DSH_HOME`。该 profile 只加载模型与会话所需的插件，工具注册表为空。容器根文件系统只读，临时目录位于 `/tmp` 的 tmpfs，运行结束后清理。
- dsh 的 stdout/stderr 就是运行内容：runner 只解析、不落日志（`deploy/agent-runner.mjs` 头注释，§3.7）。
