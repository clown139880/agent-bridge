# Matrix 连接器

Matrix 是 Agent Bridge 的一个聊天前端，以独立进程 `apps/matrix-connector` 运行（systemd `agent-matrix-connector.service`）。它只通过公开的 `/api/v1` 和 SSE 访问 Control Plane，用 `AGENT_TOKENS` 里自己的 token。改它不重启 Control Plane 和 Bridge。

## 绑定关系

| 关系 | 存在哪 |
| --- | --- |
| 房间 → 项目（记忆作用域） | 中央记忆 `scope.md` 的 `bindings.rooms`（`matrix:!id:server`）；旧的 `matrix_rooms` 继续可读，绑定时并入 `rooms`。Hermes 用同一份绑定 |
| 项目 → 工作目录 | 作用域的 `locations`（`机器:/路径`），没有时取该仓库（`repositories`）最近一次会话的目录 |
| 房间/线程 → 会话 | Control Plane `conversation_threads`（connector, room, thread → session） |
| 房间 → 新会话用的 agent | Control Plane `conversation_rooms`，默认 pi，`!new <agent>` 或绑定已有会话时更新 |

这两张表与具体连接器无关，以后的微信连接器用同一套 `/api/v1/conversations/<connector>/…`。

- 主时间线对应一个会话，一直延续，直到 `!new`。`!new` 后旧会话不再往这个房间发消息，即使在别处继续它。
- 在主时间线 @ 机器人：新开一个会话，在以那条消息为根的线程里回复。线程里的消息只发给该线程的会话，不必再 @。线程和主时间线同一作用域、同一目录，可以并发。
- 新会话按房间作用域开局注入 `_global` 和项目记忆（Codex `developerInstructions`、Claude `appendSystemPrompt`、pi `--append-system-prompt`），Bridge 重启后恢复会话时再按同一作用域注入。之后要什么记忆由 agent 通过 memory MCP 自己取；pi 没有 MCP 客户端，Bridge 启动它时加载 `apps/bridge/pi-extension/agent-bridge-mcp.ts`，把 `/mcp/memory`、`/mcp/bridge` 的工具注册为 `memory_*`、`bridge_*`（需要 Bridge 环境里有 `AGENT_TOKEN`）。ACP（grok）目前不注入。
- 没绑定的房间：Control Plane 设了 `CONVERSATION_SETUP_TARGET`（如 `claude@hal:/root/agent-bridge`）时，消息交给这个设置会话，它按你的描述建作用域和目录，再告诉你在房间里发哪条 `!bind`。设置会话不改变房间的新会话 agent。`!bind` 把原本没绑定的房间绑定后，设置会话结束、不再往房间发消息，下一条消息在作用域的目录里开新会话。没设这个变量时，房间只回复绑定提示。
- 作用域 id 要能看懂（0.7.49）：建作用域时用 scope 工具的 `scope_hint` 指定 id（如 `ops`），否则才生成 `room-xxxxxxxx`；已有的生成 id 用 memory MCP 的 `scope_rename` 改名，记忆、绑定、技能（agent-skills `scopes/<id>`）和定时任务（`automations/<id>`）一起搬。设置会话的开局指令也这样要求。
- 只处理 `MATRIX_ALLOWED_USERS` 里的人的消息，邀请也只接受他们的。

## 聊天

| 输入 | 行为 |
| --- | --- |
| 普通文字 | 发给当前会话；有正在运行的 turn 就先停止它、等真正结束再发（Matrix 没有停止按钮） |
| `!new [pi\|codex\|claude\|grok]` | 下一条消息开新会话，默认沿用上次的 agent |
| `!stop` | 停止当前 turn |
| `!status` | 作用域、会话、worker、目录、新会话 agent |
| `!bind <scope> [机器:/路径]` | 把房间（和一个目录）绑定到作用域，写入中央记忆；已被别的作用域占用时拒绝 |
| `!help` | 帮助 |

