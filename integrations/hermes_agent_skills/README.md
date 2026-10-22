# agent-bridge-skills（Hermes 技能插件）

把 Hermes 内置的 `skills_list`、`skill_view`、`skill_manage` 换成共享技能库（Control Plane `/mcp/memory` 上的技能工具：`skills/skill_search/skill/skill_write/skill_patch/skill_rm/skill_archive/skill_move`）。设计见 [`docs/agent-skills-design.zh.md`](../../docs/agent-skills-design.zh.md)。

- 会话的作用域：从 profile 的 `state.db` 读会话的 `chat_id`（房间），再用 `/mcp/memory` 的 `scope` 解析；CLI、cron 等没有房间的会话按 `_global`。
- 可见范围：当前作用域 → `AGENT_MEMORY_SELF_SCOPE` → `_global`。`AGENT_SKILLS_LOAD_ALL=true` 时 `skill_view` / `skill_manage` 能到达全部作用域（Hermes 用）。
- `skill_manage` 的新建写到当前房间的作用域；修补、写文件、删文件、删除（归档）作用于技能所在的作用域。后台 review 沿用主会话 id，所以自动沉淀也落到同一作用域。
- 技能库里没有的技能（Hermes 自带、hub 安装、跳转桩）交回内置工具处理。
- 技能库不可用时，读取类工具交回内置工具；`skill_manage` 报错，不在本地落盘。
- 试点：只有 `AGENT_SKILLS_SCOPES` 列出的作用域走技能库，其他会话保持原样。提示词里的技能列表由 agent-bridge-memory 在同样的作用域里附加。

## 安装（以 dorothy profile、试点 jmyd 为例）

```bash
ln -s /root/agent-bridge/integrations/hermes_agent_skills ~/.hermes/profiles/dorothy/plugins/agent-bridge-skills
```

`config.yaml`：`plugins.enabled` 加 `agent-bridge-skills`，并设

```yaml
plugins:
  entries:
    agent-bridge-skills:
      allow_tool_override: true
```

profile `.env`（与记忆插件共用 `AGENT_TOKEN`、`AGENT_MEMORY_SELF_SCOPE`）：

```bash
AGENT_SKILLS_SCOPES=jmyd   # 逗号分隔，或 all
```

重启网关生效。回滚：删掉 `AGENT_SKILLS_SCOPES` 或从 `plugins.enabled` 移除。

测试：`~/.hermes/hermes-agent/venv/bin/python -m pytest -q integrations/hermes_agent_skills/tests`
