# Along iPhone 薄壳

这是一层原生 HealthKit 连接页，承载现有 Along 网页。只有人在 iPhone 上选择数据类型、看过摘要并确认后，才会把所选摘要导入这台手机上的 Along 页面。

## 在 iPhone 上运行

1. 安装支持手机系统版本的完整 Xcode，打开 [AlongHealth.xcodeproj](AlongHealth.xcodeproj)。例如，iOS 27 需要 Xcode 27。在 Xcode → Settings → Apple Accounts 登录自己的 Apple 账号；然后在 target 的 **Signing & Capabilities** 里选自己的 Team，确认 **HealthKit** capability 已开启。若 bundle ID 与你的签名冲突，改成自己的唯一 ID。
2. 在 iOS 27 + Xcode 27 上，可以打开 Xcode 的 Device Hub，点侧栏的 `+` → **Pair Nearby Device…**，首次通过同一局域网无线配对；也可以用数据线连接。按提示在 iPhone 上完成配对、信任设备并开启开发者模式。选择这台 iPhone 作为运行设备，点 Run。HealthKit 的真实读取需要真机。
3. 在 Along App 中点 Apple Health 的“连接”，勾选需要的类型，点“读取并预览”。系统会显示相应 HealthKit 读取权限。确认摘要无误后，点“确认导入本机 Along”。页面随即显示所选数据和更新后的目标进度；不需要 Mac 上的同步服务、配对码或 Tunnel。

## 读取和发送的范围

| 用户选项 | HealthKit 读取 | 导入本机 Along 页面 |
| --- | --- | --- |
| 步数 | 今日步数累计 | `steps` 整数 |
| 健身记录 | 本周 workout | 总分钟数 `workoutMinutes` 与次数 `workoutCount` |
| 体重 | 最近一次 body mass | `weightKg`，保留一位小数 |
| 睡眠 | 昨晚的 asleep 阶段 | 去重后的 `sleepMinutes` 整数 |

只请求勾选类型的读取权限；不请求写入权限。没有可读取记录时，该值显示为“无可读取记录”；HealthKit 不会让读取方区分“没有记录”和“用户拒绝了读取”。用户至少有一项可读取摘要时才能确认导入。当前页面代码把摘要保存在 App 内 WKWebView 的 `localStorage`，不发送原始样本、逐条运动记录、具体睡眠区间或设备信息，也不连接 Mac 服务。模拟实验的数据与 HealthKit 摘要隔离；公网版直接读取静态 DSH 回放，不向事件接口 POST 页面状态。

## 当前边界

- 这是手动导入；没有后台 HealthKit 观察器或定期读取。页面界面仍从 `personality-demo.pages.dev` 加载，所以打开 App 需要网络；当前代码路径在导入后把摘要留在 WKWebView 本地，但远程页面将来更新时也能访问这份本地数据。若要完全离线和固定代码版本，需把页面资源打包进 App。
- 真实健康摘要会驱动网页的目标进度与本地任务计算。“目标变化实验”仍是模拟事件驱动的独立实验，不会把真实健康数据直接送入 DSH Agent。
- 2026-11-04 已在 iPhone 真机完成签名安装、HealthKit 读取预览、用户确认本机导入和页面更新验证；最终构建也已覆盖安装并启动。HealthKit 对没有匹配记录的统计查询可能返回 `errorNoData`；此时界面显示“无可读取记录”，不会把它当作整个连接失败。
- 当前使用 Xcode 个人团队签名。个人团队的配置文件通常 7 天后到期，届时需重新构建并安装。GitHub 提交不会自动更新已安装的 iPhone App；现有 Cloudflare Pages 项目也采用手动上传，提交不会自动更新网页。
