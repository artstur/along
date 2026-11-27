# Bug#5 · App 页面被双指捏合整体放大

## 正确行为

在 Along iPhone App 里，普通页面（内置页面）的比例固定在 1 倍：双指张开放大、双指收拢缩小，都不改变页面比例。
单指滚动、点按、输入照旧；iOS 辅助功能缩放是系统级能力，不受这里影响。
保持原有缩放行为的是：网页版本（GitHub Pages）、独立内容页（原生允许的 `https://artstur.github.io/Personality-Demo/`
用自己的 viewport）、以及 iOS 辅助功能缩放。本仓 `web/` 里没有自实现双指手势的控件（`grep` 零命中），这一条没有对象。

## 现象与复现

用户原话：APP 页面不应该能双指滑动放大。

复现（模拟器真实触点，见「实测证据」）：在 App 首页双指张开，品牌文字「along」的辅助功能 frame
从 61.56×31.41 变成 92.96×47.74（高度比 ×1.52），页面被整体放大。

## 范围与方案

- 只禁 Along iOS App 的普通页面。网页版本（GitHub Pages）与独立内容页不跟着锁。
- 改一处：`web/index.html` 在 head 里就地改写 viewport，只有 `along://` 的内置页面才锁。
  App 与网页版本的区别本来就用 `location.protocol === 'along:'` 表达（`web/app.mjs` 的 `nativePage`）。
- 锁的内容是 `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover`：
  宽度与初始比例不动，只收掉缩放范围。
- 不改静态 viewport：改了会连网页版本一起锁（Android 等认 `user-scalable=no` 的浏览器会跟着失去双指缩放），
  超出本轮范围。静态 viewport 保持原样，网页版本仍可缩放。
- 不动原生代码：`ios/AlongHealth/Sources/AlongShellView.swift` 无改动。

### 为什么是这一层（模拟器实测，不是源码推断）

| 方案 | 实测结果 | 结论 |
| --- | --- | --- |
| `scrollView.pinchGestureRecognizer?.isEnabled = false` + `maximumZoomScale = 1` | 页面仍放大 ×1.56～×1.84 | WebKit 的页面双指缩放不走 UIScrollView 的捏合识别器，原生容器拦不住 |
| 延迟到加载后再补一次同样的原生锁 | 第一次捏合被挡住，第二次又放大 ×1.52 | 原生锁不稳定，WebKit 会把缩放上限抬回去 |
| CSS `touch-action: pan-x pan-y`（只在 App 内置页面上） | 页面仍放大 ×1.68 | WebKit 的页面双指缩放不归 `touch-action` 管；`none` 能挡住但会连单指滚动一起关掉 |
| viewport `maximum-scale=1, user-scalable=no` | 两个方向的比例都是 1.0000 | 有效。WKWebView 认这两个参数；Safari（自己的 App 与 SFSafariViewController）从 iOS 10 起忽略它们，所以网页版本在 iPhone 上不受这条影响 |

## 验收标准

1. 首页与另一个普通页面：双指张开、双指收拢，页面比例保持 1.0000。
2. 单指滚动、点按、输入照旧。
3. 网页版本仍可缩放：静态 viewport 没有全局锁。
4. `npm run check` 全绿；新增测试在去掉锁的条件或锁的内容后变红。
5. 四处资源版本同步推进（`?v=`、`CACHE`、`build=`），`CFBundleVersion` 提高，重新安装 App 后生效。

## 实测证据（模拟器，非真机）

iPhone 17 Pro 模拟器，iOS 26.3.1（23D8133），Xcode 27.2。
手势用 XCTest 的 `pinchWithScale:velocity:` 与 `XCPointerEventPath` 发出真实触点；
测量用辅助功能树里元素的屏幕坐标：页面被整体放大时，元素 frame 同比变大（高度比 = 放大后高度 ÷ 放大前高度）。

| 手势 | 修复前 | 修复后 |
| --- | --- | --- |
| 首页 双指张开（80→200pt） | 高度比 ×1.5200（61.56×31.41 → 92.96×47.74pt） | ×1.0000 |
| 首页 双指收拢（200→80pt） | 相对上一状态再放大 ×1.4737 | ×1.0000 |
| 首页 系统 pinch（scale 2.0） | 再放大 ×1.6429 | ×1.0000 |
| 首页 系统 pinch（scale 0.5） | 页面被缩小 ×0.5978 | ×1.0000 |
| 第二个普通页面（目标聊天页，点「编辑目标」进入）双指张开 | 高度比 ×1.5200 | ×1.0000（31.41→31.41pt） |
| 单指拖动（滚动） | 内容跟着动 | 20 个可见文本里 19 个位移（锁缩放没有牵连滚动） |
| 点按页面控件 | 可点 | 可点：首页「编辑目标」进聊天页、聊天页「交给 Super Agent」有响应 |
| 输入框敲字 | 收到 | 收到：聊天页输入框的值变成 `a` |

「修复前」一列是独立核实者从基线提交（`5b2ec03`）重新构建、安装后在同一模拟器、同一手势下实测的值；
本轮自己那次基线跑出的数值与之同量级（双指张开 ×1.5600、双指收拢 ×1.4872、系统 pinch ×1.6034），
差别来自手势时序，不是结论差别。

复现与复测的命令（手势测试放在仓库外的 XCUITest 工程里，跑在真实 App 上）：

```
xcodebuild test-without-building -xctestrun .../ZoomTests_iphonesimulator27.2-arm64.xctestrun \
  -destination "platform=iOS Simulator,id=<TASK-85 模拟器>" \
  -only-testing:ZoomTests/ZoomTests/testPinchKeepsPageScale
```

```
TASK85 before rect=(67.84,233.49,61.56,31.41)
TASK85 after pinch-open rect=(67.84,233.49,61.56,31.41)   ← 修复后：比例 1.0000
```

同一个用例在基线构建（`5b2ec03`）上的输出：

```
TASK85 before rect=(67.84,233.49,61.56,31.41)
TASK85 after pinch-open rect=(101.76,243.54,92.96,47.74)   ← 修复前：比例 1.5200
→ testPinchKeepsPageScale FAILED
```

手势测试的三个用例与对应结论：`testPinchKeepsPageScale`（首页四种捏合方向）、
`testPinchKeepsPageScaleOnSecondPage`（目标聊天页）、`testScrollTapAndInputStillWork`（滚动、点按、输入）。

## 回归测试

`test/ios-page-zoom-lock.test.mjs`（4 条）钉住：静态 viewport 不全局锁、App 侧的锁内容齐全、
锁只在 `along://` 时生效、锁出现在样式表与模块脚本之前（晚于首次布局就来不及）、App 内置产物与 `web/` 一致。
`test/brand-double-tap-zoom.test.mjs` 的 viewport 用例改写成新契约：网页版本不跟着锁。

## 待确认

- 上面是**模拟器**证据，不是真机。真机复测仍待做：iPhone 上装新构建后复测首页与另一个页面的双指放大/缩小、
  单指滚动、点按与输入。
- iOS 辅助功能缩放（设置 → 辅助功能 → 缩放）是系统级放大，理论上不受页面 viewport 影响，但模拟器上未实测。
- 双击缩放（smart zoom）不在本轮范围：页面 viewport 锁住后双击文字是否仍会放大，待真机确认。
- 网页版本在 Android 等认 `user-scalable=no` 的浏览器上不受影响（本轮没锁网页版本），无需额外处理。
