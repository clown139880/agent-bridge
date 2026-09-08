# Agent Bridge

把多台机器上的 Codex 暴露成可由 Hermes 调度的远程 worker。Codex 仍运行在开发机上；每台 Bridge 只连接本机 Codex App Server，Control Plane 提供经过认证的 worker API、运行路由和 SQLite 持久化。原有 Matrix gateway 暂时保留为可选兼容层。

当前版本：`0.6.0`

## 任务完成定义

涉及 Agent Bridge 代码或发布的任务，只有在改动已推送到远程，且 Control Plane 的版本登记已更新、
bridge 自更新流程已被触发后，才算真正完成。发布时必须按语义化版本规范 bump 版本（当前为 `0.6.0`），
并在 Control Plane 中将 `BRIDGE_LATEST_VERSION` 登记为该版本；各主机的 bridge 再自行发现、拉取、校验和重启。
“本地已提交但未推送”或“远程已推送但 Control Plane 尚未登记/通告新版本”都只是中间态，
不能作为任务的完成结论。若自更新因 active turn、待审批或待输入而延后，任务报告必须记录原因和后续触发路径。

## 能做什么

- 让 Hermes 枚举 `codex@机器` worker 及其最近 workspace。
- 通过 headless HTTP API 启动、续写、中断 Codex run，并按游标读取生命周期事件。
- 将 Hermes `taskId` 与真实 Codex thread 解耦并持久关联；带 `runId` 的重试不会重复启动。
- 在不配置第二个 Matrix bot 的情况下作为纯执行面运行。
- 自动发现通过共享 App Server 启动的 Codex thread。
- 主动启动时直接把用户的首条 prompt 作为 Matrix thread 根消息；被动发现等 session 有明确标题后再同步。
- 将完成、失败、等待输入和关键进度同步到 Matrix。
- 在 Matrix thread 中继续对话、查看日志或停止 turn。
- 在 Matrix 直接发送 prompt，通过 reaction 选择 agent@机器及最近目录，也支持输入绝对路径或 zoxide 查询。
- 用 Matrix reaction 处理命令、文件修改和额外权限请求。
- 多台 Bridge 通过带 token 的 WebSocket 接入同一 Control Plane。
- 使用 SQLite 保存 machine、session 和事件状态。
- 可选监控官方 Codex Desktop 新完成的 session，并从 Matrix 续接同一个 thread。

## 架构

```text
Codex CLI/TUI
      │  ws://127.0.0.1:4500
      ▼
Codex App Server
      │
      ▼
Agent Bridge ───── authenticated WebSocket ─────► Worker Control Plane
                                                       │
                                                       ├── authenticated Worker API ◄── Hermes
                                                       ├── SQLite
                                                       └── Matrix（可选兼容层）
```

只有 Bridge 到 Control Plane 的连接需要跨机器。App Server 应始终监听 localhost。

## 环境要求

- Node.js 22.12+
- pnpm 11
- Codex CLI
- Matrix bot 账号
- 可选：zoxide，用于模糊解析项目目录

安装并检查：

```bash
pnpm install
pnpm check
pnpm test
```

## 配置

复制示例配置：

```bash
cp .env.example .env
```

Control Plane 主要变量：

