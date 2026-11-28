# ATS-88 独立复核

复核对象为 Along `ffa95c53db4e368faf7208c5ef8c0c71226cc55a`（交接分支 `agent/work-space-bunny/83e9259335fc`），父提交为 `786c89210259b6452889d6f877a0a29bd8ecfe6a`。核对时 `origin/main` 为 `187ed04af980bed7903579218d3300ee86b16c20`。验收依据为工单首条范围和验收评论、方案设计附件、实现交接。建议退回需求实现，修正状态与昵称归属后，在主干候选版本复验。

## 验收逐项

| 验收项 | 已验证 | 结论 |
| --- | --- | --- |
| 从 App 进入设置并查看三项及状态 | macOS WKWebView 加载构建产物里的同一套 `along://app/` 内置资源，验证顶栏入口、三段和返回。iOS 模拟器构建成功，专用模拟器启动卡在 `Booting`。 | WKWebView 页面接线通过，iOS 实机交互待验。 |
| 新用户可设置、已配对用户可修改，重启保留最近昵称和原 UID | macOS WKWebView 以实际 DOM 表单保存昵称，重新创建 WebView 后读回。页面测试还覆盖已有昵称修改、配对后认领、保留 UID 和配对凭据。独立用例复现两个 Host 下的串昵称，以及不同 UID 依次保存后原昵称丢失。 | 身份隔离不通过。iOS 实际容器与覆盖安装见待验。 |
| 数据源授权与连接，拒绝、撤销或失败可准确展示并重试 | 页面调用既有 Apple Health 和按目标的 OKX 桥接。Apple Health 使用真实原生回包形状复现空结果及异步读取失败。OKX 状态回执变化及已排队撤回同样有可复现偏差。 | 状态准确性不通过。真实授权、撤权与 OKX 回执见待验。 |
| 首次配对、旧配对继续可用，失败和中断有明确状态及重试 | 设置表单接真实隔离 Host、测试上游，错码得 403，正常码得 200。`/connection/verify` 200 和 `/connection/status` 503 同时成立时，页面给出相互矛盾的状态。重试覆盖 Agent 由失败转就绪，以及停止、重启 Host 后复用原绑定。另跑真实 Tier 2 Compose，双用户配对、TLS 及重建后原绑定继续可用。 | 错码、状态恢复和服务端原绑定复用通过。部分失败提示不通过。真机 Keychain 和升级见待验。 |
| 交接位置、构建、自测及实机条件 | 远端分支与待验提交一致。Web 产物重建后与提交里的 iOS 内置文件逐字一致。模拟器与真机目标均通过无签名编译。 | 交接证据齐全。集成到主干有冲突，实际装机尚未完成。 |

## 复现与落点

### P1 健康数据不可读仍显示「已连接」

- 曾导入并允许 Agent 评估后，当原生回读每项值均为空时可触发。拒绝、撤权或无样本均可产生这种回包。另一路是在设置打开时，让正在等待的原生读取返回失败。
- 预期空结果显示「无可读取记录」，提示检查系统权限或记录并可重试。读取失败应在当前页面立即可见。
- 实测全空回包显示「已连接 · 已允许 Agent 评估」，异步错误后仍显示「检查中」，离开再打开才变为「读取失败」。`web/app.mjs:1417` 只看来源和本机评估偏好，`web/app.mjs:3249` 的失败分支只在首页重绘。原生回包见 `ios/AlongHealth/Sources/HealthModels.swift:379`。

### P1 昵称在另一个 Host 同 UID 下显示，并会被覆盖

- 在 Host A 保存昵称，再配对到回传相同 UID 的 Host B。另一个独立场景是在不同 UID 的 A、B 分别保存昵称，再重配对回 A。
- 预期昵称按已确认 Host 与 UID 隔离，返回 A 后恢复 A 最后一次保存的昵称。
- 实测 B 显示 A 的昵称，B 保存后 A 显示 B 的昵称。不同 UID 下，B 保存也会覆盖本机唯一记录，A 的原昵称消失。见 `web/app.mjs:769`、`web/user-profile.mjs:36`、`:50`。复现使用两个模拟身份响应，从真实设置表单提交和切换。

