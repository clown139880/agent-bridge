# Agent Bridge

把多台机器上的 Codex 与 Claude Code 暴露成可由 Hermes/DSH 使用的远程 worker。Agent 仍运行在开发机上；每台 Bridge 只连接或启动本机执行端，Control Plane 提供经过认证的 worker/session API、运行路由、可靠 action、SSE 和 SQLite 持久化。一个 Hono 应用是 Control Plane 唯一的 HTTP 入口（默认 8787），同时提供 `/mcp/memory`、`/mcp/bridge` 两个 MCP 端点。

当前版本：`0.6.40`

当前代码能力、DSH 接入方式和已知边界以 [`docs/current-state.md`](docs/current-state.md) 为准；较早的轮次记录和方案评估是历史材料。

## 任务完成定义

涉及 Agent Bridge 代码或发布的任务，只有在改动已推送到远程，且已在 HAL 上执行
`deploy/hal/deploy.sh` 后，才算真正完成。发布时必须按语义化版本规范 bump 根 `package.json` 的版本；
Control Plane 启动时直接通告自身版本（无需编辑 `.env`），各主机的 bridge 再自行发现、拉取、校验和重启。
部署成功的标志是 Dorothy 的通知房间出现 “🟢 控制面已启动 · 版本 <版本>”（来自 `control_plane.up` webhook）。
“本地已提交但未推送”或“已推送但尚未部署到 HAL”都只是中间态，不能作为任务的完成结论。若自更新因 active turn、待审批或待输入而延后，任务报告必须记录原因和后续触发路径。

## 能做什么

- 让 Hermes 枚举 `codex@机器` worker 及其最近 workspace。
- 通过 headless HTTP API 启动、续写、中断 Codex run，并按游标读取生命周期事件。
- 将 Hermes `taskId` 与真实 Codex thread 解耦并持久关联；带 `runId` 的重试不会重复启动。
- 自动发现通过共享 App Server 启动的 Codex thread。
- Windows Bridge 在新对话/新 turn 前验证 Codex Desktop runtime；版本变化时会排空活动工作、静默轮换自己管理的 App Server，并在同一 action 上继续执行。
- 通过 Agent Control API（`/api/v1`）或 `/mcp/bridge` 创建 session、发送 turn、处理审批和问题；被动发现的 session 等有明确标题后再同步。
- 多台 Bridge 通过带 token 的 WebSocket 接入同一 Control Plane。
- 使用 SQLite 保存 machine、session 和事件状态。
- 可选监控官方 Codex Desktop 新完成的 session，并通过 Agent Control API 续接同一个 thread。
- 同一 Bridge 同时暴露 Codex 与 Claude worker，并在重启后恢复已知 Claude session。
- 将 Bridge conversation 物化进 DSH 原生 Session/Workspace，复用原生会话树、Conversation、Composer 和待处理交互。
- 从 DSH 原生输入框向 Codex/Claude 转发图片，支持只含图片的新 turn。
- 在 DSH 原生目录入口选择本地 DSH 或对应机器上的 Bridge execution source。
- 在原生行菜单中重命名、归档或删除会话；Bridge 删除等待 owning adapter 确认，本地 DSH 删除保留底层日志。

## 架构

```text
Codex CLI/TUI ── ws://127.0.0.1:4500 ──► Codex App Server ─┐
                                                            ├─► Agent Bridge
Claude Code ───────────── local SDK/process adapter ────────┘       │
                                                                    │ authenticated WebSocket
                                                                    ▼
                                                         Worker Control Plane
                                                       │
                                                       ├── Agent Control API / SSE ◄── DSH, Control Center
                                                       ├── /mcp/bridge ◄── Hermes 等 agent（驱动 session）
                                                       ├── /mcp/memory ◄── 记忆、对话档案、技能
                                                       └── SQLite
```

只有 Bridge 到 Control Plane 的连接需要跨机器。App Server 应始终监听 localhost。

## 环境要求

