# Along · 目标工作台 Demo

手机优先的目标工作台：顶部下拉切换健康、理财示例与用户自定义目标；首页突出目标进度和动态任务，连接来源只显示与当前目标相关的状态。

在线体验：[artstur.github.io/Personality-Demo](https://artstur.github.io/Personality-Demo/)（GitHub Pages）。

## 当前能体验什么

- 健康示例是「本周累计运动 120 分钟」。在 [iPhone 原生薄壳](ios/README.md)连接 Apple Health 后，按用户选择的摘要计算进度和下一步；连接页支持一键选择全部可读指标，已保存的选项再次打开时保持开启。普通网页可主动选择演示健康数据。
- 理财示例是「三个月存下 ¥10,000 应急金」。点击「体验连接」后才出现 ¥3,200 的演示余额；模拟新增 ¥800 后，进度与任务文字随之更新。它没有接入蚂蚁财富或任何真实理财账户，不读取账户，也不转账或交易。
- 下拉选择「＋ 定义新目标」，即可用自然语言告诉 Codex 期限、偏好和约束。Codex 返回受白名单约束的目标空间与动态任务；用户点「采用」后才更新首页。iPhone 需要和运行 Agent Host 的 Mac 在同一 Wi-Fi。
- 动态任务卡片可点击进入 Super Agent 协作视图。每个任务映射为独立 Ticket，展示 Source → Trigger → Eval → Ticket 编排链路、Mandate 授权边界，以及协调、情境、计划和守护四类 Agent 的分工、工作状态、进度和交付。当前是 Along 本地可解释编排层，不宣称四个模型在后台长期运行。
- HealthKit 记录在 App 打开、回到前台、收到前台 HealthKit 更新通知时重新读取；页面可见期间还每 60 秒兜底检查。小变化安静处理；显著的健身时长变化形成待确认的任务提案。当前没有后台实时同步，也不自动完成运动。
- 原有「目标变化实验」保留在健康目标页底部：固定 75＋35 分钟场景展示 Along 计算、路由判断与 Agent 建议；轻微或无关变化保持安静。
- 页面状态保存在当前浏览器的 `localStorage`。iPhone 确认导入后，所选健康摘要保存在 App 内 WKWebView 的本地页面数据中；旧健康目标数据也会保留，不依赖 Mac 同步服务。

## 运行与构建

先运行 `npm install`。开发服务使用项目安装的 Node 22.23.4；目标共创需要本机已登录的 Codex CLI。

```sh
npm run dev
npm run check
npm run build
```

本地地址 `http://localhost:4173`；静态文件在 `dist/`。

后续更新：提交并推送 `main` 后，GitHub Actions 自动运行检查、构建并部署 GitHub Pages。iPhone 使用随 App 打包的 `ios/AlongHealth/Web`，网页改动需先运行 `npm run build`，把 `dist/` 同步到该目录，再在 Xcode 重新构建并安装。

`npm run dev` 的本地服务只监听 `127.0.0.1`，`POST /api/health-event` 仍用于原有模拟实验。GitHub Pages 是静态站，无法常驻 Codex 进程；目标共创仍通过同一 Wi-Fi 的 Mac Agent Host 完成。

## 同一 Wi-Fi 的真实 Codex Agent

在 Mac 本项目目录运行 `npm run agent-host`。终端显示局域网 HTTPS 地址、SHA-256 证书指纹和 15 分钟有效的一次性配对码。iPhone App 的目标编辑页填入这三项，随后即可问答。Agent Host 默认只绑定 Mac 的 Wi-Fi 地址，退出终端即停止服务；没有公网通道。证书由 Mac 本地生成，iPhone 原生网络层校验指纹后才传输，配对后请求使用随机令牌。

健康目标问答只发送当前目标与已选健身时长的汇总值，不发送原始 HealthKit 记录；自定义目标只发送用户主动输入的目标文本。Codex 通过非交互模式输出严格 JSON Schema，再由 Along 二次验证、绑定可信指标并渲染；用户确认后才改变目标空间。健康变化的流程是 HealthKit 来源 → 有意义变化筛选 → 待处理任务 → Codex 生成提案 → 用户确认。任务详情页进一步落地了 Ticket、Mandate 和 Assignment 概念，但不宣称存在后台长期运行的独立 Worker。

Mac 关闭或网络断开时，首页的确定性进度仍可更新，Agent 问答和任务提案会显示不可用。配对令牌的哈希值保存在 Mac 本机 `~/.along/agent-host/pairing.json`，正常重启 Host 后无需重新配对；主动点「重新配对」会替换旧令牌。

## iPhone 原生薄壳

原生项目在 [ios/AlongHealth.xcodeproj](ios/AlongHealth.xcodeproj)，运行步骤与数据口径见 [ios/README.md](ios/README.md)。当前导入流程不需要 `cloudflared`、本机同步服务或配对码。旧的 `sync-server.mjs` 留作独立实验代码，不参与 iPhone App 的健康数据流程。

首次仍需用户逐项选择、预览并确认。之后 App 在前台观察已选择的类型，回到前台也会刷新摘要。HealthKit 前台通知只表明数据发生变化；Along 会重新查询，并不会保证秒级同步。后台交付尚未启用。
