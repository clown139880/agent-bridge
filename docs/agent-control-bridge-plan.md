# Agent Control UI：Bridge 改造实施计划与首版记录

> 状态：**首版已在当前工作树实施并验证，尚未发布/部署**。基线与仓库版本仍为 `0.4.2`，本卡没有
> bump 版本或触发 fleet 更新。权威 wire 契约见 [agent-control-api.md](./agent-control-api.md)。

实现覆盖 Phase 1–3 及 Phase 4 的兼容性首版：versioned SQLite migration、session/pending/action/outbox
投影、Bridge inventory 与 action ack、REST/SSE、read/write token 和 legacy Hermes 回归。Matrix 与 legacy
run 写入口仍保留 0.4.2 的同步响应语义，没有伪装成新的 ActionReceipt；Phase 5 生产灰度留给独立发布卡。

## 1. 结论摘要

建议在现有 Control Plane 上增加同一 `/api/v1` 下的 session-oriented API，而不是另建 session 服务：

- Bridge/Codex App Server 继续是外部 session 的真实状态源；SQLite 保存可查询投影、结构化历史和幂等记录。
- Hermes 继续调用现有 `/workers` 和 `/runs*`；新 UI 调用 `/snapshot`、`/sessions*`、统一 pending queues 和 SSE。
- Control Plane 对外使用 REST 写操作 + SSE 读更新；Bridge 与 Control Plane 之间继续使用现有 WebSocket。
- session 的“发送”由服务端在串行锁中判定：active turn 用 `turn/steer`，idle 用 `turn/start`；审批和
  user-input pending 时拒绝普通发送，避免把回答投成新消息。
- 所有新 POST 使用持久化 `Idempotency-Key` 和 action receipt。无需 Redis/Kafka；SQLite WAL + transactional
  outbox 足够支撑首版单 Control Plane 进程。
- DSH Host 插件持有 token、连接 REST/SSE，并通过 Host/Client RPC 转发；浏览器不接触 Bridge token。

## 2. 0.4.2 基线事实

本节保留实施前对发布版 0.4.2 的调查，作为 gap analysis 的比较基线；不描述当前工作树。当前工作树的
落地结果见第 12 节和 API 契约的“实现说明”。

### 2.1 Control Plane HTTP 与路由

`apps/control-plane/src/server.ts` 在一个类中同时处理 HTTP、Bridge WebSocket、Matrix、run admission、状态投影
和内存 pending state。`WORKER_API_ENABLED` 默认关闭，开启后所有 `/api/v1/*` 只做完整字符串 Bearer token
比较。0.4.2 已实现：

- `GET /api/v1/workers`：数据库机器加内存 WebSocket 在线状态，最近 workspace 从 sessions 聚合。
- `POST /api/v1/runs`：创建/幂等重放 Worker run，支持显式 session 或 conversation 自动续接。
- `GET /api/v1/runs/:id` 与 `/events?after=N`。
- run input、interrupt、stale blocked reclaim 和 approval response。

没有 sessions 列表/detail HTTP、runs 列表、全局实时流、通用 approval 列表或 user-input API。HTTP JSON parser
上限 1 MiB，但解析/验证错误目前会落为 500；错误响应多为 `{error:string}`，尚无统一 request ID。

### 2.2 Bridge protocol 与在线状态

`packages/protocol/src/index.ts` 定义 Bridge 注册、15 秒 heartbeat、session discovery、精简 AgentEvent、approval、
input/stop/log 和自更新消息。Bridge 注册能力当前固定为
`codex-cli/codex-app-server/local-first/git`；没有协议版本协商、inventory 分页、action acknowledgement、
结构化 user-input 或完整事件 item。

Control Plane 以 45 秒未 touch 标记数据库 machine offline；`GET /workers` 更直接以进程内 WebSocket map 判定。
heartbeat 可携带 active/waiting/blocked session IDs，但 Control Plane 只对有关联非终态 Worker run 的 session
做修复；没有 run 的外部 session 活动状态并未完整投影。

### 2.3 Codex App Server adapter

`apps/bridge/src/app-server.ts` 已经具备目标 API 所需的重要底层原语：

