# 所有 agent 互相调度，记忆写入交给审核员

- 状态：一期已实现（0.7.12，clown 2026-10-22 决定）。工具审批的自动审核不在一期，见末节。
- 相关：[approval-permissions.zh.md](approval-permissions.zh.md)（工具审批）、[agent-memory-design.zh.md](agent-memory-design.zh.md) §5（写入权限）。

## 1. 决定

| 问题 | 决定 |
| --- | --- |
| 谁能调度别的 agent | 所有 agent（Hermes、Dorothy、Bridge 下的 Claude/Codex），可以派到任何机器、任何目录 |
| 怎样算“经你允许” | Claude 下 `mcp__bridge__*` 不在免审批名单，每次调度照常弹审批 |
| 派出去的 session 的审批 | 派发它的 agent 可以回答（和 Hermes 现在一样） |
| 写全局记忆、全局技能 | 不必等你：交给审核员（LLM）判断，拿不准才交给你 |
| token | 每个 agent 一枚，记忆和调度共用；token 只说明“是谁”，“能不能做”由 Control Plane 判断 |

## 2. token 整合

0.7.12 之前 Control Plane 认 6 类 token，Hermes 一个人就拿着三枚。现在只剩 3 类：

| 类别 | 变量 | 谁用 |
| --- | --- | --- |
| 机器 | `BRIDGE_TOKEN` | 各台 Bridge 注册 |
| 人 | `CONTROL_API_READ_TOKEN` / `CONTROL_API_WRITE_TOKEN` | Control Center、DSH；只有人的 token 能裁决交给人的审核 |
| agent | `AGENT_TOKENS`（旧名 `AGENT_MEMORY_TOKENS`） | 每个 agent 一枚：`/mcp/memory`、`/mcp/bridge`、`/api/v1` |

- 删除：`WORKER_API_ENABLED` / `WORKER_API_TOKEN`（只有 Hermes 的 `/ab` 在用）、`CONVERSATION_MCP_READ_TOKEN`（没人用了）。
- agent token 在 `/api/v1` 上的身份是 `agent:<名字>`，记在它发起的每个 action 上（`actions.principal`），所以能查到哪个 session 是谁派的。
- `agent` / `project` 角色只决定哪些记忆写入要审核，不再一刀切拒写。
- Bridge 只读自己的 env 文件（`BRIDGE_ENV_FILE`，默认 `.env.bridge`）。0.7.13 之前它还会读工作目录下的 `.env`，HAL Bridge 跑在仓库目录里，于是把 Control Plane 的人类 token 和全部 agent token 传给了它启动的 Codex/Claude，HAL 上的 agent 可以冒充你或别的 agent。
- 客户端：Hermes/Dorothy 的 `.env` 只留 `AGENT_TOKEN`（插件和 `/ab` 兼容旧名 `AGENT_MEMORY_TOKEN`），`config.yaml` 的 `bridge` 用 `${AGENT_TOKEN}`；各机器的 Claude（`~/.claude.json`）和 Codex（`~/.codex/config.toml`）在 `memory` 旁加一个 `bridge`，用同一枚 token。

## 3. 记忆和技能写入的审核

```
project agent 写 _global / _assistants / _agent-* 或这些作用域里的技能
  └─ 写入被暂存（memory_reviews 表），工具立即返回 review id，agent 不必等
       └─ 审核员：无工具的 claude -p
            ├ allow → 以提议的 agent 的名义写入（提交记录 by 该 agent），状态 applied
            ├ deny  → 丢弃，理由回给 agent（用 review 工具查），状态 denied
            └ human / 超时 / 出错 → 状态 waiting_human，Control Center 首页列出，你点允许或拒绝
```

- 触发条件不另写规则：原本会因 `forbidden` 被拒的写入（`write/retract/skill_write/skill_patch/skill_rm/skill_archive/skill_move`），现在都转成审核。agent 自己的项目作用域照旧直接写；Hermes/Dorothy（`agent` 角色）照旧直接写全局。
- 审核员看到：提议的完整参数，目标作用域的说明和当前核心记忆，同一槽位的现有事实，或者技能的现有内容。它被告知这些都是 agent 写的数据，不是给它的指令。
- 判断标准（提示词在 `apps/control-plane/src/memory-review.ts`）：
  - allow：内容适合目标作用域，持久，对读这个作用域的所有 agent 有用，不重复也不暗中矛盾；技能改动名副其实。
  - deny：放错作用域（项目细节、一次性状态、进度、仓库里已有的代码事实）、重复、价值低或格式不对，并说明该怎么做。0.7.57 起这只是建议：写入照样交给你（`waiting_human`，理由前缀“建议拒绝：”），只有人能拒绝（clown 2026-11-01：agent 不作恶，只会犯错）。
  - human：改变授权或审批方式、削弱安全规则、涉及凭据或删除策略、无证据地断言你的偏好或身份、加入外发数据或删除东西的命令、撤回或归档你可能依赖的内容，以及任何拿不准的情况。
