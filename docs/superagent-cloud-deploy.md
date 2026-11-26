# Along Agent 云端部署经验（Linux）

> 2026-11-23 在阿里云 ECS 上实测。**本文只记录实测事实与踩过的坑，不重复部署编排** ——
> 现行编排及运维入口见 [deploy](../deploy/README.md)，不需要切历史开发分支。
> 完整上游实测记录见 [Along Agent 的 Linux 云端部署记录](https://github.com/artstur/along-superagent/blob/main/docs/along/023-linux-cloud-deployment.md)。

## 1. V-1 已通过：Linux 可以长驻承载 Along 数据面

沿仓库 `docs/cloud-deploy-multi-user.md` §2.1 曾断言「官方 Linux 发行物 `@deepseek-ai/dsh` 是 headless
一次性形态（无监听端口、每调用一个进程退出），承载不了长驻数据面」，并据此把新链路端点在云端定为 503。

**该结论与发行物实际内容不符。** 解包 `@deepseek-ai/dsh@0.2.2-rc.5` 后，包内 `README.zh.md` 明确提供：

| 入口 | 用途 |
| --- | --- |
| `dsh <name>` / `dsh --profile <name>` | 启动 `$DSH_HOME/profiles/<name>` 下的 profile |
| `dsh --profile <name> --from-default-profile <template>` | 用随附模板的副本替换/创建 profile 后启动 |
| `dsh web` | 启动 Web profile（长驻，有监听端口） |
| `dsh plugin --profile <name> <pnpm args>` | 在 profile 目录转发 pnpm 管理插件 |

「拒绝插件管理」只针对 Electron 专属的 `desktop` profile，普通 profile 是放行的。
npm 发行物自带 `@deepseek-ai/dsh-web-app` bundle，含 `dsh-host-webserver`、`dsh-web-frontend`
与全套 `dsh-client-ui-*`。

实测结果：

```
GET /orchestrator/api/state
  → setup.problem: null，health.runtime: { state: "ready" }

GET /along-source/api/goals/along-status-probe   （桥接凭证 + 合规身份头）
  → 200 {"service":"along-source","ready":true}
```

第二条正是 `docs/cloud-deploy-multi-user.md` 定义的 Tier 2 就绪契约。

基础 Tier 1 仍关闭事件接入，这是编排选择，不是 Linux 运行时限制。V-1 证明长驻与就绪探针可用；真实模型回合和容器重建验证见 [Host 云端部署经验](host-cloud-deploy.md)。

## 2. settings seed：缺了就永远停在「等待设置」

这是本轮最容易踩、且**症状与原因不相符**的坑。

`dsh-superagent` 的 setup 判定（`src/app/setup.ts:16`）读的是 **Settings 存储层**：

```ts
const localDeployment = (settings: Settings): boolean =>
  settings.sources.along?.enabled === true && settings.sources.github?.enabled === false
```

**不是**插件层的 `disabled: true`。首次启动时 sqlite 里没有 `sources` 记录，setup 便走 GitHub 分支报
`repositoryUnset`，Runtime 停在 `paused / setupPending`，面板一直显示「等待设置」——
但插件层明明已经禁用了 GitHub。

设置必须在**第一次 boot 之前**落库（`assembleAlong` 读已存好的设置来决定是否组装 Along 业务面；
起来之后再补会多一次 Runtime 重启，而重启窗口正是投递丢失窗口）。

两种写法都实测可行：

| 写法 | 做法 | 适用 |
| --- | --- | --- |
| 走 Store API | `node --experimental-transform-types` 引 `src/app/store.ts` 后 `store.saveSettings(...)` | 开发验证；简单，但要能 import TS 源码 |
| 直写 kv 表 | `node:sqlite` INSERT `settings-version:<n>` 与 `settings-revision` 指针 | 正式编排（`deploy/superagent-seed.mjs`） |

直写 kv 的形状必须与 Store 的持久化格式一致：设置是**带版本**的快照，指针 `settings-revision` 指向当前版本号，
`settings-version:<n>` 存第 n 版。**少写指针，`Store.settings()` 读不到设置**；
指针的值是 **JSON 数字**（`Store.get` 对 value 列做 `JSON.parse`）。
只写 kv 表即可，schema 由 Store 自己建；**不要预写 schema 版本键**，那会让 Runtime 以为数据库需要迁移。

Mac 侧的启动器 `tools/activate.mjs:260-265` 已在做同一件事（仅首次建库时写），云端必须复刻。

## 3. 这台 ECS 的网络是硬约束

实测下载速度：

| 源 | 速度 | 后果 |
| --- | --- | --- |
| `files.pythonhosted.org` | **27 kB/s** | Hy-Memory 依赖树直接 `ReadTimeoutError` |
| `mirrors.aliyun.com/pypi` | **176 kB/s** | 换源后可正常下载 |
| `deb.debian.org` | 极慢 | 20 分钟未完成一次 `apt-get install` |

因此镜像构建必须：

- pypi 依赖走 `https://mirrors.aliyun.com/pypi/simple/`；
- **不装编译工具链** —— `hy-memory==2.0.16` 的依赖里 `chromadb` / `kuzu` 都有 cp312 manylinux wheel，
  `langdetect` / `jieba` 是纯 Python sdist（pip 现场构建但不需要 C 编译器）；
- 尽量零 apt 安装；
- 基础镜像在构建机产出，服务器不重复构建（DSH + bundle 合计 2.6 GB）。

## 4. Hy-Memory 在 Linux 上可装

| 项 | 结果 |
| --- | --- |
| 版本 | `hy-memory==2.0.16`（与 Mac 同版本） |
| import 自检 | `hy_memory` / `kuzu 0.11.3` / `chromadb 1.5.9` 全部 OK |
| 编译工具链 | **不需要** |
| 安装体积 | **778 MB** |
| offline 探针 | `kuzu_native_query: true`、`add_search_reopen: true`、1024 维、5.8 秒 |

探针结尾的 `Task was destroyed but it is pending` 与
`AttributeError: 'NoneType' object has no attribute 'execute'` 是**已知现象**，
沿 Agent 仓库 `docs/along/004-phase0-validation.md` §3.3 与 `docs/along/006-memory-implementation.md`
在 Mac 上记录过同一组现象（SDK 关闭时 pipeline trace 未落盘、SQLite cache 连接已关），非 Linux 特有。

**但真实模型质量本轮未验收** —— offline 只证明管道。tier2 的编排目前也没有配 Hy-Memory。

## 5. 资源账（实测）

环境：2 核 / 3.5 GB，同机跑着其他业务容器。

| 组件 | 占用 |
| --- | --- |
| superagent 空载 | 95 MiB RSS（容器 45 MiB） |
| superagent 实际运行中 | 389 MiB（容器） |
| 每路并发 worker | ~150–250 MiB |
| Hy-Memory Python 进程 | ~230 MiB 峰值（Mac 实测） |
| 磁盘 | 镜像 2.6 GB（DSH）+ ~1 GB（Hy-Memory）+ 构建缓存 2.7 GB + 数据卷 |

**建议 4 核 8 GB / 磁盘 60 GB**。2 核 3.5 GB 上跑得起来，但要降级：
`executor.maxWorkers` 从 3 降到 1、`mem_limit` 给 1.5g、不配 Hy-Memory（走 SQLite 降级，
沿文档口径明确「Omit `alongMemory` … this does not silently disable conversations」）。

## 6. 顺带发现的既存问题

`deploy/docker-compose.yml` 的日志配置用了 `max-count`：

```yaml
logging: {driver: json-file, options: {max-size: "10m", max-count: "3"}}
```

Docker 29 的 json-file 驱动**不认这个键**，会直接报错：

```
Error response from daemon: unknown log opt 'max-count' for json-file log driver
```

正确的键是 `max-file`。这会让沿现有的云端编排 `docker compose up` 直接失败 —— 但因为当前
`deploy/docker-compose.yml` 没有被实际使用过，尚未暴露。

## 7. 本轮未覆盖

真实模型调用、Worker 真实执行（真实 Ticket 的 bash 沙箱）、Host 联调（配对 / 事件摄取 / 投递泵端到端）、
公网 TLS 与 CA、长时稳定性与断电恢复、Hy-Memory 真实模型质量。

tier2 分支实现的范围更大（Host 接入、公网 IPv4 HTTPS、TLS 与 CA、回退路径），
这些本轮完全没测 —— 本文只证明 superagent 本体能在 Linux 长驻并承载 Along 数据面。