- `thread/start`、`thread/resume`、`thread/read(includeTurns)`；启动时只恢复
  `thread/loaded/list(limit=100)`。
- 有 active turn 时 `input()` 调 `turn/steer(expectedTurnId)`，否则调 `turn/start`。
- `turn/interrupt` 使用 adapter 内存中的 active turn ID。
- 接收 completed agent message、command/file-change 摘要、turn terminal notification。
- 接收 command/file/permissions approval，并把 Codex 的实际 decision variant 映射成三种稳定 choice。
- 接收结构化 `item/tool/requestUserInput`，但仅保存在 Bridge 内存中，向上只发 `agent.waiting` 文本；普通
  `agent_input` 会解析 Matrix 文本并回答。

active turn、pending approval、pending input、logs、已上报 turn ID 都是进程内 Map/Set。App Server 断连时
pending input/approval 被清空；Control Plane 断连但 Bridge/App Server 未断时它们仍存在，却没有注册后全量
重播机制。

### 2.4 Desktop session scanner

`apps/bridge/src/desktop-sessions.ts` 只读 `CODEX_HOME/sessions` 下由 `Codex Desktop` 创建的 rollout：最多枚举
最近 500 文件，每文件最多尾读 8 MiB。它识别 session metadata、active turn、最后 assistant 文本和
complete/abort，只在新 terminal turn 时发 discovery + terminal summary。它不是完整 Desktop 对话索引；首次
默认 baseline 现存文件而不回放。Desktop active turn 会阻止 Bridge 接管，但此状态没有作为完整 session
inventory 上报。

### 2.5 数据库

`packages/database/src/index.ts` 使用 Node SQLite、WAL 和内联 `CREATE/ALTER` 迁移：

- `machines`：identity、platform/hostname、status、JSON capabilities、last seen。
- `sessions`：machine/agent/project、Matrix/native ID、单一 AgentStatus、timestamps；没有 title、prompt、
  active turn、last turn、error。
- `worker_runs`：task/conversation/machine/project/session、AgentStatus/error/timestamps；一个 session 可顺序关联
  多个 run。
- `events`：全局自增 ID、session、可选 upstream event ID/run ID、type、整个精简 AgentEvent JSON；以
  `(session_id,event_id)` 去重。

Store 只提供最近 20 sessions、单 run/最近关联 run、数字游标事件读取；没有通用 filter/keyset pagination。
approval 在 Control Plane 内存，不持久化；user input 从未到达 Control Plane。

### 2.6 Hermes 兼容使用面

`integrations/hermes_agent_bridge/worker_api.py` 只调用现有 workers/runs endpoints。supervisor 用稳定
`hermes-{board}-{task}-{claimRun}` run ID，轮询 run 和数字事件 cursor，保持 Kanban lease，并只在 Bridge
terminal 后调用 Hermes DB 完成/review/block。approval relay 扫描 running 卡片的 run detail 并提交旧 run
approval endpoint。

因此以下是强兼容约束：旧路径、字段名、数字 `after/next`、run status 值、202/200 幂等语义和 approvals
内嵌数组不可移除或改义。新 UI 不应调用 Hermes DB；Bridge 也不应根据 UI session 状态推进卡片。

## 3. Gap analysis

