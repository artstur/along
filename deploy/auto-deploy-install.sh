#!/bin/sh
#
# 把自动部署器装到目标机：
#
#   脚本  → /usr/local/libexec/along/auto-deploy.sh
#   单元  → /etc/systemd/system/along-auto-deploy.{service,timer}
#   配置  → /etc/along-auto-deploy.env（不存在时从 auto-deploy.env.example 生成）
#
# 装完定时器每小时触发一轮。装完不会立刻部署——手动跑一轮看结果再决定：
#
#   sudo systemctl start along-auto-deploy.service
#   journalctl -u along-auto-deploy.service -n 100 --no-pager
#
# 用法：sudo deploy/auto-deploy-install.sh [--no-enable] [--enable-now]
#
#   --no-enable   只安装，不启用定时器（默认行为：安装并启用）
#   --enable-now  安装并立刻触发一轮部署
#
set -eu

here="$(cd "$(dirname "$0")" && pwd)"

enable=1
trigger_now=0
for arg in "$@"; do
  case "$arg" in
    --no-enable) enable=0 ;;
    --enable-now) trigger_now=1 ;;
    *) printf '未知参数：%s\n' "$arg" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = "0" ] || { printf '需要 root：sudo %s\n' "$0" >&2; exit 1; }

# 工作区根目录：优先按本脚本所在 checkout 推断（<工作区>/along/deploy/…），
# 推断不出来就用目标机的约定布局。
workspace="$(cd "$here/../.." && pwd)"
if [ ! -d "$workspace/along" ] || [ ! -d "$workspace/along-superagent" ]; then
  workspace=/home/ecs-user/workspace
fi

user="$(id -un "$(stat -c %u "$here" 2>/dev/null || echo 1000)" 2>/dev/null || echo ecs-user)"
[ -n "$user" ] || user=ecs-user
case "$user" in root) user=ecs-user ;; esac

printf '安装自动部署器：工作区 %s，账号 %s\n' "$workspace" "$user"

install -d -m 0755 /usr/local/libexec/along
install -m 0755 "$here/auto-deploy.sh" /usr/local/libexec/along/auto-deploy.sh

# 单元里的账号与工作区按实际探测值替换，提交进仓库的单元写的是这台机的约定值。
sed -e "s#^User=.*#User=$user#" \
    -e "s#^Group=.*#Group=$user#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=-$workspace#" \
    -e "s#/home/ecs-user/workspace#$workspace#g" \
    "$here/along-auto-deploy.service" > /etc/systemd/system/along-auto-deploy.service
install -m 0644 "$here/along-auto-deploy.timer" /etc/systemd/system/along-auto-deploy.timer

if [ ! -f /etc/along-auto-deploy.env ]; then
  sed -e "s#/home/ecs-user/workspace#$workspace#g" \
      "$here/auto-deploy.env.example" > /etc/along-auto-deploy.env
  chmod 0644 /etc/along-auto-deploy.env
  printf '已生成 /etc/along-auto-deploy.env\n'
else
  printf '保留已有的 /etc/along-auto-deploy.env\n'
fi

systemctl daemon-reload

if [ "$enable" = "1" ]; then
  systemctl enable --now along-auto-deploy.timer
  printf '已启用定时器 along-auto-deploy.timer\n'
else
  printf '未启用定时器（--no-enable）\n'
fi

if [ "$trigger_now" = "1" ]; then
  printf '立刻触发一轮部署\n'
  systemctl start along-auto-deploy.service
fi

printf '\n当前定时器状态：\n'
systemctl list-timers along-auto-deploy.timer --no-pager || true
printf '\n手动跑一轮：sudo systemctl start along-auto-deploy.service\n'
printf '看结果：journalctl -u along-auto-deploy.service -n 100 --no-pager\n'
printf '停用：sudo systemctl disable --now along-auto-deploy.timer\n'
printf '卸载：sudo rm -f /usr/local/libexec/along/auto-deploy.sh %s\n' \
  '/etc/systemd/system/along-auto-deploy.service /etc/systemd/system/along-auto-deploy.timer'
printf '      sudo systemctl daemon-reload\n'
