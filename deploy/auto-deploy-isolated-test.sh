#!/usr/bin/env bash
#
# 自动部署器的**隔离端到端**验收：按实际采用的安装与登记入口跑一遍。
#
#   1. sudo sh deploy/auto-deploy-install.sh --no-enable    安装器生成配置与 unit
#   2. sudo /usr/local/libexec/along/auto-deploy.sh bootstrap <两个 SHA>   以 root 登记基线
#   3. sudo systemctl start along-auto-deploy.service          以 unit 的服务账号首次更新
#
# 第 2 步**不预先导出** ALONG_DEPLOY_STATE_USER：服务账号必须由安装器写进
# /etc/along-auto-deploy.env，部署器读配置读到它——这条路径是"按手册装"的真实形状，
# 配置文件的读取顺序错了，这里就会失败（root 登记没 chown → 服务账号写不了台账）。
#
# 需要：Linux + Docker + root（要在本机建一个服务账号、装 unit、跑容器）。
# 用法：sudo bash deploy/auto-deploy-isolated-test.sh <仓库 deploy 目录> <工作区根>
#
set -uo pipefail

DEPLOY_DIR="${1:-}"
WS="${2:-/tmp/along-auto-deploy-isolated}"
[ -n "$DEPLOY_DIR" ] || { printf '用法：%s <仓库 deploy 目录> [工作区根]\n' "$0" >&2; exit 2; }
[ -f "$DEPLOY_DIR/auto-deploy.sh" ] || { printf '找不到 %s/auto-deploy.sh\n' "$DEPLOY_DIR" >&2; exit 2; }
[ "$(id -u)" = "0" ] || { printf '需要 root\n' >&2; exit 1; }

SVC=along-autodeploy-test
id "$SVC" >/dev/null 2>&1 || useradd -m -s /bin/bash "$SVC"
usermod -aG docker "$SVC" 2>/dev/null || true

# 上一轮遗留的容器：它们身上的编排路径标签指向已删除的发布目录，
# 会让"登记基线"取到错的编排文件。
docker rm -f iso-anchor iso-host iso-superagent >/dev/null 2>&1 || true
# 干净安装：清掉上一轮装出来的东西，安装器才会重新生成配置。
rm -f /etc/along-auto-deploy.env /etc/systemd/system/along-auto-deploy.service \
      /etc/systemd/system/along-auto-deploy.timer /usr/local/libexec/along/auto-deploy.sh
systemctl daemon-reload >/dev/null 2>&1 || true

rm -rf "$WS"
mkdir -p "$WS/along" "$WS/along-superagent" "$WS/data" "$WS/secrets"

# ---- 两个本地 git origin 当"上游" ----
git init -q --bare "$WS/origin-along.git"
git init -q --bare "$WS/origin-superagent.git"
git clone -q "$WS/origin-along.git" "$WS/along"
git clone -q "$WS/origin-superagent.git" "$WS/along-superagent"

cd "$WS/along"
git config user.email t@t; git config user.name t
mkdir -p deploy www
printf 'ok\n' > www/health
printf 'FROM busybox\nCOPY www/ /www/\nCMD ["httpd","-f","-p","4176","-h","/www"]\n' > deploy/Dockerfile.host
printf 'FROM busybox\nCMD ["sh","-c","while true; do sleep 3600; done"]\n' > deploy/Dockerfile.superagent
cat > deploy/docker-compose.cloud.yml <<'YAML'
services:
  anchor:
    image: busybox
    container_name: iso-anchor
    command: ["httpd","-f","-p","3083","-h","/tmp"]
    ports:
      - "127.0.0.1:13083:3083"
      - "127.0.0.1:14176:4176"
    healthcheck:
      test: ["CMD","true"]
      interval: 2s
      timeout: 2s
      retries: 3
  superagent:
    build:
      context: ..
      dockerfile: deploy/Dockerfile.superagent
    image: iso-superagent:local
    container_name: iso-superagent
    network_mode: "service:anchor"
    depends_on:
      anchor:
        condition: service_started
    healthcheck:
      test: ["CMD","true"]
      interval: 2s
      timeout: 2s
      retries: 3
  host:
    build:
      context: ..
      dockerfile: deploy/Dockerfile.host
    image: iso-host:local
    container_name: iso-host
    network_mode: "service:anchor"
    depends_on:
      anchor:
        condition: service_started
    healthcheck:
      test: ["CMD","true"]
      interval: 2s
      timeout: 2s
      retries: 3
YAML
cp "$DEPLOY_DIR/auto-deploy.sh" "$DEPLOY_DIR/auto-deploy-install.sh" \
   "$DEPLOY_DIR/auto-deploy.env.example" "$DEPLOY_DIR/along-auto-deploy.service" deploy/
chmod +x deploy/auto-deploy.sh deploy/auto-deploy-install.sh
git add -A; git commit -qm v1; git push -q origin HEAD:main

cd "$WS/along-superagent"
git config user.email t@t; git config user.name t
mkdir -p prompts
printf 'worker-v1\n' > prompts/worker.md
git add -A; git commit -qm v1; git push -q origin HEAD:main

chown -R "$SVC" "$WS"

echo "=== 1) 按手册安装（安装器生成 /etc/along-auto-deploy.env）"
( cd "$WS/along" && sudo sh deploy/auto-deploy-install.sh --no-enable ) 2>&1 | sed 's/^/  /'
echo "  配置里的服务账号: $(grep '^ALONG_DEPLOY_STATE_USER=' /etc/along-auto-deploy.env)"
echo "  配置里的工作区:   $(grep '^ALONG_DEPLOY_WORKSPACE=' /etc/along-auto-deploy.env)"
echo "  unit 里的账号:    $(grep '^User=' /etc/systemd/system/along-auto-deploy.service)"
echo "  机器上的定时器:  $(systemctl list-timers along-auto-deploy.timer --all --no-pager 2>/dev/null | grep -c along-auto-deploy.timer || echo 0) 条（应为 0：调度归 Multica）"

