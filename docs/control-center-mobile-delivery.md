# Control Center 移动端实施记录

当前版本：根 `package.json` **0.6.100**，网页免 token 登录已上线，部署提交 `c56127e6d81a0de80fc997d3192f05a2174e2739`，线上只读验收通过。新增网页入口及网络信任边界见设计文档 §5；不取消 `/api/v1` 的 Bearer 鉴权。

以下为 **0.6.99** 已交付记录：Phase 1 和 Phase 2 已上线，构建、相关测试与线上只读验收通过。功能提交 `5f8a0ad`，部署脚本提交及本次部署源提交 `e9664ef9b57adbc5ac9ce231321e84156faa3c8d`。逐 token delta 和 Phase 3 未实施；真机、真实 HTTPS 与通知房回执的验收边界见下文。

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

## 0.6.99 当时的待验收项（历史记录）

- Safari / Android 真机：软键盘、安全区、滚动、切后台恢复与断网重连。现有 Chromium 手机视口测试使用模拟 API，不能替代真机。
- 真实 HTTPS 入口/反代：TLS、同源资源、SSE 不缓冲、网络中断和慢客户端场景。本次线上验证仅走 HAL 本机 HTTP；移动端输入操作 token 前应完成真实 HTTPS 验收。
- 通知房两条既定消息（`🟢 控制面已启动 · 版本 0.6.99`、`🔄 更新完成：hal · old → 0.6.99`）未取得可独立读取的房间回执；journal 已确认启动/注册，但不能据此声称两条通知已收到，需人工核对。
- 自动 post-deploy 续跑未触发：本次已通过用户恢复完成验证；是否另行调查续跑链路由人工确认，不属于本次代码收尾。

## 0.6.100：网页免 token 登录（已部署）

用户批准“网页免 token、API 保留鉴权”，并批准本次后端升级和指定脚本部署。前端自动连接 `/control/api/v1`；
服务端从现有 Control read/write 配置读取凭据并直接派发到原 handler，不把 token 返回浏览器，SSE 不缓冲。
新增 `apps/control-plane/src/web/api.ts`；修改 server 分流、前端 App/client/state、开发代理和说明文档；根版本升至
0.6.100。未修改原 `/api/v1` 的鉴权/业务 handler、SSE、审批规则、部署脚本或外部 Cloudflare 配置。

安全范围：网页入口只开放需要的 GET 和新建/发送/打断 POST；要求自定义头，检查同源 Origin/Fetch Metadata，不提供
CORS。配置缺少 write 时服务端和网页都只读，两个 Control token 均未配置时返回 503。可直达入口即被信任，
外网必须由 CF Access 覆盖整个 `/control/*`，源站直连应受网络限制；本次不会声称已验证外部 Access/TLS 配置。

本次部署通过原 `deploy/hal/deploy.sh` 执行；部署前提交已推送，checkout 干净。仅在调用时把已只读核对的
`CODEX_THREAD_ID` 作为 `AGENT_BRIDGE_SESSION_ID` 传入，使原脚本准确记录 intent；没有修改部署脚本、凭据或
续跑逻辑。本次自动 post-deploy turn 已收到，journal 也有 `Continued the deploying session after its deploy`。

部署前验证：`pnpm check`、`pnpm --filter @agent-bridge/control-center build` 通过；针对性回归 **39/39** 通过，
包含原 API/SSE、网页来源/白名单/只读/未配置场景和非安全 HTTP 390px Chromium 触摸操作。浏览器无需登录即可
进入与刷新，未发出 Authorization header；模拟 API 下新建、发送、追加与打断请求正常，待办/只读仍禁用写操作。
测试日志：本机忽略目录 `.runtime/control-center-access-validation.log`。

### 0.6.100 实际线上验证（2026-10-20 09:04–09:05 CST）

- 部署标记、验证时 HEAD 与 origin/main 均为 `c56127e6d81a0de80fc997d3192f05a2174e2739`。Control Plane / HAL Bridge
  均 active，启动时间 09:03:40 CST，PID 分别为 1444833 / 1444834。实际 API 中三个 HAL workers 均 online，
  报告 Bridge 版本 0.6.100；控制面从该部署根 package.json 读取版本。进程无独立 commit 字段，提交证据来自标记/源/启动记录。
- `/health` 200 `ok: true`；`/control/login`、真实详情深链均返回 200 HTML，入口与本地部署产物 hash 一致。
  CSP、Referrer-Policy no-referrer、nosniff、登录路径 no-store 继续正常。
- 网页 `/control/api/v1/access` 无 Bearer 返回 `{writable:true}`；snapshot 无 Bearer 返回 200，结构符合契约；
  活动 session 详情与尾页历史各 200。只发送 `X-Control-Center: 1`，没有向浏览器下发 Control token。
- 真实 390×844 Chromium：旧 `/control/login` 自动进入最近列表（50 行），刷新自动恢复，打开详情无登录表单；
  旧测试 fragment 被清除，所有 14 个网页 API 请求均为 GET 且没有 Authorization header，无 storage 内容、横向溢出或运行时异常。
  实际服务浏览器脚本还拦截并拒绝所有非 GET/HEAD 请求，未触发任何生产会话写入。
- 网页 API 缺少自定义头、foreign Origin、cross-site Fetch Metadata 均返回 403，无 CORS 授权；未知网页 API 404。
  缺失 JS、缺失 assets 和未知页面均真实 404。原 `/api/v1/snapshot` 无 token 401、内部读取获准 read token 时 200，
  原鉴权未放宽，凭据没有回显或传入命令参数。
- 网页活动 SSE 不带 Bearer，按 snapshot 水位收到 8 帧，同 session 过滤与游标推进通过；随后 Last-Event-ID 重连收到 11 帧，同 session 过滤、恢复边界与游标推进通过。
  SSE 200 `text/event-stream`，`retry:3000`、`X-Accel-Buffering:no`、`no-cache,no-transform` 正常，读后取消连接。
- 新 JS `/control/assets/index-Cfyx6qUa.js` SHA-256 为
  `55f38c8746246f72b186951363c360d041d38b893949a9f16566abf404bbc217`；CSS `/control/assets/index-DqENv0wY.css`
  SHA-256 为 `2845e62aa55645d488517b1d7cc1ea7c5192cca80123418f7bdaa774fc7299fc`。服务内容均与本地部署构建一致。

验证汇总及截图位于忽略目录 `.runtime/control-center-live/`，不提交产物或生产内容。此次 post-deploy 收尾仅修改文档并推送，
不再次构建、部署或重启；之后文档提交会令 Git HEAD 前移，运行部署提交仍为 c56127e。

### 当前尚需人工验收

- 真实公网 HTTPS / Cloudflare Access：确认覆盖整个 `/control/*`（包括网页 API 与 SSE）、反代保留 Host，且无法绕过 Access 直连源站。
  应用按用户方案信任网络入口，本次没有修改/验证外部 CF 或防火墙配置；不能把本机 HTTP 验证当作 Access 验收。
- Safari / Android 真机的软键盘、安全区、前后台/断网及慢网 SSE。当前有 Chromium 手机视口和实际服务只读证据，未进行真机/真实反代压力验收。
- 通知房 `🟢 控制面已启动 · 版本 0.6.100` 与 `🔄 更新完成：hal · 0.6.99 → 0.6.100` 未取得可独立读取的消息回执。
  服务启动、HAL 注册和自动 post-deploy 续跑均有证据，但不能代替两条房间消息的人工核对。
