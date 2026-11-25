# 原个人工作区接入现有云服务

2026-11-24。范围为一位已配对用户的一次冷交接，保留原业务ID、同步日志prefix、手机待发事件、权限与通知namespace。现有公网连接入口和同Mac私网换址仍保持原守卫；本方案新增有来源证书签名、设备nonce和云导入回执的专用交接，不把新配对当保全迁移。

实现前置：Along Agent提供固定schema的冷导出/导入及单写围栏；云空间须为空或与原快照完全连续。新设备凭据只经Native受保护文件/Keychain交付，旧Mac bearer不发云。签名绑定源/目标origin、原user/device、双方凭据SHA256承诺、migrationId、快照与同步prefix、手机nonce、用途、到期时间。Native用已存原pin验证来源证书DER，再验证固定字节签名；新云请求严格使用系统PKI和新凭据。

原active健康outbox不归档、不改事件内容；交接提交时重读最新队列并保留期间新增项，先原子保存proof/journal再替换Keychain。切换后旧origin的ACK不能推进新authority。Native返回tokenless证明，Web按精确旧/新scope迁移原工作区、草稿、直接chat与未撤销daily recipient；保持原通知namespace和requestID。云业务沿用原序号prefix时才能续旧cursor，不接受只有同名user或最大seq相同。

新增原生纯读系统通知库存：只读设置、pending与delivered；无Host请求、无授权弹窗、无通知创建/删除或reconcile。不改三个产品模块、不为验证发送测试通知。本次不重构APNs或付费分发。

验收：隔离fixture先复现直接跨Host会归档/撤权；固定证明错误/过期/错pin/错origin/user/device/nonce/hash拒绝；重复交接、queue追加、Keychain失败和各持久化步骤中断可恢复；旧回包不删新事件；原授权撤销不复活；原消息/草稿/通知ID保留。运行npm run check、npm run build、双端资源及Native实际验证，再由独立审阅和release owner合并部署，最后原手机蜂窝/关Mac验收。源码提交、云部署、安装、自然健康ACK与通知送达分别登记。

## 固定接口和单写次序

