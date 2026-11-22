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
# 模型密钥文件（审查 P1-4）：长驻服务要真跑模型回合就必须拿得到模型凭证。
# 之前 compose 里是 DEEPSEEK_API_KEY 环境变量——那既不进 `compose config` 的自证输出，
# 也让凭证出现在容器元数据里。改成 file secret：本体只落盘，由本脚本读出后注入
# 进程环境（DSH 的 llm-deepseek 适配器按 apiKeyEnv=DEEPSEEK_API_KEY 从环境取）。
# 与 Tier 1 的 runner 共用同一份宿主文件（../../secrets/model-credentials）。
#
# 权限口径与 runner 一致（deploy/agent-runner.mjs 的 readSecretFile）：组/其他可读
# 等同配置错误——直接拒绝启动，且报错只提路径不回显内容（G-6）。
MODEL_KEY_FILE="${ALONG_MODEL_API_KEY_FILE:-/run/secrets/model-credentials}"
CLI_DIR=/app/deploy/agent-dsh
export DSH_HOME

# 读模型密钥。缺失不是致命错误——模型回合会失败，但长驻服务本身仍要起来：
# 配对、入队、事件同步这些不依赖模型的链路要能先跑起来，运维再补密钥。
# 权限过宽则**拒绝启动**（凭证可能已被别的用户读到）。
if [ -f "$MODEL_KEY_FILE" ]; then
  model_key="$(node -e '
    const fs=require("node:fs");
    const file=process.argv[1];
    const mode=fs.statSync(file).mode&0o777;
    if (mode&0o077) { console.error(`模型密钥文件权限过宽（须 0600，拒绝启动）：${file}`); process.exit(1); }
    const value=fs.readFileSync(file,"utf8").trim();
    if (!/^[^\s\0]+$/.test(value)) { console.error(`模型密钥文件须包含单行非空 DeepSeek API key：${file}`); process.exit(1); }
    process.stdout.write(value);
  ' "$MODEL_KEY_FILE")"
  DEEPSEEK_API_KEY="$model_key"
  export DEEPSEEK_API_KEY
  unset model_key
fi

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

# ---- 3b. 收紧读取面（审查 P1-1）--------------------------------------------
#
# 长驻 DSH 与 Along 业务库在同一个容器里，而 DSH 的文件工具能读**任意绝对路径**：
# DSH 的文件沙箱只约束写（读一律放行），业务库里两位用户的数据在**同一张表**里
# （按 user_id 分行），文件路径不分用户——API 上的身份检查约束不了这条读取路径。
#
# 收紧口径：Tier 2 的部署形态下，会话只保留按用户授权的工具（Along 业务面读 Host 的
# along_* 工具，服务端绑定身份、逐行按 user_id 过滤），文件与 shell 的读取面整体去掉。
# 子代理也收：它跑在 DSH 的 standard preset 下，那套 preset 带全套文件与 shell 工具。
#
# 覆盖行是**推导**出来的（读上游自己的 patch 文件，把被禁的工具从 preset 插件表里去掉，
# 再以同 id 覆盖的形式写进本层）——不抄一份上游 preset，改上游时不会漂移。
#
# 推导失败必须**拒绝启动**：收紧没生效就等于没收紧，静默继续等于把业务库敞开。
LOCKDOWN_ROWS="$(node /usr/local/bin/along-superagent-preset-lockdown.mjs "$CLI_DIR" "$BUNDLE_DIR")"
if [ -z "$LOCKDOWN_ROWS" ]; then
  echo "读取面收紧推导结果为空，拒绝启动" >&2
  exit 1
fi
cat >> "$PROFILE_DIR/cordis.patch.yml" <<YAML
$LOCKDOWN_ROWS
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
