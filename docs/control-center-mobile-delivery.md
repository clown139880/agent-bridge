# Control Center 移动端实施记录

版本：根 `package.json` **0.6.99**。Phase 1 和 Phase 2 已上线，构建、相关测试与线上只读验收通过。功能提交 `5f8a0ad`，部署脚本提交及本次部署源提交 `e9664ef9b57adbc5ac9ce231321e84156faa3c8d`。逐 token delta 和 Phase 3 未实施；真机、真实 HTTPS 与通知房回执的验收边界见下文。

## 文件清单

| 文件 | 改动 |
| --- | --- |
| `apps/control-center/package.json` | 新前端 workspace 包和构建脚本 |
| `apps/control-center/tsconfig.json` | 浏览器 TypeScript 配置 |
| `apps/control-center/vite.config.ts` | Tailwind、base、开发 API 代理 |
| `apps/control-center/index.html` | 页面入口 |
| `apps/control-center/src/main.tsx` | 登录、列表、详情、待办、新建、发送、打断、action 展示 |
| `apps/control-center/src/styles.css` | 手机布局、滚动、软键盘、安全区与深色模式 |
| `apps/control-center/src/state.ts` | 资源合并、请求生命周期、SSE 恢复、action 与幂等重试 |
| `apps/control-center/src/api/client.ts` | 内存 Bearer、HTTP 错误、固定 key 写请求 |
| `apps/control-center/src/api/stream.ts` | SSE 增量解码、队列预算、keepalive watchdog、取消 |
| `apps/control-center/src/api/types.ts` | 所用 wire types |
| `apps/control-center/README.md` | 使用、开发、构建与验证说明 |
| `apps/control-plane/src/web/app.ts` | Hono 静态托管、安全头、严格 SPA 路由；禁止适配器替换全局 Request/Response |
| `apps/control-plane/src/server.ts` | 将 `/control/*` 接入现有 node:http server |
| `apps/control-plane/package.json` | Hono 和 Node 适配器依赖 |
| `package.json` | 版本、前端检查和 `build:control` |
| `pnpm-lock.yaml` | 锁定新增依赖 |
| `deploy/hal/deploy.sh` | 获批后补齐前端构建、显式传播 tsc 失败、失败保留现场并中止 |
| `docs/agent-control-api.md` | 已有 tail/before 能力和独立网页认证边界说明 |
| `docs/control-center-mobile.md` | 原设计及实施状态 |
| `docs/control-center-mobile-delivery.md` | 本记录 |
| `tests/control-center.test.ts` | 静态安全、SSE、状态合并、恢复、权限与写入竞态测试 |
| `tests/control-center-browser.test.ts` | Chromium 390px 手机视口模拟 API 闭环 |
| `tests/agent-control-api.test.ts` | 同 listener 的网页/API/health 兼容性回归 |

现有 `/api/v1` handler、SSE 服务端、协议、数据库、审批与权限代码均未修改；没有修改其他仓库。`dist/`、pnpm store 和 `.runtime/` 已被现有根 gitignore 规则覆盖，没有提交产物或浏览器 profile。

## Phase 状态和验证

- **Phase 1 完成**：内存登录、最近会话搜索/Worker 筛选/分页、历史尾页与更早内容、活动详情 SSE、待办只读、前后台暂停和恢复。
- **Phase 2 完成**：worker/workspace、新建与跳转、继续/追加、expectedTurnId 打断、固定 Idempotency-Key 重试、异步回执。RPC 接受与 turn 终态分开展示。
- `pnpm check`：通过，覆盖原 TypeScript project references 与新前端。
- `pnpm build:control`：通过，`tsc -b` 和前端类型检查/Vite 生产构建；不构建或安装 HAL 不使用的 DSH 插件。
- 相关回归 **37/37 通过**：`agent-control-api`、`event-contract`、`session-action-lease`、`post-deploy`、`control-center` 和 `control-center-browser`。
- 浏览器验证覆盖登录、列表/历史分页、SSE、steer、interrupt、create、横向溢出、storage/cookie 为空、刷新需登录。只用模拟 API，没有对真实 session 执行验收写操作。
- 产物约 179kB JS / 12kB CSS（gzip 约 58kB / 4kB）；未包含操作者 token。

测试日志和截图在本机忽略目录 `.runtime/`，不作为已部署证据。Safari 真机、Android 真机与真实 HTTPS 反代尚未验收。

## 部署结果

2026-10-20（Asia/Shanghai），按用户后续明确批准的最小范围修改 `deploy/hal/deploy.sh`，版本保持 0.6.99：

- `pnpm exec tsc -b --pretty false || return $?`，避免后续前端构建掩盖 TypeScript 失败。
- 随后执行 `pnpm --filter @agent-bridge/control-center build`，生成同源托管所需 Vite 产物。
- 构建失败只记录并退出：保留 checkout 与构建现场，不 reset、不自动重建、不重启服务。其他部署行为未改。

脚本提交 `e9664ef` 已推送 `origin/main`；`bash -n`、`git diff --check` 和隔离 stub 检查通过，验证 tsc/front-end 的非零退出分别传播，并验证失败分支直接中止。通过唯一部署入口 `deploy/hal/deploy.sh --note ...` 执行，HAL Bridge 重启中断原 turn。Hermes 随后确认服务上线、post-deploy intent 目录为空且未收到自动续跑；由用户本次消息恢复收尾。此次没有重跑部署或手动重启，也没有扩大修改部署/续跑逻辑；未自动续跑的原因未在本任务中调查。

