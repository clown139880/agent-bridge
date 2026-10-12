# 跨 agent 记忆运行说明

设计与决策见 [agent-memory-design.zh.md](agent-memory-design.zh.md)。

## 存储

- 事实源是 `AGENT_MEMORY_VAULT`（HAL：`/root/deathnote`）里的 `agent-memory/`，格式为 OMA v4.1 的子集，由 `packages/agent-memory` 读写。没有数据库和索引，每次请求都直接读文件，所以在 Obsidian 里改动后立即生效。
- 每次写入都是一次只包含该作用域目录的 git 提交，作者为 `agent-memory (<写入者>)`。提交在 `AGENT_MEMORY_LOCK`（HAL：`/run/lock/deathnote-git.lock`）下进行，这把锁与 deathnote 的自动提交 cron 共用。推送由 cron 负责。
- bootstrap 缓存写到 `AGENT_MEMORY_CACHE_DIR/<scope>.md`，在 checkout 之外。它只是 Control Plane 不可用时的只读兜底，可以随时删除。

## MCP

记忆工具挂在已有的 `POST /mcp` 上，按 token 分权：

| token | 工具 |
| --- | --- |
| `CONVERSATION_MCP_READ_TOKEN` | `conversation_*`，以及 `memory_resolve_scope/bootstrap/load/search/get/scopes` |
| `AGENT_MEMORY_TOKENS` 中的任一项 | 上述全部工具，加上 `memory_write/log/retract`。写入者身份取自 token，不取自参数 |

`memory_search` 先按空格分词做关键词匹配（命中词数越多越靠前）；一个都没命中时，退回整句召回：消息里出现主题名或别名得 3 分，每个共有的两字片段得 0.5 分（最多 3 分）。`mode: "recall"` 直接用整句召回，Hermes 插件的每轮召回走这个模式，只在 `scope.md` 写了 `prefetch: true` 的作用域开启。

`agent` 角色（Hermes、Dorothy）可以写 `_global`；`project` 角色（仓库里的 Codex/Claude/pi）只能写项目作用域。没绑定的房间或仓库，可以由写入者用 `memory_resolve_scope create=true` 建一个临时作用域（`status: provisional`）。

## 检查

```bash
curl -s -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_scopes","arguments":{}}}' \
  http://127.0.0.1:8787/mcp
```

文件写坏、绑定冲突、Syncthing 冲突副本，都会出现在 `memory_resolve_scope` 的 `warnings` 和 `AgentMemory.lint()` 的结果里。被跳过的文件不影响其余记忆的读取。

## 人设（SOUL 与角色卡）

人设作用域在目录里有一个 `soul.md`：一篇普通笔记，只由人在 Obsidian 里改，没有任何记忆工具会写它；同一作用域里的 facts/events 仍是 agent 可写的记忆。

- SOUL：`_agent-hermes`、`_agent-dorothy`。各 Hermes profile 的 `SOUL.md` 是指向对应 `soul.md` 的软链接，所以 cron 和子 agent 也按原机制加载；Hermes 每条消息重读 SOUL.md，改完即生效。插件注入自身作用域时用 `include_persona: false`，避免重复。
- 角色卡：`card-<名字>`（`discoverable: false`）。`memory_load` 返回人设加这张卡的记忆；对应的 Hermes 技能只是一句「加载 card-<名字>」。
- deathnote 自动提交脚本在任何 `soul.md` 改动后通知 Hermes 私聊。Hermes 有完整 shell 权限，「不改 soul.md」只能靠人设规则加这个审计；Dorothy 没有文件写工具。
