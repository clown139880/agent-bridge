# Control Center 移动端实施记录

版本：根 `package.json` **0.6.99**。Phase 1 和 Phase 2 已实现、构建与相关测试通过；部署尚未执行，等待对部署脚本例外的明确确认。逐 token delta 和 Phase 3 未实施。

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

## 需要人工确认：部署准备

用户明确将“改 deploy”和 `git reset --hard` 列为例外，所以未修改或运行 `deploy/hal/deploy.sh`。现有脚本只构建 `tsc -b`，构建失败分支又会调用被禁止的 reset；不能用隐藏构建钩子或别的部署入口绕过此限制。

待确认的具体最小调整如下：

```diff
 build() {
   # 原依赖安装逻辑保留
   pnpm exec tsc -b --pretty false
+  pnpm --filter @agent-bridge/control-center build
 }

 if ! build "$previous" "$target"; then
-  log "build of $target failed; restoring $previous"
-  git reset --hard --quiet "$previous"
-  build "$target" "$previous" || log "rebuild of $previous failed too"
+  log "build of $target failed; checkout and build output retained for investigation"
   die "deploy aborted; services were not restarted"
 fi
```

批准后还应让 `tsc` 的失败明确传播（`pnpm exec tsc -b --pretty false || return $?`），避免增加下一条命令后掩盖其失败。失败时不重置 Git、不恢复构建产物、不重启；保留现场由人工检查。其他部署行为保持原样。

脚本原本还会写仓库外的 `/run/lock/agent-bridge-deploy.lock`、`/var/lib/agent-bridge` 部署标记和 post-deploy intent；必要时安装 systemd unit 或 abctl 链接。用户也把仓库外写入列为例外，执行前需确认这些脚本固有写入在本次授权中允许。不会手动编辑密钥或生产数据库，不使用其他重启入口。

## 部署后待完成

获准并推送脚本变更后，从干净 main 调用 `deploy/hal/deploy.sh --note ...`；由 post-deploy turn 完成：

1. 核对实际运行的 Control Plane / HAL Bridge 版本和提交，检查两条既定启动/更新通知。
2. 对实际服务检查 `/health`、`/control/login`、页面深链、CSP/Referrer-Policy、资源 URL 与源构建 hash、缺失资源和未知 API 的真实 404。
3. 用已有获准凭据只读验证 snapshot/活动详情 SSE；凭据不打印、不放命令参数。不通过对生产 turn 发消息或 interrupt 来做部署冒烟。
4. 记录真实部署结果和未完成的真机/HTTPS 验收，再报告上线。提交、push、干净 worktree 或本地浏览器成功均不等于已部署。
