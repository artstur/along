# OKX 只读连接

主分类：data。依赖已合并的目标数据源推荐（PR28）及当前 main fe652f34248346d3025a1f608ad0eeb913dfb785。验收：在原目标点击“连接”，在原生安全表单填写只读 API 凭证，Host 验证真实权限并成功读取余额后，App 展示“已连接”、最近同步时间与账户摘要；重新打开仍能读取，断开后删除凭证。

用户已明确要求连接真实 OKX 账户，只读授权取代本场景原来的演示数据限制，不包含交易、提现或自动策略执行。官方 Agent Trade Kit 当前 OAuth 示例包含 live:trade，不能冒充只读授权；本次采用 API Key / Secret / Passphrase。官方设置链接只负责创建密钥，不代表已连接。

## 实现契约

- 推荐仍来自 Agent；连接状态由 Host 真实请求决定，不允许模型设置 connected。点击现有 OKX 卡打开 iOS 原生连接 sheet，凭证绝不传 WebView。公开 Web 提示在 iPhone App 连接。
- 原生调用沿用原配对的私网 HTTPS、证书固定及配对鉴权；新增私有 `/sources/okx` POST，通用网页 request 禁止访问。请求 `{action:'status'|'connect'|'refresh'|'disconnect',goalId,...}`；仅 connect 包含 `{credentials:{apiKey,secretKey,passphrase},site:'global'|'eea'|'us'}`。
- Host 从服务端配对身份确认目标归属，目标必须存在、有效且推荐 okx。凭证按 userId/goalId 绑定，Mac 以私有加密文件保存，0600 随机主密钥和密文放在 0700 目录；不写明文日志、不通过 Agent 或浏览器返回，不接受调用方提供任意 API 地址。
- 请求固定官方域名、GET 路径、禁止重定向、有超时/大小限制。先获取服务器时间，签名读取 `/api/v5/account/config`，实际 perm 必须恰为 read_only；拒绝 trade/withdraw 或无法验证权限的密钥。再读取 `/api/v5/account/balance` 和 `/api/v5/account/positions`。
- 仅成功读取后保存凭证并返回 `{provider:'okx',state:'connected',lastSyncedAt,summary:{tradingEquityUsd,assetCount,positionCount}}`。未连接为 `{provider:'okx',state:'disconnected'}`。摘要明确为交易账户权益，不把它称为所有账户总资产。
- 连接失败保留既有有效连接但表单展示失败；刷新失败必须可见且不假装本次同步成功。断开删除该目标凭证。并发操作串行化，身份/目标变化后拒绝应用过期结果。原生表单关闭或成功后清空凭证。
- 目标归档或推荐来源撤回后，后续目标同步核实当前状态并删除连接凭证；历史重放不能误删重新推荐后的连接。同所有者的纯断开操作允许在归档或撤回后执行，敏感读取仍要求有效目标及推荐。较旧的状态查询不得覆盖更新的连接结果。
- 本次账户摘要供 App 展示；完整交易历史与 Agent 策略分析为后续工作，不因连接成功宣称已完成。

## 连接失败诊断修复（2026-11-17）

主分类 ui，依赖 PR31，不改 Host 来源事件或凭证契约。用户确认三项凭证正确仍只看到“连接失败”。现状是原生表单把 Host 已脱敏的超时、网络、权限、存储等错误再次吞并。修复只显示明确白名单中的已知错误及固定说明；未知服务端文本、任意 NSError 内容仍不透传。区分 iPhone→Mac 失败与 Mac→OKX 失败，不把网络超时断言为凭证错误。验收为隔离原生运行测试分别复现并显示已知原因、未知/含秘密字符串保持通用提示，签名覆盖安装原手机且保留数据。真实连接失败仍以用户下一次安全表单操作及实际网络响应为准，公共接口超时不替代该次账户请求证据。二维码导入尚未实现，不将扫码等同只读授权。

## 验证与交付

隔离的模拟 OKX 服务覆盖签名、权限拒绝、API错误、超时、持久化、重新打开、刷新与断开；宿主配对/目标归属和原生桥保持隔离；回归原有健康连接与任务。运行 check/build、iOS 编译及模拟器交互，并由只读代理独立复核固定提交。合并后覆盖安装原 iPhone，保留用户数据与配对。真实授权必须由用户在 App 完成，mock 测试、安装、启动和真实账户读取分别记录。

## Host 源事件与按需摘要桥（编排依赖）

本子任务分类为 data，依赖 PR31 的真实只读验证与上游 Agent 私有源事件接口。仅增加 Host 内部生命周期递送，不新增手机入口、公开监听或模型可选 URL。正式账户与设备不用于测试。原生凭据／设备采集方向正在独立上游任务实现，本模块不重做 iPhone 采集、不把设备凭据复制回 Host。

