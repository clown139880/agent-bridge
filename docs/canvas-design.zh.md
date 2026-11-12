# 设计：Agent 实时画布工具

状态：用户于 2026-11-12 批准实施，首版实现遵循下述单文件方案。运行配置见文末。

## 1. 方案

**Control Plane 内置 canvas 工具 + 一张薄网页；每个画布一个 JSON 文件。** 这是临时实时展示功能，按这个规模实现即可。

Agent 经现有 `/mcp/tools` 创建画布、追加图片 URL、更新状态。浏览器通过 SSE 看变化，直接向图源取图。服务端不上传、下载、代理、缓存或删除图片文件，也不负责生成。

旧项目的全屏、淡入切换、标题/说明、状态点、键盘导航和幻灯片可以复用，去掉生成面板；不重新启用归档工作台。

## 2. 存储：一画布一文件

`CANVAS_DATA_DIR` 默认 `/tmp`，可配置。实际文件放在专属子目录：

```text
/tmp/agent-bridge-canvas/
  <canvas-id>.json
  <another-canvas-id>.json
```

每个 JSON 保存：

| 字段 | 内容 |
| --- | --- |
| 基本信息 | ID、owner、标题、任务状态、是否关闭、创建/更新时间 |
| `seq` / `meta_seq` | 画布当前序号、标题/状态等最后变更的序号 |
| `images` | 图片 ID、URL、说明、顺序、可选过期时间/缩略图 URL，以及最后变更的 `updated_seq` |
| `idempotency` | 幂等键对应的参数摘要与结果概要（ID、seq 等），不复制完整请求和整张画布 |

图片的 revision 直接使用该条的 `updated_seq`，不再维护另一套计数。没有数据库、操作日志目录、周期快照、全局索引、存储代次文件或多进程锁。运行时只由现有单个 Control Plane 进程管理这些文件。

**每次修改就重写这一个 JSON。** 内容只有受限的展示元数据，这个写入成本作为本次简化明确接受；不为了省这点写入增加存储机制。按需读取目标画布，不在启动时把所有文件读进内存；进程内可短暂缓存正在使用的画布。

### 写入与并发

只保留一个进程内的按画布串行队列，确保同一画布的读改写不会互相覆盖，不同画布可以独立处理：

1. 校验身份、幂等键、revision 和限额，生成更新后的完整 JSON。
2. 写入同目录临时文件 `<id>.<random>.tmp`，写完关闭，再 `rename` 替换 `<id>.json`。
3. 成功后才更新内存、返回回执并发 SSE；失败则保留旧状态。

状态、seq 和幂等回执在同一文件里一起替换。rename 前中断仍是旧文件；rename 后回包丢失，重试可读到同一回执。只认 `.json` 文件，残留 `.tmp` 不参与读取。这里保留基本的原子替换，不做日志恢复或掉电持久性保证。

同键同参数返回已有结果，同键不同参数报冲突。创建时可由认证 principal 与 create 幂等键派生画布 ID，避免重复创建及额外索引；新画布使用新键。更新图片需要匹配预期 revision，避免覆盖别人刚做的修改。文件丢失后幂等保证也随之结束，调用方新建画布即可。

### 生命周期

默认 `/tmp` 数据是可丢弃的：主机重启或系统清理后丢失可以接受。只重启 Control Plane、文件仍在时，直接读回这个 JSON。文件不存在就返回 `canvas_gone`，不从内存重建旧文件；文件损坏就报错，不自动修复或覆盖。

关闭画布只改变状态，不主动删文件。默认没有自动清理、备份、同步或迁移任务；主动删除仍需明确授权。

确需保留时，仅把 `CANVAS_DATA_DIR` 改为 OpenList share 对应的实际本地目录，沿用同一套文件读写，目录需支持同目录 rename。具体路径留部署配置，不使用 HTTP 分享链接作文件路径，也不新增持久模式、备份系统或文件搬运流程。持久保存元数据仍不能延长源图片 URL 的有效期。

## 3. URL 与页面

