# Along iPhone 薄壳

这是一层原生 HealthKit 连接页，承载现有 Along 网页。只有人在 iPhone 上选择数据类型、看过摘要并确认后，才会把所选摘要导入这台手机上的 Along 页面。

## 在 iPhone 上运行

1. 安装支持手机系统版本的完整 Xcode，打开 [AlongHealth.xcodeproj](AlongHealth.xcodeproj)。例如，iOS 27 需要 Xcode 27。在 Xcode → Settings → Apple Accounts 登录自己的 Apple 账号；然后在 target 的 **Signing & Capabilities** 里选自己的 Team，确认 **HealthKit** capability 已开启。若 bundle ID 与你的签名冲突，改成自己的唯一 ID。
2. 在 iOS 27 + Xcode 27 上，可以打开 Xcode 的 Device Hub，点侧栏的 `+` → **Pair Nearby Device…**，首次通过同一局域网无线配对；也可以用数据线连接。按提示在 iPhone 上完成配对、信任设备并开启开发者模式。选择这台 iPhone 作为运行设备，点 Run。HealthKit 的真实读取需要真机。
3. 在 Along App 的健康目标页点 Apple Health“管理”。上次保存的选择会保持开启，也可点右上角「全部连接」。点“读取并预览”，系统会显示新增类型的 HealthKit 读取权限。确认摘要无误后，点“确认导入本机 Along”。如果选择了健身记录，首页会更新本周运动目标及动态任务；其他摘要保存在本机，连接区简要显示静息心率、手腕温度和活动消耗。不需要 Mac 上的同步服务、配对码或 Tunnel。

网页界面改动后，从仓库根目录运行 `npm run build`，再把 `dist/` 内容同步到 `ios/AlongHealth/Web/`，随后重新构建 App。移动端通过 `along://app/` 自定义协议加载这些内置资源，避免公司网络或 CDN 状态导致启动白屏。

## 读取和发送的范围

| 用户选项 | HealthKit 读取 | 导入本机 Along 页面 |
| --- | --- | --- |
| 步数 | 今日步数累计 | `steps` 整数 |
| 健身记录 | 本周 workout | 总分钟数 `workoutMinutes` 与次数 `workoutCount` |
| 活动消耗 | 今日 `activeEnergyBurned` | `activeEnergyKcal` 整数，单位千卡 |
| 体重 | 最近一次 body mass | `weightKg`，保留一位小数 |
| 静息心率 | 近 7 天最近一次 `restingHeartRate` | `restingHeartRate` 整数，单位次/分 |
| 睡眠期间手腕温度 | 近 30 天最近一次 `appleSleepingWristTemperature` | `wristTemperatureC`，绝对温度 °C，保留一位小数 |
| 睡眠 | 昨晚的 asleep 阶段 | 去重后的 `sleepMinutes` 整数 |

Apple 健康 App 的手腕温度通常展示相对个人基线的偏差；HealthKit 读取的是绝对温度，两者显示口径不同。Apple 睡眠评分没有公开的 HealthKit 读取类型，Along 不会把睡眠时长换算成同名评分；连接页会说明这一限制。

只请求勾选类型的读取权限；不请求写入权限。上次保存的开关表示 Along 已选择在前台自动检查，不代表系统确认了某项读取权限。没有可读取记录时，该值显示为“无可读取记录”；HealthKit 不会让读取方区分“没有记录”和“用户拒绝了读取”。用户至少有一项可读取摘要时才能确认导入。当前页面代码把摘要保存在 App 内 WKWebView 的 `localStorage`，不发送原始样本、逐条运动记录、具体睡眠区间或设备信息。若用户主动把 iPhone 与同一 Wi-Fi 的 Mac 上的 Along 服务连接，目标问答和显著变化的任务重排只发送目标和健身分钟数汇总；连接信息保存在 App 沙盒中，后续会自动恢复。

## 当前边界

- 首次手动授权并确认后，App 在前台为已选类型安装 HealthKit 观察器；页面启动、回到前台也会主动读取，页面可见时每 60 秒兜底检查。HealthKit 观察器不保证秒级通知，当前没有后台交付。页面界面随 App 打包在 `AlongHealth/Web`，不依赖 GitHub Pages 的实时网络；网页更新后需重新运行 `npm run build`、同步 `dist/` 并安装 App。
- 真实健康摘要会驱动网页的目标进度与任务计算。仅在 Along 已连接且有显著健身时长变化时，请求新的任务提案；采用前需用户确认。“目标变化实验”仍是隔离的模拟实验。
- 2026-11-04 已在 iPhone 真机完成签名安装、HealthKit 读取预览、用户确认本机导入和页面更新验证；最终构建也已覆盖安装并启动。HealthKit 对没有匹配记录的统计查询可能返回 `errorNoData`；此时界面显示“无可读取记录”，不会把它当作整个连接失败。
- 当前使用 Xcode 个人团队签名。个人团队的配置文件通常 7 天后到期，届时需重新构建并安装。GitHub 提交和 Pages 更新不会自动更新已安装的 iPhone App；移动端需重新同步内置资源并安装。