| 目标 | 当前能力 | 缺口 | 建议 |
| --- | --- | --- | --- |
| 机器/在线/能力/workspace | `/workers` 基本具备 | 无 bridge version、活动数、workspace 时间；能力太粗 | 加法扩展字段与明确 feature capability |
| 所有近期/活动 sessions | 仅已 loaded、主动启动或 Desktop terminal discovery | 不是完整可分页 inventory；无 HTTP 查询 | Bridge 分页枚举 + Control Plane session 投影 + `/sessions` |
| session metadata/关联 | DB 有基础字段，能找最新 run | title/prompt/turn、全部 runs 缺失 | 扩 session 列；runs 子资源 |
| 结构化事件/对话 | 只有精简 AgentEvent；run-scoped 数字游标 | user message、turn/item ID、工具细节和跨 run 历史缺失 | 规范化 SessionEvent；历史 backfill + live ingestion |
| 创建/继续 | run 或 Matrix 能 start/resume | UI 无 session-oriented 幂等接口；创建异步无 ack | `/sessions` + actions；`/sessions/:id/turns` |
| steer vs new turn | adapter 内部已有自动分支 | Control Plane 不知道实际分支，存在状态竞态 | protocol 带 actionId/expectedTurnId 和明确 result |
| interrupt | run endpoint + activeTurn Map | session endpoint、预条件、ack 缺失 | session interrupt + turn CAS |
| approvals | Bridge/Control 都有内存 Map，Hermes 可处理 | 无全局列表/历史；重连可丢；无原子多客户端语义 | pending_requests 持久投影 + Bridge snapshot + CAS action |
| user input | adapter 会解析 Matrix 文本 | protocol/API/持久投影完全缺失；secret 风险 | 结构化 request/response；secret 不持久化 |
| 实时更新 | 无 UI stream，Hermes 轮询 | 无快照水位、补读或去重 | SQLite outbox + SSE + `/snapshot` |
| Hermes 兼容 | 当前测试覆盖主流程 | 大重构容易改变错误/游标/状态 | legacy route facade + contract regression tests |

## 4. 目标职责边界

### 4.1 Control Plane

负责：

- Bearer authentication/authorization、参数校验、速率/大小限制、稳定 HTTP 错误。
- 全局 worker/session/run/pending/action 可查询投影及 keyset pagination。
- 新写操作的幂等记录、每 session 串行化、状态 precondition 与路由。
- 将 Bridge ack/result 绑定 action，事务性写数据库/outbox，提供 SSE snapshot cursor 和补读。
- 保持 Worker run 与 session 的关联；只暴露 `taskId/conversationId`，绝不操作 Kanban 状态机。
- 对敏感字段做 redaction；secret answer 只在内存中短暂中转。

不负责：推测 App Server 未报告的活跃 turn、校验远端路径、直接读取远端 rollout、代替 Hermes claim/review。

### 4.2 Bridge protocol

负责可靠表达“机器上现在有什么”和“一个命令实际发生了什么”：

- 注册时协商 `protocolVersion`、feature capabilities 和 adapter/version 信息。
- 可分页 session inventory、完整单 session snapshot、pending request snapshot。
- 带稳定 upstream ID 的 session/turn/item/pending 增量事件。
- command 使用 `actionId`、可选 `expectedTurnId`；result 明确 `steer/start_turn`、真实 session/turn ID 或稳定错误。
- Control 重连时重放 snapshot；重复 actionId 不重复执行。

协议仍是单机 Bridge 到 Control Plane 的认证 WebSocket，不作为公共 UI API。不要把 REST/SSE envelope 原样硬绑
到 Codex JSON-RPC；protocol 包应是稳定的 Bridge domain model。

### 4.3 Codex App Server adapter

负责：

- 适配实验性 Codex RPC 的字段/方法变化，规范化 thread、turn、item、approval/user-input。
- 在本机 allowed roots 内解析/校验 workspace。
- 维护与 App Server 同步的 live state，并在一个 thread 内原子选择 steer/start/interrupt。
- 枚举近期 thread，按需 `thread/read(includeTurns=true)` 获取历史，并以 upstream ID 去重。
- 保留 Codex 原生 approval decision 映射；向 Control 层只暴露稳定 choice。
- Desktop rollout 作为能力受限的数据源，明确只读、历史/实时完整度。

adapter 不负责 HTTP 鉴权、Kanban、跨机器排序、全局 cursor 或 UI 模型。

### 4.4 DSH Host / Client

DSH Host 插件是安全代理与本地缓存层：从 Host secret store/环境读取 Control token；设置 Authorization；调用
REST、维护唯一 SSE 连接、按 eventId 去重和 cursor 重连；通过 typed Host/Client RPC 把必要数据推给浏览器。
浏览器 Client 只调用 Host 暴露的 `snapshot/list/get/mutate/subscribe` 能力，永不取得 token、Control origin 或
Bridge `/bridge` socket。

