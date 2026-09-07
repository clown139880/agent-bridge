# Agent Control API 契约（v1）

> 状态：**已随 Agent Bridge 0.5.0 发布并部署**；后续 0.5.x 保持本页 v1 兼容契约。
> 本文同时记录 Hermes Worker API；标为“现有”的行为已经过 `apps/control-plane/src/server.ts`、
> `packages/protocol/src/index.ts`、`packages/database/src/index.ts` 与 Hermes 集成交叉核对。

## 1. 范围与原则

Agent Bridge 是外部 Codex thread/session 的唯一真实状态来源。UI 展示和操控 Bridge session，不把它复制成
DSH 原生 Session。Hermes Kanban 仍是 task claim、lease、依赖、review 和完成状态的唯一真实来源；API 中的
`taskId` 只是关联标识，Bridge 不修改 Kanban。

本文使用三类标签：

- **现有**：0.4.2 已提供，必须保持兼容。
- **扩展**：保留现有路径和字段，建议只增加可选字段或查询能力。
- **新增**：相对发布版 0.4.2 新增、已在本卡工作树实现的契约。

除明确写为现有响应外，本文 JSON 和 TypeScript 定义描述已实现 v1。所有时间均为 Unix epoch 毫秒；所有 ID
均是不透明、区分大小写的字符串，客户端不得解析其格式。

## 2. 连接、鉴权与版本

- Control Plane origin 示例：`http://127.0.0.1:8787`。
- REST base URL：`{origin}/api/v1`。
- SSE URL：`{origin}/api/v1/stream`。
- 所有 `/api/v1/*` 请求，包括 SSE，都使用 `Authorization: Bearer <token>`。
- JSON 请求发送 `Content-Type: application/json`，响应发送 `application/json; charset=utf-8` 和
  `Cache-Control: no-store`。
- URI 中的 ID 必须按单个 path segment 做 percent encoding。
- 主版本在路径中。v1 内允许新增 endpoint、可选请求字段、响应字段和枚举值；删除/改义字段、改变必填性或
  幂等语义需要 `/api/v2`。客户端遇到未知响应字段和未知实时事件类型必须忽略；遇到未知状态应按 `unknown`
  展示。

当前工作树通过 `CONTROL_API_READ_TOKEN` 和 `CONTROL_API_WRITE_TOKEN` 提供 read/write 两档 scope：read token
只能调用 GET（含 SSE），write token 同时拥有读写权限。`WORKER_API_ENABLED=true` 与 `WORKER_API_TOKEN`
继续开启并认证 Hermes legacy Worker API；为保持 0.4.2 客户端兼容，该 token 也可通过共享 `/api/v1`
鉴权。生产应给 DSH Host 使用独立 Control token，而不是复用 Worker token。
DSH Host 插件保存 Control token 并代理请求/事件；浏览器 Client 不得读取 token，也不得直连 Control Plane。

## 3. Endpoint 总表

| 状态 | Method | Path | 用途 |
| --- | --- | --- | --- |
| 现有、扩展 | `GET` | `/workers` | 机器、在线状态、能力、最近 workspace |
| 新增 | `GET` | `/snapshot` | Workers/Sessions/待办的无竞态 UI 初始快照 |
| 新增 | `GET` | `/sessions` | 查询所有近期或活动 Codex sessions |
| 新增 | `POST` | `/sessions` | 创建 Codex session，可同时启动首个 turn |
| 新增 | `GET` | `/sessions/{sessionId}` | session 详情和关联关系 |
| 新增 | `GET` | `/sessions/{sessionId}/runs` | session 关联的 Worker runs |
| 新增 | `GET` | `/sessions/{sessionId}/events` | session 全量结构化事件/对话 |
| 新增 | `POST` | `/sessions/{sessionId}/turns` | 自动或显式 steer/start-new-turn |
| 新增 | `POST` | `/sessions/{sessionId}/interrupt` | interrupt 当前 turn |
| 新增 | `GET` | `/actions/{actionId}` | 查询异步写操作结果 |
| 新增 | `GET` | `/runs` | 按关联字段查询 runs |
| 现有、扩展 | `POST` | `/runs` | Hermes 创建幂等 Worker run |
| 现有、扩展 | `GET` | `/runs/{runId}` | Worker run 状态和待审批 |
| 现有 | `GET` | `/runs/{runId}/events` | run 隔离的生命周期事件 |
| 现有 | `POST` | `/runs/{runId}/input` | 兼容输入入口，Bridge 自动 steer/start |
| 现有 | `POST` | `/runs/{runId}/interrupt` | 中断 run 当前 turn |
| 现有 | `POST` | `/runs/{runId}/reclaim` | Hermes 回收特定陈旧 blocked run |
| 现有 | `POST` | `/runs/{runId}/approvals/{approvalId}` | Hermes 兼容审批入口 |
| 新增 | `GET` | `/approvals` | 查询 pending/resolved approvals |
| 新增 | `GET` | `/approvals/{approvalId}` | approval 详情 |
| 新增 | `POST` | `/approvals/{approvalId}/decision` | 原子提交 approval 决定 |
| 新增 | `GET` | `/user-input` | 查询 pending/resolved user-input requests |
| 新增 | `GET` | `/user-input/{requestId}` | 结构化问题详情 |
| 新增 | `POST` | `/user-input/{requestId}/response` | 原子提交结构化回答 |
| 新增 | `GET` | `/stream` | 可恢复的全局 SSE 实时流 |

