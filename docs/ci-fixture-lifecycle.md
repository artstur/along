# CI Host 启动失败与隔离夹具

2026-11-24：Pages run 45224773223（源码0d282e18d5ac7154f08a2a91bb673e8798920990）在macos-15-intel执行check时，agent-runner-contract的Kimi分流测试报告Host未就绪；该文件后续测试已输出，Node进程仍未退出，build/deploy尚未开始。

## 目标与范围

只修测试夹具，不改产品、并发数、证书验证、权限或部署检查。原启动失败的具体Host错误尚不可见，不把推测当作线上产品缺陷。

已发现两处独立风险：

1. Host启动与配对发生在测试try/finally之前；失败时已监听的stub runner及未返回的Host子进程没有可靠释放。runner夹具也在就绪后才定义stop。
2. provideCloudCa默认把CA写到stateDir的父目录/test-ca。并行测试的stateDir通常同在系统tmp目录，会同时改写同一组CA/叶证书，可能产生不匹配材料；清理stateDir还会遗留共享CA。

## 方案

- 隔离CA由当前测试的stateDir（或显式baseDir）持有；每套目录独立，保留原证书扩展和严格验证。
- 资源一经创建就登记清理；Host或runner启动失败也停止自己创建的子进程；检测已退出子进程并报告退出状态，避免只等就绪超时。
- 独立回归通过真实contract测试入口、仅替换其隔离Host子进程来强制启动失败。用有界进程退出证明stub server和子进程已清理；超时只终止该回归自己创建的进程组。

## 验收

- 原版在强制Host启动失败后无法有界退出，修复后失败明确且自然退出；业务断言不变。
- 两套CA夹具互不改写，证书与key可组成严格TLS上下文；并行生成仍独立。
- 对应contract、证书回归与完整npm run check通过。GitHub必须重跑完整check后才能部署，不跳过旧失败或放宽断言。
- 本变更无用户可见代码或资源，iPhone安装仍按用户安排延期。

## 已执行结果

- 原版强制Host exit71：15.2秒出现原`host 没有就绪`失败，20秒仍不退出，隔离外层只回收自己创建的进程组。不同stateDir共用CA的断言也失败。
- 原Actions run于17:36:10Z取消；完整日志确认4项Host启动失败，test45之后停住，取消时回收5个orphan Node进程。旧helper未上抛Host stderr，原始启动失败是否由CA竞争导致仍未证实。
- 修复后焦点18/18通过；新增4个真实并行Node进程生成CA并验证key/cert/root一致性。完整`npm run check`：790通过、0失败、9跳过（799 tests），81.2秒；`npm run build`两份22文件成功且无产物差异。
- 新回归在Windows显式跳过进程组回收用例；现有CI为macos-15-intel。GitHub修复后的完整check及Pages部署交Router/Release按最终主线SHA执行，不能以本机通过声称GitHub已绿。

## 第二次CI的明确阻断与最小修复计划（2026-11-24）

PR53合并后的run45230317803在check满15分钟且无可读live日志时，按有界诊断取消；最终日志确认contract的Host已经快速exit1，不再卡住本文件，但ca-tls-material多项明确“云端TLS根证书不是CA”，host-runner-agreement仍在启动失败后泄漏fixture。

先通过机器上实际可用的OpenSSL实现生成同一隔离根证书，直接读X509Certificate.ca和证书扩展，验证多次-addext与显式配置文件之间的差异，不能仅把失败归咎于CI平台。确认后，测试CA统一显式basicConstraints/keyUsage，复用严格生成器；Host产品校验保持原样。第二个contract夹具的setup进入清理作用域，子进程提前退出可见且有界回收，保留所有业务和秘密日志断言。

文件范围预计test/cloud-ca-fixture.mjs、test/ca-tls-material.test.mjs、test/host-runner-agreement.test.mjs及独立回归/本文；必要时仅扩展现有启动回归，不改Host、工作流、权限、并发、跳过或产品资源。验收要求真实OpenSSL差分红→绿、严格加载有效CA成功/无效CA仍拒绝、两个contract启动失败自然退出、全部check/build通过；再走独立PR/Release审阅和GitHub实际重跑。

确定的复现不是“某个平台不支持CA”，而是**默认req.x509_extensions与-addext叠加同OID**：在实际LibreSSL3.3.6与从官方固定tag隔离构建的OpenSSL1.1.1w中，默认v3_ca加旧recipe都生成2份BasicConstraints/KeyUsage，Node.ca=false；默认leaf_default与CA:true冲突亦可由独立Release探针复现。有效minimal配置下两实现均true，因此版本或缺配置本身不是根因。

修复用自有完整ca.cnf/-extensions root_ca，三套原recipe统一复用共享测试helper；不叠加宿主默认扩展。第二contract所有Host acquisition（包含blocked用例与真实runner情境复查）进入清理作用域，子进程启动失败也完整停止。永久回归增加冲突环境下严格加载、同文件blocked失败退出，并额外确认显式非CA根仍被产品拒绝。

第二次修复验证：5文件聚焦62/62通过；补blocked启动失败参数后，完整`npm run check` **794通过、0失败、9跳过（803 tests）**，82.2秒。`npm run build`两份22文件成功且无产物差异，`git diff --check`通过。仅6个test/helper/docs文件，GitHub实际检查和部署仍交独立Release在合并后按最终主线执行。Release原始冲突配置与status入口探针将对固定提交复验并保留外部收据，不能把本机结果当公开站或真机通过。