审批和单个问题的选项会预先作为反应贴在提示下面（1️⃣ 2️⃣ …），点一下就是回答；处理完连接器把这些反应撤掉。请求在你回答前失效（agent 重启、超时）或在别处处理时，房间里会说一声；之后再回答会提示已失效。

`!` 和 `/` 都可以。图片/文件先发，下一条文字会带上它们一起提交（每条最多 8 个，每个 15 MB；Claude/pi 只收图片）。审批和提问消息：回复数字/选项，或添加提示里的数字反应，审批也可用 ✅/❌。

turn 运行时显示“正在输入”，结束后把最后一条助手消息作为回复，末尾带一行小字页尾：哪个 agent（会话记录了模型时也写模型）、在哪台机器哪个目录、这轮用了多久，例如 `pi · hal:~/agent-bridge · 1m23s`。失败时回复错误。

房间当前对应的会话由房间提醒：UCTW App 推送对它降为 silent（失败除外），避免两边重复响，见 [MQTT 业务消息 v1](message-events-v1.zh.md)。`!new` 之后的旧会话仍按房间作用域恢复记忆注入（`conversation_sessions` 记录会话来自哪个房间）。

## 主动消息（notice）

不是回复 turn 的消息，比如 Control Plane 的上线和更新通知、以后的定时任务和 webhook，都先排进 Control Plane 的 notice 出站箱（`/api/v1/notices`），再由连接器发到房间。

- 连接器从事件流收到 `notice.upserted` 就发，发完回报消息 id；启动时补发还没发出的。Matrix 事务 ID 由 notice id 派生，重试不会重复发。机器人要先是目标房间的成员。
- notice 若代表某个会话（`sessionId`），以这条消息为根的线程绑定到该会话：在线程里回复，就接着那个会话继续。
- 在房间（或线程）里发消息时，这个位置自上一条消息以来（最多 12 小时、5 条）收到的 notice 会附在用户消息前面，标明“不是用户写的”。这样直接回一句“要”，会话也知道指的是哪条通知。代表当前会话自己的 notice 不附。
- 目标为 `app:<名字>` 的 notice 不经 Matrix，由 MQTT 发布器推给 App（`agent.notice`，见 [MQTT 业务消息 v1](message-events-v1.zh.md)）。HAL 上的生命周期通知用 `CONTROL_NOTICE_TARGET=app:operator`。
- `CONTROL_NOTICE_TARGET` 指向房间（`matrix:!room:server`）时，生命周期通知发到该房间：每 60 秒窗口内只立即发第一条，其余合并到下一条里；部署和更新结果（`🟢 控制面已启动 · 版本 …`、`🔄 更新完成：…`）、记忆审核结果从不合并。

## 状态与可靠性

连接器本地只有一个状态文件（`MATRIX_CONNECTOR_STATE`，0600）：sync 位置、SSE 游标、设备 token 和尚未回答的提示。首次启动只建立 sync 基线，不处理历史消息。创建会话和发 turn 用 Matrix 事件 ID 派生的幂等键，出站消息用稳定的事务 ID，所以重放不会重复执行或重复发送。崩溃时正在攒的附件会丢失，需要重发。

## 部署（HAL）

1. `/etc/agent-bridge/matrix-connector.env`，参照 `deploy/hal/matrix-connector.env.example`；Control Plane 的 `AGENT_TOKENS` 加一条 `matrix:<token>:agent`。
2. 推送后运行 `deploy/hal/deploy-matrix-connector.sh`：快进、只构建连接器、安装并重启它自己的 unit。
3. 只改 `apps/matrix-connector` 时只升它自己的 `package.json` 版本，不触发 Control Plane 部署。改 `/api/v1/conversations`、记忆绑定或协议时仍按根版本走 `deploy/hal/deploy.sh`。

验证：`journalctl -u agent-matrix-connector` 里有 `Matrix connector signed in`；在已绑定的房间发 `!status`。