`/health` 继续在 origin 根下且无需纳入此 UI 契约。Bridge 自身使用的 `/bridge` WebSocket 是内部协议，不对
UI 开放。

## 4. 通用 wire types（可复制）

以下代码块是前端 mock/type 的规范来源。字段后的 `?` 表示可省略；`null` 表示字段存在但当前没有值。

```ts
export type EpochMs = number;
export type Cursor = string; // opaque; never parse or increment

export type WorkerStatus = "online" | "offline";
export type AgentType = "codex-cli" | "codex-desktop" | "claude-code" | "opencode";
export type Capability =
  | "codex-cli" | "codex-app-server" | "codex-desktop-history"
  | "session-list" | "session-read" | "turn-steer" | "turn-interrupt"
  | "approvals" | "user-input" | "local-first" | "git"
  | (string & {});

export interface WorkspaceRef {
  path: string;
  name: string;
  lastUsedAt: EpochMs;
  sessionCount?: number;
}

export interface Worker {
  id: string;                 // `codex@${machineId}` for existing Codex workers
  machineId: string;
  name: string;
  status: WorkerStatus;
  platform: string;
  hostname: string;
  capabilities: Capability[];
  workspaces: string[];       // v1 legacy-compatible field
  recentWorkspaces: WorkspaceRef[];
  lastSeenAt: EpochMs;
  bridgeVersion: string | null;
  activeSessionCount: number;
}

export type SessionStatus =
  | "creating" | "active" | "waiting_for_approval" | "waiting_for_input"
  | "idle" | "offline" | "error" | "unknown";
export type TurnStatus = "in_progress" | "completed" | "failed" | "interrupted" | "unknown";

export interface RunLink {
  runId: string;
  taskId: string | null;
  conversationId: string | null;
  status: RunStatus;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface SessionSummary {
  sessionId: string;          // Bridge canonical ID; currently equals Codex native thread ID
  nativeSessionId: string;
  workerId: string;
  machineId: string;
  agent: AgentType;
  title: string | null;
  promptSummary: string | null;
  projectName: string;
  workspace: string;
  status: SessionStatus;
  activeTurnId: string | null;
  lastTurnStatus: TurnStatus | null;
  pendingApprovalCount: number;
  pendingUserInputCount: number;
  latestRun: RunLink | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface Session extends SessionSummary {
  capabilities: Capability[];
  runs: RunLink[];            // newest first; detail response may cap this list
  matrixRoomId: string | null;   // compatibility metadata, not a UI control channel
  matrixThreadId: string | null;
  error: ApiErrorBody | null;
}

// Existing names and values must remain valid for Hermes.
export type RunStatus =
  | "starting" | "update_waiting" | "update_required" | "update_failed"
  | "working" | "waiting" | "blocked" | "completed" | "failed"
  | "stopped" | "unknown";

export interface Run {
  runId: string;
  taskId: string | null;
  conversationId: string | null;
  workerId: string;
  machineId: string;
  agent: "codex-cli";
  workspace: string;
  sessionId: string | null;
  status: RunStatus;
  error: string | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  approvals?: Approval[];     // present on GET /runs/{id}; compatibility field
}

export type ApprovalKind = "command" | "file-change" | "permissions";
export type ApprovalChoice = "allow" | "deny" | "allow-session";
export type PendingResolutionStatus =
  | "pending" | "accepted" | "denied" | "resolved_elsewhere" | "expired";

export interface Approval {
  approvalId: string;
  sessionId: string;
  runId: string | null;
  turnId: string | null;
  workerId: string;
  kind: ApprovalKind;
  summary: string;
  choices: ApprovalChoice[];
  status: PendingResolutionStatus;
  decision: ApprovalChoice | null;
  requestedAt: EpochMs;
  resolvedAt: EpochMs | null;
}

export interface UserInputOption { label: string; description: string; }
export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
}
export interface UserInputRequest {
  requestId: string;
  sessionId: string;
  runId: string | null;
  turnId: string | null;
  workerId: string;
  questions: UserInputQuestion[];
  status: PendingResolutionStatus;
  answers: Record<string, { answers: string[] }> | null;
  requestedAt: EpochMs;
  resolvedAt: EpochMs | null;
}

export type SessionEventType =
  | "session.discovered" | "session.updated"
  | "turn.started" | "turn.completed" | "turn.failed" | "turn.interrupted"
  | "message.completed" | "command.completed" | "file_change.completed"
  | "progress" | "approval.requested" | "approval.resolved"
  | "user_input.requested" | "user_input.resolved" | "error";

export interface SessionEvent {
  cursor: Cursor;
  eventId: string;
  type: SessionEventType | (string & {});
  sessionId: string;
  runId: string | null;
  turnId: string | null;
  itemId: string | null;
  timestamp: EpochMs;
  payload: Record<string, unknown>; // type-specific; known payloads below
}

export interface MessageCompletedPayload {
  role: "user" | "assistant" | "system";
  text: string;
}
export interface TurnTerminalPayload {
  status: "completed" | "failed" | "interrupted";
  summary?: string;
  error?: string;
  durationMs?: number;
}
export interface CommandCompletedPayload {
  command: string;
  cwd?: string;
  status: string;
  exitCode: number | null;
  output?: string;
}
export interface FileChangeCompletedPayload { changes: unknown[]; summary?: string; }
export interface ApprovalEventPayload { approval: Approval; }
export interface UserInputEventPayload { request: UserInputRequest; }
export interface ProgressPayload { summary: string; }

// Optional stricter helper for reducers; unknown future events still fall back to SessionEvent.
export type KnownSessionEvent =
  | (SessionEvent & { type: "message.completed"; payload: MessageCompletedPayload })
  | (SessionEvent & { type: "turn.completed"|"turn.failed"|"turn.interrupted"; payload: TurnTerminalPayload })
  | (SessionEvent & { type: "command.completed"; payload: CommandCompletedPayload })
  | (SessionEvent & { type: "file_change.completed"; payload: FileChangeCompletedPayload })
  | (SessionEvent & { type: "approval.requested"|"approval.resolved"; payload: ApprovalEventPayload })
  | (SessionEvent & { type: "user_input.requested"|"user_input.resolved"; payload: UserInputEventPayload })
  | (SessionEvent & { type: "progress"; payload: ProgressPayload });

export type ActionKind = "create_session" | "submit_turn" | "interrupt_turn"
  | "resolve_approval" | "resolve_user_input";
export type ActionStatus = "accepted" | "succeeded" | "failed";
export interface ActionReceipt {
  actionId: string;
  kind: ActionKind;
  status: ActionStatus;
  sessionId: string | null;
  turnId: string | null;
  resolvedAction?: "steer" | "start_turn";
  error: ApiErrorBody | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface Page<T> {
  data: T[];
  nextCursor: Cursor | null;
  hasMore: boolean;
  streamCursor: Cursor;
}
export interface ApiErrorBody {
  error: {
    code: ErrorCode | (string & {});
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
    retryable: boolean;
  };
}
```

