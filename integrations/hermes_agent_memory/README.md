# agent-bridge-memory（Hermes 记忆插件）

Hermes MemoryProvider：用 Control Plane 的 `memory_*` MCP 工具，取代内置的 MEMORY.md/USER.md。设计见 [`docs/agent-memory-design.zh.md`](../../docs/agent-memory-design.zh.md)。

- 用网关的 `chat_id` 找到房间对应的作用域（thread 归到所在房间；没绑定的房间会自动建临时作用域）。CLI 下用 cwd 和 Git remote 找。
- 开局注入固定的核心记忆：全局 + 当前房间，加上 `AGENT_MEMORY_SELF_SCOPE`（如 `_agent-dorothy`）。会话中途不变，所以不影响 prompt 缓存。
- 工具：`memory_search/get/load/scope`，主会话另有 `memory_write/log/retract`。cron 和子 agent 只读。
- 作用域 `scope.md` 写了 `prefetch: true` 时，每轮按整句召回当前房间和全局的相关记忆（最多 5 条、800 字符、1.5 秒超时），只补开局块里没有的内容。
- 会话至少 3 轮时，结束时记一条机械交接（不用模型）。
- `AGENT_SKILLS_SCOPES` 列出的作用域（或 `all`）在核心记忆后附加共享技能库的技能列表（当前房间 → 自己的作用域 → `_global`，6000 字符以内），配合 agent-bridge-skills 插件使用。
- Control Plane 不可用时，读取本房间缓存的快照（`$HERMES_HOME/cache/agent-memory/`），写入报错。

## 安装（以 dorothy profile 为例）

```bash
ln -s /root/agent-bridge/integrations/hermes_agent_memory ~/.hermes/profiles/dorothy/plugins/agent-bridge-memory
```

profile `.env`：`AGENT_MEMORY_TOKEN=<Control Plane AGENT_MEMORY_TOKENS 中该 profile 的 token>`，可选 `AGENT_MEMORY_URL`、`AGENT_MEMORY_SELF_SCOPE`。profile `config.yaml`：

```yaml
memory:
  provider: agent-bridge-memory
  memory_enabled: false
  user_profile_enabled: false
```

带工具白名单的 profile（如 dorothy-service-policy）要放行上面 7 个工具名。改完重启网关。

测试：`~/.hermes/hermes-agent/venv/bin/python -m pytest -q integrations/hermes_agent_memory/tests`