- 当前 vault 兼容适配的成功连接／刷新仍先完成固定官方 GET、`perm === read_only`、摘要校验、当前 goal 授权及加密 vault 保存。私有 journal 先保留版本 reservation，密文附不含凭据／余额的 source stamp，再提交状态与 outbox；保存后、入队前中断由启动／周期读取实际密文 stamp 对账补发。
- generation 表示连接授权 epoch，revision 单调表示来源状态／摘要版本。断开、撤回与重连使旧授权失效。相同摘要刷新只推进 `lastSyncedAt`，不制造重复来源事件；`status` 不创建事件。
- 事件只包含稳定 id、目标、`okx`、generation／revision、ready／disconnected／revoked／unavailable、公开能力名、时间及 opaque reference。余额、持仓、API 凭据和 vault 路径绝不进入事件总线。只有已真实验证并保存、当前仍允许的连接可发布 ready。
- Host 在已有生命周期内用原 bridge 私有回环鉴权递送 `/source-events`，再拉取 `/source-reads`。每次读取重新确认配对、目标仍有效且推荐来源、vault 归属与 source epoch。旧 generation 或撤权只拒绝，不返回摘要。
- 结果沿 `/source-read-results` 回到原请求。ready 数据只含现有三字段经验证摘要；数据时效按请求 `max_age_seconds` 判断。过期缓存返回 stale；Host 不因轮询自行刷新 OKX。Agent 保留 stale／unavailable 的未满足请求，同值合法刷新后新 `observed_at` 可使同请求恢复，不必重复 source event。
- 同 generation 请求允许跟进较新的 revision，必须先 flush 对应 source fact；跨 generation 永不携带数据。denied 回显原请求版本／引用只为终结旧请求，不更新当前来源。
- 每轮有界、单次 pump 不重叠，来源／状态未变化不重复上报；启动和周期对账可恢复跨文件中断。来源撤回或目标归档经当前目标复读后清理，不能由旧快照删除新重连。

专属回归将以真实加密 vault、受控官方网络和私有 Agent HTTP 协议替身覆盖保存后中断恢复、幂等、generation、撤回／跨目标、摘要授权与过期恢复。此类测试不是实际 OKX 账户连接证据。上游接口与本子任务分别通过后，由发版负责人统一合并部署；本子任务不安装手机。

### Producer 适配边界

`createSourceJournal().recordVerifiedState(identity, goalId, provider, metadata)` 只供宿主在真实验证并持久保存 producer 记录后调用。metadata 是 opaque `connectionId`、单调 `version`、`state`、`observedAt` 和 ready 时的摘要 digest，不是 UI 传来的 `connected` 或 `verified:true`。同连接旧 version 拒绝；已断开／撤回的连接 id 退役，新连接必须用新 id。私有状态核心按 provider 隔离，当前 Agent 递送协议只开放 `okx`。

`createHostSourceEventBridge({adapters:{okx:{listGoals,lookup,revoke?}}})` 可以替换 vault 兼容适配。lookup 读取已入库的权威记录，返回 `{metadata,summary}`；`metadataOnly:true` 时只读非敏感状态。启动／周期重复 lookup 可补回“权威记录已保存、source journal hook 尚未执行”的事件。返回摘要必须与已入库 digest 一致，按请求和当前 goal 授权校验后才进入绑定 read result。

未来原生上传成功入库 hook 将接此接口：它必须由原设备配对身份、真实只读权限检查、完整摘要验证和单调采集版本来建立权威事实，不能接受 WebView／模型自报。没有该上游 hook 时，受控 native producer 测试只证明适配接口和恢复机制，不证明已接入真机采集。配置 native adapter 后不会回退读取旧 Host vault，来源凭据位置也不由此模块改变。

### 本子任务验收证据

`test/source-event-bridge.test.mjs` 的 12 项专属测试使用合成只读账户、真实加密文件与 loopback HTTP Agent 协议替身。覆盖：保存后丢 hook／删除后丢 commit 的重启对账、status 与同值刷新幂等、单调版本与退役连接、跨目标和配对隔离、旧 generation 拒绝、同 generation 新 revision 跟进、stale 同请求刷新恢复、临时目标服务失败恢复、读取期间撤权，以及无凭据的持久 native 摘要 adapter。禁用 native producer admission 的受控变异在“应有一条 ready event”断言失败（实际 0），证明该回归能识别原断点。

上述均为隔离协议／文件路径证据，不是实际 OKX 网络、Agent 真实模型调用、真机采集或通知送达证据。实际 native 采集上传成功后的权威存储 hook 尚依赖上游协议；当前 vault 适配不决定未来凭据位置。完整回归、固定提交与跨仓接口复核由本轮集成人登记。
