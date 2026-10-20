# Control Center

移动端 React + Vite + Tailwind 网页，由 Control Plane 在同源 `/control/` 托管。通过同源 `/control/api/v1` 入口复用已有 API，不需要 DSH 或 MCP 浏览器客户端。

## 开发与构建

在仓库根目录：

```sh
pnpm install --frozen-lockfile
pnpm dev:control-center
pnpm check
pnpm build:control
```

Vite 开发代理默认转发 `/control/api/v1` 到 `127.0.0.1:8787`，不包含 token。生产资源在本包 `dist/`，已由根 `.gitignore` 的 `dist/` 规则排除；Hono 从模块位置定位资源，不依赖 cwd。HAL 的正式构建步骤必须同时生成前端资源。

## 使用

入口 `/control/`，直接进入会话列表；旧 `/control/login` 地址也直接进入，不再输入 token。内网依赖网络访问边界，外网由现有 Cloudflare Access 保护整个 `/control/*`（包括 API 与 SSE）。浏览器不持有 Control token，服务器使用现有 `CONTROL_API_WRITE_TOKEN`，仅配置 read token 时网页自动只读；两者均无则返回 503，不回退使用 Bridge/legacy token。刷新会重新连接，无需登录。

`/api/v1/*` 仍要求 Bearer，不改变 MCP/CLI/DSH 鉴权。网页入口仅允许所需 GET（含 worker 模型目录），以及新建、提交 turn、interrupt、图片上传、审批决策和回答问题这些 POST，不开放删除。所有网页 API 请求包含 `X-Control-Center: 1`；拒绝跨源 Origin/Fetch Metadata，不授予 CORS，反代必须保留原 Host。Cloudflare 身份 cookie 由浏览器随同源请求携带，服务端不签发新的登录 cookie，也不把 token 发回网页。

此模式不在应用里验证 CF JWT，不根据可伪造的 CF/X-Forwarded-* 头提权：能直达网页入口即被视为操作者。公网不能绕过 Access 直连源站端口；该网络限制及 Cloudflare 配置由现有部署负责，本次未修改。

- 最近会话：按更新时间降序，搜索与 Worker 筛选通过搜索按钮提交，游标加载更多。
- 详情：尾页历史、加载更早、工具按需展开；审批可允许/拒绝/本会话始终允许（后者放行整个工具，需二次确认），结构化问题可选项或填写，保密问题仍需本机回答。
- 输入：可选或粘贴图片（PNG/JPEG/WebP/GIF，单张 15 MB，最多 8 张），先上传为引用、随消息发送；新建或开始 turn 时可选模型与思考程度，运行中追加指令不能切换。
- 正文安全地按纯文本呈现，不执行消息中的 HTML。历史覆盖范围取自服务端。
- 活动详情：共享 fetch SSE，已应用 cursor 续接、断线退避、前后台暂停。仅显示已完成消息/事件，不包含 token delta。idle 页面只按进入、前台恢复或手动刷新更新。
- 发送：idle 使用 `start_turn`，active 使用 `steer + expectedTurnId`。打断也绑定 expectedTurnId，冲突后刷新并由用户重新决策。
- 新建：在线 Worker、目标机器绝对目录、可选首条消息；跟踪异步 action，成功后打开实际 session。
- 结果未知：点击“原请求重试”沿用相同 Idempotency-Key 和请求体；accepted 可手动“查询结果”，不固定轮询。关闭/刷新会丢失内存中的 action 跟踪，不能据此自动重发。

无 Service Worker、后台推送、前端持久凭据或独立常驻网页服务。SSE 代理须禁用 buffering，读超时应长于 keepalive。

## 验证

```sh
node --conditions=source --import tsx --test tests/control-center.test.ts tests/agent-control-api.test.ts
node --conditions=source --import tsx tests/control-center-browser.test.ts
```

浏览器测试需要先构建及本机 Chromium，缺少条件时跳过；只使用模拟 API 和仓库 `.runtime/tests/` 下的 profile/截图。它覆盖 390px 手机视口的免登录进入、列表/历史分页、SSE、发送/追加、打断、新建和刷新自动连接；同时覆盖只读配置与待办阻塞。运行时需允许本机随机端口和浏览器子进程。完整设计和分期见 [设计文档](../../docs/control-center-mobile.md)。