### 4.1 状态语义

状态是服务端投影，不是 UI 根据最后一条文本事件推导的结果：

| 类型/值 | 语义 |
| --- | --- |
| Worker `online` | Control Plane 当前持有该 machine 已注册且存活的 Bridge WebSocket |
| Worker `offline` | 没有当前连接；`lastSeenAt` 仍可用于显示最后在线时间 |
| Session `creating` | create action 已接受，真实 Codex thread ID 尚未确认 |
| Session `active` | 存在 active turn；普通发送会 steer |
| Session `waiting_for_approval` | turn 活跃但被至少一个 approval 阻塞；先处理 approval |
| Session `waiting_for_input` | turn 活跃但等待结构化回答；先处理 user input |
| Session `idle` | 没有 active turn，可 start new turn；上个 turn 完成不代表 session 不可续接 |
| Session `offline` | 所属 worker 离线，最后活动状态可能已经过期 |
| Session `error` | thread/App Server 报告 system error；详情的 `error` 给出原因 |
| Session `unknown` | inventory 尚未完成或上游无法判定，禁止有副作用的自动猜测 |
| Turn `in_progress` | turn 已开始且未收到 terminal result |
| Turn `completed/failed/interrupted` | 该 turn 的终态；不会自动封存 session |
| Pending `pending` | 可参与一次 compare-and-set resolution |
| Pending `accepted/denied` | Bridge 已接受相应决定 |
| Pending `resolved_elsewhere` | 本机 TUI 或另一个客户端先完成，具体 choice 可能未知 |
| Pending `expired` | 断线/重启后不能安全恢复，不可再提交 |
| Action `accepted` | Control Plane 已持久化并准备/正在发往 Bridge |
| Action `succeeded` | Bridge 确认 App Server 接受 RPC；不等于 turn 已完成 |
| Action `failed` | 此 action 不会继续；根据 `error.retryable` 决定是否用新 key 重试 |

`RunStatus` 保留现有语义：`starting` 是尚未绑定/启动完成；`update_waiting` 是等待 Bridge 升级；
`update_required/update_failed` 是升级 admission 未满足；`working` 正在执行；`waiting` 等待用户输入；
`blocked` 等待 approval 或有明确阻塞原因；`completed/failed/stopped` 是该 run 的终态；`unknown` 是无法判定。
run terminal 不会让其背后的 Codex session 不可续接。

