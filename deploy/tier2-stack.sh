#!/bin/sh
# Run from the repository root. Anchor replacement must recreate both namespace consumers.
set -eu
set -f

files="${ALONG_TIER2_COMPOSE_FILES:-deploy/docker-compose.yml deploy/docker-compose.tier2.yml}"
project="${ALONG_TIER2_COMPOSE_PROJECT:-}"
tls_host="${ALONG_TIER2_TLS_HOST:-along.example.com}"
tls_ca="${ALONG_TIER2_CA_FILE:-/opt/along/data/host/tls/current/root.crt}"
public_ip="${ALONG_PUBLIC_IPV4:-}"

compose() {
  flags=
  for file in $files; do
    flags="$flags -f $file"
  done
  if [ -n "$project" ]; then
    set -- -p "$project" "$@"
  fi
  # The file override is a space-delimited list, as used by the integration test.
  docker compose $flags --profile tier2 "$@"
}

fail() {
  printf 'Tier 2 栈自检失败：%s\n' "$1" >&2
  exit 1
}

verify() {
  anchor="$(compose ps -q netns)"
  [ -n "$anchor" ] || fail "netns 未运行"
  for service in host superagent; do
    id="$(compose ps -q "$service")"
    [ -n "$id" ] || fail "$service 未运行"
    mode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$id")"
    [ "$mode" = "container:$anchor" ] || fail "$service 未绑定当前 netns"
  done

  if [ -n "$public_ip" ]; then
    published="$(compose port edge 443)" || fail "nginx 未发布 HTTPS 端口"
    probe="${ALONG_EDGE_PROBE:-127.0.0.1:${published##*:}}"
    set -- --connect-to "$public_ip:443:$probe" "https://$public_ip/health"
    if [ -n "${ALONG_EDGE_CA_FILE:-}" ]; then
      set -- --cacert "$ALONG_EDGE_CA_FILE" "$@"
    fi
  else
    published="$(compose port netns 4176)" || fail "netns 未发布 Host 的 TLS 端口"
    port="${published##*:}"
    set -- --cacert "$tls_ca" --resolve "$tls_host:$port:127.0.0.1" "https://$tls_host:$port/health"
  fi
  deadline=$(( $(date +%s) + 90 ))
  while :; do
    # A private listener response confirms that Host can reach the shared loopback.
    if compose exec -T host node -e '
      fetch("http://127.0.0.1:3082/",{signal:AbortSignal.timeout(2500)})
        .catch(()=>{process.exitCode=1});
    ' >/dev/null 2>&1 &&
      curl --fail --silent --show-error --noproxy '*' --max-time 4 "$@" >/dev/null 2>&1; then
      printf '%s\n' '命名空间、Super Agent 回环与 Host HTTPS /health 验证通过'
      return
    fi
    [ "$(date +%s)" -lt "$deadline" ] || fail "回环或 HTTPS 探针失败，检查服务日志、证书与入口地址"
    sleep 2
  done
}

case "${1:-verify}" in
  verify) verify ;;
  rebuild-anchor)
    if [ -z "$public_ip" ]; then
      [ -r "$tls_ca" ] || fail "无法读取 CA 文件：$tls_ca"
    fi
    command -v curl >/dev/null || fail "需要 curl 校验 HTTPS"
    compose up -d --force-recreate netns host superagent
    verify
    ;;
  *) printf '用法：%s {verify|rebuild-anchor}\n' "$0" >&2; exit 2 ;;
esac