### P2 配对写入成功、Agent 未就绪时提示已连接

- 当隔离 Host 的 `/pair` 和 `/connection/verify` 返回 200，上游未就绪使 `/connection/status` 返回 503 时触发。
- 预期显示已配对、服务暂不可用，使用现有凭据重试。Host 不可达、凭据失效与 Agent 未就绪应按可观测结果提示。
- 实测设置卡显示「连接需处理」，同一操作弹出「已连接 Along，之后会自动恢复」。`refreshAgentConnection()` 将错误转为状态后返回，提交处理器仍无条件发成功提示。见 `web/app.mjs:669`、`:2251`、`:2253`。

### P2 OKX 状态在重开设置后仍旧，撤回待同步信息丢失

- 打开有 OKX 推荐目标的设置，首次原生回包为 `connected/pending`。原生后续收到 Host 确认时退出重开设置。另一路从原生管理页返回 `disconnected/pending`。
- 预期重开设置时回读，收到回执后显示 Host 已接收。撤回排队期间，说明本机已停止采集且仍待 Host 接收。
- 实测重开仍显示「等待同步到 Mac」，打开原生管理页后才更新。撤回排队仅显示「尚未连接」。当前选中另一个目标时，设置页省略 OKX 行，用户需先切到获推荐的目标。见 `web/app.mjs:1430`、`:1448`、`:1580`、`:1602`。原生对撤回待同步已有单独口径，见 `ios/AlongHealth/Sources/PhoneSourceCoordinator.swift:489`。

## 主干集成

`git merge-tree --write-tree origin/main HEAD` 在 `web/app.mjs`、`web/sw.js` 及两份 App 内置对应文件报冲突。主干已有 PR #82 的等待态三点与 `along-shell-v108`，待审提交也使用 `v108`，但仍含等待态可见文字。合并时保留 PR #82 行为，将资源标识升到新值，重新生成内置文件并核对覆盖更新。`git diff --check HEAD^...HEAD` 通过。

## 复核命令与结果

在 Along 的独立检出运行，Node `v22.22.3`，Xcode `27.2`。

```sh
git worktree add --detach ../review-ffa95c5 ffa95c53db4e368faf7208c5ef8c0c71226cc55a
cd ../review-ffa95c5
npm ci
npm run build && git diff --exit-code -- ios/AlongHealth/Web
git diff --check HEAD^...HEAD
git merge-tree --write-tree origin/main HEAD
xcodebuild -project ios/AlongHealth.xcodeproj -scheme AlongHealth \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath ../review-xcode-ffa95c5 \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project ios/AlongHealth.xcodeproj -scheme AlongHealth \
  -destination 'generic/platform=iOS' -derivedDataPath ../review-xcode-device-ffa95c5 \
  CODE_SIGNING_ALLOWED=NO build
node --test --test-concurrency=2 test/app-settings-page.test.mjs test/user-profile.test.mjs \
  test/pairing-host-verify.test.mjs test/host-multi-user-pairing.test.mjs \
  test/ios-health-refresh.test.mjs test/ios-health-import-admission.test.mjs \
  test/ios-okx-connection.test.mjs test/ios-connection-migration.test.mjs \
  test/device-source-routes.test.mjs
node --test --test-concurrency=2 test/app-cloud-connection.test.mjs test/ios-health-transport-tls.test.mjs
ALONG_TIER2_INTEGRATION=1 node --test test/tier2-linux-integration.test.mjs
ALONG_PUBLIC_IP_INTEGRATION=1 node --test test/public-ip-compose.test.mjs
cd ..
node ats88-review-probe.mjs
xcrun swiftc -swift-version 5 WebKitReview.swift -o webkit-review
./webkit-review review-xcode-ffa95c5/Build/Products/Debug-iphonesimulator/AlongHealth.app/Web
```

