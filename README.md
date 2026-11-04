# Along · 目标工作台 Demo

手机优先的目标工作台：顶部下拉切换健康与理财两个示例目标；首页突出目标进度和动态任务，连接来源只显示与当前目标相关的状态。

在线体验：[personality-demo.pages.dev](https://personality-demo.pages.dev/)。

## 当前能体验什么

- 健康示例是「本周累计运动 120 分钟」。在 [iPhone 原生薄壳](ios/README.md)连接 Apple Health 后，按用户选择的摘要计算进度和下一步；普通网页可主动选择演示健康数据。
- 理财示例是「三个月存下 ¥10,000 应急金」。点击「体验连接」后才出现 ¥3,200 的演示余额；模拟新增 ¥800 后，进度与任务文字随之更新。它没有接入蚂蚁财富或任何真实理财账户，不读取账户，也不转账或交易。
- 首页只呈现目标、任务和连接状态。点击目标或任务后的 Agent 运行页留待后续迭代。
- 原有「目标变化实验」保留在健康目标页底部：固定 75＋35 分钟场景展示 Along 计算、路由判断与 DSH 建议；轻微或无关变化保持安静。
- 页面状态保存在当前浏览器的 `localStorage`。iPhone 确认导入后，所选健康摘要保存在 App 内 WKWebView 的本地页面数据中；旧健康目标数据也会保留，不依赖 Mac 同步服务。

## 运行与构建

先运行 `npm install`。开发服务使用项目安装的 Node 22.23.4；需要本机 DSH 已登录并能调用 `deepseek-account/deepseek-flash`。

```sh
npm run dev
npm run check
npm run build
```

本地地址 `http://localhost:4173`；静态文件在 `dist/`。现有 Cloudflare Pages 使用手动上传，代码提交不会自动更新线上页面。

后续更新：提交并推送 GitHub 后，运行 `npm run build`，再用 `npm exec --yes --package=wrangler@4 -- wrangler pages deploy dist --project-name personality-demo --branch main` 更新静态页面。iPhone 原生代码变更需在 Xcode 重新构建并安装；这两个发布动作都不需要临时公网通道。

本地服务只监听 `127.0.0.1`，`POST /api/health-event` 只接收模拟实验的最少字段，并会复核路由，再决定是否启动 DSH SDK。Cloudflare Pages 是静态站，无法常驻 DSH 进程；公网版不会向事件接口发送页面状态，只在固定 75＋35 场景回放一次真实 DSH 输出，并在界面标明「DSH 建议回放」。它不会把其他事件假装成实时 Agent 建议。

## iPhone 原生薄壳

原生项目在 [ios/AlongHealth.xcodeproj](ios/AlongHealth.xcodeproj)，运行步骤与数据口径见 [ios/README.md](ios/README.md)。当前导入流程不需要 `cloudflared`、本机同步服务或配对码。旧的 `sync-server.mjs` 留作独立实验代码，不参与 iPhone App 的健康数据流程。

这版是手动导入：每次由用户选择数据、预览并确认。它不会后台读取健康数据，也不会自动执行健身活动。真实健康数据导入后，页面的目标计算会更新；“目标变化实验”仍是独立的模拟事件与 DSH 对照实验。
