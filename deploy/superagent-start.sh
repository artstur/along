#!/bin/sh
# Along 云端 Super Agent 长驻启动脚本（docs/cloud-deploy-multi-user.md §3.5 Tier 2）。
#
# 它做四件事，然后 exec 常驻 dsh：
#
# 1. 铺 profile 目录（$DSH_HOME/profiles/<profile>），清单的 bundle 列表是
#    「web 模板的两个官方 bundle + dsh-superagent」。
# 2. 把编译后的 bundle 链进 profile 的 node_modules —— 这一步是 V-1 实测的硬要求：
#    只在 patch 层声明 bundle 时，dump-config 会出现插件行，但真实 boot 报
#    ERR_MODULE_NOT_FOUND（along-tier2-v1-evidence/evidence/boot-layer-only.redacted.log）。
#    bundle 必须是一个**可解析的包**（profile/node_modules/dsh-superagent）。
# 3. 播种设置：Along Source 开、GitHub Source 显式关。这两个开关决定 Runtime 是否
#    组装 Along 业务面（src/app/runtime.ts assembleAlong 要求 sources.along.enabled
#    且 sources.github.enabled === false），所以必须在第一次 boot **之前**写进编排库。
# 4. exec dsh --profile <profile> --no-open 常驻。
#
# 幂等：每次启动都重铺 profile 与设置（设置已存在时不覆盖，见下面的 seed 函数），
# 所以容器重启、镜像升级后不需要人工干预。
#
# 管理面只在本机可达：cordis.patch.yml 把 webserver 绑到 127.0.0.1，且 compose 里
# 本服务不发布任何端口；Host 通过共享网络命名空间用 http://127.0.0.1:3082 访问。
set -eu

DSH_HOME="${DSH_HOME:-/var/lib/dsh}"
PROFILE="${ALONG_SUPERAGENT_PROFILE:-along}"
STATE_DIR="${ALONG_SUPERAGENT_STATE_DIR:-/var/lib/along-superagent}"
ALONG_STATE_DIR="${ALONG_SUPERAGENT_ALONG_STATE_DIR:-/var/lib/along-superagent/along}"
# 桥接凭证文件：与 Host 读的是**同一份**宿主文件（compose 的 bridge-token secret，
# 两侧都挂到 /run/secrets/bridge-token）。Super Agent 侧由 profile 的
# alongBridgeTokenFile 指定这个路径——它必须是 Host 那份，否则两侧各生成不同的
# token，Host 的每一次桥接调用都会被 401（host/along-bridge.mjs 的 readBridgeToken
# 与 Super Agent 的 bridgeTokenOf 是同一套格式与同一套 0600 校验）。
#
# 文件不存在时 Super Agent 会自己生成一份（bridgeTokenOf 的 ENOENT 分支）——那只在
# 本机单机调试时成立。compose 形态下这个文件由 secret 挂载提供，缺失即配置错误。
BRIDGE_TOKEN_FILE="${ALONG_BRIDGE_TOKEN_FILE:-/run/secrets/bridge-token}"
CLI_DIR=/app/deploy/agent-dsh
export DSH_HOME

# bundle 装在 DSH CLI 的 node_modules 树里（镜像构建时确定），这样它的 peer 依赖
# （cordis、dsh-llm、dsh-scope、schemastery）才解析得到——Node 按模块**真实路径**向上找
# node_modules，bundle 必须与 CLI 同树。V-1 实测的装法。
BUNDLE_DIR="$CLI_DIR/node_modules/dsh-superagent"

mkdir -p "$DSH_HOME/profiles/$PROFILE" "$STATE_DIR" "$ALONG_STATE_DIR"
chmod 700 "$STATE_DIR" "$ALONG_STATE_DIR"

# ---- 1. profile 清单 ------------------------------------------------------
#
# 用官方 web 模板铺 profile（dsh --from-default-profile web），而不是手写 package.json：
# 官方模板带 cordis.yml / pnpm-workspace.yaml 与默认层（dsh-base、dsh-web-app），
# 手写会漏掉这些文件导致真实 boot 与 dump-config 不一致（V-1 实测的做法）。
#
# --from-default-profile 会**重置**该 profile，所以顺序必须是：先铺模板，再改
# package.json 的 bundle 列表，再写 patch 层。模板里的 bundle 列表是
# ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]，追加 dsh-superagent。
if [ ! -f "$DSH_HOME/profiles/$PROFILE/package.json" ]; then
  "$CLI_DIR/node_modules/.bin/dsh" --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null
fi

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

# 追加 bundle 层（幂等：已在列表里就不重复加）。
node --input-type=module - "$PROFILE_DIR" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs'
const dir=process.argv[2]
const file=dir+'/package.json'
const manifest=JSON.parse(readFileSync(file,'utf8'))
const bundles=manifest.dsh.profile.bundles
if (!bundles.includes('dsh-superagent')) bundles.push('dsh-superagent')
writeFileSync(file,JSON.stringify(manifest,null,2))
console.log('profile bundle 层：',bundles.join(', '))
JS

# ---- 2. bundle 链进 profile ----------------------------------------------
#
mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn "$BUNDLE_DIR" "$PROFILE_DIR/node_modules/dsh-superagent"

# ---- 3. profile 的 patch 层 ----------------------------------------------
# webserver 绑 127.0.0.1：管理面（/orchestrator、面板）只在本机可达（src/app/http.ts
# 与 src/along/api.ts 都硬性要求 webserver.host === '127.0.0.1'）。
# alongStateDir 与 alongBridgeTokenFile 是 Along 业务面的两个绝对路径配置键，缺任一
# 都会让 Runtime 启动即抛错（src/app/runtime.ts assembleAlong）。
cat > "$PROFILE_DIR/cordis.patch.yml" <<YAML
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: $STATE_DIR/engine
    alongStateDir: $ALONG_STATE_DIR
    alongBridgeTokenFile: $BRIDGE_TOKEN_FILE
- id: dsh-superagent-github
  disabled: true
- id: dsh-superagent-along
  disabled: false
YAML

# ---- 4. 播种设置 ----------------------------------------------------------
# 用编排库自己的 SQLite 表直接写「设置快照」是不行的：设置是**带版本**的记录
#（Store.settings() 读的是当前 revision 的快照，src/app/store.ts），直接写表会
# 与版本指针不一致。因此这里走 Store 自己的 API：seed.mjs 用与 src/app/store.ts 相同
# 的读写形状落库（settings-version:<n> 快照 + settings-revision 指针）。
#
# 为什么必须在第一次 boot 之前播种：Runtime 的构造函数里 assembleAlong() 读**已经存好的
# 设置**来决定是否组装 Along 业务面（src/app/runtime.ts：settings.sources.along?.enabled
# === true && settings.sources.github?.enabled === false）。设置不存在时它返回 undefined：
# 不组装业务库、不注册 /along-source 路由、也不生成桥接凭证文件。此时再从管理面补设置，
# 会触发一次 Runtime 重启才生效——多一次启动窗口，而重启窗口正是 V-1 暴露的投递丢失窗口。
#
# 为什么不用管理面 API：source:github 这一块在 GitHub Source 未安装时会被
#「Source not found」挡掉（src/app/http.ts 的 known 判定）；直接落库绕开了这个限制，
# 也绕开了「保存设置会触发重启」的时序。
node /usr/local/bin/along-superagent-seed.mjs "$STATE_DIR/engine" || exit 1

# ---- 5. 常驻 --------------------------------------------------------------
exec "$CLI_DIR/node_modules/.bin/dsh" --profile "$PROFILE" --no-open
