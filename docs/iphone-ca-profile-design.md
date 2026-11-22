# iPhone CA 描述文件与云端 TLS 迁移方案

2026-11-21。用户已选择「iPhone 手动安装 CA 描述文件，并启用完全信任」，本方案据此取代 App 内专用信任锚的建议，以及云端十年自签叶证书钉扎方案。受众为 iOS、Host 实现者及两台手机的部署管理员。

**状态：设计已落文档；代码实现已落地并通过自动化回归，但尚未上线。**

2026-11-21 实施轮次已完成的部分（详见 §7 与本轮交付说明）：服务端云端 TLS 材料加载与启动前校验、iOS
侧系统信任评估委托与连接 v2（`trustPolicy` + `bindingScopeId`）、Web 桥与后台/设备来源/通知的归属迁移、
只含公开根的描述文件制作与核验工具（`tools/ca-profile.mjs`），以及覆盖这些行为的自动化测试。

本轮**没有**做的事：生成生产密钥或生产根、制作可安装的生产描述文件、在 iPhone 上安装描述文件或开启
完全信任、推送发布或部署、真机与双手机验收。§8 的 T01–T21 里可自动化的部分已覆盖，其余仍为待执行项。

以下路径、字段及流程仍是实现契约；「已实现」只指代码与自动化验证，不代表真机或生产已验证。

## 1. 决策、代价与现状

确定的路线：Along 使用独立根 CA；根证书通过 `.mobileconfig` 安装进 iPhone，用户在系统设置启用 SSL/TLS 完全信任。云端 App 请求交给 URLSession 的系统信任评估，移除旧叶指纹钉扎；服务器使用带 DNS SAN 的短期叶证书，Bearer 仍负责业务身份与双用户隔离。

完全信任是**系统范围**，并不局限于 Along，也不因描述文件叫 Along 就获得域名限制。App 的系统评估会接受系统已信任的其他 CA 为目标主机签发的有效证书；本路线不额外限定只能链接到 Along 根。若以后要求此限制，需要另行设计叠加钉扎，不能把系统描述文件与 App 专用锚混为一谈。仅向 Along 签发、根私钥离线保管和逐台可撤除，是本次接受系统信任扩大的约束。

| 已核代码事实 | 证据 | 迁移要求 |
| --- | --- | --- |
| Host 缺证书时现场自签，仅传 CN/天数；云端 Compose 配置 3650 天 | `host/agent-host.mjs` 的 key/cert 生成段；`deploy/docker-compose.yml` 的 ALONG_TLS_* | 云端改用预签发证书，缺失或不合法就拒启；本地模式保留既有证书机制 |
| 原生只比较叶 DER SHA-256，然后 useCredential | `ios/AlongHealth/Sources/AlongShellView.swift` 的 PinnedAgentDelegate | 云端移除该放行分支，不能只安装根而保留叶钉扎 |
| 连接存储、Web 桥、设备采集、通知和健康队列均依赖 fingerprint | AlongConnectionStore.clean、`web/agent-client.mjs`、PhoneSourceCoordinator、EventTaskNotifications、HealthKitReader | 一起迁移；不能只修改一个网络委托 |
| 地址接受合法 DNS 域名及 RFC1918 IPv4，不接受公网数字 IP | AlongConnectionStore.hostAccepted | 本方案用生产域名；公网 IP 直连不在本轮目标 |

现状事实与实施状态以工作树为准。描述文件不会替代新 App 发版，也不会改变旧 App 的叶钉扎。CA 不认证访问者：公网 `/health`、配对入口及连接资源防护仍需独立处理。本轮不引入 mTLS、MDM、反代、公共 CA 自动兜底或原始健康数据上云。

## 2. 系统信任评估与连接契约

### 2.1 云端请求的唯一放行路径

1. 原生按保存的连接校验 HTTPS、规范化主机名与端口、无 user/password/path/query/fragment、路径白名单。主机名精确匹配当前连接，不用字符串 contains 或任意后缀匹配。
2. 每个请求使用现有 ephemeral URLSession 和禁止重定向策略。serverTrust challenge 的主机必须与预期主机一致；相符时 `.performDefaultHandling`，由 URL Loading System 执行系统信任评估及 ATS；不再自行返回 `.useCredential` 放行云端证书。非预期身份挑战不提供额外凭证。
3. 系统验证签名链、可信锚、请求主机名和证书有效期；ATS/TLS 要求保持生效。没有安装根、没有开启完全信任、错误 SAN、过期/尚未生效或链不完整，都必须失败，不发送 HTTP 层配对码、Bearer 或业务数据。
4. 不调用 `SecTrustSetAnchorCertificates` 把 App 内证书或服务器传来的根设置为可信，不设置忽略证书错误的例外。若实现者为诊断调用 `SecTrustEvaluateWithError`，必须保留系统的 SSL hostname policy、锚集合与验证时间，不能用该调用替代或放宽 URLSession/ATS 的放行规则。
5. TLS 失败是 TLS 失败；HTTP 401 是绑定失效。诊断文案区分两类，不能把信任错误当成“重新发码即可修复”，也不能自动重试旧叶钉扎或不验证的连接。重定向即拒绝，不能把凭证转给另一个合法证书域名。