| 变量 | 用途 |
| --- | --- |
| `MATRIX_HOMESERVER` | Matrix homeserver URL |
| `MATRIX_USER_ID` | bot 用户 ID |
| `MATRIX_PASSWORD` | bot 密码 |
| `MATRIX_ROOM_ID` | 已有控制房间；首次可省略，让 bot 创建 |
| `MATRIX_ALLOWED_USER_ID` | 唯一允许控制 Agent 的 Matrix 用户，强烈建议设置 |
| `DATABASE_PATH` | SQLite 路径，默认 `./data/control-plane.sqlite` |
| `CONTROL_HOST` / `CONTROL_PORT` | HTTP/WebSocket 监听地址 |
| `BRIDGE_TOKEN` | Bridge 注册密钥，跨机器部署时必须使用长随机值 |
| `MATRIX_ENABLED` | 默认 `true`；Hermes 已接管 Matrix 时设为 `false` |
| `WORKER_API_ENABLED` | 默认 `false`；设为 `true` 才开放 Hermes worker API |
| `WORKER_API_TOKEN` | 启用 worker API 时必填的独立 bearer token |
| `CONTROL_API_READ_TOKEN` / `CONTROL_API_WRITE_TOKEN` | Agent Control Host 的只读/读写 token；浏览器不得持有 |
| `CONTROL_SESSION_EVENT_RETENTION_MS` | 结构化 session event 保留期，默认 30 天 |
| `CONTROL_STREAM_RETENTION_MS` | SSE outbox 补读窗口，默认 7 天 |
| `CONTROL_ACTION_RETENTION_MS` | action/idempotency 保留期，默认 24 小时 |
| `CONTROL_ACTION_TIMEOUT_MS` | Bridge action ack 超时，默认 30 秒 |
| `CONTROL_SSE_KEEPALIVE_MS` / `CONTROL_SSE_POLL_MS` | SSE keepalive 与 outbox 轮询间隔 |
| `BRIDGE_LATEST_VERSION` | 可选的 bridge 最新版本注册表；与 `BRIDGE_UPDATE_SOURCE` 一起配置 |
| `BRIDGE_UPDATE_SOURCE` | 通告中的推荐获取源；Control Plane 只广播字符串，不访问该源 |

Bridge 主要变量：

| 变量 | 用途 |
| --- | --- |
| `CONTROL_WS_URL` | Control Plane 的 `/bridge` WebSocket URL |
| `BRIDGE_TOKEN` | 必须与 Control Plane 一致 |
| `MACHINE_ID` / `MACHINE_NAME` | Matrix 中显示的机器标识 |
| `BRIDGE_ALLOWED_ROOTS` | Bridge 可访问的项目根目录，使用 `:` 分隔 |
| `CODEX_APP_SERVER_URL` | 本机 App Server URL，默认 `ws://127.0.0.1:4500` |
| `CODEX_APP_SERVER_MANAGED` | 是否由 Bridge 启停 App Server |
| `CODEX_DESKTOP_HOME` | 可选；官方 Codex Desktop 的 `.codex` 目录，设置后监控新完成的 turn |
| `CODEX_DESKTOP_SCAN_INTERVAL_MS` | Desktop rollout 扫描间隔，默认 3000ms |
| `CODEX_DESKTOP_REPLAY_EXISTING` | 首次启动是否同步既有完成记录，默认关闭以避免刷屏 |
| `BRIDGE_AUTO_UPDATE` | 本机自动更新开关，默认 `false` |
| `BRIDGE_UPDATE_SOURCE` | 本机信任并实际拉取的 git 源；不会被 Control Plane 通告覆盖 |
| `BRIDGE_UPDATE_REF` | 本机拉取的 branch/tag，默认 `main` |
| `BRIDGE_UPDATE_INSTALL_ROOT` | 本机 release 根目录，默认 `/opt/agent-bridge` |
| `BRIDGE_UPDATE_CURRENT_LINK` | systemd 启动所使用的 `current` 软链接 |
| `BRIDGE_UPDATE_STATE_PATH` | 跨重启完成确认状态文件 |
| `BRIDGE_ACTION_CACHE_PATH` | action 去重结果缓存，默认位于 update install root，原子写入且权限为 0600 |
| `BRIDGE_ACTION_CACHE_RETENTION_MS` | Bridge action 去重缓存保留期，默认 24 小时 |
| `BRIDGE_UPDATE_PACKAGE_MANAGER` | 本机包管理器可执行文件，默认 `pnpm` |
| `BRIDGE_UPDATE_RESTART_EXECUTABLE` / `BRIDGE_UPDATE_RESTART_ARGS` | 本机重启程序及 JSON 参数数组；不经过 shell |

Worker API 在 bridge 版本落后时返回 `update_waiting`，并等目标版本重新注册后才发送 `start_agent`。
`update_required` / `update_failed` 都是可重试、非成功状态。紧急绕过只能在创建 run 时显式传
`allow_stale_version: true`，Control Plane 会记录包含机器、run 和版本的审计警告。