- Node.js 22.12+
- pnpm 11
- Codex CLI
- 可选：Claude Code（启用 Claude worker 时）
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
| `DATABASE_PATH` | SQLite 路径，默认 `./data/control-plane.sqlite` |
| `CONTROL_HOST` / `CONTROL_PORT` | HTTP/WebSocket 监听地址（Hono 唯一入口，默认 8787） |
| `BRIDGE_TOKEN` | Bridge 注册密钥，跨机器部署时必须使用长随机值 |
| `CONTROL_API_READ_TOKEN` / `CONTROL_API_WRITE_TOKEN` | 人的只读/读写 token（Control Center、DSH）；浏览器不得持有。只有它能裁决交给人的记忆审核 |
| `AGENT_TOKENS` | 每个 agent 一枚：`名字:token[:agent|project]`，逗号分隔（旧名 `AGENT_MEMORY_TOKENS` 仍可用）。同一枚 token 用于 `/mcp/memory`、`/mcp/bridge` 和 `/api/v1`，以 `agent:<名字>` 记在它发起的 action 上。`project`（默认）写 `_` 开头的作用域或共享技能时先经审核，见 [`docs/agent-dispatch-and-review.zh.md`](docs/agent-dispatch-and-review.zh.md) |
| `MEMORY_REVIEW` / `MEMORY_REVIEW_MODEL` / `MEMORY_REVIEW_COMMAND` / `MEMORY_REVIEW_TIMEOUT_MS` | 记忆审核员：默认用本机 `claude`（无工具）、模型 `sonnet`、超时 180 秒；`MEMORY_REVIEW=off` 时一律交给人 |
| `AGENT_MEMORY_VAULT` | 跨 agent 记忆所在的 Git 笔记库（如 `/root/deathnote`）；不设则关闭记忆。见 [`docs/agent-memory-operations.zh.md`](docs/agent-memory-operations.zh.md) |
| `AGENT_MEMORY_ROOT` / `AGENT_MEMORY_LOCK` / `AGENT_MEMORY_CACHE_DIR` | 笔记库内的记忆目录（默认 `agent-memory`）、与笔记库自动提交共用的 flock 文件、bootstrap 缓存目录（默认数据库旁的 `memory-cache`） |
| `AGENT_SKILLS_REPO` | 共享技能库的 Git checkout（如 `/root/agent-skills`）；需要先启用 agent 记忆，不设则关闭。见 [`docs/agent-skills-design.zh.md`](docs/agent-skills-design.zh.md) |
| `AGENT_SKILLS_LOCK` / `AGENT_SKILLS_ARCHIVE_DIR` / `AGENT_SKILLS_PUSH` | 技能库提交用的 flock 文件、归档目录（默认数据库旁的 `skills-archive`）、每次提交后是否后台推送（默认是，设 `false` 关闭） |
| `CONTROL_ACTION_RETENTION_MS` | action/idempotency 保留期，默认 24 小时 |
| `CONTROL_ATTACHMENT_RETENTION_MS` | 内容寻址图片附件保留期，默认 7 天 |
| `CONTROL_ACTION_TIMEOUT_MS` | Bridge action ack 超时，默认 30 秒 |
| `CONTROL_SSE_KEEPALIVE_MS` / `CONTROL_SSE_POLL_MS` | SSE keepalive 与漏唤醒兜底轮询间隔（写入即唤醒，轮询默认 2 秒） |
| `BRIDGE_LATEST_VERSION` | 可选覆盖；默认通告 Control Plane 自身版本（根 `package.json`）。需配置 `BRIDGE_UPDATE_SOURCE` 才会通告 |
| `BRIDGE_UPDATE_SOURCE` | 通告中的推荐获取源；Control Plane 只广播字符串，不访问该源 |

Bridge 主要变量：