`Worker.workspaces` 的长期目标形态是对象数组。为兼容当前 `GET /workers` 返回的 `string[]`，当前 v1
同时返回现有 `workspaces: string[]`，并把对象数组放入新增 `recentWorkspaces`；前端适配器优先读
`recentWorkspaces`，缺失时把字符串映射成 `WorkspaceRef`。待 v2 才可统一改名。

## 5. 列表、过滤、排序与游标

所有新增列表统一使用：

- `limit`：可选，默认 50，范围 1–200；超界返回 `400 invalid_parameter`。
- `cursor`：可选、不透明，绑定 endpoint、过滤器与排序；不能跨查询复用。
- 响应为 `Page<T>`。空页保留当前 `streamCursor`，`nextCursor=null`、`hasMore=false`。
- 游标分页是稳定 keyset pagination，不是 offset。结果发生并发新增时不会在同一遍历中重复；刷新应丢弃旧游标。
- 无特别说明时，字符串过滤精确匹配，可重复参数表示 OR，不同字段之间为 AND。
- 无效/被篡改游标返回 `400 invalid_cursor`；游标对应数据已超过保留期返回 `410 cursor_expired`。

`GET /sessions` 参数：

| 参数 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `status` | 可重复 `SessionStatus` | 全部 | OR 过滤 |
| `workerId` / `machineId` | string | 全部 | 两者同时给出时必须一致 |
| `agent` | 可重复 `AgentType` | 全部 | agent 类型 |
| `workspace` | string | 全部 | 规范化后的完整路径 |
| `taskId` | string | 全部 | 存在任一关联 run |
| `conversationId` | string | 全部 | 存在任一关联 run |
| `active` | boolean | 未指定 | true 包括 active/等待审批/等待输入 |
| `updatedAfter` | epoch ms | 未指定 | `updatedAt` 严格大于该值 |
| `q` | string | 未指定 | title、prompt summary、project name 的大小写不敏感包含匹配 |
| `sort` | `updatedAt`/`createdAt` | `updatedAt` | 排序键 |
| `order` | `desc`/`asc` | `desc` | 排序方向；以 `sessionId` 作稳定 tie-breaker |

`GET /runs` 支持 `status`、`workerId`、`machineId`、`sessionId`、`taskId`、`conversationId`、
`createdAfter`、`limit`、`cursor`，固定按 `createdAt desc, runId desc`。`GET /approvals` 和
`GET /user-input` 支持 `status`（默认 `pending`）、`sessionId`、`runId`、`workerId`、`limit`、`cursor`，
固定按 `requestedAt desc, ID desc`。

## 6. Endpoint 详细契约

### 6.1 Workers 与初始快照

#### `GET /workers`（现有、已加法扩展）

无参数。0.4.2 响应字段为 `workers[].{id,machineId,name,status,platform,hostname,capabilities,workspaces,
lastSeenAt}`，其中 `workspaces` 是路径字符串数组。当前工作树已加法增加 `recentWorkspaces`、
`bridgeVersion`、`activeSessionCount` 与顶层 `streamCursor`；status 由当前 WebSocket 是否存在判定：

```json
{
  "workers": [{
    "id": "codex@hal", "machineId": "hal", "name": "Codex @ HAL",
    "status": "online", "platform": "linux", "hostname": "hal.local",
    "capabilities": ["codex-cli", "codex-app-server", "turn-steer"],
    "workspaces": ["/work/agent-bridge"],
    "recentWorkspaces": [{"path":"/work/agent-bridge","name":"agent-bridge","lastUsedAt":1788770000000}],
    "lastSeenAt": 1788770000000, "bridgeVersion": "0.4.2", "activeSessionCount": 1
  }],
  "streamCursor": "g:1842"
}
```

#### `GET /snapshot`（新增）

用于 Host 打开 UI 时取得同一数据库读事务中的视图和水位，避免“先查列表、后接流”之间漏事件。
可选 `sessionLimit` 默认 100、最大 200。200：

```json
{
  "workers": [],
  "sessions": [],
  "approvals": [],
  "userInput": [],
  "streamCursor": "g:1842",
  "truncated": {"sessions": false}
}
```

快照只含 pending approvals/user input。若 sessions 被截断，UI 再从 `GET /sessions` 分页。建议首屏优先调用
此接口，不并行拼装多个可能不一致的列表。

### 6.2 Sessions

#### `GET /sessions`（新增）

使用第 5 节参数，200 返回 `Page<SessionSummary>`。

#### `POST /sessions`（新增）

创建新的 Codex thread。请求必须有 `Idempotency-Key`（1–128 个可打印 ASCII 字符，同一 token scope 内唯一）：

```ts
interface CreateSessionRequest {
  workerId: string;          // required; codex@machine
  workspace: string;         // required; Bridge 所见绝对路径
  input?: string;            // optional; 非空时创建后立即 start turn
}
```

成功通常返回 `202 ActionReceipt`。`sessionId` 在 Bridge 报告真实 thread 前为 `null`；客户端订阅
`action.updated` 或轮询 `/actions/{actionId}`。若在短等待窗口内已创建，可返回 `201`，body 仍为同一
`ActionReceipt` 且 `status=succeeded`。没有 `input` 时结果为 idle session。路径的存在性与 allowed-root 校验
只能由目标 Bridge 完成。

