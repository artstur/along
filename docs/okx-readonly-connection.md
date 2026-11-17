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
- 本次账户摘要供 App 展示；完整交易历史与 Agent 策略分析为后续工作，不因连接成功宣称已完成。

## 验证与交付

隔离的模拟 OKX 服务覆盖签名、权限拒绝、API错误、超时、持久化、重新打开、刷新与断开；宿主配对/目标归属和原生桥保持隔离；回归原有健康连接与任务。运行 check/build、iOS 编译及模拟器交互，并由只读代理独立复核固定提交。合并后覆盖安装原 iPhone，保留用户数据与配对。真实授权必须由用户在 App 完成，mock 测试、安装、启动和真实账户读取分别记录。