| 变量 | 用途 |
| --- | --- |
| `CONTROL_WS_URL` | Control Plane 的 `/bridge` WebSocket URL |
| `BRIDGE_TOKEN` | 必须与 Control Plane 一致 |
| `MACHINE_ID` / `MACHINE_NAME` | 机器标识与显示名 |
| `BRIDGE_ALLOWED_ROOTS` | Bridge 可访问的项目根目录，使用 `:` 分隔 |
| `CODEX_APP_SERVER_URL` | 默认 `ws://127.0.0.1:4500`；共享回环端口的 Bridge（Windows 与 WSL）必须配置不同端口，WSL 用 `ws://127.0.0.1:4501`；托管模式下端口 `0` 表示每次启动随机分配 |
| `CODEX_APP_SERVER_MANAGED` | 是否由 Bridge 启停 App Server |
| `BRIDGE_ARCHIVE_OUTBOX_PATH` | 等待中心 ACK 的会话事件持久 outbox；必须位于 Git checkout 外 |
| `BRIDGE_ARCHIVE_OUTBOX_LIMIT` | outbox 消息上限，默认 10000；溢出会向中心报告采集缺口 |
| `CODEX_DESKTOP_HOME` | 可选；官方 Codex Desktop 的 `.codex` 目录，设置后监控新完成的 turn |
| `CODEX_DESKTOP_SCAN_INTERVAL_MS` | Desktop rollout 扫描间隔，默认 3000ms |
| `CODEX_DESKTOP_REPLAY_EXISTING` | 首次启动是否同步既有完成记录，默认关闭以避免刷屏 |
| `BRIDGE_AUTO_UPDATE` | 本机自动更新开关，默认 `false` |
| `BRIDGE_UPDATE_SOURCE` | 本机信任并实际拉取的 git 源；不会被 Control Plane 通告覆盖 |
| `BRIDGE_UPDATE_REF` | 本机拉取的 branch/tag，默认 `main` |
| `BRIDGE_UPDATE_SOURCE_CHECKOUT` | 可选的本机干净 checkout；使用它构建后仅发布编译产物 |
| `BRIDGE_UPDATE_INSTALL_ROOT` | 本机 release 根目录，默认 `/opt/agent-bridge` |
| `BRIDGE_UPDATE_CURRENT_LINK` | systemd 启动所使用的 `current` 软链接 |
| `BRIDGE_UPDATE_STATE_PATH` | 跨重启完成确认状态文件 |
| `BRIDGE_ACTION_CACHE_PATH` | action 去重结果缓存，默认位于 update install root，原子写入且权限为 0600 |
| `BRIDGE_DRAIN_FILE` | 可选的本机部署 drain 标记；存在时拒绝创建 session 或提交新 turn，Linux 默认 `/run/agent-bridge-<machineId>.drain` |
| `BRIDGE_ACTION_CACHE_RETENTION_MS` | Bridge action 去重缓存保留期，默认 24 小时 |
| `BRIDGE_UPDATE_PACKAGE_MANAGER` | 本机包管理器可执行文件，默认 `pnpm` |
| `BRIDGE_UPDATE_RESTART_EXECUTABLE` / `BRIDGE_UPDATE_RESTART_ARGS` | 本机重启程序及 JSON 参数数组；不经过 shell |

不要提交 `.env`、`.env.bridge`、SQLite 数据库或任何 token 凭据；这些路径已写入 `.gitignore`。

## Bridge 自更新

Control Plane 是只读的版本注册表与通知源：版本发布、bridge 注册/重连、bridge 空闲和 run 派发前，都会通过
现有 WebSocket 重播 `bridge_update.available { latestVersion, source, publishedAt?, epoch? }`。没有周期版本轮询，
Control Plane 也没有拉取、写文件、执行命令或重启远端
机器的接口。bridge 注册会携带自身 `bridgeVersion`，并用
`bridge_update.status { phase, currentVersion, latestVersion, updatable, fetched, reason? }` 报告进度。

每台机器在自己的 `.env.bridge` 中独立决定是否更新以及信任哪个源。通告中的 `source` 仅供审计；实际传给
`git clone` 的始终是本机 `BRIDGE_UPDATE_SOURCE`，因此 Control Plane 不能改变拉取目标。启用前需把当前稳定
release 放在 `BRIDGE_UPDATE_INSTALL_ROOT/releases/`，让 `BRIDGE_UPDATE_CURRENT_LINK` 指向它，并让 systemd
从该软链接启动（通用示例见 `deploy/systemd/agent-bridge-self-update.service`；HAL 不走自更新，见下文）。典型本机配置：