不要提交 `.env`、`.env.bridge`、SQLite 数据库或任何 Matrix/token 凭据；这些路径已写入 `.gitignore`。

## Bridge 自更新

Control Plane 是只读的版本注册表与通知源：版本发布、bridge 注册/重连、bridge 空闲和 run 派发前，都会通过
现有 WebSocket 重播 `bridge_update.available { latestVersion, source, publishedAt?, epoch? }`。没有周期版本轮询，
Control Plane 也没有拉取、写文件、执行命令或重启远端
机器的接口。bridge 注册会携带自身 `bridgeVersion`，并用
`bridge_update.status { phase, currentVersion, latestVersion, updatable, fetched, reason? }` 报告进度。

每台机器在自己的 `.env.bridge` 中独立决定是否更新以及信任哪个源。通告中的 `source` 仅供审计；实际传给
`git clone` 的始终是本机 `BRIDGE_UPDATE_SOURCE`，因此 Control Plane 不能改变拉取目标。启用前需把当前稳定
release 放在 `BRIDGE_UPDATE_INSTALL_ROOT/releases/`，让 `BRIDGE_UPDATE_CURRENT_LINK` 指向它，并让 systemd
从该软链接启动（可参考 `deploy/systemd/agent-bridge-self-update.service`）。典型本机配置：

```dotenv
BRIDGE_AUTO_UPDATE=true
BRIDGE_UPDATE_SOURCE=ssh://git.example.com/agent-bridge.git
BRIDGE_UPDATE_REF=main
BRIDGE_UPDATE_INSTALL_ROOT=/opt/agent-bridge
BRIDGE_UPDATE_RESTART_EXECUTABLE=systemctl
BRIDGE_UPDATE_RESTART_ARGS=["--no-block","restart","agent-bridge-hal.service"]
```

发现新版本后的本机流程为：先关闭本地 start admission 并进入 `draining_for_update`，再检查 active Codex
turn/待审批/待输入；繁忙则报告 `deferred`，直到最后一项活动结束时主动发送 `bridge.idle`；
克隆到全新的 `releases/<version>-<timestamp>`；校验根 `package.json` 版本严格等于通告版本；执行
`pnpm install --frozen-lockfile` 和 `pnpm check`；原子切换 `current` 软链接；写入 0600 pending 状态；最后由
bridge 自己调用本机重启命令。新进程读取 pending 状态且版本吻合后才报告 `completed`，Control Plane 随后向
Matrix/clown 发送“完成自更新”通知。首次 `discovered` 会发送“发现更新”通知，两类通知按机器和目标版本去重。

拉取或校验失败不会触碰旧 `current`，所以旧 release 原样保留；软链接切换后若重启命令失败，会立即切回旧
release 并报告 `rolled_back`。若新进程启动但版本不吻合，它也会切回旧链接并报告回滚。release staging 不会
修改正在运行的源码目录；更新只在无 active session 的窗口重启，已完成/idle thread 的 Codex 持久状态仍可在
重启后恢复。生产启用前应让 systemd 对启动失败保留 `Restart=always`，并监控 `rolled_back`/启动失败日志。

## Agent Control Session API

Agent Control API 与 Hermes Worker API 共用 `/api/v1`，但提供 session-oriented 的查询、控制和实时状态。
推荐只让 DSH Host/backend 持有 token；浏览器 Client 通过 Host RPC 使用这些能力，不直接连接 Control Plane。

```dotenv
CONTROL_API_READ_TOKEN=<只读长随机 token>
CONTROL_API_WRITE_TOKEN=<读写长随机 token>
```