系统默认处理是本设计选定的实现方式，依据 [Apple URLSession 信任评估说明](https://developer.apple.com/documentation/foundation/performing-manual-server-trust-authentication)。安装描述文件仍须保留 Release 真机 ATS 验收，不能用合成 challenge 或关闭校验的 Node 请求代替。

### 2.2 旧连接迁移与 Mac 兼容

后续实现给原生持久连接增加 `version:2` 与 `trustPolicy`，这是内部状态，不新增用户选择模式的开关：

| 连接 | 策略 | fingerprint 的角色 |
| --- | --- | --- |
| 新的云端 DNS 连接 | `system-pki-v1` | 不要求输入、不作信任判定，不复用为 CA 指纹 |
| 已有 DNS + 叶指纹连接 | 待迁移，成功后 `system-pki-v1` | 旧值仅用于迁移旧本地状态；迁移失败不能启用旧网络放行 |
| 已有或新建 Mac RFC1918 IPv4 连接 | `legacy-local-pin-v1` | 保留原来的本地叶钉扎；不扩大为公网兼容入口 |

原生根据经校验的连接与持久状态决定策略，不接受 JavaScript 请求自报 `trustPolicy` 来放宽规则。云端 TLS 失败后不得把同一绑定改成 legacy；换 Mac 是用户在现有连接区主动建立另一连接。Mac 旧委托的既有局限仍存在，本设计不宣称已修复该本地机制，也不要求用户为 Mac 安装系统根。

已有云端连接在原域名/端口不变时，可先用**系统校验**的新会话向 `/connection/verify` 验证原 token；仅成功后原子保存 v2，保留原 token、已验证身份和本地业务历史。若 token 已失效，走现有 `/pair` 重新发码；不恢复过期/被吊销 token。保存失败不启用半迁移状态；旧数据保留供重试，但新版本仍禁止用旧 DNS 叶钉扎发请求。

叶证书摘要不能继续充当“用户/设备绑定 ID”。新增统一的稳定 `bindingScopeId`，由规范化 origin（scheme/host/有效端口）及配对 token 的哈希派生；需要用户维度的模块再使用已验证的用户身份。它不是凭证、不发给模型、不记录原 token，也不随同根叶轮换变化。迁移时对同 origin、同 token 且 verify 成功的旧状态做一次受控映射：

- 一起升级 AlongConnectionStore、Web 配置及原生桥，系统策略不再强制 fingerprint 非空；legacy 本地仍需 64hex 叶指纹。
- 更新 `web/app.mjs` 的连接比较与工作区绑定，PhoneSourceCoordinator、EventTaskNotifications、HealthKitReader 的作用域计算、回执关联及后台读取，不能把缺 fingerprint 当成未配对，或使轮换触发新用户/新设备。
- 结束旧异步回写、核对通知去重；健康/OKX 授权与队列仅在确认同一绑定后映射。无法证明归属的队列暂停并保留，不重标记后投递给新绑定。换域名、换 token 按换端处理，不沿用上述无感路径。
- 临时双读只用于本地数据迁移，写入统一 v2；不提供双 TLS 信任逻辑。一次性迁移不得重复清空目标、创建重复通知或恢复用户撤销的授权。

## 3. 根、叶证书与描述文件契约

### 3.1 密钥与证书

| 对象 | 方案参数 | 存放及约束 |
| --- | --- | --- |
| Along 生产根 | 建议 RSA 4096/SHA-256、5 年，critical CA:TRUE、pathLen:0、keyCertSign/cRLSign；期限由保管人最终确认 | 加密根私钥仅在确定的 CA 保管机及加密离线备份，禁止进入 VPS、Host/runner 卷、镜像、日志、描述文件或 iPhone |
| 服务端叶 | 建议 RSA 3072/SHA-256、90 天；SAN 明确列出实际 DNS 域名；critical CA:FALSE；EKU serverAuth；KeyUsage digitalSignature/keyEncipherment | 叶私钥在服务端生成并提交 CSR，CA 机审查 SAN 后签发；服务端只部署叶私钥和公开证书链 |
| 根公开证书 | 固定 DER 编码、完整 SHA-256 指纹；另记 SHA-256 SPKI 标识 | 可分发；根身份按完整指纹/公钥确认，不能只按 CN、文件名或名称匹配 |

本期根直接签叶，无需在线中间 CA。任何 OpenSSL 版本都必须通过明确的扩展配置签发，不依赖 `req -x509` 的默认扩展；不能仅把原来的 CN 改成域名。DNS SAN 与请求域名一致；根的有效期不能短于计划签发的叶。若将来支持 IP，必须显式签 IP SAN 并调整客户端地址约束，DNS:<数字IP> 不能替代。

建议云端证书版本目录为 `/opt/along/data/host/tls/releases/<serial>/`，包含 `fullchain.pem`、`key.pem`、公开 `root.crt` 及不含秘密的台账；`tls/current` 原子切到已校验版本。`root.crt` 是供 OpenSSL/探针使用的 PEM 副本，与 profile 所用 `root.der` 是同一根的不同编码；核验身份统一以 DER SHA-256 为准。初期 fullchain 只有叶；有中间 CA 时按叶→中间链提供，不靠客户端临时抓链补齐。私钥 0600、目录 0700、所有者为实际 Host 用户；证书和密钥为可识别的普通文件，路径解析限定在受保护的版本目录内。「根私钥不上服务器」这条防线按**内容**判定，不按文件名：递归扫描版本目录里的每一个 PEM 私钥，只要其公钥与公开根的公钥相同即判为根私钥上服务器——改名或放进子目录都躲不掉（按文件名黑名单会被平凡绕过）。扫描范围覆盖整个 `tls/releases/` 目录树（不只是 `tls/current` 指向的那一个版本）并跟随目录内的符号链接：兄弟版本目录里的材料同样是这台服务器上的材料，链接指向的私钥也必须参与判定。

后续 Host 以现有云端 Runner 配置识别云端形态，读取上述固定位置，不新增安全降级开关。`ALONG_TLS_CN` 在云端表示期望 DNS 主机，`ALONG_TLS_DAYS` 不再触发云端自签；本地自签参数仍按现有逻辑使用。云端监听前校验证书/私钥匹配、链、SAN、用途、有效期、所有者/权限；任一不满足就拒启。旧 `/data/cert.pem`、`/data/key.pem` 不得成为云端失败兜底。

### 3.2 `.mobileconfig` 仅含公开根

交付包：`Along-<environment>-<root-id>.mobileconfig`、根 DER、公开清单。`root-id` 可取 SHA-256 前缀作显示标签，实际核验必须用完整摘要。新根使用不同名称/标识/UUID，旧新可并行安装且可分别删除；同一根的同一版本只分发固定字节文件。

| 层级 | 必需字段及约束 |
| --- | --- |
| 外层 | PayloadType=`Configuration`；PayloadVersion=1；独立 PayloadUUID；PayloadIdentifier=`com.artstur.along.ca.<environment>.<root-id>`；PayloadDisplayName 包含 Along、环境和 root-id；允许用户移除，不设置不可移除限制 |
| PayloadContent | 只有一个 root payload；不夹带 VPN、代理、MDM、SCEP、账号、WebClip、客户端身份或其他配置。核验按**白名单**判定：描述文件里出现过的 `PayloadType` 只能是外层 `Configuration` 与 `com.apple.security.root` 两个值，出现任何其他类型一律拒绝；`PayloadContent` 数组的元素个数必须恰为 1（不能只数根 payload 的个数——夹带第二个同类型 payload 也要拒）。黑名单不可用：Apple 真实的类型名多为无后缀形式（`com.apple.security.pkcs12`、`com.apple.security.scep`、`com.apple.identityPreference`），按 `com.apple.vpn.*` 这类带点的模式匹配不到，而 `pkcs12` 能携带客户端身份与私钥 |
| root payload | PayloadType=`com.apple.security.root`；PayloadVersion=1；独立 UUID/identifier；PayloadCertificateFileName 标出 `.cer`；PayloadContent 为 DER 根证书的 base64 data，不是 PEM 文本或 PKCS#12 |

该结构依据 [Apple CertificateRoot payload](https://developer.apple.com/documentation/devicemanagement/certificateroot)。本期物料采用可审查的 XML plist，真实性依赖下节的可信交付与带外完整摘要；没有既存可信签名身份时，不把自签 CMS 的标记冒充真实性证明。证书自签只证明对应私钥的签名关系，不证明分发者身份；不把 iOS 的“已验证”字样、同名 CN 或文件扩展名当作根身份。XML 未签名可能显示相应提示，必须在完成核验后再安装，不能用提示文字替代核验。

## 4. 安全分发、安装与移除

### 4.1 带外核验与分发

管理员在可信 CA 工作环境中生成固定交付包与清单，清单包含：根证书完整 DER SHA-256、SPKI SHA-256、描述文件 SHA-256、根序列号/有效期、profile 标识/UUID、环境、生产 origin 和责任人。摘要及登记不含根/叶私钥、模型密钥或配对 token。

公开材料核验可使用以下只读命令（执行前替换为已批准的公开文件；本轮未执行生产操作）：

```sh
openssl x509 -in root.crt -noout -subject -serial -dates -fingerprint -sha256
openssl x509 -in root.crt -outform DER | shasum -a 256
shasum -a 256 Along-production-ROOTID.mobileconfig
```

第一条的 SHA-256 指纹与第二条 DER 摘要为同一证书身份，显示时可有冒号/大小写差异。不能混淆 PEM 文件字节摘要、DER 证书摘要与 SPKI 摘要。

还需在可信计算机核对 profile 内的确切 payload 与已批准 `root.der`，而非只核对旁边的一份证书文件。以下只读示例适用于本期 XML plist，任何额外 payload、不同根或摘要不符均停止安装；输出仍须与独立渠道的清单比对：

```sh
python3 - Along-production-ROOTID.mobileconfig root.der <<'PY'
import hashlib, plistlib, sys
from pathlib import Path
raw = Path(sys.argv[1]).read_bytes()
profile = plistlib.loads(raw)
assert profile['PayloadType'] == 'Configuration'
payloads = profile['PayloadContent']
assert len(payloads) == 1
assert payloads[0]['PayloadType'] == 'com.apple.security.root'
der = payloads[0]['PayloadContent']
assert isinstance(der, bytes) and der == Path(sys.argv[2]).read_bytes()
print('profile SHA-256:', hashlib.sha256(raw).hexdigest())
print('root DER SHA-256:', hashlib.sha256(der).hexdigest())
PY
```

默认两台手机采用管理员在场交付：通过预先认证的独立渠道确认上述完整摘要，在可信 Mac 上核验**待传输的确切描述文件及其嵌入根**与清单一致，再以双方确认身份的 AirDrop 交付到指定 iPhone，安装时逐一确认 payload 清单和标识。不能仅凭 AirDrop 显示名确定发送者。

远程下载只允许独立、已受系统信任的 HTTPS 分发站点，并且有接收端对原始文件/嵌入根完成同样摘要核验的既定工具或受信任计算机；尚未具备时不承诺纯 iPhone 远程核验。不要假定每个 iOS 版本的设置页都展示完整 SHA-256。文件和摘要若仅来自同一个未认证网页，不构成带外核验；不能从尚未受信任的 Along Host 首次下载根后盲信，也不能让用户为下载而跳过证书警告。

### 4.2 两台 iPhone 分别安装

1. 管理员完成 4.1 的摘要与嵌入根核验，记录该设备的交付状态。用户确认描述文件仅含 Along 专用公开根，环境、标识和 root-id 与清单一致；有额外 payload、同名不同摘要或来源不明就取消。
2. 在 iPhone 打开收到的描述文件。进入「设置」中的“已下载描述文件”，或「设置 → 通用 → VPN 与设备管理」查看待安装项目；选择该 Along profile，按系统要求输入设备密码并完成安装。具体入口以目标 iOS 版本显示为准。
3. 进入「设置 → 通用 → 关于本机 → 证书信任设置」，在“启用对根证书的完全信任”中开启本次 Along 根，并确认系统提示。**安装完成不等于 SSL/TLS 已完全信任**。[Apple 手动信任说明](https://support.apple.com/en-us/102390)
4. 若没有对应开关，检查是否真正安装、设备是否受管理/受限制；不以安装其他同名根、开 ATS 例外或改旧 pin 绕过。不属于本方案的 MDM/监督设备交由设备管理员处理。
5. 在目标新 App 上验证实际生产域名的连接。管理员证据中分别登记 profile 安装、完全信任开启及 App 新 TLS 握手成功；Safari 能打开只能辅助排查，不能代替 App 前台/后台验收。配对码在 TLS 就绪后才签发，避免消耗 15 分钟有效期。

### 4.3 停用、卸载与撤信

1. 停止 Along 请求/退出 App。紧急时先在「证书信任设置」关闭该根的完全信任；这不替代最终删除。
2. 进入「设置 → 通用 → VPN 与设备管理」，按清单标识、环境与 root-id 选择对应 Along profile，查看内容后“移除描述文件”，按系统要求输入密码。不要删除无关单位/学校的配置。
3. 按 Apple 建议重启设备，确认 profile 已消失，完全信任列表不再包含该根。重复安装或其他 profile/管理渠道若还包含**同一根公钥/证书**，必须逐一处置；只删除一个同名项目不算撤信完成。[Apple 移除说明](https://support.apple.com/en-ie/guide/personal-safety/ips327569a75/web)
4. 新开 App、新建 TLS 会话，对仍只提供旧根链的测试端必须失败。撤信以新完整握手验证；不能保证系统设置操作会立即中断已有连接。服务器重启/替换 TLS ticket keys、App session 失效及必要的设备重启须纳入事故操作。
5. 卸载 App、删配对 token、删手机上的 `.mobileconfig` 下载文件或仅删服务器证书，都不等同于从系统撤除根信任。描述文件只有根 payload，移除应不删除 Along 业务数据；若现场发现额外 payload，停止并审查，不能套用本步骤假定无影响。

## 5. 从现有叶指纹钉扎切换

采用一次有明确时间窗的双手机切换，不为公网 DNS 维持“系统校验失败再试旧 pin”的兼容分支。切换期旧 App 与新叶不兼容，属于需提前告知的短时不可用；不能以关校验规避。

| 顺序 | 执行角色 | 操作及通过条件 |
| --- | --- | --- |
| P0 输入 | 用户/管理员 | 确定 §9 的生产域名、保管人/保管机、双手机可升级时间和事故联络；本轮到设计交付为止 |
| P1 实现 | iOS/Host 实现者 | 完成 §7；测试 CA 和合成数据先通过 §8；确认当前并行安全修复与 BISECT 排查结束，保存确切版本/证据 |
| P2 准备 | CA 保管人/管理员 | 后续获执行授权后才创建独立生产根；签正确 SAN 叶，制作只含根的 profile；检查受保护证书版本目录、加密备份及公开清单 |
| P3 手机准备 | 两位用户与管理员 | 两台手机都完成安装、完全信任和带外核验；登记旧连接备份状态及新版安装包可用性，不导出配对 token 或原始健康数据 |
| P4 切换窗 | 管理员/两位用户 | 暂停 App 新请求；原子发布 CA 叶及新 Host，安装新版 App；顺序可协调但窗内保持请求暂停，不允许旧 App 继续承载云端业务 |
| P5 同端迁移 | 新 App/用户 | 用系统信任验证相同 origin 与原 token，保存 v2 并完成本地状态映射；原 token 无效才重新发码配对，不能重建已吊销访问 |
| P6 验收 | 管理员/两位用户 | 两台手机前台/后台、锁屏后读取、双用户隔离、同根换叶、撤信负例全部通过；记录 App/Host 版本、根/叶指纹及证据，不记录秘密 |

恢复策略：部署失败时恢复上一组**仍有效且可信的 CA 叶/私钥**。尚未迁移成功则保持停机排查，或用户明确切回原 Mac 私网连接；云端不恢复“接受所有证书”、旧 DNS pin 或已泄露密钥。此迁移不能假定旧 token 必须重置，也不能保证已失效 token 自动续用。

## 6. 叶轮换、根轮换与失窃恢复

| 事件 | 操作 | 设备侧及验收 |
| --- | --- | --- |
| 同根、同 SAN 的计划叶轮换 | 建议提前 30 天提醒、提前 14 天完成新 CSR/签发；用新叶私钥、检查有效期/用途/链和匹配后原子切目录并重建 Host，读回实际出示证书 | 无需重装 profile、输入叶指纹或重新配对；旧 token 有效时绑定、历史、授权与通知作用域保持不变。轮换失败可回仍有效且未泄露的上一版本 |
| 叶过期/私钥丢失但无泄露迹象 | 暂停服务，签新叶及新 key，按同根轮换恢复 | 不忽略过期、不临时改系统时间；恢复前请求失败，恢复后同绑定验证 |
| 叶私钥确认或疑似泄露 | 停止原服务、换叶 key、处置可能泄露的会话及配对码；不能仅部署新叶就宣布旧叶失效 | 本期未建设可被客户端可靠强制检查的私有 CRL/OCSP。保守处置是两台手机撤除旧根及所有同根副本，重启/清连接后经独立渠道安装新根，再用新根签叶恢复。根未丢失也可能需要这样切根，代价已明确 |
| 计划根轮换 | 用独立新根、新 profile 标识/UUID；逐台带外核验、安装并完全信任；两台就绪后换到新链；到约定截止时间删除旧 profile | 旧/新根并行只限登记时间窗；不能无限保留旧根。移除旧根后旧链失败，新链及现有有效业务绑定继续可用 |
| 根私钥确认或疑似失窃 | 立即带外通知两人；优先关闭完全信任并删除旧 profile/重复根，隔离 CA 保管环境；独立干净环境新建根与叶，重新分发 | 不能用旧根签“新的安全根”作为唯一证明，也不能继续从疑似被控 Host 获取恢复材料；全部可达设备撤旧并验证后才恢复。未确认撤信的离线手机不得计为恢复完成 |
| 用户换手机/退出 | 服务端吊销该用户 token 及未消费配对码；旧手机撤根/移除 profile，新手机按首次安装流程 | 应用鉴权撤销与系统撤信是两件事，另一用户不得受业务吊销影响；根移除仅作用于执行移除的那台设备 |

本路线的私有 CA **不保证自动吊销检查**；CA 文件或 CRL 的存在不代表 iOS 每次都强制查询。手动两手机环境没有可靠的远程强制撤信手段，离线设备尤其如此。若业务要求分钟级、无人值守的证书撤信 SLA，需要另行评估受管理设备、显式可验证的撤信策略或网络准入，不能在本方案中虚报已具备。撤信截止时间必须由用户补充，过渡根到期也不替代主动删除与负例验证。

## 7. 后续实现范围与完成条件

本节是实施清单。2026-11-21 实施轮次已完成「完成条件」里可自动化的部分；下表的「完成条件」描述的是
目标状态，不是「已全部达成」——真机安装、完全信任、撤根与双手机验收仍未执行（见 §8 覆盖情况）。

| 改动面 | 文件/入口 | 完成条件 |
| --- | --- | --- |
| 系统信任与持久连接 | AlongShellView.swift：AlongConnectionStore、agentRequest、PinnedAgentDelegate；Info.plist | 原生策略 v2；DNS 系统信任、无降级；URLSession/ATS、路径和重定向限制；Keychain 成功后启用；不硬编码设备已安装根的假状态 |
| Web 连接和数据归属 | `web/agent-client.mjs`、`web/app.mjs` | DNS 表单移除叶指纹必填，沿用地址/配对码流程；接收原生确认的策略和绑定作用域；切换与迟到回执隔离；不新增任意安全模式开关 |
| 原生后台与设备来源 | HealthKitReader.swift、PhoneSourceCoordinator.swift、EventTaskNotifications.swift，及扫描出的 fingerprint 消费点 | 统一 scope helper 与一次性映射；不依赖叶摘要判断用户；无重复通知、丢队列或跨绑定重投 |
| 服务端 TLS | `host/agent-host.mjs`，独立可测试的证书加载/检查模块（如实现需要） | 云端固定证书位置、SAN/用途/时间/权限检查、缺证拒启、原子换版；不加载根私钥；本地回归不受云端策略影响 |
| 编排与运维 | `deploy/docker-compose.yml`、env.example、deploy/README.md、仓库 README | 去除云端 3650 天自签操作；安装物料与证书台账、续期提醒、健康检查用正确 SNI/主机名和公开根验证；关闭 TLS 校验的探活不能作为信任验收证据 |
| 发版与测试 | 连接迁移/云端 TLS/后台/设备来源/文档契约测试 | 更新不再适用的叶指纹断言；按 AGENTS.md 同步 Web ?v=、SW CACHE、内置页 build=、CFBundleVersion；实际版本号按实施时工作树递增，不覆盖并行版本 |

### 7.1 本轮实现落点

| 改动面 | 实际落点 |
| --- | --- |
| 服务端 TLS | 新增 `host/tls-material.mjs`（加载 + 启动前校验：私钥/证书配对、链可验签到根、SAN 覆盖期望主机、EKU serverAuth、CA:FALSE、有效期、私钥 0600/目录 0700、**所有者必须是 Host 用户**；「根私钥不上服务器」按内容判定——递归扫描版本目录，任何 PEM 私钥的公钥与公开根相同即拒绝，改名或子目录都躲不掉）；`host/agent-host.mjs` 在云端形态（配置了云端 Runner）改用该材料，缺证或不合规则在监听前拒启，不再自签兜底；本地单用户形态保持既有自签不变 |
| 系统信任与持久连接 | `ios/AlongHealth/Sources/AlongShellView.swift`：新增 `SystemTrustAgentDelegate`（`performDefaultHandling`、挑战主机须与期望主机一致、不返回 `useCredential`、不设信任锚、不跟随重定向）；`AlongConnectionStore` 增加 `trustPolicy`（`system-pki-v1` / `legacy-local-pin-v1`）、`bindingScopeId` 与 `scopeSeed`；入口守卫按主机形态决定是否要求 64hex 叶指纹 |
| Web 连接和数据归属 | `web/agent-client.mjs`（叶指纹不再是必填、归属改用 bindingScopeId）、`web/app.mjs`（连接比较、事件工作区绑定键、健康委托接收人、后台模板身份）、`web/event-workspace.mjs`（通知载荷带 bindingScopeId）。`web/app.mjs` 的 `eventConnection()` 保留 §2.2 允许的迁移期一次性双读：旧记录只有叶指纹且与当前连接指纹一致时映射为当前绑定作用域并写成 v2；指纹对不上或离线无法确认时不采用 |
| 原生后台与设备来源 | `HealthKitReader.swift`、`EventTaskNotifications.swift`、`PhoneSourceCoordinator.swift` 改用 `AlongConnectionStore.scopeSeed` / `bindingScopeId`，不再用叶摘要判断用户 |
| 描述文件工具 | 新增 `host/ca-profile.mjs`（只含公开根的 XML plist 生成 + 结构与嵌入根核验 + 公开摘要）与 `tools/ca-profile.mjs`（`profile` / `verify` 两个子命令）。核验按**白名单**：出现过的 `PayloadType` 只能是外层 `Configuration` 与 `com.apple.security.root`，且 `PayloadContent` 数组元素恰为 1——黑名单漏掉 Apple 真实的无后缀类型名（`com.apple.security.pkcs12` 能携带客户端身份与私钥） |
| 编排 | `deploy/docker-compose.yml` 去掉云端 `ALONG_TLS_DAYS` 自签，`deploy/env.example` 同步；健康检查明确标注为存活探针而非信任验收 |
| 升级迁移（复核修订） | `web/app.mjs` 把「同一绑定」与「真换端」分成两层：身份层看 origin + token，归属层看 bindingScopeId。旧 App 升级当次只是归属键从 token 补齐成 bindingScopeId——**同一绑定**，每日委托授权与提醒时间原样保留（`migrateDailyRecipient` 只迁接收人键，不动 grant、不写撤销名单）；换 origin 或换 token 才是真换端，仍然隔离并撤销。用户主动撤销过的授权不在恢复范围（撤销名单里的 grant 本就没有可迁的授权） |
| 吊销与过期字段 | `host/pairing.mjs`：`revokePairing` 同时删除该用户绑定条目**与未消费的配对码**（只删绑定表的话，吊销前的旧码仍能换出新 token）；`readPairings`/`loadPairings` 区分「缺 expiresAt」（历史兼容，永不过期）与「显式非法 expiresAt」（整条丢弃，不授权，按 401 处理并重新发码自愈） |
| 测试 | 新增 `test/ca-tls-material.test.mjs`、`test/host-cloud-ca-tls.test.mjs`、`test/cloud-ca-fixture.mjs`、`test/app-upgrade-binding-migration.test.mjs`；更新 `test/ios-connection-migration.test.mjs`、`test/deploy-orchestration.test.mjs`、`test/host-multi-user-pairing.test.mjs` 及若干沿用旧归属契约的测试 |

预计不需要新增服务端业务 API。若现有读取无法验证同一身份，先暂停该本地状态的自动映射，不能从客户端自报 userId 补足信任。测试应优先证明没有跨用户投递，再验证无感迁移。

## 8. 失败场景及验收矩阵

每项需记录环境、App/Host 版本、根/叶完整指纹、步骤及结果。证书测试使用隔离 CA/测试域名，不能污染生产手机信任。拒绝项在测试服务端确认未收到 HTTP 配对码、Bearer 或业务内容；不在生产日志打印这些值。

**实施轮次覆盖情况（2026-11-21）**：自动化能覆盖的部分已在 `test/ca-tls-material.test.mjs`、
`test/host-cloud-ca-tls.test.mjs`、`test/ios-connection-migration.test.mjs` 与
`test/cloud-ca-fixture.mjs` 里落地（用隔离测试 CA 与合成材料）。仍需真机或真实部署才能判定的项
保持**待执行**，不得用合成探针宣称通过：T01/T02/T03/T04/T06/T10/T14/T15/T16/T17（真机系统信任与撤根）、
T11 的 Keychain 中途退出分支、T12 的双手机端到端、T13 的迟到回执端到端、T18 的双用户并发、
T19 的 Mac 私网真机回归、T20 的容器内权限与中断发布、T21 的另一系统已信任 CA 场景。

| 编号 | 场景 | 必须观察到的结果 |
| --- | --- | --- |
| T01 | profile 未安装；或已安装但完全信任未开启 | 新 App 的前台/后台 TLS 均失败，无 HTTP 秘密发送；不能被旧叶 pin 接管 |
| T02 | 正确根、正确 DNS SAN、有效叶及完整链 | Release iPhone 上 `/pair`/verify、前台及后台请求成功，未额外安装 App 内锚 |
| T03 | 同名 CN 的错误根；无其他可用信任路径 | 正确摘要核验能识别错根；只装错根不能连接真正 Along 链 |
| T04 | 错误 SAN、只有 CN 无 SAN、把公网 IP 当 DNS SAN | 对生产域名验证失败；公网 IP URL 仍被地址约束拒绝 |
| T05 | 叶过期、尚未生效、签名错误、缺中间链、错误 EKU/不合格叶扩展 | Host preflight 拒启；测试端强行出示时客户端拒绝不合法身份。手机时钟错误可诊断，不放宽规则 |
| T06 | TLS 版本/算法不满足 ATS | 失败，不为通过而加 NSAllowsArbitraryLoads 或手动 useCredential |
| T07 | 同域/跨域 HTTP 重定向，包括另一个受信任站点 | 不跟随，不把 Bearer/配对码带到新地址 |
| T08 | JavaScript 自报 legacy、修改 baseURL/端口或伪造 trustPolicy | 原生拒绝策略降级；需通过既有显式换端流程，不能继承旧 token |
| T09 | profile 内容被改、额外 VPN/MDM payload、指纹只来自同一下载页 | 核验失败或安装被操作流程拦下；单独文件名/CN 不能通过 |
| T10 | 两台旧 App 仅安装 profile，服务端换 CA 叶 | 旧叶 pin 不会自动升级，预期不可用；新版切换流程才恢复，不宣称原 App 无需升级 |
| T11 | 旧 DNS token 有效/已吊销；Keychain 写失败/中途退出 | 有效 token 系统 verify 后原子迁移；失效 token 仍 401；保存失败保留可重试资料但不启用旧 DNS pin 或半绑定 |
| T12 | 同根同域名换叶及私钥、Host 重启 | 无需重配对；两手机身份、健康队列、OKX grant、通知去重和工作区归属不随叶摘要改变 |
| T13 | 跨域名或跨 token 换端、旧异步结果迟到 | 按换端隔离；不会把旧队列/授权/结果重标给新用户，不静默续接 |
| T14 | 只关闭完全信任；移除 profile；删除下载文件；卸载 App | 区分系统撤信与其他动作。清连接/重启后，撤根阻止旧链；仅删下载文件或 App 不当作撤根 |
| T15 | 新旧根并行、撤旧、同名多根/重复 profile | 新链继续可用；所有旧锚移除后旧链新握手失败；不能按 CN 误删/误选 |
| T16 | 叶 key 泄露或根失窃，攻击测试端保留旧 key/叶 | 经事故流程移除所有旧根并换新后，旧测试端握手失败；仅换服务器叶不能判为已撤信 |
| T17 | 离线手机未撤根、旧 TLS 连接/ticket 仍在 | 不宣布全体恢复；清 session、重启设备/服务器后验证新完整握手；记录不可达设备的剩余风险 |
| T18 | 两用户同时迁移/配对/吊销 | A/B 绑定互不覆盖，业务及通知不串；吊销覆盖该用户旧码，不能绕过之前安全审阅缺陷 |
| T19 | Mac 私网旧连接与 DNS 云连接切换 | Mac 既有私网 pin 能力回归通过；DNS 失败绝不回退到该分支 |
| T20 | 服务器缺证、key 不匹配、权限过宽、更新中断 | 云端不自签兜底、不监听；发布失败保留上一可信版本，重启不遗失会话状态 |
| T21 | 另一个系统已信任 CA 为相同域名签出有效证书 | 系统策略可能接受，属于已选择的信任范围；本方案不声称只允许 Along 根 |

实施验收顺序：测试 CA/自动测试 → 镜像构建及只读/降权验证 → 两台 Release 真机失败矩阵 → 测试根轮换和撤除演练 → 生产材料带外核验 → 双手机切换。`npm run check`、相关 iOS 构建及真机证据全部到位前不称为上线完成。

## 9. 尚缺输入与执行门槛

| 输入 | 需确定的值 | 阻塞点 |
| --- | --- | --- |
| 生产身份 | 实际域名、端口、DNS 管理人、SAN 清单；当前 along.example.com 为占位值 | 生产签发与真实 URL/主机名验收 |
| 根保管 | 确切保管机、保管责任人、离线/加密方式、备份位置与取用恢复流程；不能按脚本推测所在机器 | 生产根创建及恢复演练 |
| 两手机条件 | iOS 版本、是否受管理、能否进入完全信任设置、能否同步安装新版 App、切换时间窗 | 安装/移除步骤与发布排期 |
| 分发与核验 | 默认管理员在场交付能否实施；若远程，独立可信站点和接收端摘要核验工具/计算机 | 首次根信任建立 |
| 运维与事故 | 续期值守人、提前提醒渠道、叶/根失窃联络、撤信截止时间、离线设备处理；是否接受手工两机撤根成本 | 生产使用和事故恢复承诺 |

路线已由用户确定，不再请求其重复选择系统描述文件或 App 内锚。这些输入不阻塞本次方案交付，也不阻塞日志、会话吊销等独立安全缺陷修复；生产材料生成和实际切换需另行安排授权。

## 10. 验证边界与背景更正

本轮核对了工作树连接/委托及 fingerprint 消费点、现有部署设计、Apple 官方描述文件/信任 API 文档；仅完成设计与一致性检查。没有运行 iPhone 安装/移除、生产 CA 签发、云端部署或本方案 T01–T21。上一轮审阅的测试条数与合成委托结果不代表本方案已实现或通过真机验收。

hermes-renren 补充更正：其复核认为 VPS Trash 的两把同名测试 CA 私钥与现役 Multica 根公钥不同，扫描未找到现役根私钥；实际保管机仍未确认。本轮未独立复核这些远端结果，**不把“现役 Multica 根已泄露”当作事实**。Along 使用独立根的理由是隔离用途、保管和撤信生命周期。可借鉴其 CA 机签发/服务器只持叶 key 的流程；现有 macOS 初始化脚本不包含 iOS 描述文件分发，不能视为 iPhone 已可安装。

同名不同钥的教训落实到公开台账及安装/撤除操作：使用完整 SHA-256 DER/SPKI 身份，不按 CN 匹配，也不沿用背景排查中的 MD5 摘要作为安全核验格式。OpenSSL 默认扩展与版本/配置相关，因此根/叶扩展全部显式配置；没有把某次默认 CA:TRUE 的复现写成所有平台的事实。
