# 定时任务与 Webhook 设计稿

状态：方案，未实现（2026-10-31）。目标是替代 Hermes 的 cron 和 webhook，让 Agent Bridge 自己承担“无人发起”的工作。

本仓库是公开项目，这里只写通用机制。具体的任务定义、私人脚本和 Hermes 迁移清单放在私有的 agent-skills 仓库 `automations/` 下（见第 4 节）。

## 1. 三种任务形态

定时任务和 webhook 共用同一套形态：

| 形态 | 做什么 | 典型用途 |
| --- | --- | --- |
| notify | 零 LLM：把 webhook 请求体渲染成文字，或交给转换脚本，然后直接投递 | 出片回执、同步失败、家电提醒、Control Plane 自己的上线通知 |
| script | 跑脚本，stdout 就是消息 | 数据同步、经营报表、备份、服务巡检、定时提醒 |
| agent | 开一轮 agent，最后的回答就是消息；可先跑脚本，把输出注入 prompt | 日报和周报、新闻策展、冲突处理、产物接续处理 |

约定沿用 Hermes：输出为空或以 `[SILENT]` 开头时不投递，从 Hermes 迁来的 prompt 和脚本不用改。

## 2. 总体结构

```text
触发（schedule：cron 表达式 / 间隔；webhook：POST /hooks/<id>）
  -> 运行（notify 渲染 / script 执行 / agent 会话）
  -> 结果文本（[SILENT] 则结束）
  -> notice 出站箱（Control Plane SQLite）
  -> 连接器投递（Matrix 房间 / 线程），或 MQTT 业务消息
```

不新增进程。Control Plane 本来就常驻，新增一个 `automations` 模块（与 `conversations.ts` 同级），调度、执行和出站箱都在里面。Matrix 连接器只多做一件事：消费 notice 并投递。Bridge 运行时不变，不升 Bridge 版本，也不触发车队自更新。

## 3. notice 出站箱（第一块，独立有用）

这是所有主动消息的唯一出口。连接器现在只会回复 turn，第一步先补上它。

- 表 `notices`：`id, connector, room_id, thread_id, text, level, source, session_id?, event_id?, created_at, delivered_at?`。
- 写入方有三个：
  1. automations 模块；
  2. Control Plane 自己的生命周期通知；
  3. 外部脚本，经 `POST /api/v1/notices`，用自己的 `AGENT_TOKENS` token。
- 投递：`/api/v1/stream` 增加 `notice.created`。连接器用 `notice:<id>` 作 Matrix 事务 ID 发送（重放不重复），成功后 `PUT /api/v1/notices/:id {eventId}` 回执。启动时补投未送达的记录。
- 目标格式与记忆绑定一致：`matrix:!room:server`，可带 `#$threadRoot`。另有 `mqtt`，走现有 `message-publisher` 的 v1 业务消息。
- **回复能接上**：notice 如果来自某个 agent 会话，连接器投递后把以这条消息为根的线程绑定到该会话（`conversation_threads`）。在线程里回复，就接着那次运行继续。
- **主时间线有上下文**：用户常在主时间线直接回一句“要”。所以连接器在把用户消息发给房间主会话前，先附上该房间自主会话上一轮以来的 notice（最多 N 条，标注为“房间里新近的通知”），让主会话知道这句话回的是哪条通知。
- **Control Plane 生命周期通知**改发 `CONTROL_NOTICE_TARGET`，取代 `DOROTHY_WEBHOOK_URL`（它今天经 Hermes 的 webhook 合并、转发）。
  - 文字保持 `🟢 控制面已启动 · 版本 <v>` 和 `🔄 更新完成：…` 不变，部署确认依赖这两句。
  - 合并和限流在 TS 里实现。
  - 过渡期两条通路并存，确认无误后再删 `DOROTHY_WEBHOOK_URL`。

## 4. 任务定义：放在私有仓库

定义和脚本都是私人内容，不进本仓库。

