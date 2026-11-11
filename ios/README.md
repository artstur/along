# Along for iPhone

这是一层原生 HealthKit 连接页，承载现有 Along 网页。只有人在 iPhone 上选择数据类型、看过摘要并确认后，才会把所选摘要导入这台手机上的 Along 页面。

## 在 iPhone 上运行

1. 安装支持手机系统版本的完整 Xcode，打开 [AlongHealth.xcodeproj](AlongHealth.xcodeproj)。例如，iOS 27 需要 Xcode 27。在 Xcode → Settings → Apple Accounts 登录自己的 Apple 账号；然后在 target 的 **Signing & Capabilities** 里选自己的 Team，确认 **HealthKit** capability 已开启。若 bundle ID 与你的签名冲突，改成自己的唯一 ID。
2. 在 iOS 27 + Xcode 27 上，可以打开 Xcode 的 Device Hub，点侧栏的 `+` → **Pair Nearby Device…**，首次通过同一局域网无线配对；也可以用数据线连接。按提示在 iPhone 上完成配对、信任设备并开启开发者模式。选择这台 iPhone 作为运行设备，点 Run。HealthKit 的真实读取需要真机。
3. 在目标首页的 Apple Health 连接卡点「连接」或「管理」，选择所需类型，点「读取并预览」，然后点「导入并允许 Agent 评估」。iPhone 在本机读取摘要和更新进度。自动编排还需要手机能够访问已配对的 Mac。具名目标通过自己的连接卡关联摘要，提案和采用后的任务保存在该目标中。

已有健康目标会在收到首份已授权摘要后复核。之后，读数变化或到了 Agent 指定的复查时间会再次触发评估；相同内容的重复读取保持安静。调整建议显示在动态任务上方，可以查看具体变化并采用。局域网地址变化时，可在「编辑目标」里更新 Mac 地址并验证原配对。

网页界面改动后，从仓库根目录运行 `npm run build`（会同时写入 `dist/` 与 `ios/AlongHealth/Web/`），随后重新构建 App。移动端通过 `along://app/` 自定义协议加载这些内置资源，避免公司网络或 CDN 状态导致启动白屏。

## 读取和发送的范围

| 用户选项 | HealthKit 读取 | 导入本机 Along 页面 |
| --- | --- | --- |
| 步数 | 今日步数累计 | `steps` 整数 |
| 健身记录 | 本周 workout，确认情境评估后增加近 28 天汇总 | 本周总时长和次数、今天和昨天的运动量，以及按类型、星期和时段聚合的习惯 |
| 活动消耗 | 今日 `activeEnergyBurned` | `activeEnergyKcal` 整数，单位千卡 |
| 体重 | 最近一次 body mass | `weightKg`，保留一位小数 |
| 静息心率 | 近 7 天最近一次 `restingHeartRate` | `restingHeartRate` 整数，单位次/分 |
| 睡眠期间手腕温度 | 近 30 天最近一次 `appleSleepingWristTemperature` | `wristTemperatureC`，绝对温度 °C，保留一位小数 |
| 睡眠 | asleep 阶段，确认情境评估后增加近 7 天汇总 | 去重后的分钟数、覆盖天数、平均时长、最近记录的睡眠结束时间 |

Apple 健康 App 的手腕温度通常展示相对个人基线的偏差；HealthKit 读取的是绝对温度，两者显示口径不同。Apple 睡眠评分没有公开的 HealthKit 读取类型，Along 不会把睡眠时长换算成同名评分；连接页会说明这一限制。

只请求勾选类型的读取权限；不请求写入权限。上次保存的开关表示 Along 已选择在前台自动检查，不代表系统确认了某项读取权限。没有可读取记录时，该值显示为“无可读取记录”；HealthKit 不会让读取方区分“没有记录”和“用户拒绝了读取”。用户至少有一项可读取摘要时才能确认导入。当前页面代码把摘要保存在 App 内 WKWebView 的 `localStorage`，不发送原始样本、逐条运动记录、具体睡眠区间或设备信息。若用户主动把 iPhone 与同一 Wi-Fi 的 Mac 上的 Along 服务连接，旧版导入仅允许分享已选的周运动分钟数。要启用情境重排，请通过 Apple Health → 管理 → 读取并预览 → 导入并允许 Agent 评估。手机会向已配对的 Mac 发送勾选类型的汇总、相邻两次观察的变化、当前目标、已有任务与近期反馈。连接信息保存在 iPhone Keychain。

网页健康目标页的「清除本机健康摘要」会一次做四件事：清掉页面 `localStorage` 里的摘要、清掉 App 保存的读取选择（`along.health.selectedTypes`）、停掉 HealthKit 观察、清掉待处理任务票（里面存着真实健身分钟数）。只清页面缓存是不够的——原生侧不停读，下一次前台刷新会把摘要原样写回来。系统层面的读取权限仍需到 iOS「设置 → 健康 → App 与服务 → Along」里撤销。

同一次只允许一个健康导入在进行中：在原生弹层还没选完时再点一次「连接 Apple Health」，这次会明确收到「已有健康数据导入正在进行」，不会被静默丢掉（网页那边的等待会一直悬着，界面看上去像点了没反应）。

## Agent 结果通知

在 iPhone 上第一次把目标或动态任务交给 Agent 时，Along 会请求系统通知权限。只有真实 Agent 运行完成、输出通过校验且包含明确下一步时，网页才把结构化通知交给原生 `UNUserNotificationCenter`；相同 Request ID 会在本机去重。点通知会回到对应目标提案或动态任务，通知本身不会替用户采用提案或执行外部操作。

新决策在 App 前台或下次打开读到工单后可发本机通知。你采用定时任务后，由 iOS 在指定时间提醒，后续采用的改期或取消会同步到系统队列。App 挂起时不会持续轮询 Mac，当前未接 APNs。

## 当前边界

- 首次手动授权并确认后，App 在前台为已选类型安装 HealthKit 观察器；页面启动、回到前台也会主动读取，页面可见时每 60 秒兜底检查。HealthKit 观察器不保证秒级通知，当前没有后台交付。页面界面随 App 打包在 `AlongHealth/Web`，不依赖 GitHub Pages 的实时网络；网页更新后需重新运行 `npm run build` 并重新安装 App。
- 在已连接并授权的前提下，新的健康观察、用户反馈和 Agent 指定的复查时间会触发情境评估。Agent 可以保留安排、提出调整或请求信息。保留安排时静默，调整由你采用。“目标变化实验”仍是隔离的模拟实验。
- HealthKit 对没有匹配记录的统计查询可能返回 `errorNoData`；此时界面显示“无可读取记录”，不会把它当作整个连接失败。
- 当前使用 Xcode 个人团队签名。个人团队的配置文件通常 7 天后到期，届时需重新构建并安装。GitHub 提交和 Pages 更新不会自动更新已安装的 iPhone App；移动端需重新同步内置资源并安装。
- 新目标输入和动态任务详情都已接入 Mac 上独立运行的 DSH Super Agent。目标页展示真实的 Source、Main Session、Ticket、Worker、子 Agent 分工、进展、输出与最终综合结果；任务页展示 Source、Eval、Ticket、Assignment 和 Report。Mac 服务或 GitHub Agent 账号未就绪时，页面明确显示阻塞原因，不会本地模拟完成。
