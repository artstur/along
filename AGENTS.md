# Along 项目约定

这里只写代码里看不出来、做错就会出问题的事。产品说明见 `README.md`，iPhone 薄壳见 `ios/README.md`，接口和参数以代码为准。

## 1. 简单是第一需求

页面已经花了大量时间重构和简化。默认做减法，不做加法。

- 加任何入口、开关、说明、状态或页面前先问：用户没有它会做不成事吗？不会，就不加。
- 一屏只服务一个主要任务。
- 能改现有的就不新建；不为假想需求预留配置、模式或分支。
- 改动会让页面明显变复杂时，先问用户。

## 2. 一份源码，两份产物

根目录是唯一源码，没有打包器。`npm run build` 按 `build.mjs` 的 `files` 白名单，把文件复制到 `dist/`（GitHub Pages）和 `ios/AlongHealth/Web/`（App 内置页面）。

- 不要手改这两个产物目录，改了会被下次 build 覆盖。
- 新增前端文件，要同时登记到 `build.mjs` 的 `files` 和 `sw.js` 的 `FILES`。漏登记会导致产物缺文件，或者离线时打不开。
- 用户可见的改动要让旧缓存失效，下面几处版本号要一起提高：`index.html` 的 `?v=`、`sw.js` 的 `CACHE`、`ios/AlongHealth/Sources/AlongShellView.swift` 的 `build=`；需要重新安装 App 时，还要提高 `ios/AlongHealth/Info.plist` 的 `CFBundleVersion`。漏掉一处，手机上就可能还是旧页面。

## 3. 怎样算改完

- 跑 `npm run check`，这是 CI 用的检查（语法检查加全部测试）。`npm test` 只跑 `engine.test.mjs`，不能替代它。
- 新增模块或测试文件，要加进 `package.json` 的 `check` 脚本，否则不会被检查。
- 推送 `main` 不会自动部署：GitHub Pages 只能手动触发；iPhone 要先 build，再在 Xcode 里重新安装。

## 4. 运行时

- Agent 有两种运行时，在 `super-agent.mjs` 里定义：`dsh-superagent` 和 `kimi-code-swarm`。用户没选过时，前端默认用 Kimi。Host 的路由在 `agent-host.mjs`。
- Mac 本地状态存在 `~/.along/agent-host/`，环境变量见 `README.md`。
- `sync-server.mjs` 是独立的实验代码，不在 App 的健康数据链路里。

## 5. 红线

- Token 只留在 Mac 上：Kimi token 和配对 token 不发给 iPhone，也不写进运行结果。
- Agent 的输出不能直接生效：先经过 `validateGoalReply` 和 `safeAdaptiveLayout` 校验，用户点「采用」后才改变目标空间。
- 健康数据只发汇总值，不发原始 HealthKit 样本。
- 理财只用演示数据：不接真实账户，不转账，不交易。
