# Agent Bridge

把多台机器上的 Codex 暴露成可由 Hermes 调度的远程 worker。Codex 仍运行在开发机上；每台 Bridge 只连接本机 Codex App Server，Control Plane 提供经过认证的 worker API、运行路由和 SQLite 持久化。原有 Matrix gateway 暂时保留为可选兼容层。

当前版本：`0.2.0`

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

不要提交 `.env`、`.env.bridge`、SQLite 数据库或任何 Matrix/token 凭据；这些路径已写入 `.gitignore`。

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
  "resumeSessionId": "可选：上一 run 返回的 sessionId"
}
```

返回 `202` 表示 Bridge 已接受请求。相同 `runId`、task、machine 和 workspace 的重试是幂等的；真实 Codex thread 创建后会异步绑定到该 run。
传入已完成 run 的 `sessionId` 作为 `resumeSessionId` 时，新 run 会在同一台机器、同一 workspace
执行 `thread/resume` 和 `turn/start`，因此可以跨 `runId`、跨 `taskId` 延续上下文。目标 session 正在执行，或机器/目录不匹配时请求会被拒绝。
也可以为连续派发传入稳定的 `conversationId`；Control Plane 会自动续接该逻辑会话在同一机器和 workspace 的最近 thread。
两者都省略时创建新 Codex thread。

一个最小的两次派发流程是：第一次正常创建 run，等待其完成并保存响应中的 `sessionId`；第二次使用新的 `runId` 和
`taskId`，同时把保存值作为 `resumeSessionId`。`runId` 仍表示一次独立、幂等的执行，`sessionId` 表示可被多个顺序 run
复用的真实 Codex thread；每个 run 的事件流仍彼此隔离。

运行控制与观察接口：

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/runs/:runId` | 当前状态、Codex session 以及待处理 approvals |
| `GET /api/v1/runs/:runId/events?after=N` | 增量读取事件；使用返回的 `next` 作为下一页游标 |
| `POST /api/v1/runs/:runId/input` | 发送 `{ "text": "..." }`，继续同一 Codex thread |
| `POST /api/v1/runs/:runId/interrupt` | 中断当前 turn |
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
- supervisor：原子 claim 卡片、启动幂等 Worker API run、续租 heartbeat，并把完成或失败回写 Kanban。
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

WSL 示例：

```bash
CODEX_DESKTOP_HOME=/mnt/c/Users/<windows-user>/.codex
BRIDGE_ALLOWED_ROOTS=/mnt/c/Users/<windows-user>/Workspace
```

启用监控时，Bridge 会把 `CODEX_DESKTOP_HOME` 同时作为其托管 App Server 的 `CODEX_HOME`，
并在 Matrix 续接的首个 turn 上用映射后的 WSL 项目路径覆盖 Desktop 保存的 Windows cwd。
Windows 项目仍优先使用 Windows-native Bridge；从 WSL 接力时，应确保所配置的
`CODEX_COMMAND` 能读取这份共享历史。不要同时从 Desktop 和 Matrix 向同一个活跃 turn 输入；扫描器检测到
未结束的 Desktop turn 时会拒绝接管。

## Matrix 使用

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
deploy/systemd       Linux/WSL service units
tests                Node test runner 测试
scripts              本地辅助脚本
```

Codex App Server WebSocket transport 仍属于实验接口。升级 Codex CLI 后应先运行测试，并实际验证 approval request/response schema。
