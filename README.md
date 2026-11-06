<p align="center">
  <img src="web/app-icon.png" width="96" alt="Along">
</p>

<h1 align="center">Along</h1>

<p align="center">
  <b>你的目标，陪你一步步实现</b><br>
  从目标到行动，Along 帮你分析拆解、持续追踪，并随着进展实时调整方向，直到达成目标。
</p>

<p align="center">
  <a href="https://artstur.github.io/along/"><img src="https://img.shields.io/badge/demo-在线体验-2ea44f" alt="Live demo"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white" alt="Node >= 22.19">
  <img src="https://img.shields.io/badge/platform-iPhone%20%7C%20Web-lightgrey?logo=apple" alt="iPhone | Web">
  <img src="https://img.shields.io/badge/agents-DSH%20%7C%20Kimi%20Swarm-6f42c1" alt="DSH | Kimi Swarm">
  <img src="https://img.shields.io/badge/build-no%20bundler-informational" alt="No bundler">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#它是怎么工作的">工作原理</a> ·
  <a href="#连接-agent">连接 Agent</a> ·
  <a href="ios/README.md">iPhone App</a> ·
  <a href="#开发与发布">开发与发布</a>
</p>

---

## 为什么是 Along

大多数目标写下来就静止了：「本周运动 120 分钟」挂在那里，你得自己算还差多少、今天该做什么、计划被打乱后怎么补。

Along 把一个目标拆成三样东西，并让它们保持联动：

| | 是什么 | 例子 |
| --- | --- | --- |
| **目标** | 你想达成的结果 | 本周累计运动 120 分钟 |
| **来源** | 与这个目标有关的真实数据 | Apple Health 的本周健身记录 |
| **动态任务** | 根据进度算出来的下一步 | 「本周只差 35 分钟，找一个活动时段」 |

来源一变，进度和任务就重新计算；变化足够显著时，Agent 才会提出新的安排，等你点「采用」后生效。小变化保持安静，不打扰你。

## 能体验什么

顶部下拉即可在目标之间切换。一屏只做一件事：看清进度，知道下一步。

| 目标 | 数据从哪来 | 你能看到 |
| --- | --- | --- |
| **健康** · 本周累计运动 120 分钟 | iPhone App 连接 Apple Health；普通网页可选演示数据 | 按所选摘要计算进度与下一步，连接页可一键选择全部可读指标 |
| **理财** · 三个月存下 ¥10,000 应急金 | 纯演示：点「体验连接」出现 ¥3,200 余额 | 「模拟 +¥800」后进度与任务文字随之更新 |
| **＋ 定义新目标** | 你用自然语言描述期限、偏好和约束 | Agent 实时拆解、分工、执行与综合，结果经校验后由你采用 |

此外还有两处值得一看：

- **动态任务详情**：点任意任务卡片，进入真实的 DSH Super Agent 协作视图，看到 Trigger → Eval → Ticket → Assignment，以及 Main Session、Worker Session、Report 与 Mandate。进度来自 DSH 的持久化状态，不是本地计时器。
- **目标变化实验**：健康目标页底部，固定 75 + 35 分钟场景，展示 Along 怎样计算、判断路由并给出建议；轻微或无关的变化保持安静。

> [!NOTE]
> 理财目标只用演示数据，没有接入蚂蚁财富或任何真实账户，不读取账户，也不转账或交易。

## 它是怎么工作的

```mermaid
flowchart LR
    A[Apple Health / 演示来源] --> B{有意义的变化?}
    B -- 轻微或无关 --> Q[安静更新进度]
    B -- 显著 --> C[待处理任务]
    C --> D[Agent 生成提案<br/>DSH Agents / Kimi Swarm]
    D --> E[严格校验<br/>JSON Schema + 白名单]
    E --> F{用户点「采用」?}
    F -- 是 --> G[更新目标空间]
    F -- 否 --> Q
```

几条贯穿全局的约定：

- **确定性的部分在本地算**。进度、剩余量、默认下一步都由前端直接计算，Mac 关机或断网时首页照样更新。
- **生成式的部分交给 Agent**。新目标的拆解和显著变化后的重排，经由 Mac 上的 Agent Host 调用 DSH Super Agent 或 Kimi Code Swarm。
- **Agent 的输出不会直接生效**。结果先过 `validateGoalReply` 与 `safeAdaptiveLayout`，绑定可信指标后再渲染，最后由你决定是否采用。