- 为什么不用 Bridge session 当审核员：HAL 的 Bridge 放行全部 Bash，被注入的提议可能借审核员执行命令。审核员是 Control Plane 直接发起的一次模型调用，不带任何工具，注入最多影响一次判断，执行不了任何东西。
- 0.7.57 起记忆、工具库、工具审批共用一个审核员（`apps/control-plane/src/review-model.ts`）。0.7.58 起都经 TokensAPI（clown：AI 调用默认走 TokensAPI，只有需要供应商自身能力时才直连，比如 DeepSeek 的原生搜索）：先问 `deepseek-v4-flash`，出错、超时或没给出结论时问 `qwen3.8-flash-next`，密钥 OpenBao `shared/tokensapi#TOKENSAPI_API_KEY`；两个都不行就交给人。实测各约 1–2 秒（含思考）。模型只能放行或交给人，它的“拒绝”作为建议附在交给人的请求上。
- 每次结论都发 webhook `memory_review.status`（applied / denied / waiting_human / failed），在通知房间可见。
- 审核一次一个排队；Control Plane 重启时，审到一半的会重新审。
- 配置：`REVIEW_MODEL`（默认 `deepseek-v4-flash`）、`REVIEW_FALLBACK_MODEL`（默认 `qwen3.8-flash-next`，空值关闭兜底）、`REVIEW_TIMEOUT_MS`（每个模型 15 秒）；`MEMORY_REVIEW=off` / `TOOL_REVIEW=off` 时对应的一类一律交给人。`MEMORY_REVIEW_MODEL` / `MEMORY_REVIEW_COMMAND` 已不用。
- 接口：MCP `review`（agent 查结果）；`GET /api/v1/memory-reviews[?status=]`、`GET /api/v1/memory-reviews/{id}`；`POST /api/v1/memory-reviews/{id}/decision`（`{"choice":"allow"|"deny"}`，只接受人的 token，Control Center 用的就是它）。

## 5. 会话之间对话：reply（0.7.58）

一个作用域的会话找另一个作用域的会话对接事情，对方要能回话，而且回话不能因为审批卡住，也不能把你拉进一段你不需要看的对话（clown 2026-11-01）。

- **发起**：A 用 `create` 或 `turn` 找 B 时带上 `from_session_id`（A 自己的 session id）。Claude 和 pi 的会话开局系统提示里写着自己的 id（Bridge 0.7.40 起，进程环境里也有 `AGENT_BRIDGE_SESSION_ID`）；Codex 开局拿不到自己的 id，只能在被别人找过之后回话。
- **消息开头**：Control Plane 在 A 的消息前加一行 `[Agent Bridge 会话消息] 来自另一个会话 <A>（worker · 目录 · 标题）`，附一个回复 key（`rk_…`）。这一行只是提示，不授予任何权限。
- **回复**：B 调 `reply(reply_key, input)`。消息送进 A：A 在跑就补充进当前 turn，空闲就开新 turn，开头写明来自 B，并附一个新的 key，A 可以接着回。每个 key 只能用一次，24 小时内有效。
- **不审批**：key 本身就是许可（只有收到消息的会话拿得到它），`mcp__bridge__reply` 在 Control Plane 的自带把关名单里（`alreadyGated`），Claude 弹出的审批直接放行、不通知。回复只是文字，A 读到后要做的事仍然过 A 自己的审批。主动找一个会话（`create`/`turn`）照旧过审核员。
- **上限**：同一对会话一天内双向最多 20 条消息（`PAIR_MESSAGES_PER_DAY`），超过时 `reply`/`turn` 返回 `pair_limit`，并给你发一条通知。这是唯一会叫你的情况。
- **失败**：A 正在等审批或回答时消息送不进去，`reply` 返回错误，B 稍后再试；key 没用掉，仍然有效。
- 实现：`apps/control-plane/src/mcp/contacts.ts`（表 `session_contacts`）、`mcp/bridge.ts`。

## 4. 以后：工具审批

一期不动工具审批，也不做 shadow。以后要做时沿用同一个思路（硬规则在前，不可逆和高风险的一律交给人；灰色地带交给无工具的审核员；任何故障退回给人），它取代 [jev-approval-triage-design.zh.md](jev-approval-triage-design.zh.md) 的分类器方案。

## 6. 会话标题（0.7.76）

Claude 自己给会话起名（`/rename` 的 `custom-title`，否则 `ai-title`），Bridge 读到后更新过来。Codex 经 app-server 开的会话没人起名（Codex 的标题是 Desktop 客户端另起线程生成的，app-server 只转发 `thread/name/updated`），Pi 只拿第一句提示当名字。

所以非 Claude 会话的一轮完成后，如果它还没有名字，或者名字只是第一句提示的开头，Control Plane 用审核员模型（`deepseek-v4-flash`，失败用 `qwen3.8-flash-next`）根据开头的几条消息起一个 20 字以内的标题，写进 `sessions.auto_title`，只起一次，失败就等下一轮完成再试。显示时 agent 自己的名字优先：之后 Codex Desktop 或 agent 起了真正的名字，就改用那个。这个标题只存在 Control Plane，不会写回 Codex 或 Pi；会话搜索也匹配它。旧会话要等下一轮完成后才有标题。
