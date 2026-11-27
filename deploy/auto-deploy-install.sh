#!/bin/sh
#
# 把自动部署器装到目标机：
#
#   脚本  → /usr/local/libexec/along/auto-deploy.sh
#   单元  → /etc/systemd/system/along-auto-deploy.service
#   配置  → /etc/along-auto-deploy.env（不存在时从 auto-deploy.env.example 生成）
#
# **机器上不装定时器**：调度由 Multica 的每小时 wakeup 驱动，它调起的是这台机上的
# 一次性部署入口：
#
#   sudo systemctl start along-auto-deploy.service
#
# 装完不会立刻部署——手动跑一轮看结果再决定：
#
#   sudo systemctl start along-auto-deploy.service
#   journalctl -u along-auto-deploy.service -n 100 --no-pager
#
# 用法：sudo deploy/auto-deploy-install.sh [--trigger-now]
#
#   --trigger-now  安装后立刻触发一轮部署
#
set -eu

here="$(cd "$(dirname "$0")" && pwd)"

trigger_now=0
for arg in "$@"; do
  case "$arg" in
    --trigger-now) trigger_now=1 ;;
    --no-enable|--enable-now) : ;;   # 旧的参数名：调度不再由机器上的定时器负责
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
group="$(id -gn "$user" 2>/dev/null || echo "$user")"
[ -n "$group" ] || group="$user"

printf '安装自动部署器：工作区 %s，账号 %s\n' "$workspace" "$user"

install -d -m 0755 /usr/local/libexec/along
install -m 0755 "$here/auto-deploy.sh" /usr/local/libexec/along/auto-deploy.sh

# 状态目录归**服务账号**所有：部署入口以服务账号运行，它要在这里放锁与版本记录。
# root 建出来的目录服务账号写不进去——取锁直接 Permission denied，每轮都失败。
install -d -m 0750 -o "$user" -g "$group" "$workspace/.auto-deploy"

# 单元里的账号与工作区按实际探测值替换，提交进仓库的单元写的是这台机的约定值。
sed -e "s#^User=.*#User=$user#" \
    -e "s#^Group=.*#Group=$user#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=-$workspace#" \
    -e "s#/home/ecs-user/workspace#$workspace#g" \
    "$here/along-auto-deploy.service" > /etc/systemd/system/along-auto-deploy.service

# 机器上**不保留定时器**：调度归 Multica。两套调度同时跑会互相切换。
if [ -f /etc/systemd/system/along-auto-deploy.timer ]; then
  systemctl disable --now along-auto-deploy.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/along-auto-deploy.timer
  printf '已停用并移除机器上的旧定时器（调度改由 Multica 驱动）\n'
fi

if [ ! -f /etc/along-auto-deploy.env ]; then
  sed -e "s#/home/ecs-user/workspace#$workspace#g" \
      "$here/auto-deploy.env.example" > /etc/along-auto-deploy.env
  chmod 0644 /etc/along-auto-deploy.env
  printf '已生成 /etc/along-auto-deploy.env\n'
else
  printf '保留已有的 /etc/along-auto-deploy.env\n'
fi

# 服务账号记进配置：以 root 跑 bootstrap 时据此把状态目录（含版本台账）改成服务账号
# 所有，免得服务账号下一轮写台账 Permission denied。
# 注意：部署器**先读这个配置文件再解析参数**，所以这里的值是生效的。
if grep -q '^ALONG_DEPLOY_STATE_USER=' /etc/along-auto-deploy.env; then
  sed -i "s#^ALONG_DEPLOY_STATE_USER=.*#ALONG_DEPLOY_STATE_USER=$user#" /etc/along-auto-deploy.env
else
  printf 'ALONG_DEPLOY_STATE_USER=%s\n' "$user" >> /etc/along-auto-deploy.env
fi

systemctl daemon-reload

if [ "$trigger_now" = "1" ]; then
  printf '立刻触发一轮部署\n'
  systemctl start along-auto-deploy.service
fi

printf '\n部署入口（Multica 的每小时 wakeup 调的就是它）：\n'
printf '  sudo systemctl start along-auto-deploy.service\n'
printf '看结果：journalctl -u along-auto-deploy.service -n 100 --no-pager\n'
printf '登记基线（以服务账号跑）：sudo -u %s /usr/local/libexec/along/auto-deploy.sh bootstrap\n' "$user"
printf '机器上没有定时器：调度由 Multica 驱动\n'
printf '卸载：sudo rm -f /usr/local/libexec/along/auto-deploy.sh %s\n' \
  '/etc/systemd/system/along-auto-deploy.service'
printf '      sudo systemctl daemon-reload\n'