建议 Host 对写操作生成 UUID/ULID `Idempotency-Key`，将 actionId 回传 Client；不要用 DSH 原生 Session 表复制
外部 Codex session。若 DSH 需要导航对象，仅保存短期 `{bridgeOrigin, sessionId}` 引用。

## 5. 建议模块与具体文件

### 5.1 Control Plane

- `apps/control-plane/src/server.ts`：保留 server/bootstrap 和 legacy facade；将新增路由从该 1083 行类拆出，
  避免继续增加 Matrix/HTTP/WS 交叉状态。
- 新增 `apps/control-plane/src/api/router.ts`：method/path 分发、body/query validation、错误 envelope。
- 新增 `apps/control-plane/src/api/schemas.ts`：请求 DTO、枚举与 runtime validators（可先手写，无需引入重框架）。
- 新增 `apps/control-plane/src/api/session-service.ts`：session locks、action/idempotency、steer/start 判定。
- 新增 `apps/control-plane/src/api/stream.ts`：snapshot 水位、SSE replay/live、keepalive/backpressure。
- 新增 `apps/control-plane/src/bridge-registry.ts`：在线连接、capability、request/ack correlation、超时和重连。
- 新增 `apps/control-plane/src/projections.ts`：protocol event → SQLite + outbox 的单事务投影。
- `apps/control-plane/src/config.ts`：新增 UI/control token/scopes、SSE retention/keepalive/action timeout；旧 Worker
  env 行为不变。
- Matrix handler 后续也调用 session-service，而不是直接 send WebSocket，使 Matrix/UI/Hermes 共享并发规则。

具体文件名可调整，但边界应保留；不建议首版引入 Express/Nest、消息队列或独立微服务。

### 5.2 Shared protocol

- `packages/protocol/src/index.ts`：保留现有 union members，新增 `protocolVersion/features`、inventory/snapshot、
  normalized session events、structured pending request 和 action command/result。旧 Bridge 的 optional heartbeat
  继续可解析。
- 建议拆分为 `packages/protocol/src/{legacy,session-events,commands,index}.ts`，由 index 重新导出，避免单文件膨胀。
- parse 后必须做按 message type 的 runtime 校验；当前 `parseMessage` 只验证 object + string type，不足以作为
  不可信跨机边界。

### 5.3 Bridge / adapter

- `apps/bridge/src/client.ts`：注册 feature/version；registered 后发送 inventory/pending snapshot；维护 actionId
  result cache；处理新的 create/submit/interrupt/resolve messages。
- `apps/bridge/src/app-server.ts`：公开 `listSessions/readSession/submitTurn/interrupt/respondUserInput/snapshotState`；
  把当前 `input()` 分支改成返回 resolved action + turn ID；上报 user message、assistant item、turn/item IDs 和
  structured requests；限制历史读取并分页。
- `apps/bridge/src/desktop-sessions.ts`：增加 inventory metadata 与明确 source completeness；除非确认性能和格式
  稳定，不在首版承诺所有 Desktop 历史 item。
- `apps/bridge/src/config.ts`：inventory 时间窗/页大小、历史事件大小限制、action dedupe TTL。

### 5.4 Database

- `packages/database/src/index.ts`：先添加 versioned migration runner；随后把 query/mutation 分到
  `migrations.ts`、`sessions.ts`、`pending.ts`、`actions.ts`、`stream.ts`。现有 Store method 和测试 import 暂时
  保留 facade。
- 新增 OpenAPI（建议 `docs/openapi/agent-control-v1.yaml`）可在 API 稳定实现阶段生成/校验；本卡不生成一个
  可能误导为已上线的机器契约。

### 5.5 Tests

- 扩 `tests/worker-api.test.ts` 为 legacy contract regression，冻结已用字段、status、HTTP 码和数字 cursor。
- 新增 `tests/session-api.test.ts`、`tests/session-pagination.test.ts`、`tests/sse.test.ts`、
  `tests/idempotency.test.ts`、`tests/pending-requests.test.ts`、`tests/protocol-compat.test.ts`。
