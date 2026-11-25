# Along 早期原型源码

这两个文本补丁用于在隔离目录重建 2026 年 11 月的原型。每份补丁有自己的公开基线。它们记录了历史页面、原生桥和测试。

| 版本 | 从本仓库导出的基线 | 源码范围 |
| --- | --- | --- |
| 移动目标原型 | `1dd7bdf4251af062869bdceb59e4b948ead1c139` | `mobile-goals.patch` 包含移动任务状态文案、睡眠与步数显示、资源缓存和对应测试。 |
| 健康伴侣原型 | `3f210dd545f6c70aa4d931f02b978f849795d221` | `health-companion.patch` 包含周期回顾、休息提醒、活动推荐、结果展示、请求组装与测试。 |

存档使用合成测试场景。健康数值、测试时间、提醒默认值与原生桥对应文案均按这一场景设置。地点和活动使用 A、B、C 占位，天气和路线使用 `example.org`，工单引用使用 fixture ID。公开机构的通用健康资料保留原链接。

以下命令可在此仓库根目录重建健康伴侣原型。移动目标原型可用表内的另一组提交和文件名独立重建。补丁采用零行上下文，务必使用对应的完整提交。

```sh
archive_dir="$PWD/archive/historical-prototypes"
scratch_dir="$(mktemp -d)"
git archive 3f210dd545f6c70aa4d931f02b978f849795d221 | tar -xf - -C "$scratch_dir"
(
  cd "$scratch_dir" || exit 1
  git apply --check --unidiff-zero "$archive_dir/health-companion.patch" &&
    git apply --unidiff-zero "$archive_dir/health-companion.patch" &&
    node --test workspace.test.mjs super-agent.test.mjs health-companion.test.mjs &&
    node build.mjs
)
```

移动目标版对应的测试是 `workspace.test.mjs` 和 `super-agent.test.mjs`。两个版本都可用 Node.js 22 运行；构建会从源码重新生成 `dist/` 和 iOS 内置页面。

更早的 10 月健康与储蓄原型可直接从 [首版源码](https://github.com/artstur/along/tree/1f5e0d7b476b18cf7657908a080e3259cc0664c1) 和 [后续源码](https://github.com/artstur/along/tree/d17966b9ece47bd426b5859e2cc9ff8bce6bb970) 取得。两次的全部 15 个公开文件均已逐份和历史目录核对。部署项目绑定由原环境单独保管。11 月的通知与情境编排候选版源码已通过 [PR #6](https://github.com/artstur/along/pull/6) 集成。