#### `GET /sessions/{sessionId}`（新增）

200 返回 `Session`。`runs` 最新在前，最多 20 条；更多通过子资源分页。未知 session 返回
`404 session_not_found`。

#### `GET /sessions/{sessionId}/runs`（新增）

参数 `limit`、`cursor`，200 返回 `Page<Run>`，按 `createdAt desc`。

#### `GET /sessions/{sessionId}/events`（新增）

参数：`after`（事件 Cursor，省略表示从保留窗口最早处）、`limit`（默认 100，最大 500）、可重复 `type`。
按事件因果落库顺序升序返回 `Page<SessionEvent>`。`nextCursor` 指向最后一条返回事件；无新事件时等于
请求的 `after`（首次空页可为 `null`），`hasMore` 表示当前页后仍有已落库事件。

这是 session 的跨 run 对话真相，必须包括 user/assistant 完整消息、turn 边界、工具摘要、approval 和 user
input；不得只返回当前 `AgentEvent` 的生命周期摘要。文本 delta 可用于 SSE 的临时体验，但持久 REST 默认只
提供 completed item，避免回放重复文本。secret user-input 的答案在任何事件和响应中都返回 `"[REDACTED]"`。

#### `POST /sessions/{sessionId}/turns`（新增）

请求必须带 `Idempotency-Key`：

```ts
interface SubmitTurnRequest {
  input: string; // required, non-empty
  delivery?: "auto" | "steer" | "start_turn"; // default auto
  expectedTurnId?: string; // recommended for steer, forbidden for known-idle start
}
```

服务端须在每 session 串行锁内，以 Bridge 返回的实时状态判定并执行：

| 当前状态 | `auto` | `steer` | `start_turn` |
| --- | --- | --- | --- |
| 有 active turn，ID 匹配 | `turn/steer` | `turn/steer` | 409 `turn_already_active` |
| 有 active turn，expected 不匹配 | 409 `turn_changed` | 409 `turn_changed` | 409 `turn_already_active` |
| idle | `turn/start` | 409 `no_active_turn` | `turn/start` |
| pending user input | 409 `user_input_pending` | 同左 | 同左 |
| pending approval | 409 `approval_pending` | 同左 | 同左 |
| worker offline/状态未知 | 409 `worker_offline` / 503 `session_state_unavailable` | 同左 | 同左 |

202 返回 `ActionReceipt`。若短等待窗口内 Bridge 已确认 App Server 接受 RPC，回执为 `status=succeeded` 并填入
`resolvedAction: "steer" | "start_turn"`；否则为 `status=accepted`、暂不填该字段，最终结果通过 action 查询或
SSE 补齐。`turnId` 对 steer 是当前 ID，对 start 可在 `turn/started` 后补齐。成功只表示相应 RPC 被接受，
不表示 turn 已完成。此接口不创建 Worker run、不修改 Hermes task。UI 在 active turn 中可显示“追加指令”，
idle 时显示“开始新 turn”；仍建议传 `delivery=auto` 和当前 `expectedTurnId` 防止状态翻转。

#### `POST /sessions/{sessionId}/interrupt`（新增）

请求必须带 `Idempotency-Key`：

```ts
interface InterruptRequest { expectedTurnId?: string; }
```

有 active turn 且期望 ID 匹配时调用 `turn/interrupt`，202 返回 `ActionReceipt`。idle 返回 409
`no_active_turn`；ID 已变返回 409 `turn_changed`。重复相同 key 返回原回执，不重复 interrupt。

### 6.3 Actions

#### `GET /actions/{actionId}`（新增）

200 返回 `ActionReceipt`。action 至少保留 24 小时；过期后返回 404 `action_not_found`。失败 action 的 HTTP
查询仍为 200，失败细节在 `status=failed` 和 `error` 中；只有提交动作时可同步判定的校验/冲突使用 4xx。

### 6.4 Runs（Hermes 兼容边界）

#### `POST /runs`（现有，保持）

```ts
interface CreateRunRequest {
  runId?: string;            // optional; omitted => server UUID
  taskId?: string;
  conversationId?: string;
  workerId?: string;         // required in documented API; codex@machine
  machineId?: string;        // legacy alternative; if both, must agree
  projectPath: string;       // required
  prompt: string;            // required
  resumeSessionId?: string;
  allow_stale_version?: boolean;
}
```

首次接受返回 202 `Run`；同一 `runId`、machine、projectPath、taskId、conversationId 重试返回 200 原 run。
当前代码**没有比较重试 prompt、resumeSessionId 或 allow_stale_version**；本次为兼容性保留该行为，尚未
新增差异审计告警。关键字段不一致返回 409 `run_id_conflict`。显式 `resumeSessionId` 优先，否则按相同
conversation+machine+workspace 的最近 run 自动续接；Hermes legacy task fallback 继续保留。

#### `GET /runs`（新增）与 `GET /runs/{runId}`（现有、扩展）

