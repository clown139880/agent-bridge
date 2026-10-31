# 定时任务与 Webhook（替代 Hermes cron / webhook）设计稿

状态：方案，未实现（2026-10-31）。

## 1. 要替代什么

Hermes 现在承担两类“无人发起”的工作，盘点自 HAL `~/.hermes` 两个 profile：

- **cron**：20 个 job（主 9 个、Dorothy 11 个），其中 3 个已暂停。
- **webhook**：8 个订阅，在 `0.0.0.0:8644` 上以 HMAC 校验。Control Plane 自己的上线和更新通知也借道这里：`DOROTHY_WEBHOOK_URL` 指向 `engine-notify`，合并后发到通知房间。

去掉 Hermes 之前，这两条链路必须先在 Agent Bridge 内落地。否则提醒、日报、出片回执和部署确认消息都会断。

现有任务归纳起来只有三种形态，cron 和 webhook 共用：

| 形态 | Hermes 写法 | 例子 |
| --- | --- | --- |
| 通知：零 LLM，渲染后直接投递 | webhook `deliver_only`，可带转换脚本 | gen-done、comfy-notify、deathnote-sync、washer-ready、engine-notify |
| 脚本：跑脚本，stdout 就是消息 | cron `script` + `no_agent` | YD-ZS 同步/日报/周报/月报、immich 备份、Homelab 监控、生长激素提醒 |
| agent：开一轮 agent，最后的回答就是消息；可先跑脚本，把输出注入 prompt | cron 带 prompt；webhook 非 deliver_only | Navi 日报、Crypto 周报、Horizon 晨报和热点速递、deathnote 冲突、gen-next、comfy-chain |

约定沿用 Hermes：输出为空或以 `[SILENT]` 开头时不投递，现有 prompt 和脚本不用改。

## 2. 总体结构

```text
触发（schedule：cron 表达式 / 间隔；webhook：POST /hooks/<name>）
  -> 运行（notify 渲染 / script 执行 / agent 会话）
  -> 结果文本（[SILENT] 则结束）
  -> notice 出站箱（Control Plane SQLite）
  -> 连接器投递（Matrix 房间 / 线程），或 MQTT 业务消息
```

不新增进程。Control Plane 本来就常驻，新增一个 `automations` 模块（与 `conversations.ts` 同级），调度、执行和出站箱都在里面。Matrix 连接器只多做一件事：消费 notice 并投递。Bridge 运行时不变，所以不升 Bridge 版本，也不触发车队自更新。

## 3. notice 出站箱（第一块，独立有用）

这是所有主动消息的唯一出口。连接器现在只会回复 turn，第一步先补上它。

- 表 `notices`：`id, connector, room_id, thread_id, text, level, source, session_id?, event_id?, created_at, delivered_at?`。
- 写入方有三个：
  1. automations 模块；
  2. Control Plane 自己的生命周期通知（取代 `DOROTHY_WEBHOOK_URL`）；
  3. 外部脚本，经 `POST /api/v1/notices`，用自己的 `AGENT_TOKENS` token。
- 投递：`/api/v1/stream` 增加 `notice.created`。连接器用 `notice:<id>` 作 Matrix 事务 ID 发送（重放不重复），成功后 `PUT /api/v1/notices/:id {eventId}` 回执。启动时补投 `delivered_at IS NULL` 的记录。
- 目标格式与记忆绑定一致：`matrix:!room:server`，可带 `#$threadRoot`。另有 `mqtt`，走现有 `message-publisher` 的 v1 业务消息，推到手机。
- **回复能接上**：notice 如果来自某个 agent 会话（agent 型任务），连接器投递后把以这条消息为根的线程绑定到该会话（`conversation_threads`）。在线程里回复，就接着那次运行继续，比如 deathnote 冲突“保留 HAL 版”、comfy-chain 的下一步。
- **主时间线有上下文**：用户常在主时间线直接回“要”（washer-ready）。所以连接器在把用户消息发给房间主会话前，先附上该房间自主会话上一轮以来的 notice（最多 N 条，标注为“房间里新近的通知”）。这样主会话的 agent 知道“要”指的是什么。
- Control Plane 生命周期通知改发 `CONTROL_NOTICE_TARGET`，即原来 engine-notify 的通知房间。文字保持 `🟢 控制面已启动 · 版本 <v>` 和 `🔄 更新完成：…` 不变，部署确认依赖这两句。合并和限流（原 `engine_notify_coalesce.py`）在 TS 里重写。过渡期两条通路并存，确认无误后再删 `DOROTHY_WEBHOOK_URL`。

## 4. automation 定义