- 扩 `tests/app-server-resume.test.ts` 与 `tests/user-input.test.ts` 覆盖 steer/start race、structured answers、
  reconnect snapshot。
- 扩 `tests/desktop-sessions.test.ts` 覆盖 inventory 上限、active 接管冲突和 capability 降级。

## 6. 数据库 schema 与迁移策略

### 6.1 是否需要扩展

**需要。** 当前 schema 无法可靠回答 title/turn/pending/history/action/SSE，也无法在 Control Plane 重启后保留
审批展示和幂等写入。建议最小扩展如下（列名为建议，不是已存在事实）：

1. `schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`。
2. `machines` 增加 `bridge_version`、`protocol_version`、`features_json`、`connected_at`；数据库 status 仍是投影，
   在线最终以 registry lease 判定。
3. `sessions` 增加 `title`、`prompt_summary`、`source`、`activity_status`、`active_turn_id`、
   `last_turn_status`、`last_error`、`inventory_seen_at`。保留旧 `status`，迁移期双写映射，避免旧查询失效。
4. 扩 `events`（或新建 `session_events`）存 `event_id/session_id/worker_run_id/turn_id/item_id/type/payload/
   created_at`。现有 `events.id` 是全局自增且 legacy run cursor 正依赖它，最安全方案是保留表与 ID，做加列；
   legacy payload 继续能 decode，new reader 按 schema version normalize。
5. `pending_requests(id, kind, session_id, worker_run_id, turn_id, machine_id, status, request_json,
   decision_json, requested_at, resolved_at, upstream_request_id)`，kind 为 approval/user_input。secret answer 不写
   `decision_json`；request question 本身也需按敏感等级 redaction。
6. `actions(id, principal, kind, session_id, turn_id, status, resolved_action, result_json, error_json,
   created_at, updated_at, expires_at)`。
7. `idempotency_keys(principal, key, method, path, request_hash, action_id, created_at, expires_at)`，
   `(principal,key)` unique。
8. `stream_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id UNIQUE, type, resource_kind,
   resource_id, session_id, payload, created_at)`，作为 transactional outbox/replay log。

recent workspaces 仍可由 sessions 的 `(machine_id, project_path, max(updated_at))` 派生，先加组合索引，无需新表。
推荐索引：sessions `(updated_at,id)`、`(machine_id,activity_status,updated_at)`；runs
`(session_id,created_at,id)`、task/conversation 查询索引；events `(session_id,id)`；pending
`(status,requested_at,id)`；stream `(created_at,sequence)`。

### 6.2 为什么单独 stream outbox

当前 `events.id` 只覆盖 AgentEvent，机器上线、session metadata、run、pending 和 action 更新都没有序号。SSE
必须有跨资源的单调补读 cursor。`stream_events` 在更新业务表的同一 SQLite transaction 内插入，然后仅在
commit 后通知内存订阅者，可避免 DB 已变但无流事件、或流先发而 DB 回滚。它不是 Kafka：单实例 SQLite
表、定时批量删除即可。

### 6.3 迁移步骤

1. 先备份 SQLite 并记录 `PRAGMA user_version`/schema hash；新增 migration runner，但不改变旧表语义。
2. 事务内做只加列/建新表/建索引。SQLite 不支持的 constraint 变更用新表-copy-rename，并在测试副本验证。
3. 新 nullable 列上线后由新事件逐步填充；后台分批 backfill title/status，而非启动时长事务扫描所有历史。
4. API reader 先支持旧 row（null → unknown），writer 双写旧 `status` 与新 `activity_status`。
5. 两个发布周期确认所有 Bridge 升级后才考虑停止双写；v1 不删除旧列、旧 events 或数字 ID。
6. migration 必须幂等、每版本一次、失败整事务回滚；启动失败时旧二进制和原 DB 仍可恢复。生产 smoke 包含
   从真实 0.4.2 DB 副本升级和旧 Hermes supervisor 连续运行。

SQLite WAL 允许当前规模下的读流并发；SSE 不持有长读事务。snapshot 只做短读事务取资源和 stream 最大
sequence。当前实现按已确认默认值保留 outbox 7 天、session events 30 天、action/idempotency 24 小时，
并全部通过环境变量配置。