只接受浏览器可直接加载的 HTTP(S) URL，不接受本地路径或 base64。后端校验格式和长度，不向图源发 HEAD/GET 探测。HTTPS 页面使用 HTTPS 图片源；需要私密自定义认证头的图片应由产图端提供可直接访问的 URL。

URL 过期或加载失败时页面显示占位，Agent 可更新同一图片 ID 的 URL，顺序不变。图像缓存由浏览器和源站管理；内容变化应由来源提供新 URL，画布不下载算哈希。

当前图及必要的相邻图按需加载，避免进入页面就下载所有原图。缩略图 URL 由调用方提供；没有时可显示编号，不生成服务端缩略图。

带签名的 URL 只保存在运行文件，不进 Git、技能或长期记忆，日志遮盖签名参数。目录/文件默认权限为 `0700`/`0600`，页面使用 `Referrer-Policy: no-referrer`。获准查看画布的浏览器会取得完整 URL。

## 4. SSE：只补当前展示状态的变化

MCP 是短调用，SSE 是浏览器的独立连接。每次可见修改增加 `seq`，给被改动图片写入 `updated_seq`，标题/状态等变化更新 `meta_seq`，保存成功后通知页面。

**不保存完整事件历史，连文件内的事件数组也不需要。** 页面带最后收到的序号重连时，从当前 JSON 选择 `updated_seq > cursor` 的图片，以及 `meta_seq > cursor` 的画布信息，发送这些变化和最新 seq。断线期间同一张图改过多次，只需要它现在的版本；不回放已经过去的进度提示。首期没有单图删除功能，无需维护删除记录。

初次读取返回状态及 seq。订阅建立时，在同一画布串行区登记监听并将首份补差写入有界响应缓冲，再发送后续实时变化，避免初次查询与订阅之间漏更新；不在队列内等待网络 drain。客户端成功应用后才推进游标，图片按 ID/revision 更新。

没变化只发小心跳；正常重连不全量重发，不同时运行全量轮询。非法或超前游标提示重新同步；新页面首次打开才读取完整的受限元数据。文件丢失则停止重连，提示画布已失效。

使用 fetch SSE 以支持同源请求头和错误处理。页面隐藏时断开，恢复可见再补差；关闭画布时停止实时连接。慢客户端缓冲有界，断开后仍按上述方式恢复；连接关闭清除监听和心跳 timer。

## 5. 工具、身份与入口

| 工具 | 作用 |
| --- | --- |
| `canvas.create` | 创建并返回画布 ID、页面链接和 seq |
| `canvas.list` / `canvas.get` | 查询画布；get 可按游标返回当前变化 |
| `canvas.add_image` | 追加 URL 和说明，返回新增图片 ID 与 seq |
| `canvas.update_image` | 按图片 ID 和预期 revision 更新 URL/说明 |
| `canvas.set_status` | 更新 working/complete/failed 与简短说明 |
| `canvas.close` / `canvas.open` | 停止或继续实时展示，关闭不删除记录 |

正常读写默认 `auto`（登记表可配置），仍检查身份、配额，并经过工具库风险决策。不能照搬当前 web/decide 内置分支的提前返回。owner 取自认证 principal，同一 principal 下的会话可共同操作，跨 principal 协作以后再考虑。

工具在 Control Plane 定义静态 schema 与处理函数，并在 ToolHub 接入 canvas 分支；私有登记表使用 `transport.builtin: canvas`。继续通过 `/mcp/tools` 搜索和调用，不新增各机器 MCP 配置。工具发现只读静态描述。

页面使用 `/canvas/{id}/`，同源提供 `state` 和 `events`（SSE）。复用现有 Control Center 的受控浏览器入口（内网/VPN/既有访问网关），不新增端口。`CANVAS_PUBLIC_URL` 可配置既有入口的 HTTP(S) origin；未指定时工具返回相对页面地址，不猜测域名。浏览器只读，服务端沿用同源检查，页面不拿 Agent token；该入口内的查看者可读画布，Agent 工具侧按 owner 检查。只在 canvas 页面 CSP 放行图片源，不放宽整个控制面。

