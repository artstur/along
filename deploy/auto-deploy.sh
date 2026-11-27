#!/usr/bin/env bash
#
# Along 云端栈的定时部署器。
#
# 每小时检查 artstur/along 与 artstur/along-superagent 的 main；有更新就在本机用
# 当轮固定下来的两个提交构建并切换，切换后探活失败就回退到上一成功版本。
#
# 每一条约束都对应一次踩过的坑（见 docs/host-cloud-deploy.md §10）：
#
#   单锁串行      flock 非阻塞：抢不到锁就跳过本轮，绝不并发切换。
#   固定提交      先 fetch，再把两个仓库 main 的 SHA 记下来；本轮构建只用这一对
#                 SHA，上游中途再动也不影响本轮。SHA 可用 ALONG_DEPLOY_ALONG_SHA /
#                 ALONG_DEPLOY_SUPERAGENT_SHA 覆盖（验收时用它模拟「只更新一个仓」）。
#   干净工作区    源码用 git archive 从固定 SHA 展开到 release 目录，不碰现场的
#                 checkout（现场有本地改动也不受影响）。
#   卷与配置不动  release 目录下的 data/ 与 secrets/ 是指向工作区真实目录的符号链接，
#                 compose 的 ../../data、../../secrets 因此仍落在同一份持久卷与凭证上；
#                 切换前用 compose config 解析出的路径逐条核对。
#   原子记录      两个服务都健康之后才把这一对 SHA 写成成功版本；失败轮次不动记录，
#                 下一轮可以重试。
#   可回退        切换前记下当前运行的镜像 ID 与编排文件；切换后探活失败就把镜像标签
#                 打回旧 ID、按旧编排重建三个容器并重新探活。
#
# 用法：
#   auto-deploy.sh run       跑一轮检查与部署（默认）
#   auto-deploy.sh status    打印成功版本、运行中的镜像与探活结果
#   auto-deploy.sh verify    只做探活（不 fetch、不构建、不切换）
#   auto-deploy.sh rollback  手工回退到上一成功版本
#   auto-deploy.sh bootstrap 首次安装时把当前运行的版本登记成基线
#
# 日志走 stderr（journal 两者都收），stdout 只用于回传命令结果。
set -euo pipefail

CONFIG_FILE="${ALONG_DEPLOY_CONFIG:-/etc/along-auto-deploy.env}"

