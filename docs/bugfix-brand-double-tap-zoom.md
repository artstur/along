# Bug#4 · 连点左上角图标触发页面缩放

> **契约变更（2026-11-28，参见 [Bug#5](bugfix-pinch-page-zoom.md)）**：App 内置页面现在整体禁掉了双指缩放
> （页面层锁 viewport），网页版本仍可缩放。本文里「从品牌区起手的双指缩放照常可用」「不用 viewport 全局锁缩放」
> 这两条只对网页版本成立；Bug#5 之前它们对 App 也成立。品牌区的 `touch-action: manipulation` 规则本身不变，
> 仍然用来挡住连点品牌图标触发的双击缩放。

## 正确行为

在 iPhone App 里连点左上角的 Along 品牌图标时，页面保持原有缩放比例和位置，不发生任何缩放。品牌图标本身没有点击行为，不该成为缩放的触发点；从品牌区起手的单指滚动与双指缩放照常可用，页面其它区域的手势不受影响。

## 范围与方案

- 只改 `web/style.css` 里 `.brand` 的手势声明（一条 CSS 声明），不改布局、不动图标素材、不动 App 原生代码、不动任何数据或接口。
- 现象层：左上角是各页面共用的 Along 品牌区（`web/app.mjs` 的 `brand()`，渲染在 `.topbar-inner` 左侧），含一张 `app-icon.png` 和一段 20px 文字「along」。iOS 的双击缩放（smart zoom）命中那张图片时会放大并移位页面：实测品牌文字高度放大到 1.64 倍。单独点旁边的「along」字样在所有版本都不放大——触发点只有那张图片。
- 方案：`.brand` 声明 `touch-action: manipulation`。
  - WebCore（`Source/WebCore/platform/TouchAction.h`）：`touchActionAllowsDoubleTapToZoom = !t.containsAny({None, Manipulation})`——`none` 与 `manipulation` 都能关掉双击缩放；列表写法 `pan-x pan-y pinch-zoom` 不带 `Manipulation` 位，照旧会双击缩放。
  - `touch-action` 不继承，但有效值是命中节点与祖先链的交集，所以图标 `img` 与文字都被覆盖到。
  - 实测（iPhone 17 Pro 模拟器，iOS 26.3.1）：`manipulation` 挡住双击缩放，同时保住品牌区起手的滚动（-42.71pt）与双指缩放（1.48～1.60 倍）。
- 不用 `touch-action: none`：它同样能挡住双击缩放，但会把品牌区起手的滚动与双指缩放一起关掉（实测滚动位移 0.00pt、放大 1.000 倍），这一版已被验收打回。
- 不用 viewport 全局锁缩放（`user-scalable=no` / `maximum-scale=1`）：会连页面其它区域的双指缩放一起关掉，超出本 bug 范围。
- 用户可见改动：同步提高 `web/index.html` 的 `?v=`、`web/sw.js` 的 `CACHE`、`ios/AlongHealth/Sources/AlongShellView.swift` 的 `build=`，由 `npm run build` 刷新 `ios/AlongHealth/Web/` 产物；需要重装 App，再提 `Info.plist` 的 `CFBundleVersion`（AGENTS.md §2）。
- 回归测试 `test/brand-double-tap-zoom.test.mjs`（5 条）：钉住品牌区用 `manipulation`、图标不能用 `none`（否则品牌区手势被关掉）、这条规则命中的元素真实存在于渲染结果、viewport 没有全局锁缩放、App 内置产物与 `web/` 一致。

## 验收标准

1. 首页与任务详情页：快速双击、连续点击左上角图标，页面缩放比例和位置保持原样。
2. 从品牌区起手的单指滚动、双指缩放仍可用；顶栏空白处与正文的滚动、缩放不受影响；相邻控件（返回箭头、切换目标）单击可用。
3. 回归：`npm run check` 全绿；新增测试在把 `.brand` 的 `touch-action` 改成 `none`、改成 pan 列表或删掉时分别变红。
4. 真机：iPhone 上装新构建后复测，版本记为 Web v95 / App `build=95` / `CFBundleVersion 87`。

## 实测证据（模拟器，非真机）

iPhone 17 Pro 模拟器，iOS 26.3.1（23D8133），Xcode 27.2。手势由 XCTest 用 `XCPointerEventPath` 发出，两版都用原仓库项目构建、全新安装。基线是 PR 分叉前的 `747eee1`。

| 手势 | 基线 747eee1 | 本修复 |
| --- | --- | --- |
| 首页 双击图标 | 品牌文字高 ×1.64，页面移位 65.32pt | ×1.000，移位 0.00pt |
| 首页 连点图标 5 下 | ×1.64 | ×1.000，移位 0.00pt |
| 详情页 双击图标 | ×1.64，移位 167.08pt | ×1.000，移位 0.00pt |
| 详情页 连点图标 5 下 | ×1.64 | ×1.000，移位 0.00pt |
| 点「along」字样 | 不放大 | 不放大 |
| 品牌区起手滚动（首页 / 详情） | -42.71pt | -42.71pt |
| 顶栏空白、正文起手滚动 | -42.71pt | -42.71pt |
| 品牌区起手双指缩放（首页 / 详情） | ×1.480 / ×1.600 | ×1.480 / ×1.600 |
| 正文起手双指缩放（首页 / 详情） | ×1.480 / ×1.600 | ×1.600 / ×1.600 |
| 详情页返回箭头单击 | 可返回 | 可返回 |

同时在模拟器上试过、但没有采用的变体：

- `touch-action: none`：双击缩放没了，品牌区起手的滚动变成 0.00pt、双指缩放变成 ×1.000 —— 验收正是因此打回。
- 在 `touchend` 上用 JS `preventDefault` 拦掉品牌区的点按：双击缩放同样被挡住，滚动与双指缩放也保住了，但多了一层会吞掉品牌区点击默认行为的 JS 改动；模拟器上没有任何平台行为需要它，按「简单是第一需求」不采用。

## 待确认

- 上面是**模拟器**证据，不是真机。真机复测仍待做：iPhone 上记录修复前后版本，并复测首页与详情页的连点、品牌区起手滚动与双指缩放、相邻控件单击。
- 首页「新建」按钮在该模拟器上 XCTest 无法命中（基线同样如此），真机补验。
- 若真机（较老的 iOS）仍会缩放：WebKit bug 319664 记录了 iOS 手势层在部分 Safari 发布分支上只认 `none`。退路是 `none`（接受品牌区起手滚动与双指缩放的回归）或 viewport 全局锁缩放（整页失去双指缩放，属产品行为变更，需要人拍板）。