部署后复核时，`/var/lib/agent-bridge/deployed-commit`、本地 HEAD 和 `origin/main` 均为 `e9664ef9b57adbc5ac9ce231321e84156faa3c8d`，工作区干净。下述文档收尾提交会让 Git HEAD 前移，但**不改变运行中的部署提交**。

## 线上只读验收（2026-10-20 00:23–00:24 CST）

目标为实际控制面 `http://127.0.0.1:8787`，非 mock。从 `/etc/agent-bridge/control-plane.env` 在 Node 脚本内读取 `CONTROL_API_READ_TOKEN`；token 仅用于内存中的 Bearer header，未打印、写入验证报告或传入命令参数。所有业务探测均为 GET，没有对生产 session 发送消息、interrupt、新建、审批或其他写请求；脚本未使用管道到解释器。

| 检查 | 实际结果 |
| --- | --- |
| 服务进程 | Control Plane 和 HAL Bridge 均为 systemd `active`；PID 分别为 `1268342`、`1268343`，启动时间均为 2026-10-20 00:20:06 CST；journal 有实际监听及 HAL 注册记录 |
| 版本/提交 | 部署标记为 `e9664ef`，根版本 `0.6.99`；控制面从该 checkout 的根 package.json 读取版本。实际 API 中 `codex@hal`、`claude@hal`、`pi@hal` 均 online，均报告 `bridgeVersion: 0.6.99`。协议未提供进程内独立 commit 字段，提交证据来自部署标记、代码源和启动记录 |
| 健康 | `/health` 返回 200、`ok: true`、`bridges: 1` |
| 登录与深链 | `/control/login` 返回 200 `text/html`；真实 session 的 `/control/sessions/{id}` 返回相同入口 HTML；入口 HTML 与部署构建产物 SHA-256 一致 |
| 安全头 | 登录页 CSP 含 `script-src 'self'`、`connect-src 'self'`；`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store` 均通过 |
| 静态资源 | 入口引用的 JS/CSS 均返回 200，服务内容与本地部署构建产物 SHA-256 一致，具体 hash 见下表 |
| 真 404 | `/control/nonexistent.js`、`/control/assets/nonexistent.js`、`/control/nope/x` 均为 404；带 read token 的未知 `/api/v1/control-center-probe-nonexistent` 为 JSON 404 `not_found`，未被 SPA 吞掉 |
| API 鉴权 | 不带 token 的 `/api/v1/snapshot` 返回 401；带 read token 的 snapshot 返回 200，worker/session/approvals/userInput/streamCursor 结构符合契约；此快照含 6 workers、200 sessions、0 approvals、0 userInput（只代表当时快照） |
| 活动详情/历史 | 从实际 active session 读取详情与 `events?tail=true&limit=5` 均为 200，返回 5 条历史事件；未输出会话正文 |
| SSE 首次接流 | `GET /api/v1/stream?sessionId=...&cursor=<snapshot水位>` 返回 200 `text/event-stream`，收到 7 个该 session 的合法 `bridge.event` envelope；frame id 与 envelope cursor 一致，游标推进 |
| SSE 重连 | 断开后用 `Last-Event-ID` 恢复，再收到 8 个同 session 的 envelope，未重复恢复边界游标；仍为 200 |
| SSE 缓冲/释放 | 两次连接均含 `retry: 3000`、`X-Accel-Buffering: no`、`Cache-Control: no-cache, no-transform`；验证脚本读取到帧后取消连接。事件来自正常活动，没有主动制造生产写操作；此检查不等同真实反代下背压压力测试 |

| 已托管资源 URL | SHA-256（源构建与实际服务一致） |
| --- | --- |
| `/control/assets/index-DGJ5-E3k.js` | `2b34729d7b777b9e6c59439c82e16e0b37334e8378dd13ea44710658b61415d7` |
| `/control/assets/index-DqENv0wY.css` | `2845e62aa55645d488517b1d7cc1ea7c5192cca80123418f7bdaa774fc7299fc` |

脱敏验证汇总位于本机忽略目录 `.runtime/control-center-live/{snapshot,sse,resume}-result.json`，不提交验证脚本、生产会话内容或构建产物。此次收尾仅文档变更，不重跑应用构建或部署；上文 37 项测试和构建结果属于部署前验证。

## 尚需人工验收/确认

- Safari / Android 真机：软键盘、安全区、滚动、切后台恢复与断网重连。现有 Chromium 手机视口测试使用模拟 API，不能替代真机。
- 真实 HTTPS 入口/反代：TLS、同源资源、SSE 不缓冲、网络中断和慢客户端场景。本次线上验证仅走 HAL 本机 HTTP；移动端输入操作 token 前应完成真实 HTTPS 验收。
- 通知房两条既定消息（`🟢 控制面已启动 · 版本 0.6.99`、`🔄 更新完成：hal · old → 0.6.99`）未取得可独立读取的房间回执；journal 已确认启动/注册，但不能据此声称两条通知已收到，需人工核对。
- 自动 post-deploy 续跑未触发：本次已通过用户恢复完成验证；是否另行调查续跑链路由人工确认，不属于本次代码收尾。