# 隔离栈的编排/镜像/容器/探活地址：写进同一个配置（这就是配置面）
cat >> /etc/along-auto-deploy.env <<ENV
ALONG_DEPLOY_ALONG_URL=$WS/origin-along.git
ALONG_DEPLOY_SUPERAGENT_URL=$WS/origin-superagent.git
ALONG_DEPLOY_ALONG_CHECKOUT=$WS/along
ALONG_DEPLOY_SUPERAGENT_CHECKOUT=$WS/along-superagent
ALONG_DEPLOY_HEALTH_URL=http://127.0.0.1:14176/health
ALONG_DEPLOY_PROBE_URL=http://127.0.0.1:13083/
ALONG_DEPLOY_HOST_CONTAINER=iso-host
ALONG_DEPLOY_SUPERAGENT_CONTAINER=iso-superagent
ALONG_DEPLOY_HOST_IMAGE=iso-host:local
ALONG_DEPLOY_SUPERAGENT_IMAGE=iso-superagent:local
ALONG_DEPLOY_EXPECT_BINDS=
ALONG_DEPLOY_EXPECT_SECRETS=
ALONG_DEPLOY_EXPECT_CONTEXTS=host=along superagent=along
ALONG_DEPLOY_EXPECT_ADDCTX=
ALONG_DEPLOY_VERIFY_HOST_IMAGE=
ALONG_DEPLOY_VERIFY_SUPERAGENT_IMAGE=
ENV

echo
echo "=== 1b) 先把隔离栈起起来（生产上登记基线时栈本来就在跑）"
sudo -u "$SVC" bash -c "cd '$WS/along' && docker compose -f deploy/docker-compose.cloud.yml up -d" 2>&1 | tail -2 | sed 's/^/  /'
sleep 3

echo
echo "=== 2) 以 root 登记基线（**不预先导出** ALONG_DEPLOY_STATE_USER）"
ALONG_SHA="$(sudo -u "$SVC" git -C "$WS/along" rev-parse HEAD)"
SA_SHA="$(sudo -u "$SVC" git -C "$WS/along-superagent" rev-parse HEAD)"
sudo /usr/local/libexec/along/auto-deploy.sh bootstrap "$ALONG_SHA" "$SA_SHA" --force 2>&1 | sed 's/^/  /'
echo "  状态目录属主: $(stat -c '%U' "$WS/.auto-deploy")"
echo "  版本台账属主: $(stat -c '%U' "$WS/.auto-deploy/versions" 2>/dev/null || echo '（不存在）')"
echo "  台账文件属主: $(stat -c '%U' "$WS/.auto-deploy/last-success.env" 2>/dev/null || echo '（不存在）')"

echo
echo "=== 3) 推一个上游改动，以 unit 的服务账号跑首次真实更新"
sudo -u "$SVC" bash -c "cd '$WS/along' && printf 'ok-v2\n' > www/health && git add -A && git commit -qm v2 && git push -q origin HEAD:main" 2>&1 | tail -1
sudo systemctl start along-auto-deploy.service
echo "  入口退出码: $?"
journalctl -u along-auto-deploy.service --no-pager -n 12 | grep -E "RECORD|DONE|ERROR|Permission|不切换" | sed 's/^/    /'

echo
echo "=== 4) 核对"
LEDGER_SHA="$(grep ALONG_SHA "$WS/.auto-deploy/last-success.env" | cut -d= -f2)"
RUNNING_SHA="$(sudo -u "$SVC" git -C "$WS/along" rev-parse origin/main)"
RUNNING_IMAGE="$(docker inspect -f '{{.Image}}' iso-host)"
LEDGER_IMAGE="$(grep HOST_IMAGE "$WS/.auto-deploy/last-success.env" | cut -d= -f2)"
HEALTH="$(docker inspect -f '{{.State.Health.Status}}' iso-host) / $(docker inspect -f '{{.State.Health.Status}}' iso-superagent)"
ENTRY="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:14176/health)"
CONTENT="$(docker run --rm --entrypoint sh iso-host:local -c 'cat /www/health' 2>/dev/null | tr -d '\n')"
echo "  台账记的提交:    ${LEDGER_SHA:0:12}"
echo "  两仓 main:       ${RUNNING_SHA:0:12}"
echo "  运行镜像 ID:     ${RUNNING_IMAGE:0:19}"
echo "  台账记的镜像 ID: ${LEDGER_IMAGE:0:19}"
echo "  容器健康:        $HEALTH"
echo "  入口返回码:      $ENTRY"
echo "  运行内容:        $CONTENT"

FAILED=0
[ "$LEDGER_SHA" = "$RUNNING_SHA" ] || { printf '  ✗ 台账记的提交与两仓 main 不一致\n'; FAILED=1; }
[ "$RUNNING_IMAGE" = "$LEDGER_IMAGE" ] || { printf '  ✗ 运行镜像与台账不一致\n'; FAILED=1; }
[ "$HEALTH" = "healthy / healthy" ] || { printf '  ✗ 双服务不都健康\n'; FAILED=1; }
[ "$ENTRY" = "200" ] || { printf '  ✗ 入口不是 200\n'; FAILED=1; }
[ "$CONTENT" = "ok-v2" ] || { printf '  ✗ 运行内容不是新提交的内容\n'; FAILED=1; }
if [ "$FAILED" = "0" ]; then printf '\n结论：全部通过\n'; else printf '\n结论：有不一致项\n'; exit 1; fi