## 6. 默认限额与空闲

以下为默认值，均可配置：

| 项目 | 默认值 |
| --- | --- |
| 图片数 | 500 张/画布 |
| URL 长度 | 每个 URL ≤ 8 KiB（UTF-8） |
| 单条说明 | ≤ 4 KiB（UTF-8） |
| 同状态进度更新 | ≤ 1 次/秒；相同内容不重复显示，完成/失败状态可立即提交 |
| 幂等回执 | 10,000 条/画布；达到上限明确报错，可新建画布，不静默丢弃旧键 |

幂等重试不重复计数；超限返回明确错误，不静默清理数据。

Control Plane 本来常驻，canvas 不新增服务。没有请求或订阅时不运行轮询、探活或清理任务；新增 timer 均 unref，连接释放时清除。无需为本功能建立 systemd 单元；若以后确需拆服务，再按 socket activation + idle-exit 处理。

## 7. 实现与运行

实现位于 `apps/control-plane/src/`：`canvas.ts` 管单文件读写、并发与补差，`canvas-tools.ts` 定义工具 schema，`canvas-web.ts` 提供只读路由和 SSE，`canvas-page.ts` 包含随 TypeScript 构建的静态页面。`tools.ts` 的 canvas 分支经过现有风险决策再执行。未改归档、DSH 或数据库 schema，没有独立应用或前端构建流程。

部署登记表增加以下条目；不携带凭据，也不用给各机器增加 MCP 服务：

```yaml
servers:
  canvas:
    title: 实时画布 / Live image canvas
    transport: { builtin: canvas }
    risk:
      auto: [create, list, get, add_image, update_image, set_status, close, open]
```

环境配置见 [`.env.example`](../.env.example)：`CANVAS_DATA_DIR`、`CANVAS_PUBLIC_URL`，以及 `CANVAS_MAX_IMAGES`、`CANVAS_MAX_URL_BYTES`、`CANVAS_MAX_DESCRIPTION_BYTES`、`CANVAS_PROGRESS_INTERVAL_MS`、`CANVAS_MAX_RECEIPTS`。修改后走正常 Control Plane 部署流程。全局 API 入口仍需认证；网页仅在既有浏览器入口配置了读或写权限时可读取。

Agent 用 `tool_search(query="canvas")` 发现，再通过 `tool_call` 调用。创建需要 `title`、`idempotency_key`；推图需要 `canvas_id`、`url`、`idempotency_key`；更新图片携带 `image_id` 与 `expected_revision`（上次回执的 `revision` 或查询中的 `updated_seq`）。关闭后要先 `open` 才能继续写；已关闭的页面点击“重新连接”恢复。图片排序保持追加顺序，不做单图删除或重排。

文件中的 `status_at` 只用于同状态进度限频。幂等键存成摘要，回执不含原图 URL；风险审核与审批记录中的 URL 只保留 origin，图片完整 URL 仍仅在临时画布文件与获准查看的调用方/页面之间传递。文件或进程丢失没有自动恢复承诺；主机 `/tmp` 清理与外部写入不受进程内队列控制。

设计留在项目 `docs/`；不向历史 `shared-skills/` 添加内容。工具本身无需技能，未来操作手册可经 Control Plane 写入私有技能库。相关约定见 [AGENTS.md](../AGENTS.md)、[技能库设计](agent-skills-design.zh.md)、[中央工具库](tool-hub-design.zh.md)和[审批权限](approval-permissions.zh.md)。

实施时重点验证：单文件原子替换、同画布并发和幂等、revision 冲突、断线只补变化、服务重启读取文件、临时文件丢失后停止恢复、整个过程没有图片下载或落盘。

验证覆盖 `tests/canvas.test.ts`、`tests/canvas-web.test.ts`、`tests/canvas-browser.test.ts`：并发写/幂等/revision/限额、重启和文件丢失、工具风险档与 URL 脱敏、同源只读入口和 SSE、真实浏览器按需取图、后台恢复、失效占位与关闭重开。Control Plane 发布只升根版本，不升 Bridge 版本。
