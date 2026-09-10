# dsh-session-hub 评估：Bridge session 原生接入 DSH

状态：研究与设计结论；当前不实施生产路径重构

日期：2026-09-11

评估对象：`Asaiuta/dsh-session-hub@fef18684e2112c2546f6098fd8aaf6e289126b95`（v0.1.0）

目标客户端基线：`deepseek-harness@d347e70`（`dsh-v0.1.3-alpha.1`）

本仓库基线：`agent-bridge@dc234513a534d35c86c9b33ccbc24134276dc47f`

## 1. 一句话结论

**否，dsh-session-hub v0.1.0 的具体实现不是当前条件下更稳地达成“在 DSH 内管理 Bridge session、复用 DSH UI”的生产方案。**

它最值得借鉴的思想是“只接数据层，让 DSH 官方 session runtime 和 UI 拥有展示”；但它依赖旧 DSH 的完整私有/半公开 wire 面，并没有真正解除 DSH 版本耦合。目标客户端 `0.1.3-alpha.1` 已更换 Session API、传输与事件模型，而 Agent Bridge 也不是一台远端 DSH，无法像该项目一样原样转发官方 frame。现在照搬会把 `External*` UI shim 换成更大、更危险的 DSH wire/event shim。

因此，本卡按“有硬阻塞则停止，不硬重写生产路径”的分支执行。目标不变；推荐先推动 DSH 提供稳定的外部 session source/provider 扩展点，再让本插件实现 Bridge provider。这样才能同时得到官方树、官方会话区和真正可维护的版本边界。

## 2. 研究范围与方法

参考仓库克隆在 `/tmp/dsh-session-hub`，未向本仓库复制源码。审阅范围包括：

- README、CHANGELOG、package/build/TypeScript/Cordis 配置；
- Host 入口、Typert contract/runtime、Gateway、ServerRegistry/ServerLink；
- HTTP/WebSocket/SSE 通道、信任围栏、自环检测、SSH tunnel、model sync；
- Codex/Claude/opencode/Pi importer、history fold、promotion；
- Client mount、官方 runtime bridge、live state bus、设置页与样式；
- 手写 DSH stubs 和生成声明，用于核对其编译边界。

同时读取了本插件指定基线文件：

- `README.md`
- `src/client/session-store.ts`
- `src/client/sessions.tsx`
- `src/bridge-client.ts`
- `src/service.ts`

并以本机只读的 `deepseek-harness-research` tag `dsh-v0.1.3-alpha.1` 核对实际 Session Controller、Connection 和 Typert Gateway contract。

## 3. dsh-session-hub 实际方案

### 3.1 架构

它不是一个独立 session hub/chat view。除“设置 → 插件 → Session Hub”管理页外，它不画 session browser、conversation 或 composer。

核心由四层组成：

1. **ServerLink / Registry**
   - 每台远端 DSH 是一个 link；通过远端标准 `/api` 做 unary RPC，并订阅 `events.mux`、`events.host` WebSocket。
   - Link 缓存远端 session summaries、archived ids 和 pending approvals/questions。
   - Registry 持久化服务器配置，管理重连、SSH tunnel，并聚合 link snapshot。

2. **Host Gateway**
   - 在旧版 WebServer 上注册 17 条 exact route，抢在官方 `/api` prefix route 前处理：`session.list/history/prompt/...`、`workspace.list/...` 和 `respond`。
   - `session.list` 合并本地 DSH、远端 DSH 和 importer rows。
   - `workspace.list` 加入虚拟服务器 workspace，并把导入会话分配到真实或合成 workspace。
   - 其他调用按 session id ownership 路由：远端 session 交给所属 ServerLink，本地 session 委托官方 ApiProxy。

3. **实时 frame bridge**
   - Host 把远端的官方 mux/host frames 原样 fan-out 到本机 `/hub/events` SSE。
   - Client 把 `host/*` frame 注入官方 `sessions.handleHostEnvelope` 和 `workspaces.handleHostEnvelope`，其他 frame 注入 `sessions.handleMuxEnvelope`。
   - 因为 unary API 和 live frame 都保持 DSH 官方 wire shape，官方 session runtime 认为这些远端 session 就是普通 session。

4. **Importer**
   - 将 Codex CLI、Claude Code、opencode、Pi 历史解析成 DSH `SessionSummary` 和官方 fold 可读的 `user/message`、`assistant/chunk`、`tool/call`、`tool/result` events。
   - 导入 session 只读；首次发消息时创建真实 DSH session，再通过官方 session store append 历史完成 promotion。