```ts
interface Automation {
  id: string;              // slug，例：yd-zs-daily、comfy-chain
  title: string;
  scope?: string;          // 记忆作用域：默认投递房间取 bindings.rooms，agent 工作目录取 locations
  trigger:
    | { kind: "schedule"; cron?: string; everyMinutes?: number; tz?: string /* 默认 Asia/Shanghai */ ;
        catchUp?: "once" | "skip" }
    | { kind: "webhook"; secretRef: string; template?: string };   // 见第 6 节
  script?: { path: string; timeoutSec?: number; cwd?: string };    // 可单独用，也可作为 agent 的前置
  agent?: { agent: "pi" | "codex" | "claude"; model?: string; prompt: string;
            target?: string /* worker@machine:/path，缺省按 scope */; timeoutMin?: number };
  deliver: string[];       // ["matrix:!x:server"]、["mqtt"]、[]；缺省为 scope 的房间
  enabled: boolean;
}
```

运行时状态单独存 `automation_runs`：`id, automation_id, trigger_at, started_at, finished_at, status (ok|silent|failed|skipped|missed), session_id?, output (≤64 KiB), error`。Control Center 和 MCP 都从这里读执行历史。

定义的权威来源是 SQLite（`/api/v1/automations` 增删改）。另提供 `GET /api/v1/automations/export`，导出 JSON 作备份和审阅。

## 5. 执行语义

**调度**

- 单个定时器，指向最近一次到期时间；不按秒轮询。
- Control Plane 重启后：错过的触发若在宽限期内（默认 1 小时）且设了 `catchUp: once`，补跑一次；否则记为 `missed`，不补。
- 同一任务上一次还在运行时，本次记为 `skipped`，不并发。
- 时区默认 `Asia/Shanghai`，与 Hermes 的 `next_run_at` 一致。

**script**

- 只在 HAL 本机执行，由 Control Plane 的 systemd 单元派生子进程。
- `path` 必须解析到白名单根目录之内（`AUTOMATION_SCRIPT_ROOTS`）。不经 shell，不接受参数拼接。
- webhook 的请求体（JSON）从 stdin 传入；环境变量只给最小集，外加 `AUTOMATION_ID`、`AUTOMATION_RUN_ID`。
- stdout 截到 64 KiB；默认超时 10 分钟。
- 退出码非 0：记为 `failed`，并投递失败通知（含 stderr 尾部）。agent 型任务此时不再启动 agent。
- 目前全部脚本都在 HAL 上，所以第一期不做“在别的机器跑脚本”。真有需要时，再做成 Bridge action，届时才涉及 Bridge 版本。

**agent**

- 每次运行新开一个会话，复用 `/api/v1` 建会话的同一路径：按 `scope` 注入记忆，标题 `⏰ <title> · <日期时间>`。prompt 等于脚本输出（若有，放在顶部，标明“脚本输出”）加 `agent.prompt`。
- 以会话的 `turn.completed` 为结束信号，取最后一条助手消息作为结果。`turn.failed` 或超时（默认 30 分钟）则中断，并发失败通知。
- 无人值守时如果出现审批，照常进入现有 pending 流（Control Center、ntfy）；超过 15 分钟没人答，就按失败处理，通知里写明卡在哪个审批。所以 agent 型任务应在权限规则里预先放行它要用的工具，迁移时逐个确认。
- 不同运行之间的连续性（去重账本、偏好）靠记忆作用域和项目文件，不靠复用会话。这和 Hermes 每次新开的做法一致。

## 6. Webhook 入口

- 路由：`POST /hooks/<name>`，挂在 Control Plane 现有的 Hono 入口（`0.0.0.0:8787`）。局域网里的 HA 和 ComfyUI 机器可以直接访问，和原 8644 的暴露范围相同。
- 鉴权：每个 hook 一个 HMAC secret，按 `secretRef` 从 `/etc/agent-bridge/automation-secrets.env` 读取，不进库、不进日志。
  - 接受 GitHub 风格的 `X-Hub-Signature-256: sha256=<hex>`，Control Plane 现有的 `webhook.ts` 就用它。
  - Hermes 通用 HMAC（带时间戳的 V2）也兼容，前提是调用方确实在用它。迁移前逐个调用方确认请求头，只实现用到的方案。
- 先校验长度上限（1 MB）和签名，再读请求体。立即返回 `202 {runId}`，运行异步进行。
- 去重：有投递 ID 头时按它去重，否则按 body 哈希，10 分钟窗口。
- 模板：`{a.b}` 取 JSON 路径，缺失的字段渲染为空。也可以不用模板，改用 `script` 转换，stdout 即消息（对应 `comfy_done_fmt.py`、合并限流类脚本）。

## 7. 管理入口

