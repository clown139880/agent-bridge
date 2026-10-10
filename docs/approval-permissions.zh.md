# Bridge 工具审批与权限体系（现状）

> 这份文档写的是**现在代码里实际怎么做**。改审批/权限相关代码或 `.env*` 之前先读它。
> Jev 自动分诊的设计方案（尚未实现）见 [jev-approval-triage-design.zh.md](jev-approval-triage-design.zh.md)。

一次 Claude 工具调用从发出到执行，依次经过下面几层，**前一层放行或拒绝了，后一层就不会看到它**：

```
claude 进程内（原生权限引擎）          Bridge（claude-adapter）               Control Plane / 人
deny 规则 → allow 规则 → permissionMode ─▶ canCallTool → handleToolPermission ─▶ approval_request ─▶ Matrix 反应 / DSH / Hermes 审批转发
```

## 1. Claude 原生权限（claude 进程内）

由 Bridge 启动 claude 时传入，配置在 Bridge 的 env 文件里（`apps/bridge/src/config.ts`）：

| 变量 | 作用 |
|---|---|
| `CLAUDE_PERMISSION_MODE` | `default` / `acceptEdits` / `plan` / `bypassPermissions`。`acceptEdits` 会自动接受**工作区内**（cwd 加上 `CLAUDE_ADDITIONAL_DIRECTORIES`）的文件编辑，工作区外的编辑仍要审批。`bypassPermissions` 跳过所有检查，Bridge 也不会再弹审批。 |
| `CLAUDE_PERMISSION_ALLOW` | JSON 数组，例如 `["Bash(git:*)","Read(**)"]`，命中后直接放行，不会到达 Bridge。 |
| `CLAUDE_PERMISSION_DENY` | JSON 数组，命中后直接拒绝。 |
| `CLAUDE_ADDITIONAL_DIRECTORIES` | 扩展工作区信任范围（`--add-dir`）。 |

求值顺序：deny → allow → mode → 交给 Bridge 的 `canCallTool`。

各机器使用的 env 文件：HAL Bridge 用 `/etc/agent-bridge/bridge.env`，WSL 用户态 Bridge 用 `~/agent-bridge/.env.bridge`（`deploy/systemd/agent-bridge-wsl-user.service`），Windows 原生 Bridge 见 `docs/windows-native.md`。
2026-10 review 时 WSL 侧的 `.env.bridge` 是：`CLAUDE_PERMISSION_MODE=acceptEdits`；`CLAUDE_PERMISSION_ALLOW=[Bash(git:*), Read(**)…, Glob, Grep, TodoWrite]`；`CLAUDE_AUTO_APPROVE=readonly`；没有配置 deny。
注意 `Bash(git:*)` 是按前缀匹配的，`git push` 和 `git reset --hard` 也会被它放行。

## 2. Bridge 自动放行（`apps/bridge/src/claude/claude-adapter.ts`）

`handleToolPermission` 只会收到原生引擎没有决定的调用：

- `AskUserQuestion` 走用户输入流程，不算审批。
- `CLAUDE_AUTO_APPROVE`：
  - `off`：全部弹审批。
  - `readonly`：只放行 `READONLY_TOOLS` = Read / Grep / Glob / LS / NotebookRead / WebSearch / WebFetch / TodoWrite。
  - `all`：全部放行。
- `CLAUDE_AUTO_APPROVE_TOOLS`：额外按**工具名**整体放行，例如 `["Bash"]` 会放行所有 Bash 命令。
- **Bash、Edit/Write/MultiEdit/NotebookEdit、所有 MCP 工具**在 `readonly` 模式下一律弹审批，不看命令内容。
- 审批选项是 `allow` / `deny` / `allow-session`。`allow-session` 把**工具名**加入 `session.sessionAllowedTools`：点一次之后，本会话里**所有** Bash 都不会再问，不区分具体命令。
- Codex app-server 的审批（`apps/bridge/src/app-server.ts`）由 Codex 自己的 approval policy 决定什么时候请求，Bridge 只负责转发。

## 3. Control Plane 与人工

- `apps/control-plane/src/server.ts` 里的 `handleApprovalRequest` 会落库（controlStore pending），把会话标记成 `blocked`，然后发到 Matrix 线程（用表情反应作答）。DSH 和 API 的 `/api/v1/approvals` 也能作答，通过 `reservePending` 保证只被处理一次。
- Bridge 重连时，会在 snapshot 里重新上报还没处理的审批，所以不会丢请求。

## 4. Hermes 审批转发（`integrations/hermes_agent_bridge/approval_relay.py`）

- 把 Kanban worker 的审批推到创建卡片的那个 Hermes 聊天，使用 Hermes 原生的 exec-approval 交互。
- **等不到回复（超时）或回复无法识别，都会被映射成 `deny`**（见 `_approval_choice`）。所以 agent 看到的 "denied" 有可能只是超时，并不代表用户真的拒绝了。排查"被拒绝"时要先区分这两种情况。
- 这里不提供 `allow_permanent`；只有请求本身提供 `allow-session` 选项时，才会显示 session 选项。

## 5. 已知问题

- 一段 14 分钟的 Claude 会话弹了大约 27 次审批，其中真正需要人工判断的只有 3~4 次。主要原因是 Bash 和 MCP 工具不看内容一律弹审批。
- `allow-session` 是按工具名放行的，粒度太粗：为了一条命令点了它，之后连高危命令也不会再问。
- `Bash(git:*)` 前缀规则把 `git push` 和 `reset --hard` 也放行了。