log()     { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
die()     { log "ERROR $*"; exit 1; }

# ---------- 配置（默认值先落，配置文件后覆盖） ----------

WORKSPACE="${ALONG_DEPLOY_WORKSPACE:-/home/ecs-user/workspace}"
ALONG_URL="${ALONG_DEPLOY_ALONG_URL:-git@github.com:artstur/along.git}"
SUPERAGENT_URL="${ALONG_DEPLOY_SUPERAGENT_URL:-git@github.com:artstur/along-superagent.git}"
BRANCH="${ALONG_DEPLOY_BRANCH:-main}"
ALONG_CHECKOUT="${ALONG_DEPLOY_ALONG_CHECKOUT:-$WORKSPACE/along}"
SUPERAGENT_CHECKOUT="${ALONG_DEPLOY_SUPERAGENT_CHECKOUT:-$WORKSPACE/along-superagent}"
COMPOSE_REL="${ALONG_DEPLOY_COMPOSE_REL:-deploy/docker-compose.cloud.yml}"
STATE_DIR="${ALONG_DEPLOY_STATE_DIR:-$WORKSPACE/.auto-deploy}"
RELEASE_ROOT="${ALONG_DEPLOY_RELEASE_DIR:-$WORKSPACE/release}"
KEEP_RELEASES="${ALONG_DEPLOY_KEEP_RELEASES:-2}"
HEALTH_URL="${ALONG_DEPLOY_HEALTH_URL:-https://127.0.0.1:4176/health}"
HEALTH_TIMEOUT="${ALONG_DEPLOY_HEALTH_TIMEOUT:-420}"
BUILD_TIMEOUT="${ALONG_DEPLOY_BUILD_TIMEOUT:-5400}"
MIN_FREE_KB="${ALONG_DEPLOY_MIN_FREE_KB:-3145728}"
DRY_RUN="${ALONG_DEPLOY_DRY_RUN:-0}"
BUILD_ONLY="${ALONG_DEPLOY_BUILD_ONLY:-0}"
TEST_FAULT="${ALONG_DEPLOY_TEST_FAULT:-}"
ALONG_SHA_PIN="${ALONG_DEPLOY_ALONG_SHA:-}"
# 定时任务以这个账号运行；状态目录与版本记录都必须归它所有。
STATE_USER="${ALONG_DEPLOY_STATE_USER:-}"
SUPERAGENT_SHA_PIN="${ALONG_DEPLOY_SUPERAGENT_SHA:-}"

STATE_FILE="$STATE_DIR/last-success.env"
PREV_STATE_FILE="$STATE_DIR/prev-success.env"
VERSIONS_DIR="$STATE_DIR/versions"
LOCK_FILE="$STATE_DIR/deploy.lock"

HOST_IMAGE="${ALONG_DEPLOY_HOST_IMAGE:-along-host:cloud}"
SUPERAGENT_IMAGE="${ALONG_DEPLOY_SUPERAGENT_IMAGE:-along-superagent:local}"
# 容器名与跳板探针地址：线上那两个容器名是 along-host / along-superagent，
# 跳板在锚点的 3083。隔离环境用别的名字与端口，所以做成配置。
HOST_CONTAINER="${ALONG_DEPLOY_HOST_CONTAINER:-along-host}"
SUPERAGENT_CONTAINER="${ALONG_DEPLOY_SUPERAGENT_CONTAINER:-along-superagent}"
PROBE_URL="${ALONG_DEPLOY_PROBE_URL:-http://127.0.0.1:3083/}"

# 核对用的期望值。默认是线上那套云端栈；隔离环境换一份配置即可复用同一个脚本。
#
# 注意用的是 ${VAR-default} 而不是 ${VAR:-default}：**显式设成空串**表示"不核对这一类"
#（隔离栈没有生产那样的卷与凭证），只有**没有设**才取默认值。
EXPECT_BINDS="${ALONG_DEPLOY_EXPECT_BINDS-host:/data=data/host superagent:/var/lib/dsh=data/superagent/dsh superagent:/var/lib/along=data/superagent/along superagent:/var/lib/memory=data/superagent/memory}"
EXPECT_SECRETS="${ALONG_DEPLOY_EXPECT_SECRETS-runner-token=secrets/runner-token memory-env=secrets/memory-env bridge-token=data/superagent/along/data/bridge-token}"
EXPECT_CONTEXTS="${ALONG_DEPLOY_EXPECT_CONTEXTS-host=along}"
EXPECT_ADDCTX="${ALONG_DEPLOY_EXPECT_ADDCTX-superagent:along=along-superagent}"
# 切换前核对镜像产物与源码是否一致（默认开；关掉就只剩 mtime 隔离这一道防线）。
VERIFY_IMAGE="${ALONG_DEPLOY_VERIFY_IMAGE:-1}"
# 镜像产物核对：镜像 | 源码在发布目录下的相对目录 | 镜像内目录:源码内目录
# 镜像产物核对：镜像 | 源码在发布目录下的相对目录 | 镜像内路径:源码内路径
#
# 只比**逐字拷贝**进镜像的那些目录：Host 镜像的 host/ 与 web/，Super Agent 镜像的
# prompts/ skills/ locale/ scripts/ 与 package.json、cordis.patch.yml。
# 不比 lib/——那是镜像里编译出来的产物，源码树里根本没有（.gitignore）。
VERIFY_HOST_IMAGE="${ALONG_DEPLOY_VERIFY_HOST_IMAGE-$HOST_IMAGE|along|/app/host:host,/app/web:web}"
VERIFY_SUPERAGENT_IMAGE="${ALONG_DEPLOY_VERIFY_SUPERAGENT_IMAGE-$SUPERAGENT_IMAGE|along-superagent|/app/deploy/agent-dsh/node_modules/dsh-superagent/prompts:prompts,/app/deploy/agent-dsh/node_modules/dsh-superagent/skills:skills,/app/deploy/agent-dsh/node_modules/dsh-superagent/locale:locale,/app/deploy/agent-dsh/node_modules/dsh-superagent/scripts:scripts,/app/deploy/agent-dsh/node_modules/dsh-superagent/package.json:package.json,/app/deploy/agent-dsh/node_modules/dsh-superagent/cordis.patch.yml:cordis.patch.yml}"

if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

# ---------- 小工具 ----------

# 从 state 文件读一个键的值（state 文件是 KEY=value 的文本）。
state_get() {
  local file="$1" key="$2" value
  [ -f "$file" ] || return 1
  value="$(sed -n "s/^${key}=//p" "$file" | tail -n 1)"
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

# 原子写 state 文件。
state_write() {
  local file="$1"; shift
  local tmp="$file.tmp.$$" kv
  : > "$tmp"
  for kv in "$@"; do printf '%s\n' "$kv" >> "$tmp"; done
  mv -f "$tmp" "$file"
}

# 改单个键，不动文件里的其它行。
manifest_set() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s#^${key}=.*#${key}=${value}#" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

container_image_id() {
  docker inspect -f '{{.Image}}' "$1" 2>/dev/null || true
}

container_compose_file() {
  docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$1" 2>/dev/null || true
}

container_health() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo "missing"
}

free_kb() {
  df -Pk "$WORKSPACE" 2>/dev/null | awk 'NR==2 {print $4}'
}

# ---------- 锁 ----------

acquire_lock() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  if [ ! -w "$STATE_DIR" ]; then
    die "状态目录 $STATE_DIR 对当前账号（$(id -un)）不可写：定时任务以服务账号运行，请用服务账号执行 bootstrap，或由 root 执行 chown $(id -u):$(id -g) $STATE_DIR"
  fi
  # flock 不可用必须**报错**，不能当成"锁被占"——那会让每一轮都静默跳过，
  # 定时任务看着在跑，实际上一件事都没做。
  command -v flock >/dev/null 2>&1 || die "缺少 flock（util-linux），无法保证不并发切换"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "SKIP 已有部署在执行（锁 $LOCK_FILE 被占），本轮不切换"
    exit 0
  fi
  log "LOCK 本轮持有部署锁 $LOCK_FILE"
}

# ---------- 取提交 ----------

# fetch 两个仓库，让目标 SHA 落进本地对象库。fetch 只写对象库，不动现场工作区。
#
# 顺带把本轮要用的 SHA 固定下来：fetch 写进 FETCH_HEAD 的就是远端分支当轮的尖端，
# 不再单独 ls-remote 一次——多一次远端读取就多一个窗口，远端在 fetch 与读取之间
# 推进时，本轮会拿到一个还没被取下来的提交（fetch/ls-remote 之间的竞争）。
fetch_repos() {
  local repo
  for repo in "$ALONG_CHECKOUT" "$SUPERAGENT_CHECKOUT"; do
    [ -d "$repo/.git" ] || die "找不到 checkout：$repo"
  done
  log "FETCH 拉取 $ALONG_URL 与 $SUPERAGENT_URL 的 $BRANCH"
  git -C "$ALONG_CHECKOUT" fetch --quiet "$ALONG_URL" "$BRANCH" || die "拉取 $ALONG_URL 失败"
  git -C "$SUPERAGENT_CHECKOUT" fetch --quiet "$SUPERAGENT_URL" "$BRANCH" || die "拉取 $SUPERAGENT_URL 失败"
}

# 本轮 fetch 取下来的提交（FETCH_HEAD 就是远端分支尖端）。
fetched_sha() {
  git -C "$1" rev-parse --verify --quiet FETCH_HEAD
}

resolve_sha() {
  local url="$1" pin="$2" checkout="$3" sha
  if [ -n "$pin" ]; then
    sha="$pin"
    log "SHA 使用钉住的提交 $sha（$url）"
  else
    sha="$(fetched_sha "$checkout")"
    [ -n "$sha" ] || { log "ERROR $url 的 $BRANCH 没有取到提交"; return 1; }
    log "SHA $url 的 $BRANCH 是 $sha"
  fi
  git -C "$checkout" cat-file -e "${sha}^{commit}" 2>/dev/null || {
    log "ERROR 本地对象库里没有 $sha（先 fetch 一次）"
    return 1
  }
  printf '%s' "$sha"
}

