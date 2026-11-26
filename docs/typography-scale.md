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
  - 随字号变化的容器：`.agent-message` 的最大宽度、`.agent-composer textarea` 的高度上下限、`.select-wrap select` 的最小宽度。
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

## 已验证 / 待确认

- 见本工单的交付评论：本地无头 Chrome 实测的计算字号、截图与视口溢出检查。
- 真机（iPhone WKWebView）观感、键盘遮挡与安装后生效**待确认**，由独立验证人复核。
