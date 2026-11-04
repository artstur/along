# Along · 健康目标 Demo

手机优先的健康目标体验：iPhone 薄壳按类型读取 Apple Health，确认后把最小摘要导入本机 Along 页面；页面展示步数、体重、健身、睡眠、目标和动态任务。

在线体验：[personality-demo.pages.dev](https://personality-demo.pages.dev/)。

## 当前能体验什么

- 在普通网页点击「连接」会说明 Apple Health 的授权条件；在 [iPhone 原生薄壳](ios/README.md)中会打开逐项选择、读取预览和本机导入确认页。
- 点击「先用演示数据体验」可查看四项示例数据，明确标记为「演示中」。
- 设定「本周健身总时长」或「本月减重」目标。模拟新的健身或体重记录，可以观察目标进度和任务更新。
- 「目标变化实验」固定本周 120 分钟、初始 75 分钟。新增 35 分钟后，Along 计算还差 10 分钟；路由层决定是否重排，本地服务调用 DSH SDK 给出下一步及调整依据。新增 1 分钟或仅改变步数不会调用 Agent。
- 页面状态保存在当前浏览器的 `localStorage`。iPhone 确认导入后，所选健康摘要保存在 App 内 WKWebView 的本地页面数据中；不依赖 Mac 同步服务。

## 运行与构建

先运行 `npm install`。开发服务使用项目安装的 Node 22.23.4；需要本机 DSH 已登录并能调用 `deepseek-account/deepseek-flash`。

```sh
npm run dev
npm run check
npm run build
```

本地地址 `http://localhost:4173`；静态文件在 `dist/`。现有 Cloudflare Pages 使用手动上传，代码提交不会自动更新线上页面。

本地服务只监听 `127.0.0.1`，`POST /api/health-event` 只接收模拟实验的最少字段，并会复核路由，再决定是否启动 DSH SDK。Cloudflare Pages 是静态站，无法常驻 DSH 进程；公网版不会向事件接口发送页面状态，只在固定 75＋35 场景回放一次真实 DSH 输出，并在界面标明「DSH 建议回放」。它不会把其他事件假装成实时 Agent 建议。

## iPhone 原生薄壳

原生项目在 [ios/AlongHealth.xcodeproj](ios/AlongHealth.xcodeproj)，运行步骤与数据口径见 [ios/README.md](ios/README.md)。当前导入流程不需要 `cloudflared`、本机同步服务或配对码。旧的 `sync-server.mjs` 留作独立实验代码，不参与 iPhone App 的健康数据流程。

这版是手动导入：每次由用户选择数据、预览并确认。它不会后台读取健康数据，也不会自动执行健身活动。真实健康数据导入后，页面的目标计算会更新；“目标变化实验”仍是独立的模拟事件与 DSH 对照实验。