```dotenv
BRIDGE_AUTO_UPDATE=true
BRIDGE_UPDATE_SOURCE=ssh://git.example.com/agent-bridge.git
BRIDGE_UPDATE_REF=main
BRIDGE_UPDATE_INSTALL_ROOT=/opt/agent-bridge
BRIDGE_UPDATE_RESTART_EXECUTABLE=systemctl
BRIDGE_UPDATE_RESTART_ARGS=["--no-block","restart","agent-bridge-hal.service"]
```

HAL 的完整环境模板见 [`deploy/hal.env.example`](deploy/hal.env.example)。HAL 本机不走自更新
（`BRIDGE_AUTO_UPDATE` 保持关闭），Control Plane 与 Bridge 都直接从 `/root/agent-bridge` 运行编译产物，
由 [`deploy/hal/deploy.sh`](deploy/hal/deploy.sh) 统一部署：

```bash
/root/agent-bridge/deploy/hal/deploy.sh          # 已是最新则直接退出；--force 强制重启
```

脚本 fetch/ff-only 到 `origin/main`，仅在 lockfile 变化时 `pnpm install`，然后 `tsc -b` 编译服务
（HAL 不需要 DSH 插件，不构建它）；编译失败会回退到原 commit 并重新编译，服务不重启。成功后安装仓库中的
`deploy/systemd/agent-control-plane.service` 与 `agent-bridge-hal.service`（有变化时），最后用
`systemctl restart --no-block` 同时重启两者。重启由 systemd 执行，所以任何 agent 都能无人值守地运行它——
包括由本机 Bridge 托管、会被这次重启结束会话的 agent。Control Plane 起来后发出 `control_plane.up`
webhook，由 Dorothy 转发为通知房间里的 “🟢 控制面已启动 · 版本 <版本>”；从 Bridge 之外调用时，
脚本还会等待服务健康并报告结果。

发现新版本后的本机流程为：先关闭本地 start admission 并进入 `draining_for_update`，再检查 active Codex
turn/待审批/待输入；繁忙则报告 `deferred`，直到最后一项活动结束时主动发送 `bridge.idle`；
在固定 source checkout 中 fetch/ff-only；校验根 `package.json` 版本严格等于通告版本；执行
`pnpm install --frozen-lockfile`、`pnpm check` 和 `pnpm build`；把编译 artifact 放入新的 release；原子切换
`current` 软链接；写入 0600 pending 状态；最后由
bridge 自己调用本机重启命令。新进程读取 pending 状态且版本吻合后才报告 `completed`，Control Plane 随后经
通知 webhook 发送“完成自更新”通知。首次 `discovered` 会发送“发现更新”通知，两类通知按机器和目标版本去重。

拉取或校验失败不会触碰旧 `current`，所以旧 release 原样保留；软链接切换后若重启命令失败，会立即切回旧
release 并报告 `rolled_back`。若新进程启动但版本不吻合，它也会切回旧链接并报告回滚。release staging 不会
修改正在运行的源码目录；更新只在无 active session 的窗口重启，已完成/idle thread 的 Codex 持久状态仍可在
重启后恢复。生产启用前应让 systemd 对启动失败保留 `Restart=always`，并监控 `rolled_back`/启动失败日志。

## Agent Control Session API

Agent Control API 在 `/api/v1` 下提供 session-oriented 的查询、控制和实时状态。
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
| `POST/GET /api/v1/attachments*` | 上传并读取受认证的内容寻址图片附件 |
| `GET /api/v1/stream` | 带 `Last-Event-ID` 补读的 SSE 状态流；`?sessionId=` 只推送该 session 的资源 |

所有新增 POST 都必须发送 `Idempotency-Key`。异步响应为 ActionReceipt，可用
`GET /api/v1/actions/:id` 或 SSE 的 `action.updated` 跟踪。先读取 snapshot 的 `streamCursor`，再连接
`/api/v1/stream?cursor=...`，可以避免首屏查询与订阅之间漏事件。完整契约见
[`docs/agent-control-api.md`](docs/agent-control-api.md)。

Bridge 会优先使用 App Server `thread/list` 枚举近期 thread，并为首批 thread 补入最近 50 个 turn；不支持
该方法时明确降级为 `thread/loaded/list`。Codex Desktop rollout 仍只有 terminal-only 历史，不伪装成完整
对话。结构化 command output 截断为 64 KiB，file changes 最多 200 项。

