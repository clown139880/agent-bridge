# Agent 实时画布

状态：已实现；2026-11-13 精简为创建画布和推送两个操作，支持图片与视频混排。

## 使用

这是临时实时展示功能。Agent 创建画布后，把图片或视频 URL 推进去，页面自动显示；用完关掉网页即可。

| 工具 | 参数与结果 |
| --- | --- |
| `canvas.create` | 传标题、幂等键；返回画布 ID、页面链接和 seq |
| `canvas.push` | 传画布 ID、图片或视频 URL、可选说明、幂等键；返回条目 ID（兼容字段 `image_id`）、revision 和 seq |

需要替换同一条目的 URL、媒体类型或说明时，仍用 `push`，带上 `image_id` 和上次回执的 revision（参数名 `expected_revision`），顺序不变。

可选 `media_type: "image" | "video"` 显式指定类型；未指定时页面按 URL 路径的 `.mp4`、`.webm`、`.ogv`、`.mov`、`.m4v` 后缀识别视频，其余视为图片，忽略查询参数与后缀大小写。无后缀的视频链接应传 `media_type: "video"`；显式类型随条目保存，更换类型时通过 `push` 更新。旧记录无需迁移，已有 MP4 链接刷新页面即可识别。

不提供列表、查询、任务状态、关闭或重开的 Agent 工具。调用方保存创建回执即可。页面读取与断线补差由浏览器处理。

工具内置于 Control Plane，沿用 `/mcp/tools` 的 `tool_search` / `tool_call`。不新增服务、端口或各机器 MCP 配置。默认 auto，仍通过工具库风险决策并校验身份和配额；owner 来自认证 principal，同一 principal 的会话可共同推图。

## 图片、视频与页面

**只处理可访问的 HTTP(S) URL，不处理媒体文件。** 后端仅校验 URL 格式与长度，不上传、下载、代理、缓存、探测、转码或删除源文件。媒体来源应提供浏览器可直接加载的 URL；HTTPS 页面使用 HTTPS 来源。视频能否播放取决于浏览器对源文件编码的支持，通常使用 H.264 MP4 或 WebM；不增加 HLS/DASH 播放器。

页面 `/canvas/{id}/` 提供全屏、图片淡入切换、标题/说明、键盘导航、自动切换和跟随更新。始终只有两个图片元素用于淡入，另有一个复用的视频元素；只加载选中媒体，不提前加载其他图片或视频。只有当前显示的图片接收鼠标事件，透明旧图不拦截右键或拖拽。

视频默认尝试静音自动播放，提供浏览器原生播放、进度、声音与全屏控件；浏览器阻止自动播放时可手动播放。控件不被画布底栏遮挡。自动切换模式下图片每五秒切换，视频播完再切下一项。切离视频会暂停、清空 src 并调用 load 释放资源；切到视频时清空两个图片源。页面隐藏暂停视频，回来只恢复原本正在播放的视频。源 URL 或格式不可用时显示占位，Agent 可通过 `push` 换 URL。缩略图 URL 仍只作为可选元数据保存。

页面复用既有受控浏览器入口（内网/VPN/访问网关）。同源 `state`、`events` 是页面内部只读接口，需要浏览器入口已配置读或写权限与同源请求头；浏览器不拿 Agent token。工具侧按 owner 校验，受控入口内的查看者可读画布。只对 canvas 页面放行 HTTP(S) 的 `img-src` 与 `media-src` CSP，使用 `Referrer-Policy: no-referrer`。

`CANVAS_PUBLIC_URL` 可指定既有入口的 HTTP(S) origin；未指定时返回相对页面链接，不猜测实际域名。

## 存储与生命周期

每个画布一个 JSON 文件：

```text
<CANVAS_DATA_DIR>/agent-bridge-canvas/<canvas-id>.json
```

`CANVAS_DATA_DIR` 默认 `/tmp`，目录/文件权限为 `0700`/`0600`。JSON 只存 ID、owner、标题、时间、seq、媒体 URL/可选类型/说明/顺序/updated_seq 和幂等回执。可选缩略图 URL、过期时间也是普通元数据。条目 revision 就是 updated_seq，不维护第二套计数。为兼容既有调用和文件，数组名 `images`、回执与更新参数 `image_id` 保留，图片与视频共享同一配额。

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

默认限额均可配置：500 条媒体/画布、每 URL 8 KiB、每说明 4 KiB、10,000 条幂等回执。超限明确报错，不静默清理；重试不重复计数。`CANVAS_MAX_IMAGES` 沿用原名，同时限制图片和视频总数。

环境变量见 [`.env.example`](../.env.example)：`CANVAS_DATA_DIR`、`CANVAS_PUBLIC_URL`、`CANVAS_MAX_IMAGES`、`CANVAS_MAX_URL_BYTES`、`CANVAS_MAX_DESCRIPTION_BYTES`、`CANVAS_MAX_RECEIPTS`。

私有工具登记表：

```yaml
servers:
  canvas:
    title: 实时画布 / Live image canvas
    transport: { builtin: canvas }
    risk: { auto: [create, push] }
```

后端实现在 `apps/control-plane/src/` 的 `canvas.ts`、`canvas-tools.ts`、`canvas-web.ts`，由 ToolHub 和既有 HTTP 入口接入。页面为三个独立静态文件：

```text
apps/control-plane/public/canvas/
├── index.html
├── page.css
└── page.js
```

固定路由按请求从磁盘读取这三个文件，不内嵌进 TypeScript、不缓存进进程、不需要打包或文件监听。路径按模块位置解析，开发模式与编译后的服务使用同一个目录，不依赖启动目录。HTML/CSS/JS 保持 `no-store`，更新后刷新网页即可；不开放任意文件读取，CSP 和入口校验仍由后端设置。

首次切换为静态资源、修改后端工具/接口或 CSP，仍需完整发布一次。此后只改这个目录时，提交推送后运行 `deploy/hal/deploy.sh --frontend-only`：检查与运行中服务提交之间的差异，fast-forward 拉取，校验 JS 语法和 HTTP 返回的三个文件哈希；跳过编译、依赖安装和服务重启，已有 SSE 不会被发布过程断开。若同时包含后端变更就拒绝此模式，改走完整部署。纯页面发布仍升根版本，服务版本标记留到下一次完整发布；Control Center 页脚在它下次构建时更新。

没有改归档、数据库或 DSH，也不新增前端构建流程。项目知识留在 docs，不向历史 shared-skills 添加内容，工具无需额外 skill。

验证：`tests/canvas.test.ts` 覆盖文件、并发、幂等、revision、配额、媒体类型与旧文件兼容；`canvas-web.test.ts` 覆盖两个工具、风险决策、同源入口、视频 CSP、SSE 和静态文件即时更新；`canvas-browser.test.ts` 用真实 Chromium 验证连续切图后的右键目标与原生拖拽 URL、按需加载、图片视频混排、原生控件、视频播完切换、切离释放、后台恢复、失效占位与刷新后继续推送。`frontend-deploy.test.ts` 用隔离 Git 仓库和运行中的 HTTP 服务验证静态发布无编译/重启、后端变更和错误 JS 被拒绝、线上哈希不匹配不能报成功。测试用 1.6 KiB 合成视频，不读取用户媒体。Control Plane 发布只升根版本。
