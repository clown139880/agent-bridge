# agent-bridge-memory（Hermes 记忆插件）

Hermes MemoryProvider：用 Control Plane `/mcp/memory` 上的记忆工具（`bootstrap/search/get/write/retract/load/scopes/scope`），取代内置的 MEMORY.md/USER.md。设计见 [`docs/agent-memory-design.zh.md`](../../docs/agent-memory-design.zh.md)。

- 用网关的 `chat_id` 找到房间对应的作用域（thread 归到所在房间；没绑定的房间会自动建临时作用域）。CLI 下用 cwd 和 Git remote 找。
- 开局注入固定的核心记忆：全局 + 当前房间，加上 `AGENT_MEMORY_SHARED_SCOPE`（Hermes 和 Dorothy 共用的隐藏作用域 `_assistants`）和 `AGENT_MEMORY_SELF_SCOPE`（如 `_agent-dorothy`）。会话中途不变，所以不影响 prompt 缓存。
- 工具（Hermes 里看到的名字）：`memory_search/get/load/scope`，主会话另有 `memory_write/retract`，分别转发到 `/mcp/memory` 的 `search/get/load/scopes/write/retract`。cron 和子 agent 只读。不指定 `scope` 时用当前房间；私聊用共享作用域（搜索时连同 `_global`），`_global` 只在显式指定时写入，只放所有 agent（包括 Bridge 下写代码的 agent）都该知道的画像、偏好和通用规则。
- 作用域 `scope.md` 写了 `prefetch: true` 时，每轮按整句召回当前房间和全局的相关记忆（最多 5 条、800 字符、1.5 秒超时），只补开局块里没有的内容。
- 会话结束时不自动记录任何东西（2026-10-15 去掉了机械交接）。0.8.0 去掉了 `memory_log`：进度和交接写在项目里或对话档案里，记忆只存长期有效的事实。
- `AGENT_SKILLS_SCOPES` 列出的作用域（或 `all`）在核心记忆后附加共享技能库的技能列表（当前房间 → 自己的作用域 → `_global`，6000 字符以内），配合 agent-bridge-skills 插件使用。
- Control Plane 不可用时，读取本房间缓存的快照（`$HERMES_HOME/cache/agent-memory/`），写入报错。

## 安装（以 dorothy profile 为例）

```bash
ln -s /root/agent-bridge/integrations/hermes_agent_memory ~/.hermes/profiles/dorothy/plugins/agent-bridge-memory
```

profile `.env`：`AGENT_MEMORY_TOKEN=<Control Plane AGENT_MEMORY_TOKENS 中该 profile 的 token>`，可选 `AGENT_MEMORY_URL`（默认 `http://127.0.0.1:8787/mcp/memory`，Bearer 即上面的 `AGENT_MEMORY_TOKEN`；旧的 `/mcp` 与旧工具名保留到 0.8）、`AGENT_MEMORY_SELF_SCOPE`、`AGENT_MEMORY_SHARED_SCOPE`。profile `config.yaml`：

```yaml
memory:
  provider: agent-bridge-memory
  memory_enabled: false
  user_profile_enabled: false
```

带工具白名单的 profile（如 dorothy-service-policy）要放行上面 6 个工具名。改完重启网关。

测试：`~/.hermes/hermes-agent/venv/bin/python -m pytest -q integrations/hermes_agent_memory/tests`
