# 设备侧数据采集通用规则

用户于 2026-11-18 明确：沿用 Apple Health 的设备采集方式；OKX 应由 iPhone 获取，再交 Agent 执行，并沉淀为通用规则。主分类 client/data，依赖诊断版 PR32 与并行来源事件桥、Agent source-state/task-trigger。验收为 iPhone 前台实际读取官方只读 API，原目标收到可读取摘要并解锁相关 Agent 工作；重试、断开、撤权、重连与健康原流程均保持正确。

## 架构边界

数据优先在用户授权且实际可达的设备采集。平台负责校验授权、真实读数与规范化，密钥留在采集设备安全存储；Mac Host 校验设备身份、目标、授权版本和摘要协议，保存必要数据及可信来源事实；Agent 通过目标限定的能力读取数据并执行。手机不是任意网络代理，不接收 Agent/JS 指定 URL、HTTP 方法或签名材料。

Apple Health 保留现有 HealthKit 权限、七类摘要和 wire 协议；提取通用持久队列、先落盘再发送、同号重试、回执匹配与撤回隔离。OKX 作为原生 provider 复用该投递模式，不伪装健康事件或聊天。iOS 前台采集/刷新优先；后台运行机会由系统决定，不承诺常驻采集。

## OKX 采集与迁移

凭证仅在 iPhone 原生表单输入并保存至 WhenUnlockedThisDeviceOnly、非同步的 Keychain，按本人/目标/provider/配对/授权grant隔离。只允许固定官方 HTTPS GET time/config/balance/positions，禁止重定向和任意域，限制超时/响应大小，校时后 HMAC-SHA256 签名。实际 `perm` 必须恰为 read_only，读取与验证全部成功后才保存连接。

首个能力继续使用已约定的 `okx + trading_account_summary`（交易权益、资产数、持仓数），不冒充完整交易历史或已完成策略分析。界面区分本机已读取、Mac已接收、Agent源事实/按需读取结果已记录、Agent实际任务产出。手机收到publish回执只显示Mac已接收，不称Agent已同步或已执行。

旧 Mac vault 不向手机下载密钥；迁移时只清理该作用域的旧凭证。旧 `/sources/okx` connect/refresh 不再收真实密钥，返回升级提示；纯断开继续允许清理。采集事实的 provenance 为 iOS 原生设备报告，不能称 Host 独立向 OKX 验证。

## 原生专用入口草案（待上游冻结后接线）

POST `/sources/device`，沿用原配对 TLS/鉴权；仅本地 App 原生代码可调用，通用网页 request 禁止此路径。服务端本人身份只来自配对，client 不能自报 userId/deviceId。固定 action：context/open/publish/disconnect/status；固定 provider 当前仅 okx。

- context：核验 active goal 与 okx 推荐，返回绑定的 userId/deviceId/goalId/provider，不改变连接状态。
- open：携带先在手机持久化的稳定requestId，重试同一requestId取得同一grantId。它立即替换/撤回旧授权，Host journal提交disconnected使旧ready不可读，不是候选保留。新Key失败不恢复旧连接；界面正常只在未连接状态可发起open。旧Mac vault必须由设备gateway作用域接管，禁止后续adopt恢复。
- publish：`{action,provider,goalId,grantId,eventId,sequence,observedAt,permission:'read_only',summary:{tradingEquityUsd,assetCount,positionCount}}`。同 eventId/同内容为 duplicate，冲突拒绝；旧 grant/sequence 返回 stale，不修改新连接。当前目标/推荐/配对仍有效才保存。
- disconnect：`{action,provider,goalId,grantId,eventId,sequence}`。本机先持久撤回、删除凭证、丢弃旧代际摘要，再将稳定撤回事件补传。Host 同所有者可清理已归档目标，旧 grant 的断开不能删除新的连接。
- 回执含匹配 event_id、status accepted/duplicate/stale/rejected；accepted/duplicate确认Host接收，stale/rejected/conflict放入held后移出队首，未知/不匹配回执仍保留原id重试。不得换id复活旧授权。schema 严格白名单，拒绝任何凭据、签名、请求头、UID或任意数据字典。

Host gateway 作为并行 source journal 的缓存适配器，不另建 Agent source 状态：保存前 prepareReady、设备摘要附 sourceStamp 原子落盘、commitSaved；中断通过 sourceSnapshot/recover 对账。提供现有 source-event-bridge 要求的 `sourceSnapshot({userId,goalId,stillAuthorized})` 和 `handle(disconnect)` 接口。source generation/revision 由既有 Host journal 管理；手机 grantId/sequence 只负责设备授权与投递排序，两者不得混用。Agent 继续用 /source-events → /source-reads → /source-read-results 及既有 ready/generation/revision/reference 契约。

手机先持久连接requestId/作用域，再请求open；成功验证后存Keychain，再把summary/sequence/事件同文件原子提交。后者失败补偿删除Keychain，中断留下的opening记录不能被当成connected。Host已接收但响应丢失时同id重试。撤回先持久tombstone+撤回事件，再删Keychain；中断在下次前台继续清理，不再采集。Host prepare→cache→commit任何中断以已保存stamp对账，不能凭内存成功返回。采集时间允许未来最多5分钟，但未来值仍不能被read bridge冒充新鲜；Agent freshness继续按实际observedAt计算。

## 交付证据

先验证 iPhone 自身无凭证 public/time 可达性，再做真实授权。隔离测试覆盖 HMAC、权限拒绝、Keychain隔离、队列重启/重复/冲突、配对变化、撤回与重连竞态、源事实/按需读取/任务恢复。手机覆盖安装保留原目标、任务、提醒与配对；不代发正式测试消息。模拟器、真机联网、真实API授权、Agent实际执行分别记录。