## MCP 端点

Control Plane 在同一个 8787 端口上提供两个 MCP 端点（官方 MCP SDK，无状态 Streamable HTTP）。客户端必须发送
`Accept: application/json, text/event-stream`，并用 `Authorization: Bearer <token>` 认证；token 放在本机秘密或环境变量里，
不写入 Git。客户端里配置的 server 名字决定工具前缀。

| 端点 | server 名 | 工具 |
| --- | --- | --- |
| `http://<control-plane>:8787/mcp/memory` | `memory` | 对话档案 `history_search/history_review/history_read`；记忆 `bootstrap/search/get/write/retract/load/scopes/scope`；技能 `skills/skill_search/skill/skill_write/skill_patch/skill_rm/skill_archive/skill_move`；审核结果 `review` |
| `http://<control-plane>:8787/mcp/bridge` | `bridge` | `workers/sessions/session/pending/wait/create/turn/approve/answer/interrupt`（只读 token 只有前五个） |

客户端看到的全名是 `mcp__memory__search`、`mcp__bridge__wait` 这样的形式。

两个端点都用 agent 自己的 token（`AGENT_TOKENS`），每个 agent 一枚，记忆和调度共用。

`/mcp/bridge` 是 Agent Control API 的一层薄封装，供任何 agent（Hermes、Bridge 下的 Claude/Codex）跨项目、跨机器调度别的
session，发起的 action 记为 `agent:<名字>`。agent token 可用全部工具；人的只读 token 只有 `workers/sessions/session/pending/wait`；
Bridge 注册 token 会被拒绝。Claude 下 `mcp__bridge__*` 照常弹审批，经人允许才调度。典型流程：`workers` 看有哪些机器与最近目录，`create`
新建 session（workspace 可用最近目录名），`turn` 发送新 turn（或 steer 正在运行的 turn），`wait` 等待结束，`pending` 查看待处理请求，
`approve`（allow/deny/allow-session）与 `answer` 处理审批和问题。

`wait` 从 `create`/`turn` 返回的 cursor 重放事件，所以 turn 在两次调用之间结束也不会漏。它在需要人处理时返回；默认等待 120 秒，
最长 600 秒（`timeout_seconds`），超时返回 `timeout` 和 cursor，再调用一次即可。处理完审批或问题后用同一个 cursor 继续等待。

没有命令行客户端（`abctl` 已删除）。旧的手写 `/mcp` 端点保留到 0.8，沿用旧工具名（也接受新名），
每次调用都会记日志并计入 `/health` 的 `legacyMcpCalls`。

Hermes 的 `/ab` 命令也用它自己的 agent token 列出 session（0.7.12 删除了 `WORKER_API_TOKEN` 和
`CONVERSATION_MCP_READ_TOKEN`）。旧的 `/api/v1/runs` Worker API 与 Hermes Kanban 插件已移除，`GET /api/v1/runs` 只保留历史记录查询。

## 本地启动

启动 Control Plane（运行编译产物，先 `pnpm exec tsc -b`；开发时用 `pnpm dev:control` 直接跑源码）：

```bash
pnpm start:control
```

在 Codex 所在机器启动 Bridge：

```bash
pnpm start:bridge
```

Codex TUI 必须连接同一个 App Server（WSL 为 4501）：

```bash
codex --remote ws://127.0.0.1:4501
```

也可以加载透明包装函数，之后继续输入普通的 `codex`（默认连接 `ws://127.0.0.1:4501`，可用 `CODEX_APP_SERVER_URL` 覆盖）：

```bash
source scripts/codex-remote.zsh
```

已经在没有 `--remote` 的情况下启动的 Codex 进程无法事后附加。

### Codex Desktop 完成后接力

官方 Codex Desktop 不会把其私有 App Server 的实时事件发送给 Bridge，但 Desktop 与
Codex CLI 可以共享 `CODEX_HOME` 中的 session 历史。设置 `CODEX_DESKTOP_HOME` 后，Bridge
会只读扫描其中由 `Codex Desktop` 创建的 rollout；新 turn 完成或中断、且 session 已有明确标题时，
它才会把该 session 同步到 Control Plane。用户随后经 Agent Control API（DSH、Control Center 或 `/mcp/bridge`）续接时，
Bridge 会先确认 Desktop 没有仍在执行该 thread，再通过现有 App Server 执行 `thread/resume` 和 `turn/start`。

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