- **REST**：`/api/v1/automations`（列表、读取、增改、暂停/恢复）、`POST …/:id/run`（手动触发，便于验证）、`GET …/:id/runs`。
- **MCP**：`/mcp/bridge` 增加 `automation_list`、`automation_runs`（只读，HAL 上放行）和 `automation_upsert`、`automation_pause`、`automation_run`、`automation_delete`（写入照常审批）。这样 agent 可以像 Hermes 的 `cronjob` 工具那样，替用户建提醒。
  - agent 可以创建 notify 和 agent 型任务。script 型只能引用白名单目录里已有的脚本，放脚本本身仍是一次写文件的审批。
  - 删除任务按全局规则需要人明确授权。
- **Control Center**：一个列表页，显示下次运行、上次状态和输出，可暂停或手动运行。放在最后做。

## 8. Hermes 迁移清单

| Hermes 项 | 形态 | 迁移 | 需要先解决 |
| --- | --- | --- | --- |
| YD-ZS 销售同步、经营日报/周报/月报、商品周报（Dorothy） | script | 直接迁，`cwd=/root/projects/yd-zs-sales` | — |
| immich-db-backup | script | 直接迁 | — |
| Homelab 服务状态监控 | script | 直接迁 | 它为已暂停的“故障诊断”写 pending-event，可以一并停用 |
| Horizon 日报生成 | script，不投递 | 直接迁，`deliver: []` | — |
| Immich 任务监控 | script | 先问是否还要（prompt 写着已无需监控） | — |
| 生长激素提醒 10 点/16 点 | script | 直接迁 | — |
| 生长激素确认循环 | script，依赖 Hermes `session_search` 查 DM 确认 | 改造：确认动作改为线程回复或主会话调用 `gh_inject_state.py --confirm` | 确认来源要换 |
| deathnote-auto-commit-push | script + agent | 迁，冲突消息线程绑定会话 | 投递到哪个房间（原 Hermes DM） |
| Navi DeFi 日报 | agent | 迁 | `navi_portfolio_pnl` 是 Hermes 侧工具，需要等价的 MCP |
| Crypto 周风险、投资风向周报 | agent | 迁 | web 检索工具；模型 deepseek-v4-flash 走哪个 agent |
| Horizon 私享晨报、热点速递 | agent（速递带前置脚本） | 迁 | 文件读写权限、horizon 记忆作用域 |
| 热点追踪-小度播报、Homelab 故障诊断 | 已暂停 | 不迁，记录后在 Hermes 侧保留存档 | — |
| engine-notify | notify（合并） | 由 Control Plane 内部 notice 取代 | — |
| gen-done、comfy-notify、deathnote-sync、washer-ready | notify | 迁，调用方改 URL 和 secret | 找到每个调用方（HA 自动化、ComfyUI 机器、deathnote 脚本） |
| gen-next、comfy-chain | agent | 迁 | hui-prompt-library 和 ComfyUI 工具在 Bridge agent 下是否可用 |
| comfy-debug | script，不投递 | 需要时再迁 | — |

逐项切换，不做双跑：在 Bridge 启用一项的同时，在 Hermes 暂停同一项，避免重复消息。washer-ready 回“要”之后要开烘干机，房间主会话的 agent 得有 Home Assistant 工具，这属于工具分发问题，不在本稿范围内。

## 9. 分期

1. **notice 出站箱**：`POST /api/v1/notices`、连接器投递与回执、主时间线通知上下文，Control Plane 生命周期通知改走内部 notice。Control Plane 升根版本；连接器升自己的版本，并单独部署。
2. **schedule + script + notify**：调度器、脚本执行、`/api/v1/automations`。迁移全部脚本型 cron。
3. **webhook 入口 + agent 运行**：`/hooks/<name>`、agent 会话、线程绑定、超时和审批失败。迁移通知型 hook，再迁 agent 型任务（按第 8 节的依赖逐个解决）。
4. **MCP 工具和 Control Center 页面**。

每期都只改 Control Plane 和连接器，不改 `apps/bridge`、`packages/protocol`、`deploy/windows-native`，Bridge 版本不动。

## 10. 待定

1. **脚本放哪**：沿用 `~/.hermes/scripts`，迁到 `/etc/agent-bridge/automations/`，还是收进一个私有仓库（像 agent-skills 那样有版本）？项目自带的脚本（YD-ZS）留在项目目录，并把项目目录加进白名单。
2. **agent 型任务默认用哪个 agent/model**：Dorothy 的任务现在用 deepseek-v4-flash。
3. **发送身份**：投递都以连接器的 Matrix 账号发出，Dorothy 的房间以后也是这个账号说话，是否接受。多身份另议。
4. **agent 自建任务**：是否允许 agent 不经人确认就创建 agent 型定时任务（只影响审批规则，不影响实现）。