# ---------- 展开干净的发布工作区 ----------

# 把展开后的每个文件的 mtime 设成**该文件内容派生**的时间戳。
#
# 为什么不能留 git archive 给的 mtime：那是提交时间。同秒提交、同样字节长度的
# 改动，路径+大小+mtime 三项都不变——buildkit 的本地源同步按这三项判断文件是否
# 变了，没变就直接复用上一次的**内容**，于是镜像里留下旧代码，而台账记的是
# 新提交。--no-cache 也救不了：旧的是源同步这一层，不是构建缓存层。
# 按内容派生 mtime 之后，内容变了 mtime 就变，源同步会重新读文件。
#
# 逐文件而不是整棵树：整棵树一个摘要会让任何一个文件的改动都作废全部文件的
# mtime，把 pnpm install 之类的层也拖下水。逐文件只作废真正变了的文件。
#
# 秒 + 纳秒两段都取自摘要：同一路径内容不同 → mtime 必不同（碰撞概率可忽略），
# 同一内容 → mtime 相同 → 构建缓存照旧命中（这是想要的：没变的东西别重建）。
# 基准取 2020-01-01 并限制在当天之内，文件时间不会跑到未来。
stamp_tree_mtime() {
  local dest="$1" file digest secs nanos
  while IFS= read -r -d '' file; do
    digest="$(sha256sum "$file" | cut -d' ' -f1)"
    [ -n "$digest" ] || continue
    secs=$(( 1577836800 + (0x${digest:0:8} % 86400) ))
    nanos=$(( (0x${digest:8:8} % 1000000) * 1000 + (0x${digest:16:8} % 1000) ))
    touch -h -d "@$secs.$nanos" "$file" 2>/dev/null || true
  done < <(find "$dest" -type f -print0 2>/dev/null)
}

# 用 git archive 从固定 SHA 展开一棵干净源码树到 $dest。
# 不用 worktree/checkout：现场 checkout 可能有未提交改动，展开出来的树只含该提交的内容。
#
# 解包失败必须显式失败：管道 `git archive | tar -x` 的失败码会被调用方的 `|| die`
# 吞掉——命令替换里的 errexit 在 `||` 上下文下不生效，解包失败会被当成成功，
# 接着写清单、下一轮复用这个不完整的目录。先落到临时 tar 文件，两步各自查返回码。
expand_tree() {
  local checkout="$1" sha="$2" dest="$3" tarball
  tarball="$(mktemp)"
  if ! git -C "$checkout" archive --format=tar "$sha" > "$tarball"; then
    rm -f "$tarball"
    log "ERROR 从 $checkout 导出 $sha 失败"
    return 1
  fi
  mkdir -p "$dest"
  if ! tar -xf "$tarball" -C "$dest"; then
    rm -f "$tarball"
    log "ERROR 解包 $sha 失败"
    return 1
  fi
  rm -f "$tarball"
  stamp_tree_mtime "$dest"
}

# 展开一个发布目录：<release>/{along,along-superagent} + data/secrets 符号链接。
#
# 目录形状是刻意选的：compose 的 project directory 是 <release>/along/deploy，
# 于是 ../../data、../../secrets、../../along-superagent 分别落到
# <release>/data、<release>/secrets、<release>/along-superagent —— 前两个是指向
# 工作区真实目录的符号链接（持久卷与凭证仍是同一份），第三个就是本轮钉住
# 提交的 Super Agent 源码。
materialize_release() {
  local along_sha="$1" sa_sha="$2"
  local id release staging
  id="$(printf '%s' "$along_sha" | cut -c1-12)-$(printf '%s' "$sa_sha" | cut -c1-12)"
  release="$RELEASE_ROOT/$id"

  if [ ! -f "$release/manifest.env" ] || [ ! -d "$release/along" ] || [ ! -d "$release/along-superagent" ]; then
    log "RELEASE 展开发布目录 $release"
    # 先展开到暂存目录，**完整展开成功后**才发布：半成品目录不能被下一轮复用。
    staging="$RELEASE_ROOT/.staging.$$"
    rm -rf "$staging"
    mkdir -p "$staging"
    if ! expand_tree "$ALONG_CHECKOUT" "$along_sha" "$staging/along" \
      || ! expand_tree "$SUPERAGENT_CHECKOUT" "$sa_sha" "$staging/along-superagent"; then
      rm -rf "$staging"
      return 1
    fi
    rm -rf "$release"
    mkdir -p "$release"
    mv "$staging/along" "$release/along"
    mv "$staging/along-superagent" "$release/along-superagent"
    rm -rf "$staging"
  else
    log "RELEASE 复用发布目录 $release"
  fi

  ln -sfn "$WORKSPACE/data" "$release/data"
  ln -sfn "$WORKSPACE/secrets" "$release/secrets"

  local manifest="$release/manifest.env"
  if [ ! -f "$manifest" ]; then
    manifest_set "$manifest" CREATED "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  fi
  manifest_set "$manifest" ALONG_SHA "$along_sha"
  manifest_set "$manifest" SUPERAGENT_SHA "$sa_sha"
  manifest_set "$manifest" HOST_TAG "along-host:rel-$(printf '%s' "$along_sha" | cut -c1-12)-$(printf '%s' "$sa_sha" | cut -c1-12)"
  manifest_set "$manifest" SUPERAGENT_TAG "along-superagent:rel-$(printf '%s' "$along_sha" | cut -c1-12)-$(printf '%s' "$sa_sha" | cut -c1-12)"
  printf '%s' "$release"
}

# ---------- 核对卷与配置路径 ----------

