# Along · 健康目标 Demo

手机优先的单页体验：展示 Apple Health 连接入口、查看步数/体重/健身/睡眠、设定目标、查看随数据变化的任务。

在线体验：[personality-demo.pages.dev](https://personality-demo.pages.dev/)。

## 当前能体验什么

- 点击「连接」会说明 Apple Health 的实际授权条件。普通网页无法直接读取 HealthKit；此页面当前没有原生 iOS 容器，不会伪装成已连接。
- 点击「先用演示数据体验」可查看四项示例数据，明确标记为「演示中」。
- 设定「本周健身总时长」或「本月减重」目标。模拟新的健身或体重记录，可以观察目标进度和任务更新。
- 状态只保存在当前浏览器的 `localStorage`。旧版 Along 状态使用独立 key，不会混入新版健康数据。

## 运行与构建

需要 Node.js 20+，无运行依赖。

```sh
npm run dev
npm run check
npm run build
```

本地地址 `http://localhost:4173`；静态文件在 `dist/`。现有 Cloudflare Pages 使用手动上传，代码提交不会自动更新线上页面。

## 下一步接入 iOS

页面预留 `window.AlongHealthBridge.connect({types:['steps','weight','workout','sleep']})`，调用方应返回 `{steps,weightKg,workoutMinutes,workoutCount,sleepMinutes}`。步数是当天值，健身是本周累计，睡眠是最近一晚时长。体重和睡眠可以为 `null`。原生 iOS 容器需要请求 HealthKit 读取权限、完成查询，再提供这个桥接接口。

此版仅完成前端接口约定；尚无 iOS 原生实现、DSH 后台或自动执行的 Agent。
