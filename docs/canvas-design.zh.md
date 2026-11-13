# Agent 实时画布

状态：已实现；2026-11-13 按用户反馈精简为创建画布和推图两个操作。

## 使用

这是临时实时展示功能。Agent 创建画布后，把图片 URL 推进去，页面自动显示；用完关掉网页即可。

| 工具 | 参数与结果 |
| --- | --- |
| `canvas.create` | 传标题、幂等键；返回画布 ID、页面链接和 seq |
| `canvas.push` | 传画布 ID、图片 URL、可选说明、幂等键；返回图片 ID、revision 和 seq |

需要替换同一张图片的 URL 或说明时，仍用 `push`，带上 `image_id` 和上次回执的 revision（参数名 `expected_revision`），图片顺序不变。

不提供列表、查询、任务状态、关闭或重开的 Agent 工具。调用方保存创建回执即可。页面读取与断线补差由浏览器处理。

工具内置于 Control Plane，沿用 `/mcp/tools` 的 `tool_search` / `tool_call`。不新增服务、端口或各机器 MCP 配置。默认 auto，仍通过工具库风险决策并校验身份和配额；owner 来自认证 principal，同一 principal 的会话可共同推图。

## 图片与页面

**只处理可访问的 HTTP(S) URL，不处理图片文件。** 后端仅校验 URL 格式与长度，不上传、下载、代理、缓存、探测或删除源图片。需要私密认证的图源应提供浏览器可直接加载的 URL。HTTPS 页面使用 HTTPS 图片源。

页面 `/canvas/{id}/` 提供全屏、淡入切换、标题/说明、键盘导航、幻灯片和跟随新图。只加载当前图；缩略图如有需要由调用方提供。源 URL 失效时显示占位，Agent 可通过 `push` 换 URL。

页面复用既有受控浏览器入口（内网/VPN/访问网关）。同源 `state`、`events` 是页面内部只读接口，需要浏览器入口已配置读或写权限与同源请求头；浏览器不拿 Agent token。工具侧按 owner 校验，受控入口内的查看者可读画布。只对 canvas 页面放行图片源 CSP，使用 `Referrer-Policy: no-referrer`。

`CANVAS_PUBLIC_URL` 可指定既有入口的 HTTP(S) origin；未指定时返回相对页面链接，不猜测实际域名。

## 存储与生命周期

每个画布一个 JSON 文件：

```text
<CANVAS_DATA_DIR>/agent-bridge-canvas/<canvas-id>.json
```

`CANVAS_DATA_DIR` 默认 `/tmp`，目录/文件权限为 `0700`/`0600`。JSON 只存 ID、owner、标题、时间、seq、图片 URL/说明/顺序/updated_seq 和幂等回执。可选缩略图 URL、过期时间也是普通元数据。图片 revision 就是 updated_seq，不维护第二套计数。

每次修改重写这个小文件：同画布进程内串行队列 → 校验幂等/revision/限额 → 同目录临时文件写完关闭 → rename 替换 → 返回回执并通知 SSE。不同画布独立执行，网络 drain 不占队列。失败不发布变更。没有数据库、事件日志、全局索引、快照或多进程锁；只由现有一个 Control Plane 进程管理。

同幂等键同参数返回原回执，不同参数报冲突；创建 ID 从 principal 与创建幂等键派生，不需要额外索引。幂等键和参数只存摘要，回执不复制完整 URL。审核/审批记录里的图片 URL 只保留 origin，完整 URL 保存在运行文件并提供给获准查看的页面。

默认数据可丢：主机重启或 `/tmp` 清理后不保证保留。Control Plane 重启时若文件仍在就按需读取；文件丢失返回 `canvas_gone`，不从内存重建；损坏报错，不自动修复。rename 提供原子替换，不承诺掉电持久性。残留 `.tmp` 不参与读取。

关闭网页只释放连接，不删除记录。不新增自动清理、备份或同步任务；主动删除仍需明确授权。若确需持久保存，仅将目录改为 OpenList share 对应的实际本地路径，需支持普通文件读写和同目录 rename；不是 HTTP 分享链接。保存元数据不能延长源 URL 的有效期。

旧版本 JSON 继续可读可写；旧任务状态、closed、meta_seq、status_at 不再生效，下次正常写回时略去，不扫描或迁移旧文件。旧 `add_image` / `update_image` 调用改用 `push`，其余管理工具直接移除。

## 实时更新

MCP 是短调用，浏览器另开 fetch SSE。图片变化增加 seq，并更新该图 updated_seq。首次 cursor=0 返回标题和图片；之后只选 updated_seq 大于游标的图片。离线期间同一图修改多次只补最新内容，不保存完整事件历史，也没有单图删除记录。

订阅登记和首份补差写入有界响应缓冲位于同画布串行区，避免初次读取与订阅间漏更新。浏览器成功应用后推进游标；正常重连只补变化，不并行全量轮询。非法或超前游标要求重新同步，文件丢失停止恢复。

无变化只发小心跳。页面隐藏时断开，恢复可见再补差；关闭页面清理订阅和定时器。慢客户端断开后按游标恢复。所有新增 timer 均 unref，无请求/订阅时没有新增后台任务。Control Plane 已常驻，canvas 不另建 systemd 单元；以后若拆服务才采用 socket activation + idle-exit。

## 配置与登记

默认限额均可配置：500 张/画布、每 URL 8 KiB、每说明 4 KiB、10,000 条幂等回执。超限明确报错，不静默清理；重试不重复计数。

环境变量见 [`.env.example`](../.env.example)：`CANVAS_DATA_DIR`、`CANVAS_PUBLIC_URL`、`CANVAS_MAX_IMAGES`、`CANVAS_MAX_URL_BYTES`、`CANVAS_MAX_DESCRIPTION_BYTES`、`CANVAS_MAX_RECEIPTS`。

私有工具登记表：

```yaml
servers:
  canvas:
    title: 实时画布 / Live image canvas
    transport: { builtin: canvas }
    risk: { auto: [create, push] }
```

实现在 `apps/control-plane/src/` 的 `canvas.ts`、`canvas-tools.ts`、`canvas-web.ts`、`canvas-page.ts`，由 ToolHub 和既有 HTTP 入口接入。没有改归档、数据库或 DSH，也不新增前端构建流程。项目知识留在 docs，不向历史 shared-skills 添加内容，工具无需额外 skill。

验证：`tests/canvas.test.ts` 覆盖文件、并发、幂等、revision、配额与旧文件兼容；`canvas-web.test.ts` 覆盖两个工具、风险决策、同源入口和 SSE；`canvas-browser.test.ts` 用真实 Chromium 验证按需取图、后台恢复、失效占位与刷新后继续推图。Control Plane 发布只升根版本。