# compose 相对路径配错是静默降级（卷挂到空目录、数据看着"配好了"其实没生效），
# 所以切换前把 compose 实际解析出来的路径逐条核对。
#
# 期望值用配置描述，默认是线上那套；隔离环境换一份配置即可复用同一个脚本。
#   ALONG_DEPLOY_EXPECT_BINDS    service:target=工作区相对路径（多项空格分隔）
#   ALONG_DEPLOY_EXPECT_SECRETS  名字=工作区相对路径
#   ALONG_DEPLOY_EXPECT_CONTEXTS service=发布目录相对路径（构建上下文）
#   ALONG_DEPLOY_EXPECT_ADDCTX   service:上下文名=发布目录相对路径
verify_paths() {
  local compose_file="$1" release="$2"
  command -v python3 >/dev/null 2>&1 || {
    log "WARN 没有 python3，跳过卷与配置的路径核对"
    return 0
  }
  local cfg cfg_file
  cfg="$(docker compose -f "$compose_file" config --format json 2>&1)" || {
    log "ERROR docker compose config 失败：$cfg"
    return 1
  }
  cfg_file="$(mktemp)"
  printf '%s' "$cfg" > "$cfg_file"
  python3 - "$cfg_file" "$release" "$WORKSPACE" \
      "$EXPECT_BINDS" "$EXPECT_SECRETS" "$EXPECT_CONTEXTS" "$EXPECT_ADDCTX" <<'PY' \
    || { rm -f "$cfg_file"; return 1; }
import json, os, sys

cfg = json.load(open(sys.argv[1]))
release = os.path.realpath(sys.argv[2])
workspace = os.path.realpath(sys.argv[3])
expect_binds = sys.argv[4].split()
expect_secrets = sys.argv[5].split()
expect_contexts = sys.argv[6].split()
expect_addctx = sys.argv[7].split()
problems = []


def real(path):
    return os.path.realpath(path) if path else path


def service(name):
    return cfg["services"].get(name) or {}


def expect_bind(service_name, target, expected):
    for vol in service(service_name).get("volumes") or []:
        if vol.get("type") == "bind" and vol.get("target") == target:
            if real(vol.get("source")) != real(expected):
                problems.append(
                    "%s 的 %s 挂载 %s，期望 %s"
                    % (service_name, target, vol.get("source"), expected))
            return
    problems.append("%s 缺少 %s 的 bind 挂载" % (service_name, target))


def expect_secret(name, expected):
    sec = (cfg.get("secrets") or {}).get(name) or {}
    path = sec.get("file")
    if not path:
        problems.append("secret %s 没有 file 来源" % name)
        return
    if real(path) != real(expected):
        problems.append("secret %s 指向 %s，期望 %s" % (name, path, expected))
        return
    try:
        os.stat(path)
    except FileNotFoundError:
        problems.append("secret %s 的文件不存在：%s" % (name, path))
    except PermissionError:
        # root 属主的凭证文件，宿主普通用户读不到是预期的（compose up 由 daemon 读）。
        pass


for item in expect_binds:
    spec, _, rel = item.partition("=")
    service_name, _, target = spec.partition(":")
    expect_bind(service_name, target, os.path.join(workspace, rel))

for item in expect_secrets:
    name, _, rel = item.partition("=")
    expect_secret(name, os.path.join(workspace, rel))

for item in expect_contexts:
    service_name, _, rel = item.partition("=")
    ctx = (service(service_name).get("build") or {}).get("context")
    if real(ctx) != real(os.path.join(release, rel)):
        problems.append(
            "%s 的构建上下文是 %s，期望 %s"
            % (service_name, ctx, os.path.join(release, rel)))

for item in expect_addctx:
    spec, _, rel = item.partition("=")
    service_name, _, context_name = spec.partition(":")
    contexts = (service(service_name).get("build") or {}).get("additional_contexts") or {}
    if context_name not in contexts:
        problems.append("%s 的构建缺少 additional_contexts.%s" % (service_name, context_name))
    elif real(contexts[context_name]) != real(os.path.join(release, rel)):
        problems.append(
            "%s 的 %s 来源是 %s，期望 %s"
            % (service_name, context_name, contexts[context_name],
               os.path.join(release, rel)))

if problems:
    for problem in problems:
        print("PATH-CHECK-FAIL " + problem, file=sys.stderr)
    sys.exit(1)
print("PATH-CHECK-OK 卷、凭证与构建输入都指向预期位置")
PY
  rm -f "$cfg_file"
}

# ---------- 核对镜像产物与源码一致 ----------

# 核对镜像里的产物与本轮钉住的源码逐文件一致。
#
# 挡住的是「镜像里跑的是旧内容、台账记的却是新提交」这类问题：内容对不上就
# 当轮失败，不切换、不写成功记录，下一轮重来。
#
# 方向是**镜像 → 源码**：镜像里可以比源码少（.dockerignore 会筛掉一部分文件），
# 但每个镜像里的文件都必须在源码里存在且内容一致。
#
# 规格：<镜像>|<源码在发布目录下的相对目录>|<镜像内路径>:<源码内路径>，逗号分隔。
# 两侧的路径都可以是目录（逐个文件比对相对路径）或单个文件（直接比）。
verify_image_content() {
  local spec="$1" release="$2"
  local image source_rel pairs
  image="$(printf '%s' "$spec" | cut -d'|' -f1)"
  source_rel="$(printf '%s' "$spec" | cut -d'|' -f2)"
  pairs="$(printf '%s' "$spec" | cut -d'|' -f3)"
  local source_root="$release/$source_rel"
  [ -d "$source_root" ] || { log "ERROR 源码目录不存在：$source_root"; return 1; }

  local checked=0 item img_path src_path part
  for item in $(printf '%s' "$pairs" | tr ',' ' '); do
    img_path="$(printf '%s' "$item" | cut -d: -f1)"
    src_path="$(printf '%s' "$item" | cut -d: -f2)"
    part="$(docker run --rm --entrypoint sh "$image" -c \
      "if [ -d '$img_path' ]; then cd '$img_path' && find . -type f | LC_ALL=C sort | while IFS= read -r f; do printf '%s\t%s\n' \"\$(sha256sum \"\$f\" | cut -d' ' -f1)\" \"\${f#./}\"; done; elif [ -f '$img_path' ]; then printf '%s\t%s\n' \"\$(sha256sum '$img_path' | cut -d' ' -f1)\" \"\$(basename '$img_path')\"; fi" 2>&1)" || {
      log "ERROR 无法从镜像 $image 读取 $img_path 的产物清单：$part"
      return 1
    }
    local img_hash rel src_hash
    while IFS="$(printf '\t')" read -r img_hash rel; do
      [ -n "$rel" ] || continue
      checked=$((checked + 1))
      if [ -d "$source_root/$src_path" ]; then
        src_hash="$(sha256sum "$source_root/$src_path/$rel" 2>/dev/null | cut -d' ' -f1)"
      else
        src_hash="$(sha256sum "$source_root/$src_path" 2>/dev/null | cut -d' ' -f1)"
      fi
      if [ -z "$src_hash" ]; then
        log "ERROR 镜像 $image 里的 $src_path/$rel 在源码里不存在"
        return 1
      fi
      if [ "$src_hash" != "$img_hash" ]; then
        log "ERROR 镜像 $image 里的 $src_path/$rel 与源码不一致（镜像 $img_hash / 源码 $src_hash）"
        return 1
      fi
    done <<EOF
