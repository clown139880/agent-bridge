# Matrix 前端

0.7.31 起，Control Plane 可运行基于 `matrix-js-sdk` 的 Matrix 前端。它直接使用现有会话 API、可靠动作、审批 CAS、中央记忆和技能库；不依赖 Hermes/Python，也不创建另一套助手身份。

## 配置与上线

生产数据库、设备凭据和房间配置放在 Git checkout 外。Control Plane 的环境配置增加：

```dotenv
MATRIX_ENABLED=true
MATRIX_HOMESERVER=https://matrix.example.com
MATRIX_USER_ID=@bridge:example.com
MATRIX_CONFIG_FILE=/etc/agent-bridge/matrix.json
MATRIX_STATE_FILE=/var/lib/agent-bridge/matrix-device.json
# 二选一：MATRIX_ACCESS_TOKEN 或 MATRIX_PASSWORD，从本机获准的凭据配置读取。
# MATRIX_DEVICE_ID 可选；access token 必须对应这个设备。
```

`matrix.json` 示例（项目、用户、worker 和目录均须替换成实际配置）：

```json
{
  "rooms": [{
    "roomId": "!project:example.com",
    "scopeId": "repo-project",
    "users": ["@human:example.com"],
    "requireMention": false,
    "defaultTarget": "codex",
    "targets": {
      "codex": { "workerId": "codex@hal", "workspace": "/root/projects/project" },
      "claude": { "workerId": "claude@hal", "workspace": "/root/projects/project" },
      "pi": { "workerId": "pi@dev-wsl", "workspace": "/home/user/project" }
    }
  }]
}
```

只处理配置中的房间和 `users`；启动只加入明确配置的房间。`scopeId` 必须是已有中央记忆作用域；若中央记忆的房间绑定与这里冲突，拒绝运行，不回退全局作用域。工作目录控制执行位置，不决定房间身份。一个配置可包含多个房间、不同机器的目标。

设备登录结果以 `0600` 原子保存。重启复用同一 access token/设备，保证出站 transaction ID 的幂等作用域不变；不自动换 token 或借用其他机器上正在使用的机器人设备。`/health.matrix` 提供连接状态、最近同步时间、保留输入和待发送消息数，绝不暴露凭据。Matrix 网络故障不影响 Control Center 和 DSH。

发布遵守仓库的版本、推送和 `deploy/hal/deploy.sh` 流程。房间会话要求 worker 宣告 `session-memory` 能力；旧 Bridge 必须先升级。首次启用或新增房间只建立同步基线，不执行历史聊天。之后断线按保存的同步位置补取；遇到 limited timeline 会向前翻页寻找原锚点，找不到就暂停同步，不跳过缺口。

## 聊天与命令

所有命令同时支持 `!` 和 `/`。部分 Matrix 客户端会本地拦截 `/`，此时用 `!`。

| 命令 | 行为 |
| --- | --- |
| `!new` / `!new claude` | 切换到默认/指定目标的新会话，收到普通文字后才创建 |
| `!use <sessionId>` | 继续已有同项目会话；已有不同作用域时拒绝绑定 |
| `!status` | 显示作用域、worker、会话状态和模型 |
| `!stop` | 请求停止当前 turn，保留真实结束状态；不撤销已经执行的操作 |
| `!help` | 显示帮助 |
| `!retry` | 核对并重试保留的输入；结果不明的已发动作沿用原幂等键 |
| `!discard` | 放弃尚未发送的草稿；结果不明的已发送动作不被当作未执行 |
| `!drafts` / `!restore <编号>` | 查看旧草稿，明确返回它原来的会话绑定 |

房间主时间线和每个原生 `m.thread` 各有会话，共享房间作用域。普通引用回复不会创建线程。专用房间可处理所有普通文字；`requireMention: true` 的共享房间要求明确提及机器人，已经绑定的线程不需重复提及。

普通新任务统一为 **持久化输入 → 中断确切旧 turn → 等待实际终态 → 同一会话启动新 turn**。中断期间同一发送者的后续文字按到达顺序合并，直到提交正文冻结。停止未确认时保留输入，不并发启动、不偷偷改成 steer。其他客户端抢先启动 turn 时也由原 API 的活动 turn 校验拒绝冲突。