## 7. 协议与状态设计要点

### 7.1 Inventory 与 discovery

Bridge 注册后发送一个带 generation ID 的 inventory：分页枚举目标时间窗内 Codex threads，随后 complete
marker。Control Plane upsert，不因某一页缺失立即删除 session；只有 generation 完成后才把长期未见且机器在线
的 session 标为 unknown/offline。live discovery 与 inventory 可交错，按 upstream updatedAt + generation 合并。

首版应优先使用 App Server 官方 thread list/read API；`thread/loaded/list` 只能作为能力降级。需要在目标
Codex 版本上确认分页方法和字段。Desktop scanner 上报 `source=desktop_rollout` 与
`historyCompleteness=terminal_only`，UI 可提示历史有限。

### 7.2 状态分层

不要继续让一个 AgentStatus 同时表示 thread activity、turn terminal 和 run admission：

- session activity：creating/active/waiting_for_approval/waiting_for_input/idle/offline/error/unknown。
- last turn：in_progress/completed/failed/interrupted/unknown。
- Worker run：完整保留现有 11 个 `RunStatus`。

兼容映射只用于旧字段：active→working，waiting_for_input→waiting，waiting_for_approval→blocked，idle 且
last completed→completed（但新 session API 始终把 resumable thread 表为 idle）。断线时不要把 active 误报为
idle；先 offline/unknown，inventory 对账后再确定。

### 7.3 Action command/result

每条新 protocol command 含 `actionId/sessionId/expectedTurnId`；Bridge 缓存 action result 至少 24 小时，重复
actionId 直接重发。adapter 在 thread-local mutex 内读取当前 live state并执行 RPC，返回：accepted operation、
真实 thread/turn ID、resolvedAction 或稳定 domain error。Control Plane 超时把 action 标为 failed/retryable，
不得假定 WebSocket `send()` 等于 App Server 接受。

session create 的真实 thread ID 异步产生：Control Plane 先落 action/idempotency，再发送；discovery/result 将
action 绑定 session。Control 重启后根据 pending action 重发相同 actionId。不要使用临时 runId 冒充 sessionId。

### 7.4 Pending requests

Bridge 对 Control Plane 重连时发送所有尚在其 adapter Map 中的 approval/user-input snapshot；Control Plane
以 `(machineId, upstreamRequestId)` upsert 并将 snapshot 中消失的旧 pending 标为 resolved_elsewhere/expired。
正常 `serverRequest/resolved` 也发 resolved event。Control Plane、Bridge 各自做 compare-and-set，解决 UI、
Hermes relay、本机 TUI 竞争。

Bridge **进程**重启或 App Server 连接重建后能否恢复 server request 取决于上游 Codex API。实施前必须验证：
若不能列出 pending requests，则旧项只能安全过期并要求本机重试，不能凭数据库 request ID 盲目回答。

## 8. 分阶段实施、验收与测试

### Phase 0：契约冻结与上游探针

工作：评审 API 文档；用固定 Codex 版本探测 thread list/read、turn IDs、历史 item IDs、pending request 重连；
记录 fixture，不改生产路径。

验收：待确认项有明确结论；UI Agent 能由 TypeScript interfaces 生成 mock；旧 Worker API golden fixtures 建立。

测试：协议 fixture decode、App Server 探针 smoke、现有 `pnpm check/test/build`。

### Phase 1：数据库与只读投影

工作：versioned migrations、session metadata/status、normalized events、pending/actions/outbox；Bridge inventory 和
structured event 上报；Control Plane projections。暂不开放写 UI API。

验收：重启 Control Plane 后 sessions/history/pending 仍可查询；Bridge 重连 inventory 无重复；0.4.2 Bridge
仍能注册且 legacy run 正常。

测试：0.4.2 DB fixture migration、重复/out-of-order events、inventory generation、断线重连、10k session
pagination query plan。

### Phase 2：只读 REST、snapshot 与 SSE

工作：workers additive fields、sessions/detail/events/runs/pending lists、snapshot 水位、outbox SSE replay。