## 快速开始

### 只想看看

直接打开 [在线体验](https://artstur.github.io/along/)。健康和理财示例都能在纯网页里用演示数据跑通。

### 本地运行

```sh
npm install        # 会安装项目自带的 Node 22.23.4
npm run dev        # http://localhost:4173，仅监听 127.0.0.1
```

没有打包器：`web/` 就是前端唯一源码，改完刷新即可。

### 连接 Agent

「定义新目标」和任务提案需要在 Mac 上运行 Along Agent Host。目标页可以在两种运行时之间切换，两者的运行记录相互隔离；没选过时默认用 Kimi。

<details open>
<summary><b>Kimi Swarm</b>：需要 Kimi Code 2.5.0 或更新版本</summary>

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
kimi                                  # 输入 /login 完成登录后退出
kimi web --no-open --port 58627       # 启动本机 Web Server
npm run agent-host
```

Agent Host 只从 Mac 本机读取 `~/.kimi-code/server.token`，不会把它发给 iPhone，也不会写进运行结果。Kimi 未登录或 Web Server 未运行时，只有 `Kimi Swarm` 显示不可用，`DSH Agents` 可继续使用。

</details>

<details>
<summary><b>DSH Agents</b>：需要本机 DSH Super Agent</summary>

先启动 DSH Super Agent（默认 `http://127.0.0.1:3082`）并加载 Along Source，然后：

```sh
npm run agent-host
```

Super Agent 只监听 Along Source。GitHub 账号仅用于 Worker 的分支、提交和 PR 交付，默认不自动合并。

</details>

### 和 iPhone 配对

`npm run agent-host` 启动后，终端会打印三样东西：

```text
局域网 HTTPS 地址     https://192.168.x.x:4176
证书 SHA-256 指纹     AB:CD:...
一次性配对码          15 分钟内有效
```

在 iPhone App 的目标编辑页填入这三项即可开始问答，只需首次填写；之后正常重启、升级或重新安装 App 都会自动恢复。iPhone 需要和 Mac 在同一 Wi-Fi。

iPhone App 的签名、安装与 HealthKit 读取口径见 [ios/README.md](ios/README.md)。

## 配置

所有变量都有默认值，一般无需设置。Mac 本地状态保存在 `~/.along/agent-host/`。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` / `HOST` | `4173` / `127.0.0.1` | `npm run dev` 本地服务 |
| `ALONG_AGENT_PORT` | `4176` | Agent Host 的 HTTPS 端口 |
| `ALONG_AGENT_HOST` | `en0` 的 IPv4，取不到时为 `127.0.0.1` | Agent Host 绑定地址 |
| `ALONG_SUPERAGENT_URL` | `http://127.0.0.1:3082` | DSH Super Agent 地址 |
| `ALONG_KIMI_CODE_URL` | `http://127.0.0.1:58627` | Kimi Code Web Server 地址 |
| `ALONG_KIMI_CODE_TOKEN` | 读取 `~/.kimi-code/server.token` | 覆盖 Kimi token |
| `ALONG_KIMI_CODE_MODEL` | `kimi-code/kimi-for-coding` | Kimi 模型 |
| `ALONG_KIMI_WORKSPACE` | 当前目录 | Kimi 会话工作目录 |
| `CODEX_BIN` | `~/.local/bin/codex`，否则 PATH 中的 `codex` | 健康变化任务提案使用的 Codex |

## 隐私与安全

Along 处理的是健康这类敏感数据，所以边界写得很死：

| 原则 | 具体做法 |
| --- | --- |
| 只发汇总，不发原始样本 | 目标问答只发送当前目标与已选健身时长的汇总值；自定义目标只发送你主动输入的文本 |
| 数据留在手机 | 健康摘要保存在 App 内 WKWebView 的本地页面数据中，不依赖 Mac 同步服务 |
| Token 留在 Mac | Kimi token 和配对 token 不发给 iPhone，也不写进运行结果 |
| 只在局域网 | Agent Host 默认只绑定 Mac 的 Wi-Fi 地址，没有公网通道，退出终端即停止 |
| 证书钉扎 | 证书由 Mac 本地生成，iPhone 原生网络层校验指纹后才传输，连接后使用随机令牌 |
| 你说了算 | Agent 结果需通过校验，并由你点「采用」后才改变目标空间 |

连接凭证的哈希保存在 Mac 的 `~/.along/agent-host/pairing.json`，连接信息同时保存在 iPhone Keychain。

## 项目结构

```text
.
├── web/                                   # 前端唯一源码（保持平铺）
│   ├── index.html  app.mjs  style.css     # 页面与交互
│   ├── sw.js  manifest.webmanifest        # 离线缓存与 PWA
│   ├── health.mjs  loop.mjs               # 目标进度、健康摘要与变化循环
│   ├── workspace.mjs  adaptive-ui.mjs     # 目标空间与自适应布局校验
│   ├── goal-agent-core.mjs                # Agent 回复解析、路由与校验
│   └── super-agent.mjs  agent-client.mjs  # 运行时定义与前端 Agent 客户端
├── host/                                  # 在 Mac 上运行的服务
│   ├── agent-host.mjs                     # HTTPS Agent Host
│   ├── kimi-code-agent.mjs  codex-agent.mjs # 各 Agent 运行时适配
│   ├── server.mjs                         # npm run dev 本地服务
│   └── schemas/                           # Agent 输出的 JSON Schema
├── test/                                  # *.test.mjs，npm run check 自动运行
├── tools/                                 # build.mjs 构建脚本
└── ios/                                   # iPhone App（HealthKit + WKWebView）
```

`host/` 会从 `../web/` 引用共享校验逻辑，所以这些共享文件必须同时能在浏览器和 Node 里运行。

## 开发与发布

```sh
npm run check   # CI 同款：语法检查 + 全部测试
npm run build   # 产出 dist/（GitHub Pages）与 ios/AlongHealth/Web/（App 内置页面）
```

> [!IMPORTANT]
> `npm test` 跑全部测试，`npm run check` 在此之上再加一遍语法检查。`check` 按目录匹配：`web/`、`host/` 下的 `.mjs` 自动做语法检查，`test/*.test.mjs` 自动运行，新文件放对目录即可。

**一份源码，两份产物。** `tools/build.mjs` 按白名单把 `web/` 里的文件复制到 `dist/` 和 `ios/AlongHealth/Web/`，不要手改这两个目录。新增前端文件时，放进 `web/`，并同时登记到 `tools/build.mjs` 的 `files` 和 `web/sw.js` 的 `FILES`。

**用户可见的改动要让旧缓存失效**，以下版本号一起提高，漏一处手机上就可能还是旧页面：

- `web/index.html` 的 `?v=`
- `web/sw.js` 的 `CACHE`
- `ios/AlongHealth/Sources/AlongShellView.swift` 的 `build=`
- 需要重新安装 App 时，再提高 `ios/AlongHealth/Info.plist` 的 `CFBundleVersion`

**推送 `main` 不会自动部署：**

- GitHub Pages：手动触发工作流（GitHub Actions → Deploy GitHub Pages → Run workflow，或 `gh workflow run pages.yml --ref main`），依次执行 `npm ci`、`npm run check`、`npm run build` 并发布 `dist/`。
- iPhone：先 `npm run build`，再在 Xcode 里重新构建并安装。

## 当前边界

坦白说，这还是一个 Demo，下面这些是有意为之或尚未完成的：

- **没有后台同步**。HealthKit 在 App 打开、回到前台、收到前台更新通知时重新读取，页面可见期间每 60 秒兜底检查；不保证秒级，也不会自动标记运动完成。
- **Agent 依赖 Mac**。Mac 关闭或网络断开时，首页确定性进度照常更新，Agent 问答和任务提案显示不可用；GitHub Pages 是静态站，无法常驻生成进程。
- **理财只是演示**。不接真实账户，不转账，不交易。
- **个人团队签名**。Xcode 个人团队的配置文件通常 7 天后到期，需要重新构建安装。

## 相关文档

- [ios/README.md](ios/README.md)：iPhone App 的运行步骤、HealthKit 读取范围与数据口径
- [AGENTS.md](AGENTS.md)：参与开发前必读的项目约定与红线