### 3.2 数据流

冷启动和读取：

```text
DSH official UI
  -> official session/workspace client runtime
  -> /api/session.* or /api/workspace.*
  -> HubGateway exact route
  -> local official ApiProxy + remote DSH ServerLink + ImportStore
  -> merged official wire values
  -> official tree / conversation fold
```

实时更新：

```text
remote DSH events.mux / events.host WebSocket
  -> ServerLink
  -> HubEventBus
  -> same-origin /hub/events SSE
  -> startOfficialBridge
  -> official sessions/workspaces runtime
  -> official UI
```

写操作：

```text
official composer / approval card / workspace action
  -> intercepted official /api method
  -> ownership lookup by sessionId or rpcId
  -> owning remote DSH (or local official service)
```

### 3.3 UI 与状态管理

- Session 树、conversation、composer、tool cards、approval/question cards 全部是 DSH 官方 UI。
- 唯一自绘 UI 是设置页，用于服务器 CRUD、probe、import 和 model sync。
- Host 持有权威聚合状态；Client 只持有 SSE connection 状态和轻量 listener bus。
- 它不 shadow `sidebar.workspaces` 或 `conversation`，也不使用 `ExternalSessionBrowser`、`ExternalComposer`、`ExternalConversationSurface`。

### 3.4 它如何尝试规避 DSH UI 版本耦合

它通过两件事规避 React/UI export 变化：

- 把外部 session 投影到 DSH 原生 API 数据结构，而不是复刻或包装组件；
- 将远端 DSH 原生 frames 注入官方 runtime，让官方客户端自己 fold 和 render。

这个方向确实消除了 `External*` 组件重命名、props、CSS seat 和布局变化带来的维护工作。

## 4. 与当前插件的对比

| 维度 | 当前 dsh-agent-control | dsh-session-hub v0.1.0 |
| --- | --- | --- |
| Bridge 数据源 | Agent Bridge REST/SSE；Host 保管 token | 远端 DSH 官方 `/api` + WS；另有本地日志 importer |
| session 状态 | Client `SessionStore` 自己分页、去重、receipt/pending | Host Link/Registry 缓存，官方 Client runtime fold |
| session 树 | shadow `sidebar.workspaces`，合并 native/Bridge rows | Gateway 合并官方 session/workspace wire values |
| conversation | shadow `conversation`，自己投影 Bridge events | 官方 conversation 完整渲染 |
| composer | `ExternalComposer` + fallback | 官方 composer 原样工作 |
| approval/input | Bridge schema 的自绘/共享组件 adapter | 远端 DSH 官方 frames 原样进入官方 cards |
| DSH UI 耦合 | 高：组件 exports、props、slots、runtime casts、CSS | 低：只有设置 tab/基础 primitives |
| DSH wire 耦合 | 低：Bridge contract 自成体系 | 极高：完整 Session/Workspace/API/frame contract |
| 与 DSH 版本的真实边界 | UI minor release 可破坏 | wire/transport release 可破坏，且破坏面更大 |

## 5. 为什么不能直接采用

### 5.1 参考实现已经与目标 DSH 版本脱节

dsh-session-hub 的 README 明确写“实测 `@deepseek-ai/dsh@0.1.0-rc.6`”；其源码和 stubs 使用：

- `@deepseek-ai/dsh-host-apiproxy`
- `/api/session.list`、`/api/workspace.list` 等 dot endpoint
- `events.mux` / `events.host`
- Client `sessions.handleMuxEnvelope()` / `handleHostEnvelope()`

而 `dsh-v0.1.3-alpha.1` 已经是：

- `@deepseek-ai/dsh-api-session-controller`
- Typert Remote `session/list`、`session/page`、`session/follow`、`session/control`
- Connection 共享 `/api` RPC interceptor；HTTP 路径是 `/api/session/list` 一类 slash endpoint
- 多路 Remote stream 走 `/api/remote.mux`
- Client SessionManager/EventSource/SessionBinding 生命周期，不再是参考项目假设的旧 ApiProxy runtime

当前 DSH 自己的 Connection 测试甚至把旧 `/api/session.list` 作为“未认领路径”样例。参考实现的去耦只发生在 UI 层；其 wire adapter 已需要针对 `0.1.3-alpha.1` 重写。

### 5.2 Agent Bridge 不是远端 DSH，frame 不能原样转发

