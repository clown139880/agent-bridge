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
  - deny：放错作用域（项目细节、一次性状态、进度、仓库里已有的代码事实）、重复、价值低或格式不对，并说明该怎么做。
  - human：改变授权或审批方式、削弱安全规则、涉及凭据或删除策略、无证据地断言你的偏好或身份、加入外发数据或删除东西的命令、撤回或归档你可能依赖的内容，以及任何拿不准的情况。
- 为什么不用 Bridge session 当审核员：HAL 的 Bridge 放行全部 Bash，被注入的提议可能借审核员执行命令。现在审核员由 Control Plane 直接启动 `claude -p`：`--tools ""`、`--strict-mcp-config`、空的临时目录，只加载用户设置（API 端点在里面），不继承 Control Plane 的环境变量。注入最多影响一次判断，执行不了任何东西。
- 每次结论都发 webhook `memory_review.status`（applied / denied / waiting_human / failed），在通知房间可见。
- 审核一次一个排队；Control Plane 重启时，审到一半的会重新审。
- 配置：`MEMORY_REVIEW_MODEL`（默认 `sonnet`）、`MEMORY_REVIEW_COMMAND`（默认 `claude`）、`MEMORY_REVIEW_TIMEOUT_MS`（默认 180 秒）；`MEMORY_REVIEW=off` 时一律交给人。
- 接口：MCP `review`（agent 查结果）；`GET /api/v1/memory-reviews[?status=]`、`GET /api/v1/memory-reviews/{id}`；`POST /api/v1/memory-reviews/{id}/decision`（`{"choice":"allow"|"deny"}`，只接受人的 token，Control Center 用的就是它）。

## 4. 以后：工具审批

一期不动工具审批，也不做 shadow。以后要做时沿用同一个思路（硬规则在前，不可逆和高风险的一律交给人；灰色地带交给无工具的审核员；任何故障退回给人），它取代 [jev-approval-triage-design.zh.md](jev-approval-triage-design.zh.md) 的分类器方案。