- **位置**：Control Plane 读取 `AUTOMATIONS_DIR`，部署时指向 agent-skills checkout 的 `automations/`。目录结构 `<scope>/<id>/automation.yaml`，同目录放这个任务自己的脚本。`automations/` 与 `scopes/` 并列，技能扫描器不会把它当技能。
- **职责划分**：SQLite 只存运行时状态（下次运行、执行历史、待确认提案），定义本身以 Git 为准。
- **写入**：与技能库共用一个写入方和同一把锁。经 Control Plane 写入：`flock` → 校验 → 凭据扫描 → 一次提交 → 异步推送。人工改动按 agent-skills README 加锁提交，Control Plane 在自己提交后和文件变化时重新加载。

```yaml
# automations/<scope>/<id>/automation.yaml
title: 经营日报
trigger:                       # 二选一
  schedule: { cron: "20 9 * * *", tz: Asia/Shanghai, catchUp: once }   # 或 everyMinutes: 30
  # webhook: { secretRef: hook_report, template: "{emoji} {title}\n{detail}" }
script: { path: report.sh, cwd: /path/to/project, timeoutSec: 600 }    # 可选；相对路径相对本目录
agent:                         # 可选；省略 agent/model 时用部署默认值
  prompt: |
    ...
  target: pi@hal:/path         # 省略时按 scope 的 locations
  timeoutMin: 30
deliver: [matrix:!room:server] # 省略时为 scope 绑定的房间；[] 表示不投递
enabled: true
```

- 部署默认值：`AUTOMATION_DEFAULT_AGENT=pi`，`AUTOMATION_DEFAULT_MODEL` 由部署填写（HAL 上为 deepseek-v4-flash）。代码里不写死某个模型。
- 执行历史 `automation_runs`：`id, automation, trigger_at, started_at, finished_at, status (ok|silent|failed|skipped|missed), session_id?, output (≤64 KiB), error`。

## 5. 执行语义

**调度**

- 单个定时器，指向最近一次到期时间，不按秒轮询。
- Control Plane 重启后：错过的触发若在宽限期内（默认 1 小时）且设了 `catchUp: once`，补跑一次；否则记为 `missed`，不补。
- 同一任务上一次还在运行时，本次记为 `skipped`，不并发。

**script**

- 只在 Control Plane 所在机器执行，不经 shell，不接受参数拼接。
- 允许的脚本只有两处：任务自己的目录里的，以及 `AUTOMATION_SCRIPT_ROOTS` 白名单根目录之内的（例如项目仓库自带的报表脚本）。
- webhook 请求体（JSON）从 stdin 传入；环境变量只给最小集，外加 `AUTOMATION_ID`、`AUTOMATION_RUN_ID`。
- stdout 截到 64 KiB；默认超时 10 分钟。
- 退出码非 0：记为 `failed`，并投递失败通知（含 stderr 尾部）。agent 型任务此时不再启动 agent。
- 在别的机器跑脚本暂不做。真有需要时，再做成 Bridge action，届时才涉及 Bridge 版本。

**agent**

- 每次运行新开一个会话，复用 `/api/v1` 建会话的同一路径：按 `scope` 注入记忆，标题 `⏰ <title> · <日期时间>`。prompt 等于脚本输出（若有，放在顶部，标明“脚本输出”）加 `agent.prompt`。
- 以 `turn.completed` 为结束信号，取最后一条助手消息作为结果。`turn.failed` 或超时就中断，并发失败通知。
- 无人值守时如果出现审批，照常进入现有 pending 流（Control Center、ntfy）；超过 15 分钟没人答，就按失败处理，通知里写明卡在哪个审批。所以迁移 agent 型任务时，要在权限规则里预先放行它要用的工具。
- 不同运行之间的连续性（去重账本、偏好）靠记忆作用域和项目文件，不复用会话。

## 6. Webhook 入口

- 路由：`POST /hooks/<id>`，挂在 Control Plane 现有的 Hono 入口上。暴露范围与 Control Plane 相同。
- 鉴权：每个 hook 一个 HMAC secret，由 `secretRef` 从部署的 secret 文件读取，不进仓库、不进库、不进日志。
  - 接受 GitHub 风格的 `X-Hub-Signature-256: sha256=<hex>`，与 Control Plane 现有的 `webhook.ts` 相同。
  - Hermes 通用 HMAC（带时间戳的 V2）也兼容，前提是调用方确实在用它。迁移前逐个调用方确认请求头，只实现用到的方案。