列表见第 5 节。详情 200 返回 `Run`，并继续包含 0.4.2 形态的 `approvals`：
`approvalId/kind/summary/choices`。统一状态字段通过新增 `/approvals*` 读取，旧对象未删除或改义。

#### 既有 run actions（现有、保持）

- `GET /runs/{runId}/events?after=<integer>&limit=1..500` 返回
  `{runId, events: Array<{sequence:number,event:LegacyAgentEvent}>, next:number}`。这里继续使用数字游标，且只读
  该 run 关联的事件，不能改成新 opaque cursor。
- `POST /runs/{runId}/input` body `{text:string}`：202 `{runId,accepted:true}`。现状在 Bridge 收到后才按有无
  active turn 选择 steer/start，HTTP 响应不能证明具体动作；为兼容 Hermes 保留。
- `POST /runs/{runId}/interrupt` body 可为空：202 `{runId,accepted:true}`。
- `POST /runs/{runId}/reclaim`：只有 blocked、无 error、无 pending approval、且至少 5 分钟未更新才成功；
  200 返回 `Run`，否则 409 `run_not_reclaimable`。
- `POST /runs/{runId}/approvals/{approvalId}` body `{choice:ApprovalChoice}`：202
  `{runId,approvalId,accepted:true}`。保留给 Hermes approval relay。

### 6.5 Approvals

#### `GET /approvals`、`GET /approvals/{approvalId}`（新增）

列表规则见第 5 节。详情返回 `Approval`。默认列表只含 pending；历史 resolution 至少保留 7 天。命令输出和
summary 必须经过现有敏感信息清理策略，不向 Client 暴露 Host token 或环境 secret。

#### `POST /approvals/{approvalId}/decision`（新增）

要求 `Idempotency-Key`，body：

```ts
interface ApprovalDecisionRequest { choice: ApprovalChoice; }
```

只有 `status=pending` 且 choice 在 `choices` 中才向 Bridge 提交。202 返回 `ActionReceipt`。同 key 重试返回
原结果；不同 key 竞争同一 approval，首个成功者获胜，其余返回 409 `approval_already_resolved`，details 含
最新 `status/resolvedAt`，但不保证披露其他主体选择的敏感决定。若本机 TUI 先处理，状态为
`resolved_elsewhere`。

### 6.6 User input

#### `GET /user-input`、`GET /user-input/{requestId}`（新增）

返回 `UserInputRequest`。问题完整保留 App Server 的 `id/header/question/isOther/isSecret/options`。pending
request 必须在 Bridge 重连后通过状态快照重新对账；无法恢复的旧请求变为 `expired`，不能继续显示可提交。

#### `POST /user-input/{requestId}/response`（新增）

要求 `Idempotency-Key`，body：

```ts
interface UserInputResponseRequest {
  answers: Record<string, { answers: string[] }>;
}
```

每个 question ID 必须恰好出现一次；非 `isOther` 选项题的答案必须来自 label；空自由文本无效。202 返回
`ActionReceipt`。竞争、已本地处理和过期语义与 approval 相同，对应错误为
`user_input_already_resolved`。首版对任一 `isSecret=true` 问题固定返回 409
`secret_input_unsupported` 并要求在本机处理；secret answer 不进入数据库、日志、SSE 或 action。

## 7. SSE 实时协议

### 7.1 首版选择

首版选择 **SSE**，而不是新增面向 UI 的 WebSocket：控制写入已经由 REST 表达，实时方向主要是服务端到
客户端；SSE 具有 HTTP 代理友好、文本可观测、`Last-Event-ID` 原生重连和较小实现面。现有 `/bridge`
WebSocket 继续只承担机器双向协议。未来只有在需要高频双向 token streaming 时再评估 UI WebSocket。

DSH Host 使用可设置 Authorization header 的 fetch/HTTP client 连接 SSE，再通过插件 Host/Client 通道发布
给浏览器。浏览器原生 `EventSource` 不应通过 query token 绕过 header 限制。

### 7.2 建连与补读

1. Host 调用 `GET /snapshot`，渲染数据并取得 `streamCursor=C`。
2. Host 连接 `GET /stream?cursor=<C>`，header 带 Bearer 和 `Accept: text/event-stream`。
3. 重连时优先发送 `Last-Event-ID: <last fully applied cursor>`；若同时有 query cursor，header 优先。
4. Server 每 15 秒发送 `: keepalive\n\n`，并建议 `retry: 3000`。这些 comment 不推进 cursor。
5. Server 先补发 cursor 之后的持久事件，再发送 live event，二者使用同一全局顺序。
6. cursor 过期时在建立流前返回 HTTP 410 `cursor_expired`；Host 丢弃局部缓存、重新 snapshot。

响应头还应含 `Content-Type: text/event-stream`、`Cache-Control: no-cache, no-transform`、
`X-Accel-Buffering: no`。一次连接只保证至少一次投递；客户端必须按 `eventId` 去重并按 cursor 顺序应用。

### 7.3 Envelope

