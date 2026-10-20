# 跨 agent 记忆运行说明

设计与决策见 [agent-memory-design.zh.md](agent-memory-design.zh.md)。

## 存储

- 事实源是 `AGENT_MEMORY_VAULT`（HAL：`/root/deathnote`）里的 `agent-memory/`，格式为 OMA v4.1 的子集，由 `packages/agent-memory` 读写。没有数据库和索引，每次请求都直接读文件，所以在 Obsidian 里改动后立即生效。
- 每次写入都是一次只包含该作用域目录的 git 提交，作者为 `agent-memory (<写入者>)`。提交在 `AGENT_MEMORY_LOCK`（HAL：`/run/lock/deathnote-git.lock`）下进行，这把锁与 deathnote 的自动提交 cron 共用。推送由 cron 负责。
- bootstrap 缓存写到 `AGENT_MEMORY_CACHE_DIR/<scope>.md`，在 checkout 之外。它只是 Control Plane 不可用时的只读兜底，可以随时删除。

## MCP

记忆工具挂在 `/mcp/memory`（官方 MCP SDK，无状态 Streamable HTTP）上，按 token 分权。客户端配置 URL `http://<control-plane>:8787/mcp/memory`、请求头 `Authorization: Bearer <token>` 和 `Accept: application/json, text/event-stream`，server 名用 `memory`，工具显示为 `mcp__memory__<工具>`。`tools/list` 只列出该 token 可用的工具。旧的 `/mcp` 端点保留到 0.8，沿用旧名 `memory_*` / `conversation_*`（也接受新名），每次调用计入 `/health` 的 `legacyMcpCalls`。

| token | 工具 |
| --- | --- |
| `CONVERSATION_MCP_READ_TOKEN` | `history_search/history_review/history_read`，以及 `scope/bootstrap/load/search/get/scopes` |
| `AGENT_MEMORY_TOKENS` 中的任一项 | 上述全部工具，加上 `write/retract`。写入者身份取自 token，不取自参数 |

`search` 先按空格分词做关键词匹配（命中词数越多越靠前）；一个都没命中时，退回整句召回：消息里出现主题名或别名得 3 分，每个共有的两字片段得 0.5 分（最多 3 分）。`mode: "recall"` 直接用整句召回，Hermes 插件的每轮召回走这个模式，只在 `scope.md` 写了 `prefetch: true` 的作用域开启。

`agent` 角色（Hermes、Dorothy）可以写 `_global`；`project` 角色（仓库里的 Codex/Claude/pi）只能写项目作用域，不能写下划线开头的作用域。没绑定的房间或仓库，可以由写入者用 `scope create=true` 建一个临时作用域（`status: provisional`）。

## 作用域分工（0.6.98）

- `_global`：只放所有 agent 都该知道的事——你的画像、通用偏好、通用规则。Bridge 下写代码的 agent 每个会话都会看到它，所以不放 HAL 运维细节、助理之间的约定或一次性的事。
- `_assistants`（`discoverable: false`）：Hermes 和 Dorothy 共用、其他 worker 不需要的记忆，例如服务和设备的用法、HAL 上的环境经验、两个助理的分工。两个 profile 用 `AGENT_MEMORY_SHARED_SCOPE=_assistants` 注入；私聊里不指定作用域时读写都落在这里（搜索时连同 `_global`）。
- `_agent-hermes`、`_agent-dorothy`：各自的人设和职责规则。
- 没有进度日志：0.6.98 去掉了 `memory_log` 和 bootstrap 里的「最近进展」。进度写在项目里（提交、文档），需要回溯时查对话档案。旧的 `events/` 文件留在库里，不再读取。

## Bridge 会话的开局注入

Bridge 开新会话前用自己的 `BRIDGE_TOKEN` 调 `GET /memory/bootstrap?machine_id=&cwd=&repository=`，Control Plane 按机器、目录和仓库解析作用域（不新建），返回 `_global` 加项目作用域的 bootstrap。Codex 放进 `thread/start` 的 `developerInstructions`（只在新线程，之后随线程保存）；Claude 每次启动进程都放进 `--append-system-prompt`。超时 2 秒，失败就不带记忆照常开局。所以 Bridge 下的 agent 不必再调 `scope`/`bootstrap`，只在要写入时用 MCP。

## 检查

```bash
curl -s -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"scopes","arguments":{}}}' \
  http://127.0.0.1:8787/mcp/memory
```

文件写坏、绑定冲突、Syncthing 冲突副本，都会出现在 `scope` 的 `warnings` 和 `AgentMemory.lint()` 的结果里。被跳过的文件不影响其余记忆的读取。

## 人设（SOUL 与角色卡）

人设作用域在目录里有一个 `soul.md`：一篇普通笔记，只由人在 Obsidian 里改，没有任何记忆工具会写它；同一作用域里的 facts 仍是 agent 可写的记忆。

- SOUL：`_agent-hermes`、`_agent-dorothy`。各 Hermes profile 的 `SOUL.md` 是指向对应 `soul.md` 的软链接，所以 cron 和子 agent 也按原机制加载；Hermes 每条消息重读 SOUL.md，改完即生效。插件注入自身作用域时用 `include_persona: false`，避免重复。
- 角色卡：`card-<名字>`（`discoverable: false`）。`load` 返回人设加这张卡的记忆；对应的 Hermes 技能只是一句「加载 card-<名字>」。
- 改动历史在 deathnote 的 git 里，不另做通知。

## 技能库

共享技能库（设计见 [agent-skills-design.zh.md](agent-skills-design.zh.md)）挂在同一个 `/mcp/memory` 上，配置 `AGENT_SKILLS_REPO` 后启用：

| token | 工具 |
| --- | --- |
| 记忆读者（`CONVERSATION_MCP_READ_TOKEN`） | `skills`、`skill_search`、`skill` |
| `AGENT_MEMORY_TOKENS` 中的写入者 | 上述加 `skill_write`、`skill_patch`、`skill_rm`、`skill_archive`、`skill_move` |

- 技能目录是 `scopes/<scope>/<category>/<skill>/SKILL.md`；一个技能目录里只能有一个 `SKILL.md`。
- 每次写入是一次只含该技能目录的提交，作者为 `agent-skills (<写入者>)`，在 `AGENT_SKILLS_LOCK` 下进行，之后后台 `git push`（失败不影响写入，下一次推送会带上）。
- `project` 写入者不能写下划线开头的作用域（`_global`、`_agent-*`）。
- 归档会把技能目录移到 `AGENT_SKILLS_ARCHIVE_DIR`，Git 历史保留原内容。
- 凭据扫描与记忆相同，命中就拒写。