- 先校验长度上限（1 MB）和签名，再读请求体。立即返回 `202 {runId}`，运行异步进行。
- 去重：有投递 ID 头时按它去重，否则按 body 哈希，10 分钟窗口。
- 模板：`{a.b}` 取 JSON 路径，缺失的字段渲染为空。也可以不用模板，改用 `script` 转换，stdout 即消息。

## 7. 管理与确认

**原则：新建任务、以及改动任务做什么，都要人确认后才生效。**

“做什么”指触发、脚本、prompt、目标和投递。暂停、恢复和手动运行一个已确认的任务不需要确认。删除也要确认，与全局规则一致。

- **提案**：agent 经 `/mcp/bridge` 的 `automation_propose`（新建、修改或删除）只生成一条提案，存在 SQLite 的 `automation_proposals`。此时不写文件，也不调度。
  - Control Plane 发一条 notice 到 scope 的房间（没有就发到通知房间），内容是任务的完整定义（修改时给出差异），并提示 ✅/❌。
  - Control Center 也列出待确认的提案。
  - 提案 7 天未确认就过期。
- **确认**：只有人能确认。具体有两条路：
  - Control Center 登录用户；
  - 连接器转发 `MATRIX_ALLOWED_USERS` 里的人对提案消息的 ✅ 反应。
  
  确认接口不在 `/mcp/bridge` 上，agent token 调用会被拒绝。所以 agent（包括驱动别人会话的 agent）没法替人确认，这和普通工具审批不同。确认后 Control Plane 才写入 `automation.yaml`、提交并开始调度。
- **只读与免确认操作**：`automation_list`、`automation_runs` 只读，在 HAL 上放行；`automation_pause`、`automation_run` 照常走工具审批。
- **人直接改**：在 Control Center 新建或修改，或者人工加锁提交到仓库，本身就是人的操作，不再二次确认。
- **REST**：`/api/v1/automations`（列表、读取、暂停/恢复）、`POST …/:id/run`、`GET …/:id/runs`、`/api/v1/automations/proposals`。

## 8. 从 Hermes 迁移

- 逐项切换，不做双跑：在 Bridge 启用一项的同时，在 Hermes 暂停同一项，避免重复消息。
- 每项先在私有仓库写好定义，经人确认后启用。先跑一次 `POST …/:id/run`，看到投递结果，再暂停 Hermes 的对应项。
- webhook 调用方要改 URL 和 secret。迁移前逐个找到调用方，确认它用的签名请求头。
- 依赖 Hermes 专有工具的任务（Hermes 插件工具、`session_search` 等）要先有等价的 MCP 或改造，再迁。
- 具体清单见私有仓库 `agent-skills/automations/hermes-migration.md`。

## 9. 分期

1. **notice 出站箱**：`POST /api/v1/notices`、连接器投递与回执、主时间线通知上下文，Control Plane 生命周期通知改走内部 notice。Control Plane 升根版本；连接器升自己的版本，并单独部署。
2. **schedule + script + notify**：读取 `AUTOMATIONS_DIR`、调度器、脚本执行、执行历史。迁移脚本型任务。
3. **webhook 入口 + agent 运行**：`/hooks/<id>`、agent 会话、线程绑定、超时和审批失败。
4. **提案与确认**：MCP 工具、Matrix ✅ 确认、Control Center 页面。在这一期上线前，任务只由人直接提交到私有仓库。

每期都只改 Control Plane 和连接器，不改 `apps/bridge`、`packages/protocol`、`deploy/windows-native`，Bridge 版本不动。

## 10. 已定

- 发送身份：投递都以连接器的 Matrix 账号发出。多身份另议。
- agent 型任务默认 pi + deepseek-v4-flash（部署配置）。
- 定义和私人脚本放 agent-skills 仓库的 `automations/`。
- agent 创建或修改任务必须经人确认。