dsh-session-hub 能保持代码相对简单，关键前提是两端都是同协议 DSH：`SessionSummary`、history events、live frames、approval rpcId 和 prompt payload 都可原样透传。

Agent Bridge 使用自己的稳定 contract：

- session status 是 `active/waiting_for_approval/waiting_for_input/offline/...`；
- history 是 `message.completed`、`command.completed`、`file_change.completed`、`turn.*` 等 Bridge events；
- write 返回异步 `ActionReceipt`，并以 `expectedTurnId` 做并发保护；
- approvals/user-input 是可独立分页和结算的资源；
- stream 是带 opaque global cursor 的 `bridge.event` SSE。

要让 DSH 官方 runtime 接管，插件必须长期维护双向翻译：

- Bridge session → DSH `SessionSummary`/projection baseline；
- Bridge history/live event → 当前 DSH event fold；
- DSH prompt/cancel/model/attachment/queue → Bridge action + receipt；
- Bridge approvals/questions → DSH control stream + client response routing；
- Bridge snapshot/cursor/replay → DSH follow/control stream generation semantics。

这不再是“只搬数据”。它是一个完整的 DSH Session backend adapter，而 DSH 当前没有稳定的第三方 source 接口来承载它。

### 5.3 exact route 劫持不是稳定扩展点

参考实现依靠“exact route 优先于官方 prefix route”。这在旧 WebServer 可行，但存在结构性风险：

- 必须复制官方请求信任围栏和响应 envelope；
- 必须知道并接管所有 UI 会调用的方法，新增方法会漏路由；
- 必须能把本地请求委托回官方 business service；服务名/形状改变即破坏；
- 任何另一个 `/api` 聚合插件都会 route collision；
- 新 Typert Gateway 已把 API endpoint registry、codec、Remote stream 和 Context/lookup provider 组合成一个整体；从 HTTP exact route 外层绕过会丢失这些保证。

把这套逻辑移植到 Bridge 上，会比当前 UI shim 更难测试，也更容易在升级时出现数据损坏、重复提交或错误审批路由。

### 5.4 参考项目的“版本无关”没有被测试证明

参考项目没有 test script 或测试目录；`typecheck` 依赖仓库内手写 `stubs/@deepseek-ai/*`，peer dependency 多为 `*`。这能保证它对自己的 stubs 编译，但不能证明它对安装目标的实际 runtime contract 兼容。

CHANGELOG 也记录了多次 wire/runtime 假设导致的真机问题，例如 `host/session-status` 被送错 handler、projection baseline 缺少 `asOfSeq` 使整个列表不 settle、审批 resolved key 使用错误等。这些恰好说明 wire adapter 的维护成本和故障半径。

## 6. 值得借鉴的部分

以下原则应保留到下一版设计中：

1. **DSH 拥有 UI，插件只实现 session source。** 不再对外部 session 提供第二套 browser/conversation/composer。
2. **Bridge credential 和连接留在 Host。** 浏览器只访问同源 DSH API，不接触 Control Plane token/origin。
3. **一个 source of truth。** Bridge 仍是 Bridge session/action/pending 的权威；DSH runtime 只持投影和 UI 生命周期。
4. **snapshot + cursor + replay。** Bridge 的现有 REST/SSE contract 已具备正确的无竞态基线，应该由 provider 直接消费。
5. **显式 capability。** prompt、steer、interrupt、attachments、models、approval/input 根据 Bridge worker capability 暴露，不伪造 DSH 能力。
6. **管理 UI 与 session UI 分离。** Agent Control/Kanban overlay 可以保留；session 浏览和会话交互应归官方树与官方 conversation。
7. **冲突时原子降级。** provider 注册失败时保持 DSH 本地 session 正常，不留下半注册路径。

不应借鉴：旧 ApiProxy exact routes、手写 DSH stubs 作为兼容证明、直接调用 client runtime 的非扩展方法、把 Bridge events 强行伪造成某一版 DSH frames。

## 7. 推荐实现：DSH 外部 SessionSource 扩展点

### 7.1 必需的上游 contract

需要 DSH 提供一个公开、版本化、由 Session Controller 聚合的 provider registry。概念接口如下（字段名由 DSH 上游最终决定）：

