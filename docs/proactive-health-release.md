# 主动健康编排与结果展示：集成发布

2026-11-24。本轮将 Along Agent 的主动复评、结果展示契约与客户端健康摘要一起集成。保持原目标、任务、提醒、聊天隔离和配对。先部署兼容 Agent，再安装新增健康摘要的 App；手机安装按用户要求延后到恢复连接。

Agent PR #34 已合并为 `53e3ef0c8b065c4ce1f6b3c3b0b16bf1f2655385`，部署两种 Agent 镜像默认共用该完整 SHA。Along 健康摘要 PR #50 与展示 PR #51 已按依赖合并，最终组合为 App80 / Web89。源码集成不等同实际运行版本；部署及手机验收在工作区发版台账分别记录。

## 发布验收

- 按 Agent → 健康数据 → 结果 UI 的依赖顺序核实并合并固定 PR head；验证两仓契约镜像、跨日/时区、旧结果和重复任务缓存、来源与实际执行证据。
- 统一 App build、Web 缓存参数和两端构建产物，部署默认 Agent pin 使用实际合并完整 SHA。
- 搜索/抓取必须使用严格的已授权 provider 和最小公开查询，保留研究证据与隐私校验；配置就绪、真实请求和推荐完成分别登记。
- 对最终主干 SHA 构建签名包并记录资源一致性。构建、部署、手机安装、健康自然上传、系统通知送达分别验收。

旧客户端的 message.text 继续是最多1200字的明确预览；新 wire.result_text 保存最多16000字完整正文。新版只有在原有 background、task、execution receipt、revision 与 task_execution_revision 校验通过后才将完整正文存入本地text；未知或跨任务字段不扩大权限。完整正文随既有结果投影迁移重放和缓存恢复，普通chat上界保持2000。公开Web与手机仅发布本轮最终组合版本，不单独发布中间展示协议。

新展示字段与完整正文拒绝孤立UTF16代理对；Agent分片/预览保持Unicode标量边界，避免合法emoji被切成iOS无法解析的JSON。旧缓存正文保留，可选展示结构非法时仅丢弃该结构并回退正文，不能清空工作区。

## 本机检查的已有不稳定项

精确基线 bcde2bcc 在此 Mac 上可复现六项 TLS 断言失败：测试用 OpenSSL CLI 的人类可读 subject 文本固定格式提取 CN，LibreSSL 的格式不同会得到 null。证书本身有效。本轮测试改为 Node X509Certificate 独立解析证书的真实主题，保留 CN、有效期、指纹和实际 TLS 握手断言，不修改 Host 证书实现。

多用户隔离测试用固定 200/800ms 的延迟碰并发窗口，在机器繁忙时首个请求可能已结束或未开始。测试改为临时进程的开始/释放文件屏障：确证 A 正在执行时发 A 第二条与 B 第一条，验证 A 第二条 429、B 能在 A 完成前进入执行，再释放并核对两者真实结果。屏障仅属于测试桩，不修改产品锁或超时，不跳过任何安全断言。

验收命令：npm run check、npm run build，必要的 Node/Swift/Xcode 定向回归及跨仓合同验证；环境权限失败与业务失败分别留证。无 CI 工作流的 PR 如实记录本机检查，不能称云端 CI 已通过。


## GitHub Pages 的构建与部署边界

目标与范围：修复同一个 job 内上传后立即读取 artifact 的失败及整 job 重跑产生的同名产物歧义。只调整 `.github/workflows/pages.yml` 与本发布说明；本轮功能、App80 / Web89、产品源码、测试断言、并发策略和权限均不变。

2026-11-24 的原始失败证据：主线 `db5ad370ad9da5d3b23fc8c1eff182848bce3c4a` 的 run `45236078023` attempt 1 全量 check/build/upload 成功，但 deploy 读取到 0 个 artifact；稍后官方 API 已能读取有效产物。attempt 2 整 job 重跑再次上传后，deploy 读取到 2 个同名 `github-pages` 产物并拒绝发布。这是两个不同的失败状态，不能据此认定 check/build 失败，或不断重跑整个 job。

实现方案：

- `build` 保留 `macos-15-intel`、Node 22、`npm ci`、完整 `npm run check`、`npm run build`、configure v5 与 upload v3。
- build 生成 `github-pages-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`，将同一名称用于上传并通过 job output 传给 deploy。名称绑定创建产物的 build attempt。
- `deploy` 使用 `needs: build`，独占 `github-pages` environment、URL output 与 deploy v4。它只读取 `needs.build.outputs.artifact_name`，不能用 deploy 当前的 run attempt 重算名称。
- 保留原 `workflow_dispatch`、permissions、concurrency 和 action 版本；不增加密钥、读取产物的 API、等待脚本或旁路发布通道。

失败恢复：build 成功后优先仅重跑失败的 deploy job，复用原 build 的输出与产物。若重跑所有 job，build 会生成新 attempt 的名称，deploy 仍只选该次 build 的产物，不与历史产物重名。默认 artifact 保留期仍为 1 天；过期后从核实的同一 ref 新发完整 run。保留旧 artifact 与失败日志。job 依赖保证先完成上传，再调度 deploy，但不能据此声称服务端元数据有严格可见性时限；若仍读到 0 个，先保留证据，核实后仅重试 deploy。deploy 的 timeout/reporting_interval 控制发布状态轮询，不能替代 metadata 可见性处理。

验收标准：实际 YAML 可解析，actionlint 通过；完整 `npm run check` 与 `npm run build` 通过，22 份 Web 资源与两端产物一致。最终 main 的真实 workflow 须分别出现成功 build 与 deploy，记录唯一匹配 artifact、名称及源 SHA，线上资源逐字节比对后才记为公开 Web 发布成功。开发执行人仅提交 PR，最终独立审阅、合并和部署由 release verifier 完成；手机仍按用户要求延后更新。

官方契约：[Pages 工作流的 job 依赖](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[deploy-pages v4 的专用 job 用法](https://github.com/actions/deploy-pages/blob/v4/README.md)、[upload v3 的 name 输入](https://github.com/actions/upload-pages-artifact/blob/v3/action.yml)、[deploy v4 的 artifact_name 输入](https://github.com/actions/deploy-pages/blob/v4/action.yml)、[未重跑 job 保留 outputs 的规则](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)。

本机实施验证：独立修复工作树完整 `npm run check` 为 794 通过 / 0 失败 / 9 跳过（803 tests）；`npm run build` 产出 22 份资源，全部与 `web/` 及 iOS 内置资源逐字节一致。实际工作流通过 YAML 唯一键解析和上游 actionlint v1.7.12；执行真实命名 shell 验证 attempt 1 / 2 的名称不同。没有增改测试或改变跳过项。此证据仅覆盖本机，实际 main workflow / 公开 Web 部署仍由独立 release verifier 完成并写工作区发版台账。