$part
EOF
  done
  [ "$checked" -gt 0 ] || { log "ERROR 镜像 $image 的比对范围内没有文件"; return 1; }
  log "VERIFY 镜像 $image 的产物与源码逐文件一致（核对了 $checked 个文件）"
}

# ---------- 构建 ----------

build_images() {
  local compose_file="$1" release="$2"
  local host_tag sa_tag
  host_tag="$(state_get "$release/manifest.env" HOST_TAG)" || die "发布清单缺少 HOST_TAG"
  sa_tag="$(state_get "$release/manifest.env" SUPERAGENT_TAG)" || die "发布清单缺少 SUPERAGENT_TAG"
  log "BUILD 开始构建镜像（along 与 superagent 的源码都取自本轮钉住的提交）"
  if ! timeout "$BUILD_TIMEOUT" docker compose -f "$compose_file" build; then
    die "构建失败"
  fi
  docker tag "$HOST_IMAGE" "$host_tag"
  docker tag "$SUPERAGENT_IMAGE" "$sa_tag"
  # 把镜像 ID 记进发布清单：清理时按 ID 精确删自己的镜像，
  # 不用全局 prune（那会连同机上其它项目的悬空镜像一起删）。
  manifest_set "$release/manifest.env" HOST_IMAGE_ID "$(docker image inspect -f '{{.Id}}' "$host_tag")"
  manifest_set "$release/manifest.env" SUPERAGENT_IMAGE_ID "$(docker image inspect -f '{{.Id}}' "$sa_tag")"
  log "BUILD 完成，版本化标签 $host_tag / $sa_tag"
}

# ---------- 切换与探活 ----------

# 探活：两个容器都要 healthy，Host 的 HTTPS /health 要 200，
# 锚点跳板要可达（跳板在锚点的命名空间里，够不着说明被落下）。
probe_health() {
  local host_code jump_code
  host_code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
  jump_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$PROBE_URL" 2>/dev/null || true)"
  [ "$host_code" = "200" ] || return 1
  [ "$jump_code" != "000" ] && [ -n "$jump_code" ] || return 1
  return 0
}

wait_healthy() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while :; do
    if [ "$(container_health "$HOST_CONTAINER")" = "healthy" ] \
      && [ "$(container_health "$SUPERAGENT_CONTAINER")" = "healthy" ] \
      && probe_health; then
      log "HEALTH 两个服务都健康（Host /health 与锚点跳板可达）"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "ERROR 探活超时（host=$(container_health "$HOST_CONTAINER") superagent=$(container_health "$SUPERAGENT_CONTAINER")）"
      return 1
    fi
    sleep 5
  done
}

# 切换：锚点与两个服务一起重建。
#
# 为什么要带 --force-recreate：编排文件里的相对路径（./netns-proxy.mjs、
# ./superagent-profile.patch.yml）落在发布目录上，与现场 checkout 的路径不同，
# compose 的配置指纹因此变了，锚点本来就会被重建。命名空间跟着持有它的容器走，
# 单独重建 host/superagent 会把它们留在旧 netns 里（外部入口静默断掉），
# 所以锚点与两个使用方必须在同一次操作里一起重建。
#
# compose up 可能**部分成功**：锚点与 Super Agent 已经重建，Host 容器创建失败
# （比如新增了一个指向不存在路径的 bind），此时线上入口是断的，而命令返回非零。
# 所以这里必须把返回码带出去，由调用方进回退——只看「命令失败」是不够的。
switch_stack() {
  local compose_file="$1"
  log "SWITCH 用新镜像重建锚点与两个服务（命名空间随之更新）"
  if ! docker compose -f "$compose_file" up -d --no-build --force-recreate anchor superagent host; then
    log "ERROR compose up 失败（可能部分切换：锚点与 Super Agent 已重建，Host 未起来）"
    return 1
  fi
}

# ---------- 回退 ----------

# 回退到切换前记录下来的镜像与编排文件，并重新探活。
rollback_to() {
  local prev_host_image="$1" prev_sa_image="$2" prev_compose_file="$3"
  if [ -z "$prev_host_image" ] || [ -z "$prev_sa_image" ] || [ -z "$prev_compose_file" ]; then
    log "ERROR 没有可回退的目标（缺少切换前的镜像或编排文件记录）"
    return 1
  fi
  if [ ! -f "$prev_compose_file" ]; then
    log "ERROR 回退用的编排文件不存在：$prev_compose_file"
    return 1
  fi
  local img
  for img in "$prev_host_image" "$prev_sa_image"; do
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      log "ERROR 回退用的镜像已不在本机：$img"
      return 1
    fi
  done
  log "ROLLBACK 把镜像标签打回 $prev_host_image / $prev_sa_image"
  docker tag "$prev_host_image" "$HOST_IMAGE"
  docker tag "$prev_sa_image" "$SUPERAGENT_IMAGE"
  log "ROLLBACK 按旧编排重建锚点与两个服务"
  docker compose -f "$prev_compose_file" up -d --no-build --force-recreate anchor superagent host
  if wait_healthy; then
    log "ROLLBACK 上一版本已恢复并重新健康"
    return 0
  fi
  log "ERROR 回退后仍未健康，需要人工处理"
  return 1
}

# ---------- 记录与清理 ----------

# 版本号：两个提交各取前 12 位。
version_id() {
  printf '%s-%s' "$(printf '%s' "$1" | cut -c1-12)" "$(printf '%s' "$2" | cut -c1-12)"
}

