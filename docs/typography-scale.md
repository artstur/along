# 字号层级（Typography Scale）

## 目标

参照「小豆」对话截图，把 Along App 的可读字号整体上调，**重点是对话正文**。

- 对话收发正文从 13 CSS px 提到 **17 CSS px**，行高 **1.6**（≈27 px）。
- 其余页面按文字用途逐项上调到统一层级，而不是整体等比例放大（等比例会同时放大标题、图标和紧凑控件，窄屏溢出风险高）。

## 依据

参考截图 `TASK-79` 附件（1320×2868 px @3x，即 440 CSS px 宽）：中文长回复行距约 27 CSS px，对应 17 px 字号 + 1.6 行高。

## 层级

在 `web/style.css` 的 `:root` 定义三个字号变量，全站复用：

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--text-body` | 15px | 常规正文：卡片说明、任务描述、列表摘要、提示文案 |
| `--text-body-large` | 16px | 稍重的正文：任务标题、结果正文、输入框 |
| `--text-chat` | 17px | 对话收发正文（两条聊天路径共用 `.agent-message > p`） |
| `--text-caption` | 13px | 辅助信息：时间戳、状态、来源标签、脚注 |

在此之上只用两个例外值：

- **11px**：极小的机器化标签（`Source` / `Mandate` / 协作单元状态），保持信息密度。
- **12px**：更弱的次级信息（徽标、分区计数、免责声明）。

标题层级（页面标题 24–27px、卡片标题 18–22px、章节标题 16–19px、按钮 15px）**保持现有结构**，只统一到相邻档位，不改。

## 范围

### 改

- `web/style.css`：
  - `:root` 增加三个字号变量。
  - `.agent-message > p`（旧 Host 与事件工作区两条聊天路径共用）→ 17px / 1.6。
  - `.agent-message > p.agent-disclaimer`（"待同步"、"发送未完成"）单独 13px，避免被正文选择器一起放大。
  - `.agent-composer textarea` → 16px（占位文字同样 16px；同时避免 iOS 输入框自动放大）。
  - 目标列表与详情、任务列表与结果、设置与连接页、弹层（`#sheet`）逐项调整。
  - 随字号变化的容器：`.agent-message` 的最大宽度、`.agent-composer textarea` 的高度上下限、`.select-wrap select` 的宽度。
- `web/app.mjs`：
  - 对话滚动目标从「容器底部」改为「最后一条消息的底边」（编排面板在消息之后，滚到底会把最新回复挤到可视区外）。
  - 软键盘弹出时把文档滚回顶部，抵消 iOS 为露出输入框的那次滚动；**只在原生壳里做**，
    网页端照常滚动。
- `web/index.html` 的 `?v=`、`web/sw.js` 的 `CACHE`、`ios/AlongHealth/Sources/AlongShellView.swift` 的 `build=`、`ios/AlongHealth/Info.plist` 的 `CFBundleVersion`：94 → 95、86 → 87。
- `npm run build` 重新生成 `ios/AlongHealth/Web/` 产物。

### 不改

- 接口、持久化、消息渲染与同步逻辑。
- SwiftUI 原生页面的文字：继续沿用系统文字样式（`Form` / `.footnote` / `.caption`），不引入自定义字号。
- 图标尺寸、页面结构、导航入口。

## 验收

1. iPhone WKWebView 默认字号下，两个聊天路径的收发正文计算值均为 **17 px**、行高约 **27 px**；输入框（含占位文字）至少 **16 px**。
2. 在约 375 与 440 CSS px 视口检查目标、任务、设置与弹层：正文清晰，主要文字与按钮可读可点，无新增横向溢出或遮挡；键盘打开时输入框与发送按钮可用，发送后能滚动到最新消息。桌面网页做一次显示回归。
3. `npm run check` 与 `npm run build` 通过。

### 回归用例（不可省）

| 场景 | 判据 |
| --- | --- |
| 桌面网页 1280×620 目标首页 | 滚轮向下、End 键都能滚到连接区与页尾（`scrollY` 达到文档最大滚动量） |
| 桌面网页 1280×320 任务详情 | 同上，可滚到页尾 |
| iPhone 原生壳软键盘弹出 | 发送键留在可视区内且可点，点击后 Host 收到请求，最新回复可见 |

第 1、2 条是软键盘复位改动的直接回归面：复位只允许发生在原生壳
（`location.protocol === 'along:'`），网页端的文档滚动是正常浏览。`test/web-document-scroll.test.mjs`
把这条约束固化成用例。

## 复核中发现并修掉的问题

第一轮交付后，独立复核在 WKWebView 里发现三处问题，逐一处理：

1. **长链接截断**（两条聊天路径共用）。对话正文是 `white-space: pre-wrap`，它只在空格处换行，长 URL 没有任何断点，文字会溢出气泡被裁掉。
   修法：给 `.agent-message p` 加 `overflow-wrap: anywhere`，链接在词内折行。实测（WKWebView，320 CSS px）气泡 `scrollWidth == clientWidth`，不再裁切。
2. **窄屏目标下拉框越界**。`<select>` 的固有宽度来自最长选项文案，会把「当前目标」整行撑出视口；`min-width` 又让下拉框不能随外层收缩，320 px 下还会压到「新建」按钮。
   修法：宽度改由 `.select-wrap` 决定（`flex: 0 1 auto` + `max-width: 220px`），`select` 用 `width: 100%` 填满外层、外层可收缩。选项文字在框内截断，整行不再越界。
3. **发送后最新回复不在可视区**。滚到底会停在编排面板末尾，最新回复被面板挤到可视区上缘。
   修法：`web/app.mjs` 新增 `lastMessageScrollTop()`，滚动目标改成把最后一条消息的底边对齐到可视区底边。

另外把 `.agent-composer textarea` 的 `min-height` 保持在 48px：16px 字号下实际高度仍是 51px，与改动前一致，输入区不因字号上调而变高。

## 已验证 / 待确认

- 见本工单交付评论：无头 Chrome 实测的计算字号、视口溢出与滚动目标；iPhone 17 Pro 模拟器 WKWebView 实测的气泡计算样式与几何。
- 桌面滚动回归：Chrome 158，1280×620 目标首页滚轮/End 实测与 `c68dbb8` 基线一致
  （`scrollY` 600 / 616，文档最大滚动量 616），1280×320 任务详情 212 / 212 一致。
- **320 CSS px 下的软键盘发送不可点，是改动前就存在的问题**，根因是 `Info.plist` 没有 `UILaunchScreen`：iOS 按 320×480 兼容模式运行，WKWebView 可视区只有 384 CSS px，软键盘弹出后剩余约 150 px，放不下 58 px 顶栏加输入区。同一环境对照 `944da99` 的发送键位置与本轮一致（相差 3 px），确认不是字号改动引入。彻底解决需要补 `UILaunchScreen` 拿到整屏视口，属打包改动，另开工单。
- 真机（iPhone）观感、真机重装与真机键盘**待确认**，由独立验证人复核。