```ts
interface ExternalSessionSource {
  readonly id: string
  list(signal: AbortSignal): Promise<ExternalSessionSummary[]>
  page(sessionId: string, cursor: unknown, signal: AbortSignal): Promise<ExternalSessionPage>
  follow(sessionId: string, cursor: unknown, signal: AbortSignal): AsyncIterable<ExternalSessionDelta>
  prompt(sessionId: string, request: ExternalPrompt, signal: AbortSignal): Promise<ExternalActionReceipt>
  cancel(sessionId: string, expectedTurnId: string | undefined, signal: AbortSignal): Promise<ExternalActionReceipt>
  respond(sessionId: string, pendingId: string, value: unknown, signal: AbortSignal): Promise<ExternalActionReceipt>
  models?(sessionId: string, signal: AbortSignal): Promise<ExternalModelCatalog>
  attachment?(sessionId: string, attachmentId: string, signal: AbortSignal): Promise<ExternalAttachment>
}
```

关键不在具体名称，而在 ownership：

- Provider 只表达稳定的业务语义和 opaque cursors；
- DSH Session Controller 负责把 provider data 转成当前版本的 list/page/follow/control wire；
- DSH Client runtime 和官方 UI 不知道 Bridge，也不需要插件注入 frame；
- DSH 升级 wire/event fold 时由 DSH 自己更新一次 adapter，第三方 provider contract 按 semver 保持。

还需要 workspace/project grouping metadata、capability negotiation、pending interaction identity、idempotency key/receipt 和 source-scoped session identity，避免本地 DSH id 与 Bridge id 冲突。

### 7.2 本插件届时的实现

在 DSH 有该扩展点后：

1. 新增 `BridgeSessionSource`，复用现有 `BridgeClient` 和 Agent Control Host service；
2. 把 `SessionStore` 的 snapshot/cursor/replay/receipt 逻辑移到 Host provider，或删除已由 DSH provider runtime 承担的部分；
3. 删除 `UnifiedSessions`、`BridgeSidebar`、`BridgeConversation`、`SessionComposer` 及 `External*` feature detection；
4. Footer 只保留 Agent Control/Kanban 管理入口；Bridge sessions 自动出现在官方树；
5. 由 provider contract tests 覆盖 list/history/live/prompt/cancel/pending/receipt/cursor-expiry；
6. 用 Bridge mock transport 做全套测试，不连接真实 ModelDeck、DSH generation 或用户 Kanban。

### 7.3 若上游暂时不提供扩展点

保持当前实现，不再扩大 UI shim：

- 冻结 `External*` 兼容范围在已验证版本；不为每个新 UI export 继续复制分支；
- 将所有 DSH client seam 集中到一个 adapter，并在不匹配时显式禁用 Bridge session surface，而不是静默 fallback；
- 保留 Bridge session 管理目标和现有功能，等待 provider contract 后一次性迁移；
- 可以制作只读 proof-of-concept 验证 provider shape，但不得用 exact route hijack 进入生产。

“让 Bridge 伪装成一台旧版远端 DSH，再套 dsh-session-hub”也不推荐：这只是把同一套 DSH wire 翻译挪到另一个进程，版本问题、审批语义和 action receipt 差异仍然存在。

## 8. 生产重构判定

本次判定为 **不实施**，原因是以下硬阻塞同时成立：

1. 参考实现所依赖的 DSH API/transport/runtime 在目标版本已经变更；
2. DSH 没有可由第三方注册的稳定 session source/backend contract；
3. Bridge 与 DSH 不是同协议端点，无法使用参考项目最关键的“原样转发”；
4. exact route + wire translation 会继续要求按 DSH 版本重写，违反本卡最核心的退出条件。

这不是否定“官方 UI + 数据层接入”方向；相反，结论是这个方向正确，但必须落在 DSH 正式 provider extension point 上，而不能再用另一种 interception shim 冒充稳定 API。

## 9. 后续准入条件

满足以下条件后再开启生产重构：

- DSH 发布或接受一个版本化 External SessionSource/SessionBackend 扩展点；
- contract 能表达 Bridge 的 async receipt、expected turn、pending approval/input 和 opaque cursor；
- 官方 Session Controller 明确负责 wire/event/UI adaptation；
- mock contract tests 在当前版和下一预览版 DSH 上通过，而无需修改本插件 source；
- 降级/卸载能原子撤销 provider，不影响本地 DSH sessions。

达到这些条件时，dsh-session-hub 的目标架构可以实现：Bridge sessions 进入 DSH 官方树、打开官方 conversation、使用官方 composer/approval UI，同时删除现有 `External*` 兼容层。
