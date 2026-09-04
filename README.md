# Agent Bridge

通过 Matrix 在手机上查看和控制本机 Codex CLI session。Codex 仍运行在开发机上；Bridge 连接本机 Codex App Server，Control Plane 负责 Matrix、session 路由和 SQLite 持久化。

当前版本：`0.2.0`

## 能做什么

- 自动发现通过共享 App Server 启动的 Codex thread。
- 为每个 Codex session 创建一个 Matrix thread。
- 将完成、失败、等待输入和关键进度同步到 Matrix。
- 在 Matrix thread 中继续对话、查看日志或停止 turn。
- 从 Matrix 远程创建 Codex session，支持绝对路径和 zoxide 查询。
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
Agent Bridge ───── authenticated WebSocket ─────► Control Plane
                                                       │
                                                       ├── Matrix room / threads
                                                       └── SQLite
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
会只读扫描其中由 `Codex Desktop` 创建的 rollout；新 turn 完成或中断时，它会在 Matrix
创建或更新对应 thread。用户随后在 Matrix 回复时，Bridge 会先确认 Desktop 没有仍在执行
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

房间命令：

```text
!machines
!sessions
!codex /absolute/project/path Fix the failing tests
!codex@bridge-01 z:agent-bridge Fix the failing tests
!help
```

Session thread 内：

```text
任意文本       发送给同一个 Codex thread
/log 100      查看最近的结构化日志
/stop         中断当前 turn
```

远程创建 session 时，项目参数可以是绝对路径、`z:<query>` 或普通 zoxide query。解析后的真实路径仍必须位于 `BRIDGE_ALLOWED_ROOTS` 中。

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