审批和提问消息记录确切 request ID。回复该消息的选项/数字，或添加提示列出的数字反应；审批还可用 ✅/❌。只接受原请求提供的选择，不扩大 `allow-session` / `allow-always` 的既有语义。多问题逐行 `1: 答案`、`2: 答案`；多选数字用逗号。秘密输入必须在本地客户端回答。其他客户端已作答时告知“已处理”，不把迟到回复变成新任务。没有回答就保持 pending。

## 附件批次

连续发送图片/文件只存草稿和回执反应，不启动 agent、不打断当前 turn。**单独的一条普通文字**封存此前附件并提交；媒体文件名和媒体 caption 都不是提交边界。命令、审批/问题回答不消耗草稿。

草稿按房间、线程、发送者、会话绑定代次隔离，存于 SQLite，重启可继续。文字到达时下载尚未完成也属于该批，稍后的附件进入下一批。会话切换保留旧草稿，用 `drafts` / `restore` 明确恢复，不偷偷移交给新 session。

沿用 API 的 8 个附件/批、15,000,000 字节/文件限制；超过限制、下载失败、附件被撤回或 worker 不支持都会保留整批并提示，不静默截断。音视频和加密媒体暂不支持。Codex 可将非图片文件落到 worker 本机供工具读取；Claude/Pi 仅接受图片；ACP 还校验 harness 的图片能力。缺少附件读取能力或下载失败不会只发送文字。

## 记忆与恢复

`roomId → scopeId → session_memory` 是持久关系，主线程、原生线程、不同 agent 和执行机器使用相同项目作用域。会话从网页/DSH 继续也经过同一中央上下文装配器，不按恢复时 cwd 改变身份。

上下文包含 `_global` 和项目核心记忆、置顶技能目录、显式 memory 工具作用域约定；角色卡继续通过已有 `memory.load`/技能加载。revision 是实际装配文本的 SHA-256，事实变化即使没有修改 `scope.md` 也会更新。仅动作被接受后记录已送达 revision；后续 turn 只在内容变化时补充上下文，不逐 turn 重写历史系统提示。作用域的 `prefetch` 开关控制当前项目和 `_global` 内的相关召回。

记忆不可用时只可使用同作用域的缓存；两者均不可用就保留输入。记忆绑定冲突不会用缓存掩盖。改变房间项目会建立新绑定代次/会话，旧作用域输入不能进入新项目。

收件 ledger 与 `/sync` cursor 在同一事务提交；出站使用持久 outbox 和稳定 Matrix transaction ID。输入动作和去重记录保留超过普通 API 的 24 小时动作窗口，防止长时间停机后重跑。附件字节继续按既有保留期清理，过期未提交附件可重新下载。未明确核对的 `bridge_timeout` / `action_outcome_unknown` 不自动生成新动作。

每个 turn 的目的房间/线程在观察到事件时固定。切换绑定不会把旧输出送往新会话；绑定现有会话从当前事件位置开始，审批另行对账，不倾倒历史。状态消息以 `m.notice` 节流编辑，回复正文以普通 `m.text` 发送，采用客户端正常正文颜色；消息不附带 Control Center 会话链接。Markdown 经 HTML 白名单清洗，长消息按字节切分。当前协议没有所有 harness 通用的 final/commentary 区分，最后一条完整助手消息作为最终回复，中间进展进入状态消息。

## 验证

`tests/matrix-gateway.test.ts` 覆盖草稿竞态、真实停止确认、重放、线程/发送者隔离、审批映射、旧 turn 路由、sync 缺口和 outbox 重试；`tests/session-memory-context.test.ts` 覆盖作用域恢复、事实 revision、API 防护；`tests/matrix-transport.test.ts` 使用本地 Matrix 假服务器验证 SDK 登录、设备持久化、认证媒体和事务 ID。

上线后检查 `/health.matrix.connected`，再在获准房间验证 `!status`、三张图后单独发文字、运行中发新任务、原生线程，以及网页接续。未配置/未连接时应明确区分“代码已部署”和“机器人已上线”。