主要入口：

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/snapshot` | workers、近期 sessions、pending approvals/input 与无竞态 SSE 水位 |
| `GET /api/v1/sessions` | 按机器、状态、workspace、task/conversation 等游标分页 |
| `GET /api/v1/sessions/:id/events` | 跨 run 的结构化 turn/message/tool 事件 |
| `POST /api/v1/sessions` | 幂等创建 session，可不带首条 input |
| `POST /api/v1/sessions/:id/turns` | active turn steer；idle session start new turn |
| `POST /api/v1/sessions/:id/interrupt` | 按 `expectedTurnId` 中断当前 turn |
| `GET/POST /api/v1/approvals*` | 查询并原子处理 approval |
| `GET/POST /api/v1/user-input*` | 查询并提交结构化回答；secret input 必须在本机处理 |
| `GET /api/v1/stream` | 带 `Last-Event-ID` 补读的 SSE 状态流 |

所有新增 POST 都必须发送 `Idempotency-Key`。异步响应为 ActionReceipt，可用
`GET /api/v1/actions/:id` 或 SSE 的 `action.updated` 跟踪。先读取 snapshot 的 `streamCursor`，再连接
`/api/v1/stream?cursor=...`，可以避免首屏查询与订阅之间漏事件。完整契约见
[`docs/agent-control-api.md`](docs/agent-control-api.md)。

Bridge 会优先使用 App Server `thread/list` 枚举近期 thread，并为首批 thread 补入最近 50 个 turn；不支持
该方法时明确降级为 `thread/loaded/list`。Codex Desktop rollout 仍只有 terminal-only 历史，不伪装成完整
对话。结构化 command output 截断为 64 KiB，file changes 最多 200 项。

## Hermes worker API

当 Hermes 已经连接 Matrix 时，建议让本项目只运行执行面：

```dotenv
MATRIX_ENABLED=false
WORKER_API_ENABLED=true
WORKER_API_TOKEN=<独立长随机值>
```

API 默认关闭；启用后所有 `/api/v1/*` 请求都必须携带：

```http
Authorization: Bearer <WORKER_API_TOKEN>
```

Hermes 可以先读取 worker 和最近使用过的 workspace：

```http
GET /api/v1/workers
```

确定 `agent@machine` 与目录后启动 run：

```http
POST /api/v1/runs
Content-Type: application/json

{
  "runId": "Hermes 为本次 claim 生成的稳定 ID",
  "taskId": "Hermes Kanban task ID",
  "conversationId": "可选：Hermes/Matrix 逻辑会话 ID",
  "workerId": "codex@bridge-01",
  "projectPath": "/workspace/project",
  "prompt": "完成卡片中的任务，并报告验证结果",
  "model": "deepseek-chat",
  "resumeSessionId": "可选：上一 run 返回的 sessionId"
}
```

返回 `202` 表示 Bridge 已接受请求。相同 `runId`、task、machine 和 workspace 的重试是幂等的；真实 Codex thread 创建后会异步绑定到该 run。
传入已完成 run 的 `sessionId` 作为 `resumeSessionId` 时，新 run 会在同一台机器、同一 workspace
执行 `thread/resume` 和 `turn/start`，因此可以跨 `runId`、跨 `taskId` 延续上下文。目标 session 正在执行，或机器/目录不匹配时请求会被拒绝。
也可以为连续派发传入稳定的 `conversationId`；Control Plane 会自动续接该逻辑会话在同一机器和 workspace 的最近 thread。
两者都省略时创建新 Codex thread。

### 指定模型

`POST /api/v1/runs` 和 `/api/v1/runs/:runId/input` 均可在 body 中传可选 `model`。新建 thread 时该值同时传给
`thread/start` 与首个 `turn/start`；通过 `resumeSessionId` 或 `conversationId` 续接时，它只覆盖新 turn，
不改变历史 turn。活动 turn 的 steer 不支持切换模型，带 `model` 会返回 `model_not_applicable`。
模型 provider 仍只由各机器的 `config.toml` 静态配置；省略该字段即使用 Codex 默认模型。

一个最小的两次派发流程是：第一次正常创建 run，等待其完成并保存响应中的 `sessionId`；第二次使用新的 `runId` 和
`taskId`，同时把保存值作为 `resumeSessionId`。`runId` 仍表示一次独立、幂等的执行，`sessionId` 表示可被多个顺序 run
复用的真实 Codex thread；每个 run 的事件流仍彼此隔离。

运行控制与观察接口：

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/runs/:runId` | 当前状态、Codex session 以及待处理 approvals |
| `GET /api/v1/runs/:runId/events?after=N` | 增量读取事件；使用返回的 `next` 作为下一页游标 |
| `POST /api/v1/runs/:runId/input` | 发送 `{ "text": "...", "model": "可选" }`，继续同一 Codex thread |
| `POST /api/v1/runs/:runId/interrupt` | 中断当前 turn |
| `POST /api/v1/runs/:runId/reclaim` | 定向收尾已停滞至少 5 分钟、无原因且无待审批项的 blocked run |
| `POST /api/v1/runs/:runId/approvals/:approvalId` | 提交 `{ "choice": "allow" }` 等授权决定 |

当前这层 API 是 Hermes backend 的稳定边界：Hermes 保持 Kanban claim、lease、依赖与 review 的唯一状态真相；Bridge 只维护远程执行状态。不要把 Control Plane 端口直接暴露到公网，跨机器优先使用内网或 VPN。

长期会话（例如小时脉冲与 Matrix bot）应为“机器 + 项目 + 逻辑会话”使用稳定 `conversationId`，或由上层持久保存最新 `sessionId`。
Hermes 插件会自动把来源卡片的 `session_id` 作为 `conversationId`，因此同一 Hermes/Matrix 会话产生的两张卡会顺序复用 thread；
没有来源 session 的卡则使用稳定的 board + task ID，使同一张卡的后续 claim 仍可续接。小时脉冲可使用一个固定逻辑 ID。
不应复用 `runId`，也不应并发续接同一 session。若上下文需要重置，改用新的 `conversationId` 或省略续接字段创建新 thread。

## Hermes 插件

仓库内的 `integrations/hermes_agent_bridge` 是独立 Hermes 插件，不修改 Hermes core。它提供：

- `agent_bridge_workers`：让 Hermes 查看在线的 `codex@machine` 与最近 workspace。
- `on_kanban_dispatch_tick` observer：看到分配给 `codex@machine` 的卡片后启动本地 supervisor。
- supervisor：原子 claim 卡片、启动幂等 Worker API run、续租 heartbeat，并把完成或失败回写 Kanban；对状态和事件游标均停滞 5 分钟的无理由 blocked run，会定向调用 reclaim 后释放 claim。
- approval relay：按 Kanban 通知订阅把远端 Codex approval 送回卡片来源 profile，并复用 Hermes 原生
  gateway queue 与 Matrix 表情审批；Hermes 不在线或路由不明确时保持阻塞，不会自动放行。

开发安装可把插件目录链接到 Hermes 的用户插件目录：

```bash
ln -s /root/agent-bridge/integrations/hermes_agent_bridge ~/.hermes/plugins/agent-bridge-worker
```

本机部署脚本会原子同步 Worker API secret；确认 Hermes 已接管 Matrix 后可同时关闭旧 UI：

```bash
python3 scripts/deploy-hermes-plugin.py --disable-control-matrix
```

在 Hermes 的 `config.yaml` 中配置非敏感设置：

```yaml
plugins:
  entries:
    agent-bridge-worker:
      enabled: true
      settings:
        api_url: http://127.0.0.1:8787
        completion_mode: done
        max_in_progress: 4
        api_failure_timeout_seconds: 300
```

把与 Control Plane `WORKER_API_TOKEN` 相同的值作为 Hermes secret 提供给 gateway：

```dotenv
AGENT_BRIDGE_WORKER_API_TOKEN=<与 WORKER_API_TOKEN 相同的值>
```

随后在 `hermes tools` 中启用 `Agent Bridge` toolset，并重启 gateway。外部 worker 卡片必须使用
`workspace_kind=dir`，且 `workspace_path` 是所选 Bridge 机器看到的绝对路径；插件不会在 Hermes 主机上创建或校验这个远端目录。

默认 `completion_mode: done` 会在 Codex 成功结束时完成卡片；设为 `review` 会让实现任务进入 Hermes review lane，review lane 自身成功后仍会完成卡片。

## 本地启动

启动 Control Plane：

```bash
pnpm start:control
```

在 Codex 所在机器启动 Bridge：

```bash
pnpm start:bridge
```

Codex TUI 必须连接同一个 App Server：

```bash
codex --remote ws://127.0.0.1:4500
```

也可以加载透明包装函数，之后继续输入普通的 `codex`：

```bash
source scripts/codex-remote.zsh
```

已经在没有 `--remote` 的情况下启动的 Codex 进程无法事后附加。

### Codex Desktop 完成后接力

官方 Codex Desktop 不会把其私有 App Server 的实时事件发送给 Bridge，但 Desktop 与
Codex CLI 可以共享 `CODEX_HOME` 中的 session 历史。设置 `CODEX_DESKTOP_HOME` 后，Bridge
会只读扫描其中由 `Codex Desktop` 创建的 rollout；新 turn 完成或中断、且 session 已有明确标题时，
它才会在 Matrix 创建或更新对应 thread。用户随后在 Matrix 回复时，Bridge 会先确认 Desktop 没有仍在执行
该 thread，再通过现有 App Server 执行 `thread/resume` 和 `turn/start`。

推荐由与 Desktop 同一操作系统上的原生 Bridge 负责这类 session。Windows Desktop 应由
Windows-native Bridge 使用 Windows cwd 和工具链接力；WSL Bridge 保持 WSL-only，不读取挂载在
`/mnt/c` 下的 Desktop `CODEX_HOME`，避免跨 Windows/WSL 的 SQLite/WAL 锁、路径和执行环境混用。

Windows-native Bridge 示例：

```dotenv
CODEX_DESKTOP_HOME=C:\Users\<windows-user>\.codex
BRIDGE_ALLOWED_ROOTS=C:\Users\<windows-user>\Workspace
```

启用监控时，Bridge 会把 `CODEX_DESKTOP_HOME` 同时作为其托管 App Server 的 `CODEX_HOME`，
并在接力前确认 Desktop 没有仍在执行该 thread。不要同时从 Desktop 和其他控制端向同一个活跃 turn 输入。

## Matrix 使用（已弃用，仅作兼容保留）

直接在房间发送第一条任务，例如：

```text
修复不稳定的测试，并说明根因
```

Control Plane 会在只有一个可用 `agent@机器` 时自动选择，否则给出数字 reaction；随后用 reaction
选择该机器最近使用的工作目录，或选择 `➕ 新的工作目录` 后发送绝对路径、`z:<query>` 或普通 zoxide query。
启动后，这条原始任务消息就是 session thread 的根消息。可用 `!cancel` 取消尚未完成的选择流程。

辅助命令：

```text
!machines
!sessions
!help
```

旧的 `!codex <path> [prompt]` 与 `!codex@<machine> <path> [prompt]` 仍保留兼容。

Session thread 内：

```text
任意文本       发送给同一个 Codex thread
/log 100      查看最近的结构化日志
/stop         中断当前 turn
```

输入其他目录时，路径可以是绝对路径、`z:<query>` 或普通 zoxide query。解析后的真实路径必须已存在，且位于 `BRIDGE_ALLOWED_ROOTS` 中。

## Matrix 授权

Codex 阻塞在 approval request 时，Bridge 会在对应 thread 中展示请求内容，并由 bot 添加可用 reaction：

| Reaction | 操作 | Codex 语义 |
| --- | --- | --- |
| `✅` | 允许一次 | `accept`，或 turn scope permission |
| `❌` | 拒绝 | `decline`；若服务只提供 `cancel` 则使用 `cancel` |
| `♾️` | 本 session 一直允许 | `acceptForSession`、exec/network policy amendment，或 session scope permission |

选项会根据 Codex App Server 下发的 `availableDecisions` 动态显示。点击后 Control Plane 会立即移除 bot 添加的 reactions，将决定传回原始 JSON-RPC request，并让 turn 继续。如果请求已在本机 TUI 或其他客户端处理，reactions 也会被清理。

## systemd 部署

### Control Plane

默认 unit 假设代码位于 `/root/agent-bridge`。如果使用其他目录，请先调整 unit 中的路径：

```bash
sudo systemctl link /root/agent-bridge/deploy/systemd/agent-control-plane.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-control-plane.service
sudo systemctl status agent-control-plane.service
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

不要直接把 8787 暴露到公网。优先使用内网、VPN 或防火墙，并始终设置 `BRIDGE_TOKEN`。

### WSL 开机服务（推荐）

确认 `/etc/wsl.conf` 已启用 systemd：

```ini
[boot]
systemd=true
```

将 WSL 配置写入 `.env.bridge`。如果以前安装过用户 unit，先停用它，避免两个 Bridge 同时连接同一个 App Server：

```bash
systemctl --user disable --now agent-bridge-wsl-user.service 2>/dev/null || true
```

WSL-only 配置只允许 Linux workspace，并且必须让 `CODEX_DESKTOP_HOME` 保持未设置：

```dotenv
MACHINE_ID=dev-wsl
MACHINE_NAME=dev-wsl
BRIDGE_ALLOWED_ROOTS=/home/<linux-user>/Workspace
CODEX_COMMAND=/home/<linux-user>/.local/share/pnpm/bin/codex
CODEX_APP_SERVER_MANAGED=true
# 不要设置 CODEX_DESKTOP_HOME；Windows Desktop 由 Windows-native Bridge 负责。
```

可复制 [`deploy/wsl-only.env.example`](deploy/wsl-only.env.example) 作为无凭据模板。

仓库中的系统级 unit 使用专用的 `agent-bridge` 用户、`/opt/agent-bridge` 代码目录和
`/etc/agent-bridge/bridge.env` 配置文件。请按本机环境创建用户和目录，或复制 unit 后调整这些值。
服务由 WSL 的 systemd 在启动时拉起，不依赖交互式登录或用户 manager：

```bash
sudo systemctl link /opt/agent-bridge/deploy/systemd/agent-bridge-wsl.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-bridge-wsl.service
sudo systemctl status agent-bridge-wsl.service
```

验证 Bridge 管理的 App Server：

```bash
curl http://127.0.0.1:4500/readyz
```

修改 unit 后运行 `daemon-reload` 和 `restart`。修改 `.env.bridge` 后只需重启服务：

```bash
sudo systemctl daemon-reload
sudo systemctl restart agent-bridge-wsl.service
```

如需验证真正的 WSL 冷启动，可从 Windows PowerShell 执行 `wsl --shutdown`，重新进入发行版后检查服务状态。

### WSL 用户服务（仅随登录启动）

如果明确只希望在该用户的 systemd session 存活期间运行，也可以使用用户 unit：

```bash
systemctl --user link "$PWD/deploy/systemd/agent-bridge-wsl-user.service"
systemctl --user daemon-reload
systemctl --user enable --now agent-bridge-wsl-user.service
systemctl --user status agent-bridge-wsl-user.service
```

不开启 lingering 时，它不会提供可靠的 WSL 开机启动保证。不要同时启用系统级和用户级 Bridge unit。

## 开发

```bash
pnpm dev:control
pnpm dev:bridge
pnpm check
pnpm test
pnpm build
```

Workspace 布局：

```text
apps/control-plane   Matrix、WebSocket server、session routing
apps/bridge          Codex App Server adapter、Bridge client
packages/protocol    Bridge ↔ Control Plane 消息类型
packages/database    SQLite store
integrations/dsh-agent-control   DSH Agent Control 插件（out-of-tree DSH plugin）
deploy/systemd       Linux/WSL service units
tests                Node Test runner 测试
scripts              本地辅助脚本
```

## DSH Agent Control 插件

`integrations/dsh-agent-control` 是一个 out-of-tree DSH 插件，为 DSH Web 客户端
添加 Agent Control sidebar 和 Hermes Kanban 控制面板。它不修改 DSH 本体，通过
`cordis.patch.yml` 注入一个 Host 服务和 24 个 model tool。该插件已在 monorepo 中
作为 workspace 成员管理；`pnpm install`、`pnpm check`、`pnpm test`、`pnpm build`
均覆盖它（分别 55 Bridge + 13 DSH = 68 项测试通过）。

安装到 DSH Web profile：

```bash
dsh plugin --profile agent-control add file:/root/agent-bridge/integrations/dsh-agent-control
dsh --profile agent-control web
```

插件详细文档见 `integrations/dsh-agent-control/README.md`。

Codex App Server WebSocket transport 仍属于实验接口。升级 Codex CLI 后应先运行测试，并实际验证 approval request/response schema。