每帧事件名固定为 `bridge.event`，SSE `id` 等于 envelope cursor：

```text
id: g:1843
event: bridge.event
data: {"cursor":"g:1843","eventId":"01J...","type":"session.updated","timestamp":1788770000123,"resource":{"kind":"session","id":"thr_123"},"sessionId":"thr_123","data":{"status":"active","activeTurnId":"turn_9"}}

```

```ts
export type StreamEventType =
  | "worker.upserted" | "worker.offline"
  | "session.upserted" | "session.updated" | "session.event.appended"
  | "run.upserted" | "approval.upserted" | "user_input.upserted"
  | "action.updated" | (string & {});
export interface StreamEnvelope<T = unknown> {
  cursor: Cursor;
  eventId: string;
  type: StreamEventType;
  timestamp: EpochMs;
  resource: { kind: "worker"|"session"|"run"|"approval"|"user_input"|"action"; id: string };
  sessionId: string | null;
  data: T; // upsert 事件为完整 resource；updated 可为字段 patch
}
```

客户端只有在事务性应用完整 envelope 后才保存 cursor。`session.event.appended.data` 是完整
`SessionEvent`。数据库提交后才能广播，禁止广播无法通过 REST 补读的“幽灵状态”。短暂 message delta 如不
持久化，必须使用独立 `session.message.delta` 类型并声明 `ephemeral:true`；首版建议不提供。

## 8. HTTP 状态与稳定错误码

成功：200 查询/幂等旧结果，201 快速创建完成，202 异步动作已接受，204（当前契约不使用）。错误 envelope
统一为 `ApiErrorBody`；现有 run API 在迁移期仍可能返回 `{error:"code", ...}`，不得突然改变 Hermes 解析行为。

| HTTP | code | 含义/重试 |
| --- | --- | --- |
| 400 | `invalid_json`, `invalid_parameter`, `invalid_cursor`, `invalid_worker_id`, `invalid_choice` | 修正请求 |
| 400 | `idempotency_key_required`, `idempotency_key_reused` | 缺 key，或同 key 配了不同 method/path/body |
| 401 | `unauthorized` | token 缺失/错误 |
| 403 | `forbidden` | token scope 不足 |
| 404 | `not_found`, `worker_not_found`, `session_not_found`, `run_not_found`, `approval_not_found`, `user_input_not_found`, `action_not_found` | 资源不存在 |
| 409 | `worker_offline` | 等待 worker 在线后重试 |
| 409 | `capability_unavailable` | 老 Bridge/App Server 不支持该可靠操作；升级或使用 legacy 入口 |
| 409 | `run_id_conflict`, `resume_session_conflict`, `resume_session_busy`, `run_not_attached`, `run_not_reclaimable` | 现有 run 冲突 |
| 409 | `turn_already_active`, `no_active_turn`, `turn_changed` | 刷新 session 后决定动作 |
| 409 | `approval_pending`, `approval_already_resolved`, `user_input_pending`, `user_input_already_resolved` | 先处理待办或刷新 |
| 409 | `secret_input_unsupported` | 转本机安全入口 |
| 410 | `cursor_expired` | 丢弃增量 cursor，重新 snapshot |
| 413 | `body_too_large` | body 上限 1 MiB |
| 415 | `unsupported_media_type` | 使用 JSON |
| 429 | `rate_limited` | 按 `Retry-After` 重试 |
| 500 | `internal_error` | 可退避重试；携带 requestId 报障 |
| 502 | `bridge_protocol_error`, `app_server_error` | 上游拒绝/异常，视 retryable |
| 503 | `bridge_unavailable`, `session_state_unavailable` | 退避或等待 stream 更新 |

错误 `message` 给人阅读，逻辑只能依赖 `code`；`details` 不得包含 token、secret answer 或未清理环境变量。

## 9. 幂等与并发

- 所有新增 POST 要求 `Idempotency-Key`。Control Plane 持久保存 key、token principal、method、规范化 path、
  request body hash 和最终 ActionReceipt 至少 24 小时。
- 同 principal + key + 相同请求返回同 HTTP 语义和同 `actionId`；key 用于不同请求返回 400
  `idempotency_key_reused`。网络超时后应原 key 重试。
- 每个 session 的 `create/submit/interrupt/approval/user-input` 在 Control Plane 与 Bridge 两端按 actionId
  串行去重。HTTP 预检查不是锁；App Server RPC 前必须再次检查 activeTurnId/requestId。
- 一个 session 同时只允许一个 active turn。多个客户端同时 `auto` 提交时，第一个可能 start，第二个只在
  读取到同一个 active turn 后 steer；若调用者给了旧 `expectedTurnId`，第二个必须冲突而非误投。
- approval/user-input 是 compare-and-set：只有 pending 可变为 resolved。Control UI、Hermes relay 和本机 TUI
  地位相同，先完成者获胜。
- SSE 与 REST 都是至少一次观察语义；`eventId` 唯一，Bridge upstream event ID 用
  `(machineId, nativeSessionId, upstreamEventId)` 去重。