仓库中的系统级 unit 使用专用的 `agent-bridge` 用户、`/etc/agent-bridge/bridge.env` 配置文件，
并从 `/opt/agent-bridge/current`（不可变 release 的 `current` 软链）运行编译产物
`node apps/bridge/dist/index.js`，而不再从源码目录跑 `pnpm start:bridge`。这与 HAL 一致：
自更新会 `git fetch + merge --ff-only` 共享源码检出、把编译产物写入
`BRIDGE_UPDATE_INSTALL_ROOT/releases/`（共享 pnpm store、保留最近 `BRIDGE_UPDATE_RELEASE_RETENTION` 个），
原子切换 `current` 后重启本 unit——不再为每个 release 克隆整份源码树。

首次启用前必须先把 `current` 播种出来（否则 unit 因软链不存在而启动失败）。用 env 参数化
[`deploy/hal/deploy-bridge.sh`](deploy/hal/deploy-bridge.sh) 完成初次构建即可：

```bash
sudo AGENT_BRIDGE_ENV_FILE=/etc/agent-bridge/bridge.env \
  AGENT_BRIDGE_REPO=/opt/agent-bridge AGENT_BRIDGE_INSTALL_ROOT=/opt/agent-bridge \
  AGENT_BRIDGE_SERVICE=agent-bridge-wsl.service AGENT_BRIDGE_MACHINE_ID=dev-wsl \
  deploy/hal/deploy-bridge.sh
```

服务由 WSL 的 systemd 在启动时拉起，不依赖交互式登录或用户 manager：

```bash
sudo systemctl link /opt/agent-bridge/deploy/systemd/agent-bridge-wsl.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-bridge-wsl.service
sudo systemctl status agent-bridge-wsl.service
```

验证 Bridge 管理的 App Server：

```bash
curl http://127.0.0.1:4501/readyz
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
apps/control-plane   Hono HTTP 入口（/api、/control、/mcp/*）、WebSocket server、session routing
apps/bridge          Codex App Server adapter、Bridge client
packages/protocol    Bridge ↔ Control Plane 消息类型
packages/database    SQLite store
integrations/dsh-agent-control   DSH Agent Control 插件（out-of-tree DSH plugin）
deploy/systemd       Linux/WSL service units
tests                Node Test runner 测试
scripts              本地辅助脚本
```

## DSH Agent Control 插件

`integrations/dsh-agent-control` 是一个 out-of-tree DSH 插件。它把 Bridge conversation
物化为 DSH 原生 Agent、Session 和 Workspace，由原生 Sessions 树、Conversation、Composer、
approval 和 user-question 界面负责交互；Agent Control 只保留为管理 overlay。
插件不维护第二套会话浏览器或输入框，也不修改 DSH 本体。它通过 `cordis.patch.yml`
注入 Host 服务、Bridge execution provider 和 13 个 model tool，并作为 monorepo workspace
成员由根目录的 install/check/test/build 覆盖。

当前插件版本为 `0.2.0`，目标运行时是 TokensCowork 内置 DSH `0.1.3-alpha.1`；开发依赖
主要固定在 npm 已发布的 `0.1.2-rc.1`，所以发布前还必须运行 installed-runtime verifier。
现有能力包括稳定身份与分页历史投影、5 秒增量 reconciliation、原生 turn/interrupt、
approval/question、图片转发、目录 execution source 选择、同机器同路径 workspace 合并、
标题保留，以及 Bridge 真删除和本地 DSH 逻辑删除。

安装到 DSH Web profile：

```bash
dsh plugin --profile agent-control add file:/root/agent-bridge/integrations/dsh-agent-control
dsh --profile agent-control web
```

插件详细文档见 `integrations/dsh-agent-control/README.md`，当前整体事实见
[`docs/current-state.md`](docs/current-state.md)。

Codex App Server WebSocket transport 仍属于实验接口。升级 Codex CLI 后应先运行测试，并实际验证 approval request/response schema。
