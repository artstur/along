# Along iPhone 薄壳

这是一层原生 HealthKit 连接页，承载现有 Along 网页。只有人在 iPhone 上选择数据类型、看过摘要并点“确认并同步”后，才会发送数据。

## 在 iPhone 上运行

1. 安装完整 Xcode，打开 [AlongHealth.xcodeproj](AlongHealth.xcodeproj)。在 target 的 **Signing & Capabilities** 里选自己的 Team，确认 **HealthKit** capability 已开启。若 bundle ID 与你的签名冲突，改成自己的唯一 ID。
2. 用数据线连接 iPhone，按 Xcode 提示信任设备并开启开发者模式。选择这台 iPhone 作为运行设备，点 Run。HealthKit 的真实读取需要真机。
3. 在 Mac 上的项目根目录执行 `npm install`、`npm run sync-server`。终端会显示仅 10 分钟有效的一次性 8 位配对码。服务默认只监听 `127.0.0.1:4175`。
4. 为手机建立临时 HTTPS 地址。安装 [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) 后，另开终端执行 `cloudflared tunnel --url http://127.0.0.1:4175`，记下输出的 `https://…trycloudflare.com` 地址。服务和 tunnel 两个终端都要保持运行。临时地址会变化；每次重启同步服务都会产生新的配对码。不要把配对码公开分享。
5. 在 Along App 中点 Apple Health 的“连接”，勾选需要的类型，点“读取并预览”。系统会显示相应 HealthKit 读取权限。确认摘要无误，输入上面的 HTTPS 地址和配对码，点“确认并同步到 Along”。成功后，网页显示所选数据和更新后的目标进度。

配对成功后凭证保存在 iPhone Keychain；同一同步服务再次使用时可不填配对码。同步服务删除或更换配对凭证后，需要重启服务并重新配对。Mac 关闭服务时，iPhone 无法继续同步。

## 读取和发送的范围

| 用户选项 | HealthKit 读取 | 发送给 Along 服务 |
| --- | --- | --- |
| 步数 | 今日步数累计 | `steps` 整数 |
| 健身记录 | 本周 workout | 总分钟数 `workoutMinutes` 与次数 `workoutCount` |
| 体重 | 最近一次 body mass | `weightKg`，保留一位小数 |
| 睡眠 | 昨晚的 asleep 阶段 | 去重后的 `sleepMinutes` 整数 |

只请求勾选类型的读取权限；不请求写入权限。没有可读取记录时，该值显示为“无可读取记录”；HealthKit 不会让读取方区分“没有记录”和“用户拒绝了读取”。服务端拒绝未勾选类型的字段，也不接收原始样本、逐条运动记录、具体睡眠区间或设备信息。用户至少有一项可读取摘要时才能确认同步。

服务将最近一次摘要存于 Mac 的 `~/.along/health-summary.json`（文件权限 `0600`），配对凭证仅存哈希。已配对客户端可通过 `GET /api/health-sync` 读回，或 `DELETE /api/health-sync` 删除。iPhone 只访问 HTTPS 地址；Quick Tunnel 充当传输中继，数据会经过 Cloudflare。如果不希望使用该中继，可以换成自己控制的 HTTPS 入口。

## 当前边界

- 这是手动同步；没有后台 HealthKit 观察器或定期读取。
- 真实健康摘要会驱动网页的目标进度与本地任务计算。“目标变化实验”仍是模拟事件驱动的独立实验，不会把真实健康数据直接送入 DSH Agent。
- 项目源码已提供，但只有安装完整 Xcode 并在真机上运行后，才能完成 HealthKit 授权与签名验证。