验收：UI 可完整实现 Workers、Sessions、Session Detail 和 pending 页面；snapshot→SSE 压测无漏事件；重连
重复可由 eventId 去重；cursor 过期返回 410。

测试：route/schema contract、filter/keyset、事务竞态、SSE keepalive/backpressure/replay、慢消费者断开、鉴权。

### Phase 3：session 写操作

工作：idempotency/actions、create/resume、submit auto/steer/start、interrupt、approval/user-input resolve；Bridge
action result cache 和 thread mutex。

验收：网络超时重试不重复建 thread/turn/decision；active↔idle 竞态返回明确结果；三个审批客户端竞争只有
一个获胜；worker offline/action timeout 能恢复或明确失败。

测试：并发 barrier 测试、expectedTurnId CAS、Control/Bridge 各自在 RPC 前后重启、secret redaction、路径越界。

### Phase 4：共享入口与兼容强化

工作：Matrix 与 legacy run handler 复用 session-service/bridge-registry 的可靠 ack，同时由 legacy facade 保持
外部响应；Hermes 插件只在需要时消费 additive 字段，不强制升级。

验收：现有 Hermes supervisor/approval relay 无修改可跑完整 claim→approval→complete；Matrix 行为不回归；
UI 与 Hermes 同时观察/处理同一 session 符合 CAS 规则。

测试：端到端双客户端、旧 Python client contract、reclaim 5 分钟规则、conversation resume、self-update busy
admission（active/pending 均阻止更新）。

### Phase 5：生产灰度

工作：先 Control Plane（能接旧协议），再逐台 Bridge；观察 migration、inventory 大小、outbox、SSE clients 和
action latency。版本/发布按 README 的独立发布流程执行，不属于本卡。

验收：至少一次 Control Plane 重启、Bridge 断网重连、DSH Host 重连和 Hermes 长 run；可用旧 UI/Worker API
回退。清理策略只在观测保留期满足后启用。

## 9. 兼容、安全与可靠性风险

| 风险 | 后果 | 缓解/测试 |
| --- | --- | --- |
| 改动 legacy run response/cursor | Hermes supervisor 卡死或误完成 | 单独 facade；golden contract；不改数字 cursor |
| session status 混用 | idle thread 被当完成或 active 被并发 resume | 三层状态；thread mutex；expectedTurnId |
| WS send 无业务 ack | UI 显示成功但 App Server 未执行 | action.result + timeout/retry + Bridge dedupe |
| Control/Bridge 断线漏事件 | UI 永久陈旧 | inventory/pending snapshot；upstream ID；SSE outbox |
| 至少一次产生重复 | 重复消息/审批/turn | eventId/actionId/idempotency key 唯一约束 |
| approval 多入口竞争 | 二次回答或误报 working | pending CAS；resolved_elsewhere；刷新最新状态 |
| user input 被普通 steer 吞掉 | 回答含义错误 | pending 时普通 turns 409；专用 response endpoint |
| secret answer 落库/日志 | 凭据泄露 | 内存中转+redaction tests；不满足则禁用远程 secret |
| 浏览器获得 bearer | token 被扩展/XSS 窃取 | DSH Host secret；Client RPC allowlist；不使用 query token |
| allowed-root 绕过 | 操作非授权目录 | Bridge realpath 最终校验；拒绝 symlink escape；不信 Control |
| SSE 慢消费者 | 内存增长/拖垮服务 | bounded queue、断开并用 cursor 重连、压测 |
| outbox/event 无限增长 | SQLite 膨胀 | 分表保留、批删/checkpoint、指标和磁盘告警 |
| Desktop 历史不完整 | UI 看似丢对话 | capability/completeness 标记；不伪装为完整 App Server session |
| Codex 实验 API 漂移 | approval/turn schema 失效 | adapter fixture、版本 capability、升级前 smoke |
| 单 token 权限过大 | UI 可控制所有机器 | 独立 scoped token；后续 machine/root claims；审计 principal |
| Control Plane 多实例 | SQLite/内存 registry 分裂 | 首版明确单 active instance；不要假装支持 HA |