- Web 生成 23 个文件，iOS 内置目录没有差异。两个 Xcode 构建均 `BUILD SUCCEEDED`。
- 设置、Host、配对与数据源专项回归 59 项全部通过，云连接、真实原生指纹验证专项 14 项全部通过。
- Tier 2 真实隔离 Compose 集成 1 项通过，约 153 秒。覆盖 TLS、双用户配对、事件同步、Host/Agent 与网络锚点重建、同根换叶，以及回退到 Tier 1。测试使用合成用户、CA、模型密钥占位及仓库锁定的 Along Agent，容器和数据卷已收尾。
- 公网 IP 隔离 Compose 使用合成 IP 证书与 ACME 替身，连接真实 nginx、Host 和 Along Agent。`ffa95c5` 首次验过 IP SAN、双用户配对和原绑定鉴权，随后在 `test/public-ip-compose.test.mjs:195` 的第二张叶证书检查收到不同指纹。父提交 `786c892` 同命令通过，`ffa95c5` 同命令复跑通过。复跑覆盖换叶、错 SAN 拒绝、回滚和两份原绑定继续使用。`ffa95c5` 未改 Host、部署实现或该用例，首次失败原因仍待定位。
- 独立脚本可复现上述状态和身份缺陷，退出 0 表示成功复现。Host 使用临时状态目录和测试上游。页面通过仅回环的 HTTPS 客户端接入真实 Host，自签证书的信任由原生 TLS 专项另验。iOS 桥接由测试替身接入。脚本与检出目录 `review-ffa95c5` 并排放置。
- macOS WKWebView 的入口、三段、真实 DOM 保存、重建 WebView 后回读和返回操作均通过。测试使用嵌入产品包的页面，数据存储独立。`WebKitReview.swift` 可复跑。
- 首次 `npm run check` 与 Xcode 构建并行，937 项、926 通过、5 失败、6 跳过。失败涉及 Swift 编译（2 项）、Host 启动或结果回读（2 项）、runner 完成等待（1 项）。复跑同一语法检查并执行 `node --test --test-concurrency=3 test/*.test.mjs` 后 937 项、931 通过、0 失败、6 跳过。跳过项涉及显式集成开关、相邻仓库及本机双来源 IP 条件。

## 待用设备和服务端完成

- `xcrun devicectl list devices` 所列两台物理设备均 `unavailable`。专用 iPhone 17 Pro / iOS 26.3 模拟器启动超时，`simctl install`、`simctl launch` 均返回 CoreSimulator 405。需要可连接且解锁的测试 iPhone、可签名安装的同 Bundle ID 旧包和新包。先覆盖验证已有工作区 Keychain、UID、原任务与提醒，再用隔离安装验证新用户配对、昵称强退后持久性和原生页面动作。
- 在测试 iPhone 上准备至少一项可用 Apple Health 摘要。分别执行授权导入、拒绝、系统设置撤权、重新授权与无样本情形，回前台核对页面与实际读数。系统读取权限与空样本无法直接区分，验收应判断无可读取记录的提示是否准确。
- OKX 需要获推荐的测试目标、隔离账户仅只读凭据、手机到 OKX 与 Host 的网络。核对原生表单、真实只读核验、本机连接、Host 回执、断开和撤回后重连。
- 服务端联调需要测试 iPhone、一台隔离的实际 Along Host 和运行中的 Along Agent。分别测私网证书指纹、公网系统信任、错误和过期配对码、已有绑定的覆盖升级，以及 Host 与 Agent 分别恢复后的状态。App 真机到真实 Agent 的全链路仍待核对。
- 昵称是否供 Agent 称呼及跨设备同步，沿用交接里的待确认边界。本轮验收按本机昵称处理。