version_file() {
  printf '%s/%s.env' "$VERSIONS_DIR" "$1"
}

# 登记一个成功版本：版本台账 + 当前/上一成功版本指针。
#
# 版本台账记的是**镜像 ID**与版本化标签。镜像必须有标签：没有标签的镜像算
# dangling，会被 docker 的清理动作当成垃圾删掉——上一成功版本的镜像一旦被删，
# 回退就无从下手（这正是踩过的坑）。
record_success() {
  local along_sha="$1" sa_sha="$2" release="$3" compose_file="$4"
  local host_image sa_image id host_tag sa_tag
  host_image="$(container_image_id "$HOST_CONTAINER")"
  sa_image="$(container_image_id "$SUPERAGENT_CONTAINER")"
  id="$(version_id "$along_sha" "$sa_sha")"
  host_tag="along-host:rel-$(printf '%s' "$along_sha" | cut -c1-12)-$(printf '%s' "$sa_sha" | cut -c1-12)"
  sa_tag="along-superagent:rel-$(printf '%s' "$along_sha" | cut -c1-12)-$(printf '%s' "$sa_sha" | cut -c1-12)"
  mkdir -p "$VERSIONS_DIR"
  docker tag "$host_image" "$host_tag" 2>/dev/null || true
  docker tag "$sa_image" "$sa_tag" 2>/dev/null || true
  state_write "$(version_file "$id")" \
    "VERSION_ID=$id" \
    "ALONG_SHA=$along_sha" \
    "SUPERAGENT_SHA=$sa_sha" \
    "RELEASE_DIR=$release" \
    "COMPOSE_FILE=$compose_file" \
    "HOST_IMAGE=$host_image" \
    "SUPERAGENT_IMAGE=$sa_image" \
    "HOST_TAG=$host_tag" \
    "SUPERAGENT_TAG=$sa_tag" \
    "DEPLOYED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if [ -f "$STATE_FILE" ]; then
    cp -f "$STATE_FILE" "$PREV_STATE_FILE"
  fi
  state_write "$STATE_FILE" \
    "VERSION_ID=$id" \
    "ALONG_SHA=$along_sha" \
    "SUPERAGENT_SHA=$sa_sha" \
    "RELEASE_DIR=$release" \
    "COMPOSE_FILE=$compose_file" \
    "HOST_IMAGE=$host_image" \
    "SUPERAGENT_IMAGE=$sa_image" \
    "DEPLOYED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  log "RECORD 成功版本已记录：along=$along_sha superagent=$sa_sha"
}

# 清理台账里不再保留的版本：删掉它们的发布目录、版本化标签与镜像。
#
# 刻意**不跑** `docker image prune`：那是全局动作，会把同机其它项目的悬空镜像
# 一起删掉。这里只按台账逐个删自己的镜像。
cleanup_versions() {
  local keep=" " file id v i=0
  for file in "$STATE_FILE" "$PREV_STATE_FILE"; do
    v="$(state_get "$file" VERSION_ID || true)"
    [ -n "$v" ] && keep="$keep$v "
  done
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    i=$((i + 1))
    [ "$i" -le "$KEEP_RELEASES" ] || break
    v="$(basename "$file" .env)"
    keep="$keep$v "
  done < <(ls -1t "$VERSIONS_DIR"/*.env 2>/dev/null)

  # 保留版本在用的镜像 ID：删镜像前先排除它们，别把还能回退的版本删掉。
  local protected_images=" " file2 img
  while IFS= read -r file2; do
    [ -n "$file2" ] || continue
    v="$(basename "$file2" .env)"
    case "$keep" in *" $v "*) ;; *) continue ;; esac
    for img in "$(state_get "$file2" HOST_IMAGE || true)" \
               "$(state_get "$file2" SUPERAGENT_IMAGE || true)"; do
      [ -n "$img" ] && protected_images="$protected_images$img "
    done
  done < <(ls -1 "$VERSIONS_DIR"/*.env 2>/dev/null)

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    id="$(basename "$file" .env)"
    case "$keep" in *" $id "*) continue ;; esac
    local tag dir
    for tag in "$(state_get "$file" HOST_TAG || true)" \
                "$(state_get "$file" SUPERAGENT_TAG || true)"; do
      [ -n "$tag" ] && docker rmi "$tag" >/dev/null 2>&1 || true
    done
    # 删镜像本身前先确认它不是保留版本在用的那个。
    for tag in "$(state_get "$file" HOST_IMAGE || true)" \
                "$(state_get "$file" SUPERAGENT_IMAGE || true)"; do
      [ -n "$tag" ] || continue
      case "$protected_images" in
        *" $tag "*) log "CLEANUP 跳过受保护的镜像 $tag" ;;
        *) docker rmi "$tag" >/dev/null 2>&1 || true ;;
      esac
    done
    dir="$(state_get "$file" RELEASE_DIR || true)"
    # 只删发布根目录下的真目录：现场 checkout 不是发布目录，不能删；
    # 符号链接也不删——发布目录里的 data/ 与 secrets/ 就是指向真实卷的链接。
    case "$dir" in
      "$RELEASE_ROOT"/*)
        if [ -L "$dir" ]; then
          log "CLEANUP 跳过（是符号链接）：$dir"
        elif [ -d "$dir" ]; then
          rm -rf "$dir"
          log "CLEANUP 删除旧发布目录 $dir"
        fi
        ;;
    esac
    rm -f "$file"
    log "CLEANUP 清理旧版本 $id"
  done < <(ls -1 "$VERSIONS_DIR"/*.env 2>/dev/null)

  # 台账里已经没有的发布目录（孤儿）：连同它们独占的镜像一起清掉。
  # 台账外的发布目录一定是没人再引用了——当前与上一成功版本都在台账里。
  local kept_dirs=" " dir
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    dir="$(state_get "$file" RELEASE_DIR || true)"
    [ -n "$dir" ] && kept_dirs="$kept_dirs$dir "
  done < <(ls -1 "$VERSIONS_DIR"/*.env 2>/dev/null)
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    case "$kept_dirs" in *" $dir "*) continue ;; esac
    [ -f "$dir/manifest.env" ] || continue
    local tag
    # 孤儿目录只删标签，不按镜像 ID 删：镜像可能被保留版本共用。
    for tag in "$(state_get "$dir/manifest.env" HOST_TAG || true)" \
                "$(state_get "$dir/manifest.env" SUPERAGENT_TAG || true)"; do
      [ -n "$tag" ] && docker rmi "$tag" >/dev/null 2>&1 || true
    done
    if [ -L "$dir" ]; then
      log "CLEANUP 跳过（是符号链接）：$dir"
    elif [ -d "$dir" ]; then
      rm -rf "$dir"
      log "CLEANUP 删除孤儿发布目录 $dir"
    fi
  done < <(ls -1d "$RELEASE_ROOT"/*/ 2>/dev/null | sed 's#/*$##')
}