所有可执行内容（command/output/diff/title）按不可信文本处理；DSH Client 必须转义渲染，禁止把 agent Markdown
直接作为可信 HTML。CORS 对 Host-native client不是安全边界；Control Plane 默认仍应仅监听内网/VPN，TLS 在
反向代理或 Host 到 Control 间终止。

## 10. UI 并行工作与依赖

可以立即并行：

- 根据 API 文档生成 TS types、mock server 和 fixture。
- Workers/Sessions list、filters、Session Detail timeline、approval/user-input cards、offline/error/empty states。
- Host/Client RPC facade、Host secret 配置界面、SSE reducer（用 mock 重复/乱序/410）。
- action optimistic/pending UI；但最终状态只以 action/SSE 为准。

必须等待后端 Phase 0/1 确认或完成：

- 真实 Codex history 的 payload 细节和 Desktop completeness 标记。
- active turn steer/new-turn 的 end-to-end ack 与 expectedTurnId。
- pending request 重连恢复能力，尤其 Bridge/App Server 进程重启。
- secret user input 是否开放。
- 大 command output/file diff 的最终截断/下载策略。

集成关键路径：先交付只读 REST + SSE，UI 即可替换 mock；写操作逐个 feature flag 开启。Host 应按
`capabilities` 隐藏不可用按钮，而不是用版本号猜功能。

## 11. 可观测性与运维验收

新增结构化指标/日志但不记录敏感正文：HTTP requestId、principal/scope、route/status/latency；Bridge
protocol/version、inventory generation/count/duration；action queue/ack latency/result；SSE connection/replay
count/lag/slow disconnect；outbox oldest cursor/rows/bytes；pending age；migration version/duration。

建议健康检查拆分：现有 `/health` 保持轻量；另在内部 readiness 中验证 DB 可写、migration current、Bridge
registry 状态，但“没有在线 Bridge”不应使 Control Plane 自身 unready。action 和 approval 审计记录 ID、主体、
机器/session、choice、时间和结果，不记录 token、secret answer 或未清理完整环境。

## 12. 已落地决定与后续边界

- Control Plane 首版单实例；token 为 read/write 两档，旧 Worker token 保持 Hermes 权限。
- session events/SSE outbox/action 默认保留 30 天/7 天/24 小时，均由环境变量配置。
- secret user input 不允许远程提交；command output 64 KiB、file changes 200 项有界截断。
- UI 可创建无首条 input 的 idle session；所有新 POST 使用持久化 idempotency + ActionReceipt。
- Bridge action result cache 跨进程保留；RPC 中途崩溃返回 outcome unknown，避免重复副作用。

实际模块落点与第 5 节提案有几处有意差异：HTTP 分为 `api/router.ts`、`api/validation.ts`、
`api/session-actions.ts` 和 `api/sse.ts`；`bridge-registry.ts` 只管理 live connection/capability，action 超时、
重发与 receipt 由 session action service 负责；数据库 migration 在 `migrations.ts`，首版投影/outbox/query
集中在 `control.ts` 以保持事务边界清楚；protocol 暂保留单一 `index.ts` 以避免改变既有 package import。
测试按端到端场景集中在 `agent-control-api.test.ts` 和 `bridge-action-dedupe.test.ts`，并扩展既有 database、
adapter 与 Hermes contract tests，而未机械采用提案中的文件名。

Matrix reaction 与 Hermes legacy approval 已接入同一 pending reservation CAS。其余 legacy run input/interrupt
仍使用旧 WebSocket fire-and-forget 响应，确保 HTTP 状态和 body 不变；可靠 action ack 仅适用于新增 session
POST。跨机 protocol 当前仍由 `parseMessage` 做基础 envelope 检查，再由 handler 隔离异常；完整逐字段 runtime
schema validation 是后续 hardening，不影响旧 Bridge 注册或 capability 降级。

后续发布/运维卡仍需在目标生产 Codex 版本上 smoke `thread/list` 与历史字段，并完成 Phase 5 灰度。若上游不支持
`thread/list`，当前实现会明确降级为 loaded-only，而不会影响 legacy Worker API 或伪造完整历史。
