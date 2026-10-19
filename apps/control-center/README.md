# Control Center

移动端 React + Vite + Tailwind 网页，由 Control Plane 在同源 `/control/` 托管。仅调用已有 `/api/v1`，不需要 DSH 或 MCP 浏览器客户端。

## 开发与构建

在仓库根目录：

```sh
pnpm install --frozen-lockfile
pnpm dev:control-center
pnpm check
pnpm build:control
```

Vite 开发代理默认转发 `/api/v1` 到 `127.0.0.1:8787`，不包含 token。生产资源在本包 `dist/`，已由根 `.gitignore` 的 `dist/` 规则排除；Hono 从模块位置定位资源，不依赖 cwd。HAL 的正式构建步骤必须同时生成前端资源。

## 使用

入口 `/control/login`。输入已有 Control read/write token；选择“启用操作”才显示写入口。此选项不证明 scope，后端仍校验每次请求。凭据仅在页面内存，刷新/关闭后重新登录；生产应通过同源 HTTPS 入口访问。

- 最近会话：按更新时间降序，搜索与 Worker 筛选通过搜索按钮提交，游标加载更多。
- 详情：尾页历史、加载更早、工具按需展开、待办只读；正文安全地按纯文本呈现，不执行消息中的 HTML。历史覆盖范围取自服务端。
- 活动详情：共享 fetch SSE，已应用 cursor 续接、断线退避、前后台暂停。仅显示已完成消息/事件，不包含 token delta。idle 页面只按进入、前台恢复或手动刷新更新。
- 发送：idle 使用 `start_turn`，active 使用 `steer + expectedTurnId`。打断也绑定 expectedTurnId，冲突后刷新并由用户重新决策。
- 新建：在线 Worker、目标机器绝对目录、可选首条消息；跟踪异步 action，成功后打开实际 session。
- 结果未知：点击“原请求重试”沿用相同 Idempotency-Key 和请求体；accepted 可手动“查询结果”，不固定轮询。关闭/刷新会丢失内存中的 action 跟踪，不能据此自动重发。

无 Service Worker、后台推送、持久凭据或独立常驻网页服务。SSE 代理须禁用 buffering，读超时应长于 keepalive。

## 验证

```sh
node --conditions=source --import tsx --test tests/control-center.test.ts tests/agent-control-api.test.ts
node --conditions=source --import tsx tests/control-center-browser.test.ts
```

浏览器测试需要先构建及本机 Chromium，缺少条件时跳过；只使用模拟 API 和仓库 `.runtime/tests/` 下的 profile/截图。它覆盖 390px 手机视口的登录、列表/历史分页、SSE、追加、打断、新建和刷新后退出。运行时需允许本机随机端口和浏览器子进程。完整设计和分期见 [设计文档](../../docs/control-center-mobile.md)。
