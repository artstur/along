# 阶段 C：健康变化自动跟进

2026-11-16。用户明确要求：健康数据变化后，无需聊天，自动触发 Agent 跟进。本文为实现前设计；文末分别登记自动测试、真实模型与真机证据。

下文的同 Mac 换址是早期实现记录。现行连接规则见[用户设置页](user-settings.md#云端连接收敛2026-11-28)。

## 目标与范围

复用既有 Apple Health 选择、预览与导入入口。用户允许 Agent 使用所选摘要后，前台读取与 iOS 提供后台执行机会时都可靠上传同一协议；Mac 保存最新有效事实，按目标筛选并自动派工。Agent 读取目标、任务、对话、记忆与摘要，保持安排或自动调整任务；不需要聊天触发或采用。

沿用七类摘要和原有统计口径，不上传样本或模型凭证，不新增页面、开关或模式。新协议目标页恢复已有 Apple Health 连接卡。健康事件只能跟进已有目标，不能擅自创建、改写或归档用户目标；任务修改仍走完整 ChangeSet 校验。普通跟进不发系统通知。完整通知策略、健康授权撤回历史清理、Skill 发布不属于本轮。

## 实现方案

1. **手机摘要与可靠补传**：原生采集为七类提供固定统计窗口、最新读数时间和读取修订时间；事件只包含标量汇总、单位、统计方法、时区、窗口、版本与可用性。同内容重复读取不入队。新协议由原生持久 outbox 统一负责前后台上传，避免 Web 与原生重复生产；先原子落盘，再发 /events，只有匹配的持久 accepted/duplicate 回执才从本机删除；匹配的 rejected/conflict 归入本机 held 后继续后续事件，不让坏事件堵住整条队列。断网、进程重启、锁屏后解锁及前台恢复重试同一事件号。连接按配对凭证绑定，切换用户不补传到另一用户。SDK 回调必须完成；iOS 唤醒机会与锁屏 HealthKit 读取不可保证，保留待处理标记并在可读时补传。
2. **先存事实再筛选**：服务端按类型、窗口和读取修订排序；迟到旧窗口/旧修订不得覆盖新事实。未知类型只存待适配，已知类型拒绝对象、数组、非法单位/窗口与非有限数字，缺失不当零。累计类型跨窗口重新建立基线，不当负进度；睡眠明确标注睡眠日与窗口边界，尚未结束的窗口不解释成缺睡；最新读数按读数时间处理。
3. **按目标独立跟进**：只对本人 active 的 health/custom 目标产生候选，finance 排除。首次评估由模型判断关联，并持久登记该目标关注的健康类型（可为空）。后续只按关注类型筛选；聊天更改目标后重新判断关联。小变化相对上次实际读取的评估基线积累；同值不派工，跨窗/可用性/显著变化触发。阈值仅用于减少重复评估，不是医学判断。每目标持久 pending 合并，已有正在规划的工作时合并等待，不并行派多个当前健康 Worker；已 settled 的等待回答/失败报告不阻塞健康独立跟进；新数据只保留最新有效事实，当前工作结束后按上次实际读取的基线处理剩余变化；重启不丢。
4. **可信自动派工**：保留 human:false；只有本地 Along 部署、已配对且仍在允许名单内、现有主动接单模式为 `auto`、真实持久健康派工记录才能取得宿主授权。派工绑定目标/摘要/输入版本，不能用任意客户端 payload 伪造资格。复用 DSH Event/Engine/Ticket/Assignment 和恢复；不恢复旧工单或解除暂停。派工阶段确定性建评估工单，是否需要改任务由 Worker 语义判断。
5. **读取与自动生效**：Worker 可读所有本人目标的简要安排作为协调上下文，但仅能写绑定目标的任务。健康读工具返回当前摘要及本次读取凭据；结果记录关联本次实际读到的版本，读后新数据不被误算为已评估。用户聊天使旧健康工单提交失效，不能抄新 input_version 绕过。提供跟进结果工具记录 keep/update/ask 及原因、相关类型，必要说明进入目标对话；keep 不制造聊天噪声。任务变更、结论和同步均幂等；假完成与未读取摘要的完成报告拒绝。

## 验收标准

- 无新用户消息：健康摘要 → 持久接收 → 自动 Ticket/Worker → 真实注册工具读摘要 → 校验后的任务变化 → sync 可见；没有采用环节。
- 七类摘要、真实零/未知、重复读取、迟到版本、跨日/周、睡眠跨夜、单位错误、原始样本/伪造身份拒绝。
- 两个目标独立跟进，一个冲突不回滚另一个；未知关联经模型登记，空关联不反复唤醒，聊天修改后重新判断。
- 小变化累计、持续输入合并、在途输入保留、用户纠正覆盖旧结果、暂停/停止/移出名单、重启恢复、无关健康类型与无目标不建单。
- 原生 outbox 在网络失败/回执不匹配/写失败时不丢；同号重试；更换配对不串数据。前台与后台共用；旧 Host 兼容流程保留。
- Along npm run check、Along Agent VITEST_MAX_WORKERS=4 pnpm check、前端构建及产物一致、Xcode 无签名构建；真实模型仅用合成数据。真机健康变化、HTTPS 配对和后台唤醒单列，不能用替身测试替代。

## 实施与验证记录

实现落点：原生 `HealthSummary.eventSummaries` 与 `HealthEventDelivery`；网页复用连接卡并调用原生事件接线；Along Agent 的 `health.ts`、`health-store.ts`、`health-schema.ts` 及 Runtime/工具/ChangeSet 接线。`along.sqlite` 从 schema 3 事务升级到 4，新增评估基线与派工 outbox 两张表，不改写既有业务历史。

- 原生统一负责健康事件生产和上传，网页只上传聊天。未获持久回执或回执事件号不符时保留待发送项；换配对时旧队列隔离保留，已不在当前选择范围内的旧事件留在本机 held，不转发。旧 Host 继续走原路径。
- 新协议采用标量摘要，严格拒绝对象/数组值。阶段 A 的 `{total: ...}` 测试向量同步改成数值；此前手机并未生产这类健康事件。本次收紧不会把旧数据库里的历史摘要伪装成新摘要。
- 前台/后台共用同一原生持久文件。iOS 提供 HealthKit 回调时上传；锁屏不可读则留 dirty，解锁、前台或下一次观察机会恢复。数据采集不以网页是否打开为前提，但不承诺 iOS 一定唤醒、Mac 一定可达或即时送达。
- 七类筛选阈值是固定的调度去重参数：步数 500、运动 5 分钟、活动消耗 50 千卡、体重 0.1 千克、静息心率 3 次/分、手腕温度 0.1°C、睡眠 15 分钟。它们不用于医学结论；新窗口、读数时间、可用性变化另外处理。明确的结构化数值目标跨过目标值时不受小变化阈值抑制，不从自由文本猜数值目标。新增健康类型首次同步时重新判断关联，无需聊天来重新激活。步数/运动/活动消耗的过期窗口不自动派工，睡眠与有时限的最近读数也检查新鲜度；工具明确返回 current 和窗口。
- 健康先可靠保存，不再逐条进入旧的无目标 DSH 线程。新派工是每个目标一个不可变的派生事件，保留 human:false，确定性建立“评估是否需要变化”的工单；业务关联与修改内容由真实 Worker 判断。已有工作期间继续收摘要，结束后再处理累计差异，不额外制造平行健康工单。人工停止不重开旧工单，后续新的变化仍可产生新工单。失败按持久报告时间退避，重试同一工单；Worker 无结论空闲时转入可重试状态，已持久完成但缺结束报告时可确定性收尾，防止一直占住目标。
- 新增 `along_health_followup` 记录 keep/update/ask、关注类型、原因与实际读取的摘要；keep 不发聊天。新增只读 `along_goal_overview` 用于理解其他目标的安排，写入范围仍限定本目标。新聊天立即使旧健康工单失效，即使复制新版本号也不能提交。

### 自动检查与构建

- Along `npm run check`：292 项全部通过，含从真实 Swift 源码编译执行的原生队列测试，以及真实 App 处理器的连接/导入测试。
- Along Agent `VITEST_MAX_WORKERS=4 pnpm check`：80 个文件、1532 项通过，类型检查和构建通过；其中阶段 C 的 14 项实际 Runtime/Engine/SQLite/注册工具验收覆盖独立派工、任务生效、去重、累计基线、读后更新、迟到数据、未知与零、聊天抢先、双目标隔离、只读协调、无关类型、停止/权限/暂停、重启、失败退避、等待回答不阻塞、完成报告恢复、目标达成小变化和新连接类型重新判断。
- `npm run build` 后 18 份源码与 dist / iOS 内置资源逐字节一致。资源版本 59，Bundle 52。
- Xcode 27.2 generic iOS 无签名构建成功；产物位于验证用 DerivedData，不等于已签名安装。
- Playwright 390×844（原生桥与服务器响应为替身）：健康连接卡导入后变为管理，无横向溢出（scrollWidth=390），控制台无错误/警告；截图 `output/playwright/stage-c-health.png`。

### 真实模型与部署边界

隔离验证 profile 使用 Harness 0.2.2-rc.3 / MiniMax-M3.1-Flash，只输入合成目标、任务与健康摘要，不接触真实健康数据。只有既有目标和健康事件，没有新用户聊天：真实 Worker 读取运动汇总，校验后移除过时的“本周还需运动45分钟”安排，保留原目标，并持久登记评估基线。初次与复测证明分别在 Along Agent 忽略目录 `.artifacts/along-health-runtime/proof.json`、`.artifacts/along-health-runtime-final/proof.json`，均 `ok:true`、5 条断言通过、0 次工具错误。最终交付构建的复测 `.artifacts/along-health-runtime-delivery/proof.json` 同样 `ok:true`，5 条断言通过、0 次工具错误；各隔离验证进程均已停止。

本轮通过当前功能分支交付代码、文档与生成资源；未切换正式 DSH profile 或手机数据，也未在实际 iPhone 安装、配对或触发 HealthKit 后台事件。真机 HTTPS/断网重连/锁屏与系统唤醒机会、长期模型语义稳定性仍需验收；模型样例成功不能替代这些证据。使用时需启动同一套新协议 Host/profile、现有主动模式为 auto，并重新安装 App，在既有 Apple Health 卡片中导入允许使用的类型。

## 本地 Mac 地址更新与健康队列归属（2026-11-24）

分类 client/data，依赖 Along Agent #34、Along #50–55。用户可观察的验收是：原配对 Mac 换局域网地址后，已授权、未确认的健康事件仍以原 event_id 补传并收到对应 ACK，原目标、任务、提醒、授权和未发送内容保留。

现有健康 binding 含 transport URL，不能在换地址后创建空队列。实现保留 binding 作为不可变队列 identity，仅为 `legacy-local-pin-v1` 的有效原 pin、token 逐字相同且信任策略不变的候选地址记录受验证 transport。原生通过既有固定证书网络请求认证新地址的 `/connection/status`（ready、eventProtocol 1、相同 user），不信任网页自报 user。await 后重新核实原连接、完整队列与 enabled。验证失败不写连接或队列；先原子保存完整队列与证明，再保存连接，同时保留原 transport，以恢复断电、写失败或 Keychain 写失败。系统信任跨 origin、不同 pin/token/user/policy 和未知旧 hash 继续隔离、保留原归档。

原生 save/load 仅向内置网页返回 tokenless `transportMigration`：from/to baseURL、bindingScopeId、userId，来自已原子提交的认证记录。网页剥离证明，不写进连接配置，仅在原/新精确端点、同 pin/token/policy 与原 owner 全匹配时保留 event 指针和 daily recipient。grant 内容、撤销名单、workspace cursor、草稿和聊天不变；撤销过的 grant 不恢复。两次 localStorage 写之间中断，允许证明内已写的新 event 指针配合旧连接恢复，其他 origin/scope 不认领。既有 DEBUG 启动迁址也调用同一 native 事务。

健康发送在每次 await 后重新读盘，只推进仍属于原 identity/user 的相同完整 event；旧地址的 ACK 不覆盖新 proof、事件或 payload。Web 旧 workspace 的 pendingACK 回来后先检查 disposed，防止覆盖新草稿。全局 `bindingScopeId/scopeSeed`、普通 origin guards、OKX 作用域不改。通知只在同一 native proof 下复用原 scope/since/results，输入 scopeId 仍校验当前连接；Build79 只读 owner 证据增加已认证 transport 支持，未知端点隔离、无采集/写入/网络副作用不变。

验证使用实际发布 Swift 函数及网页 DOM 接线，在一次性目录、UserDefaults suite、合成证书和 loopback HTTPS 中运行：最新 e6 原代码换地址丢 active event 的红例、原事件完整 ACK、held/lastContent、离线冷开、异身份隔离、认证/并发/写失败、Keychain 失败、权限缩窄、陈旧 ACK、native bootstrap、通知 scope/回执与 Web 两键中断重启。实际 TLS 用原样 agentRequest 与 pinned delegate，只有测试地址接受/路由适配 loopback；错指纹在发送应用数据前拒绝。无真实健康事件进入夹具。

交付为 App81/Web90，四处版本和两份内置资源同步，无新增界面。运行完整 `npm run check`、`npm run build`、逐资源比对、Xcode simulator build 与独立固定 SHA 复核。源码任务只提交、推送 PR；合并、正式 Host、原手机安装、自然健康上传及真实用户流程由 release/client delivery 执行并分别记录，合成验证不替代真机验收。

前置请求边界：地址表单和 DEBUG 入口在 save 前已有 `/connection/verify`。因此原生 agentRequest 在创建 URLRequest 和附加 bearer 之前执行 `permitsPairedTransport`：复用当前配对 token 时，旧 legacy 私网必须保持私网 pin 策略和原 pin；旧系统信任配对只允许原规范 origin，跨 origin 必须真正新配对。saveConnection 也在写入前执行同一预检。调用方自报 policy、同值 nil pin 或 sameUser 不能绕过；同公网 origin 换叶、新 token 配对的正例保留。

B3 中断恢复补充：native proof 同时允许精确 from/to 两个当前连接端点，用于完成已提交新 AGENT/EVENT、尚未写完 daily recipient 的状态。经该证明核实后，在同连接早退前逐 goal 幂等迁移；只移动 `proof.fromBindingScopeId` 的原 recipient，已到新 scope 的跳过，未知 scope、无 grant、撤销名单内 grant 均不改。多个 goal 中途写失败后从同证明继续，原授权内容不变。
