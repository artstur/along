# 健康上下文：近期运动与睡眠分期

2026-11-24。主分类 client/data；依赖 Along Agent 对同版严格 health context 的支持。先部署 Agent 兼容能力，再安装新 App；不改变配对、目标、任务和原提醒。

## 目标与边界

Agent 不能只靠本周运动总分钟和七日睡眠均值作第二天建议。本轮增加本机算好的有界细节：最近最多七次运动的活动类别、有效时长、起止和可读的距离/消耗/强度，最新统计窗的睡眠段数、最长连续观测与分期分钟。没有实际记录的量不估算；无样本也不等于未运动或拒绝授权。夜间统计窗包含小睡，不能自动称为主睡眠、入睡或睡眠质量诊断。

健康仍是只读、选择后导入、情境评估授权后上传汇总。运动详情使用官方关联统计和关联 effort 查询，不发原始样本、UUID、设备、品牌或私有 metadata。地点仅公开的 indoor/outdoor/unknown，精确路线和地名不接入本轮。自动刷新不弹权限页；只有选择健身记录并主动读取时请求相关只读权限，拒绝可选权限不破坏旧摘要。

## 实现

- 沿用七类 scalar envelope 与 along-health-v1，strict context 增加 optional 字段，旧事件兼容。
- Workout context 新增 recentSessions 最多 7，每项本地归纳；当前 28 天窗内、按开始倒序，活动时长 <= 起止跨度。HKWorkout 的本地 UUID 仅用于本次查询去重。
- 可选距离米/活动能耗千卡/运动关联平均和最大心率、iOS18+有关联记录的 effort 与 estimated effort 分开。丢失、拒权或不支持均省略，不能补零。附加数据查询失败只影响该字段。
- 附加统计随既有 workout 观察通知或前台健康读取一起刷新；本轮不监听每一次心率跳动，不承诺第三方稍后补录 effort 的即时后台送达。回前台读取能发现相同 workout 的真实统计修正并按内容重新投递。
- Sleep context 增加最新窗 asleep 合并段数、最长连续分钟及 core/deep/rem/unspecified/awake 分期汇总。时间段切分去重，具体 asleep stage 冲突记 unspecified，并标 latestStageOverlap。awake 与 asleep 重叠不双计。
- HealthModels 白名单剥离任意 nested 私有字段；event-envelope JS 与 Agent TS 严格镜像，仍按观测内容去重。

## 验收

隔离合成记录验证：暂停导致 duration 小于跨度、同记录重复、无心率/effort、不支持系统、跨夜/当前未结束运动、超长记录、错误单位/越界/时间倒置、睡眠多源重叠/分期冲突/小睡/缺失、未知嵌套字段剥离或拒绝、旧 wire 兼容、同事实重读安静、真实细节修正能产生变化。运行 npm run check、build、Xcode simulator 无签名编译；真机授权和自然同步待用户连接后验收。

## 官方依据与接入优先级

- [HKWorkout](https://developer.apple.com/documentation/healthkit/hkworkout)：单次活动 summary 与关联统计；duration 是有效活动时间，不能以结束减开始替代。
- [关联样本](https://developer.apple.com/documentation/healthkit/adding-samples-to-a-workout)：按 workout predicate 查询；不混用同时间窗其他活动心率。
- [HealthKit 授权](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data)：仅请求需要的类型；读权限状态不可作为已获准/拒绝的事实。
- [室内标记](https://developer.apple.com/documentation/healthkit/hkmetadatakeyindoorworkout)：仅说明是否室内，不是地点。

“运动深度”没有通用单一 HealthKit 字段：本轮只呈现设备真正记录的关联心率和 effort，不把时长换算成强度分数。力量训练的动作、组数、重量和健身房名称通常需要对应记录 App 自身的数据来源，不能从 HKWorkout 汇总中推断。

| 数据 | 价值与优先级 | 本轮与后续边界 |
|---|---|---|
| 单次运动类型、时长、距离、能耗、心率与 effort | P0，帮助结合近期负荷和偏好建议活动 | 本轮接入实际可读的汇总；不能据此诊断恢复或自行计算临床强度 |
| 睡眠时间、分期、碎片观测 | P0，辅助跨日睡眠计划 | 本轮接入；缺失/分期冲突保留，不能保证 Watch 记录完整 |
| 日历空闲与日程变动 | P1，避免建议撞会议 | 已有设备来源能力应复用；用户授权且实际采集后使用，不额外读日历私密正文 |
| HRV、静息心率趋势、恢复相关观察 | P1，更多纵向背景 | 当前已接静息心率；HRV 需新类型、覆盖和基线设计，本轮不凭单值推断疲劳 |
| 饮食能量、蛋白质、饮水 | P1，饮食目标相关时有用 | HealthKit 可存营养数据，但不会自动识别用户吃了什么；需要记录 App/手动来源与明确授权，不能用缺失当未进食 |
| 运动路线与具体地点 | P2，地点/路线偏好 | 通常只部分户外运动有路线，需独立读授权和本机隐私缩减；本轮不读取或上传坐标，也不猜健身房 |
| 训练区间、配速、功率等 | P2，特定运动目标时有用 | 设备、系统、运动类型和授权依赖更强，按实际场景选择，不为所有用户扩大权限 |

## 发布与证据

原生 build/cache 版本由集成 release 统一更新。本轮不安装手机，不更换正式路由，不造个人目标或测试健康事件。编译与隔离回归不是原手机实际授权、上传或 Agent 复评成功的证明。