## 10. 完整 UI 调用示例

以下流程覆盖“打开 Sessions 页 → 继续对话 → 输入/审批 → 完成”。为简洁省略 Host 到浏览器的内部 IPC；
所有 HTTP 均由 DSH Host 发出。

1. Host 请求快照：

   ```http
   GET /api/v1/snapshot?sessionLimit=100
   Authorization: Bearer ***
   ```

   返回 sessions、workers、pending queues 和 `streamCursor: "g:200"`。Client 以 `sessionId` 作行 key。

2. Host 从 `g:200` 接 SSE；用户打开 session 后补读对话：

   ```http
   GET /api/v1/sessions/thr_123
   GET /api/v1/sessions/thr_123/events?limit=100
   ```

   UI 将 `message.completed` 按 turn 渲染，并把最后页 `nextCursor` 保存为 session 局部 cursor。

3. 详情显示 `status=idle`。用户发送“请运行完整测试”，Host 生成 key：

   ```http
   POST /api/v1/sessions/thr_123/turns
   Idempotency-Key: ui-01J-turn-1
   Content-Type: application/json

   {"input":"请运行完整测试","delivery":"auto"}
   ```

   返回 202 ActionReceipt，`resolvedAction="start_turn"`。随后 SSE 依次出现 `action.updated`、
   `session.updated(active)`、`session.event.appended(turn.started)`。

4. Codex 请求结构化补充信息。SSE 收到完整 `user_input.upserted(status=pending)`；UI 也可用
   `GET /user-input?sessionId=thr_123` 恢复。用户提交：

   ```http
   POST /api/v1/user-input/in_7/response
   Idempotency-Key: ui-01J-input-7

   {"answers":{"mode":{"answers":["Safe"]},"note":{"answers":["保持兼容"]}}}
   ```

5. turn 继续后请求命令审批。UI 只渲染 `choices` 中提供的按钮：

   ```http
   POST /api/v1/approvals/ap_9/decision
   Idempotency-Key: ui-01J-approval-9

   {"choice":"allow"}
   ```

   若 Hermes relay 已抢先处理，返回 409 `approval_already_resolved`；UI 将响应 details 或下一条 SSE 作为
   最新状态，不重复提交。

6. 用户在 turn 尚 active 时追加“也检查 lint”：

   ```http
   POST /api/v1/sessions/thr_123/turns
   Idempotency-Key: ui-01J-turn-2

   {"input":"也检查 lint","delivery":"auto","expectedTurnId":"turn_44"}
   ```

   返回 `resolvedAction="steer"`。若 turn 恰好已结束，则返回 409 `turn_changed`；UI 刷新详情，让用户确认
   是否以新 turn 发送，避免意外改变语义。

7. `turn.completed` 和 assistant `message.completed` 通过 SSE 到达。Host 断线重连时带最后应用的
   `Last-Event-ID`；若收到 410，重新执行步骤 1。session 回到 `idle`，但关联 Hermes run（若有）的 task
   生命周期仍由 Hermes supervisor 决定。

## 11. OpenAPI 与 mock 建议

实现时建议维护 OpenAPI 3.1 文件，以本文 types 作为 component schemas：所有对象声明
`additionalProperties: false` 仅用于请求，响应保持可扩展；discriminator 使用事件 `type`。SSE 在 OpenAPI 中
可声明 `text/event-stream` 并引用 `StreamEnvelope`，但重连语义仍以本文为准。

UI mock 应至少模拟：worker 离线、空列表、100+ session 游标、active↔idle 翻转、approval 与 user-input
竞争解决、steer 的 `turn_changed`、重复 SSE、cursor expired 和 action 异步失败。不要把示例 ID、当前
`sessionId===nativeSessionId` 或 `codex@` 以外的未来 agent 限制固化进组件。

## 12. 实现说明与已知降级

本次实现通过 version 1/2 事务迁移扩展 0.4.2 schema；旧 `events.id`、Worker runs 和 Hermes 数字 cursor 保留。
结构化 session events、pending requests、actions、idempotency keys 与 SSE outbox 已落库。默认保留期分别为
30 天、7 天和 24 小时，并可由环境变量配置。

实现与理想上游能力之间有以下明确降级：

1. Bridge 优先分页调用 `thread/list` 并为第一页补读最近 50 turns；App Server 不支持时回退
   `thread/loaded/list(limit=100)`，session 标记 `historyCompleteness=loaded-only`。
2. Codex Desktop 仍通过 rollout scanner 只提供 terminal-only 历史；不会声称完整对话。
3. command output 截断至 64 KiB，file changes 最多保留 200 项；首版没有 blob endpoint。
4. `isSecret=true` 的 user input 固定返回 `409 secret_input_unsupported`，只能在本机回答。
5. Control Plane 首版明确为单实例。Bridge 将 action 结果以 0600 文件持久化；若进程在 RPC 期间崩溃，
   同 actionId 安全返回 `action_outcome_unknown`，不会盲目重复有副作用的 RPC。