# ---------- 子命令 ----------

cmd_status() {
  log "STATE 目录 $STATE_DIR"
  if [ -f "$STATE_FILE" ]; then
    while IFS= read -r line; do log "STATE $line"; done < "$STATE_FILE"
  else
    log "STATE 还没有成功版本记录"
  fi
  if [ -f "$PREV_STATE_FILE" ]; then
    while IFS= read -r line; do log "PREV $line"; done < "$PREV_STATE_FILE"
  fi
  local vf
  while IFS= read -r vf; do
    [ -n "$vf" ] || continue
    while IFS= read -r line; do log "VERSION $line"; done < "$vf"
  done < <(ls -1t "$VERSIONS_DIR"/*.env 2>/dev/null)
  log "RUNTIME $HOST_CONTAINER 镜像 $(container_image_id "$HOST_CONTAINER") 健康 $(container_health "$HOST_CONTAINER")"
  log "RUNTIME $SUPERAGENT_CONTAINER 镜像 $(container_image_id "$SUPERAGENT_CONTAINER") 健康 $(container_health "$SUPERAGENT_CONTAINER")"
  if probe_health; then log "HEALTH 当前探活通过"; else log "HEALTH 当前探活失败"; fi
}

cmd_verify() {
  wait_healthy
}

# 首次安装时把「当前正在跑的版本」登记成基线：之后每轮才有「变没变」可比，
# 而不是第一轮就无条件重装一遍。登记的是现场 checkout 的 HEAD 与运行中容器的
# 镜像 ID、编排文件路径。
#
# **必须以服务账号运行**：状态目录归服务账号所有，root 建出来的目录服务账号
# 写不进去——下一轮取锁直接 Permission denied，定时任务从此每轮都失败。
# 所以这里先检查目录属主，属主不对就明确报错，而不是留下一个装不上的定时器。
cmd_bootstrap() {
  local force="" along_sha="" sa_sha=""
  for arg in "$@"; do
    case "$arg" in
      --force) force="--force" ;;
      *) if [ -z "$along_sha" ]; then along_sha="$arg"; elif [ -z "$sa_sha" ]; then sa_sha="$arg"; fi ;;
    esac
  done
  if [ -f "$STATE_FILE" ] && [ -z "$force" ]; then
    die "$STATE_FILE 已存在（要覆盖请加 --force）"
  fi
  # 状态目录必须归服务账号所有。属主不对就当场说清楚，别等到定时任务每轮失败。
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  if [ -d "$STATE_DIR" ]; then
    local owner
    owner="$(stat -c '%U' "$STATE_DIR" 2>/dev/null || stat -f '%Su' "$STATE_DIR" 2>/dev/null || echo '?')"
    if [ "$(id -u)" = "0" ] && [ -n "$STATE_USER" ] && [ "$owner" != "$STATE_USER" ]; then
      # 以 root 跑 bootstrap 却把目录留成 root 所有 —— 服务账号下一轮取锁就
      # Permission denied。直接改成服务账号所有。
      chown -R "$STATE_USER" "$STATE_DIR" 2>/dev/null \
        && log "BOOTSTRAP 状态目录 $STATE_DIR 已改为 $STATE_USER 所有"
      owner="$STATE_USER"
    fi
    if [ "$(id -u)" != "0" ] && [ "$owner" != "$(id -un)" ] && [ "$owner" != "?" ]; then
      die "状态目录 $STATE_DIR 归 $owner 所有，当前账号 $(id -un) 写不进去。请以服务账号运行本命令：sudo -u $owner $0 bootstrap"
    fi
  fi
  # 不给提交号时用现场 checkout 的 HEAD——这只在「现场 HEAD 就是当前运行的版本」
  # 时成立；否则显式给两个提交号。
  [ -n "$along_sha" ] || along_sha="$(git -C "$ALONG_CHECKOUT" rev-parse HEAD)"
  [ -n "$sa_sha" ] || sa_sha="$(git -C "$SUPERAGENT_CHECKOUT" rev-parse HEAD)"
  local compose_file checkout_root
  compose_file="$(container_compose_file "$HOST_CONTAINER")"
  [ -n "$compose_file" ] && [ -f "$compose_file" ] || die "取不到当前运行实例的编排文件路径"
  checkout_root="$(cd "$(dirname "$(dirname "$compose_file")")" && pwd)"
  # 发布布局里编排文件在 <发布根>/along/deploy/ 下，发布根才是可清理的单位。
  case "$checkout_root" in
    "$RELEASE_ROOT"/*/along) checkout_root="$(dirname "$checkout_root")" ;;
  esac
  log "BOOTSTRAP 基线：along=$along_sha superagent=$sa_sha 编排=$compose_file"
  # 基线版本的发布目录就是现场 checkout（不是发布目录，清理时不会删它）。
  record_success "$along_sha" "$sa_sha" "$checkout_root" "$compose_file"
}

cmd_rollback() {
  acquire_lock
  local host_image sa_image compose_file release
  host_image="$(state_get "$PREV_STATE_FILE" HOST_IMAGE || true)"
  sa_image="$(state_get "$PREV_STATE_FILE" SUPERAGENT_IMAGE || true)"
  compose_file="$(state_get "$PREV_STATE_FILE" COMPOSE_FILE || true)"
  release="$(state_get "$PREV_STATE_FILE" RELEASE_DIR || true)"
  if [ -z "$host_image" ] || [ -z "$compose_file" ]; then
    die "没有可回退的上一成功版本记录（$PREV_STATE_FILE）"
  fi
  rollback_to "$host_image" "$sa_image" "$compose_file" || die "回退失败"
  # 回退成功后，把状态对调：回退目标成为当前版本，被回退的版本留作上一版本。
  if [ -f "$STATE_FILE" ]; then cp -f "$STATE_FILE" "$PREV_STATE_FILE.tmp"; fi
  cp -f "$PREV_STATE_FILE" "$STATE_FILE"
  [ -f "$PREV_STATE_FILE.tmp" ] && mv -f "$PREV_STATE_FILE.tmp" "$PREV_STATE_FILE"
  log "ROLLBACK 已回退到上一成功版本（发布目录 $release）"
}