依赖 Along Agent [PR35](https://github.com/artstur/along-superagent/pull/35) 的交接契约和 [PR36](https://github.com/artstur/along-superagent/pull/36) 的冷停排空守卫兼容修复。2026-11-25 核实 PR36 已合入，真实main为`ccc57ba64494ce528e7c27eff5539455bb09e3e9`，deploy两种镜像的默认Agent pin均为该完整SHA。验收为两处默认构建来源一致且包含该修复，通过`npm run check`、`npm run build`及22项Web/dist/iOS资源比对；实际云部署和原工作区交接另行验收。

PR36 按实际Runtime的退役语义判定`health_dispatch.result=NULL`：有效关联的due/repair/source review中任一已退役时，该dispatch不再算pending，原NULL结果与全部review历史保留。真实pending（仅有active review或没有关联）、无效退役标记、无效事件ID、目标归属不符及缺失/跨作用域source引用仍阻塞交接；不能靠SQL补值或删除历史绕过守卫。schema 18、manifest、摘要、冷锁、单写围栏、Source witness和companion绑定不变。

契约合成fixture仍来自PR35固定作者提交`640b637dcf6ace7dc38adef6284615fcdcf4839f`（与PR35合入main `9b5217695e16559caa954c1ef46d703f44a137b5`同tree）；`test/fixtures/personal-handoff-{manifest,history-receipt}.json`保持逐字节不变，实际Swift验证其完整manifest和有history时的targetReceipt。默认pin和构建通过均不是已部署声明；本轮未改原Mac/云运行时，也不改变App82/Web91或重新签名安装手机。

1. 原手机只读保全后，Native生成24小时nonce challenge；nonce不含token。
2. 停写并保全原Host/Agent，Host导出已静止的最小companion。P1 inspect/freeze接收其canonical SHA256，完整manifest必有`hostCompanionSHA256`。P1包是`{manifest,data}`，本Host工具的`manifestFile`仅接受独立manifest头，不能把整包当头。
3. 空专用云Agent stage导入。Host stage核manifest、P1 fence/targetReceipt、companion摘要、原user/device授权；生成新token，先保存私有交付副本/状态，安装必要账本，最后发布只含hash的原device绑定。没有普通pair或任意业务导入HTTP路由。
4. 原Agent持久`source_retired`后释放migration-only permit；云Agent验证permit后`target_active`成为唯一writer。不能在未知云ACK后重启旧源。
5. 原Host只在精确匹配source_retired、原配对承诺与原证书pin时签固定字段原文。Native验证原DER SHA256==已存pin，再验原始UTF8签名，再严格parse；完整manifest原文字节哈希和importReceipt原文字节哈希均由证明绑定，不用Foundation重新序列化验签。
6. Native用新云token和系统PKI请求`POST /workspace-handoff/status`、空body。Host实际桥接`GET /along-source/api/workspace-handoff/status`，核实际打开数据库的import checkpoint/active fence及全部identity/digests/holds/targetReceipt后才可`handoffReady:true`；普通ready=true或相同IDs的空Source不足以通过。staged仅metadata，不探测/启动Runtime。
7. Native保存proof/prepared journal，再换Keychain，最后committed。换Keychain失败保留原待发；冷启动源侧仍须在线active证明和连接代次复核，缓存先可读；Keychain已是已证明目标时可离线补完本地journal。Native失败不恢复旧源，云继续保持权威。

## Host最小状态闭包

`along-host-personal-handoff/v1`只含原user/device/credential SHA承诺、精确goalIds、来源journal、notificationLedger和`daily:[]`。本版只支持已盘点的空daily，无APNs token和无通知queue；非空或未知形状拒绝，不能静默丢弃。来源journal须归属专用单用户、pending/outbox为空，保留generation/revision、producerVersions、retired与delivery去重。原网关summary/history、账户值、API Key、旧token、Keychain和模型配置不进入包。

P1 `sourceHolds`指向的原ready history必须与Host原generation/revision一致。云stage按同一固定recipe得到unavailable、同generation/nextrevision、`handoff:<migrationId>:cloud_history_unsupported`、manifest.createdAt、无capabilities/digest，目标outbox为空（Agent已在stage持久接纳）；其他ready无gateway也拒绝。原任务、结果、历史证据均保留，暂不声称云可实时读取原OKX history。原手机旧binding的来源和Keychain不动，不回灌旧goal、不重连。

通知只搬原路由账本，原系统请求不会removeAll或增测试通知。Native保留原namespace；Web迁移原scope、草稿和直接chat，已撤销daily不复活。旧Mac ACK与替换过的同号信封不能删除新权威待发。原sync prefix可以续cursor，历史prefix内通知不补发；后续合法云seq增长后冷重开仍延续原cache。

## 受保护的交付入口

本版无需新产品模块。Debug签名包可使用固定App Caches文件（凭据进入Native后只留Keychain，授权journal保存在Application Support）：

- `AlongWorkspaceHandoff.request.json`仅精确接受`{"action":"inventory"}`、`{"action":"prepare","targetOrigin":"https://…"}`或`{"action":"commit"}`。
- prepare写tokenless `.challenge.json`，inventory写`.inventory.json`；commit只读取固定`AlongWorkspaceHandoff.offer.json`，成功后删除offer，`.result.json`只写状态。
- Native执行时核普通文件/大小并设complete保护0600；不从环境变量/argv/网页URL取新凭据。不向外部网页暴露handoff proof，正常跨源守卫不变。
- `readOnlyInventory`仅读UNCenter的设置、pending、delivered及requestID/日历/路由metadata，不读正文、不请求权限、不连Host、不reconcile。Notification Center记录不等同已被用户看见。

Host本机工具只收一个owner-only配置文件，不把新token作为命令参数或日志输出：`node host/workspace-handoff-admin.mjs export-companion|stage-target|sign-source PRIVATE_CONFIG`。配置键以工具的精确白名单为准。产物/配置0600，父目录0700；单次迁移复用相同私有输出，不能用普通configure代替交接或重新pair。操作员须先独立核云Host域名、实际Source及空专用目标，正式源停写/迁云/手机提交只在固定head审阅和发布条件通过后执行。

重复prepare在同源/同目标且原challenge未过期时返回同一nonce。超过challenge/15分钟签名有效期而尚未Native提交时，只为同一manifest、新Native nonce和原有cloud offer重新运行source-retired签发；不重新pair、不重新导入，不把已active云再stage。prepared持久授权的冷恢复使用原journal和Keychain副本，仍执行目标active证明。