cmd_run() {
  acquire_lock

  if [ "$TEST_FAULT" = "fetch" ]; then
    die "TEST-FAULT 注入：fetch 阶段失败"
  fi

  fetch_repos
  local along_sha sa_sha
  along_sha="$(resolve_sha "$ALONG_URL" "$ALONG_SHA_PIN" "$ALONG_CHECKOUT")" || die "确定 Along 提交失败"
  sa_sha="$(resolve_sha "$SUPERAGENT_URL" "$SUPERAGENT_SHA_PIN" "$SUPERAGENT_CHECKOUT")" || die "确定 Super Agent 提交失败"

  local last_along="" last_sa=""
  last_along="$(state_get "$STATE_FILE" ALONG_SHA || true)"
  last_sa="$(state_get "$STATE_FILE" SUPERAGENT_SHA || true)"
  if [ -n "$last_along" ] && [ "$last_along" = "$along_sha" ] && [ "$last_sa" = "$sa_sha" ]; then
    log "SKIP 两个提交都没变（along=$along_sha superagent=$sa_sha），不构建也不重启"
    return 0
  fi
  log "CHANGE 上游有更新：along ${last_along:-（无记录）} → $along_sha，superagent ${last_sa:-（无记录）} → $sa_sha"

  local avail
  avail="$(free_kb || echo 0)"
  if [ "${avail:-0}" -lt "$MIN_FREE_KB" ]; then
    die "磁盘可用空间不足（${avail}KB < ${MIN_FREE_KB}KB），本轮不构建"
  fi

  local release compose_file
  release="$(materialize_release "$along_sha" "$sa_sha")" || die "展开发布目录失败"
  compose_file="$release/along/$COMPOSE_REL"
  [ -f "$compose_file" ] || die "发布目录里没有编排文件：$compose_file"

  verify_paths "$compose_file" "$release" || die "卷与配置的路径核对不通过，不构建"

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN 只做计划：会构建 $HOST_IMAGE 与 $SUPERAGENT_IMAGE（编排 $compose_file）"
    log "DRY-RUN 目标提交 along=$along_sha superagent=$sa_sha"
    return 0
  fi

  if [ "$TEST_FAULT" = "build" ]; then
    die "TEST-FAULT 注入：构建阶段失败"
  fi
  build_images "$compose_file" "$release"

  if [ "$BUILD_ONLY" = "1" ]; then
    log "BUILD-ONLY 只构建不切换，成功版本记录不变"
    return 0
  fi

  # 构建完、切换前核对镜像产物与源码一致。
  #
  # 挡住的是「构建缓存把旧内容烤进镜像，台账却记了新提交」这类问题：源码与镜像
  # 对不上就当轮失败，不切换、不写成功记录，下一轮重来。
  # 放在切换前，是因为内容不对的镜像根本不该上线。
  if [ "$VERIFY_IMAGE" = "1" ]; then
    [ -n "$VERIFY_HOST_IMAGE" ] && {
      verify_image_content "$VERIFY_HOST_IMAGE" "$release" \
        || die "Host 镜像产物与源码不一致，不切换"
    }
    [ -n "$VERIFY_SUPERAGENT_IMAGE" ] && {
      verify_image_content "$VERIFY_SUPERAGENT_IMAGE" "$release" \
        || die "Super Agent 镜像产物与源码不一致，不切换"
    }
  fi

  # 切换前的现场：回退要靠它。
  local prev_host_image prev_sa_image prev_compose_file
  prev_host_image="$(container_image_id "$HOST_CONTAINER")"
  prev_sa_image="$(container_image_id "$SUPERAGENT_CONTAINER")"
  prev_compose_file="$(container_compose_file "$HOST_CONTAINER")"
  log "SWITCH 切换前的现场：along-host=$prev_host_image along-superagent=$prev_sa_image 编排=$prev_compose_file"

  if [ "$TEST_FAULT" = "switch" ]; then
    die "TEST-FAULT 注入：切换阶段失败"
  fi
  # 切换返回非零同样要回退：compose up 可能部分成功（锚点与 Super Agent 已重建、
  # Host 容器创建失败），此时线上入口是断的，不能就这么走人。
  if ! switch_stack "$compose_file"; then
    log "ERROR 切换失败，进入回退"
    rollback_to "$prev_host_image" "$prev_sa_image" "$prev_compose_file" || true
    die "切换失败，本轮未推进成功记录"
  fi

  # 切换后核对镜像产物与源码一致：内容对不上就是旧内容进了镜像，
  # 这种轮次不能算成功，也不能写成功记录。
  if [ "$TEST_FAULT" = "health" ]; then
    log "ERROR TEST-FAULT 注入：探活失败"
    rollback_to "$prev_host_image" "$prev_sa_image" "$prev_compose_file" || true
    die "探活失败，本轮未推进成功记录"
  fi

  if ! wait_healthy; then
    log "ERROR 切换后探活失败"
    rollback_to "$prev_host_image" "$prev_sa_image" "$prev_compose_file" || true
    die "探活失败，本轮未推进成功记录"
  fi

  record_success "$along_sha" "$sa_sha" "$release" "$compose_file"
  cleanup_versions
  log "DONE 部署完成：along=$along_sha superagent=$sa_sha"
}

case "${1:-run}" in
  run) cmd_run ;;
  status) cmd_status ;;
  verify) cmd_verify ;;
  rollback) cmd_rollback ;;
  bootstrap) cmd_bootstrap "${@:2}" ;;
  *)
    printf '用法：%s {run|status|verify|rollback|bootstrap [--force]}\n' "$0" >&2
    exit 2
    ;;
esac
