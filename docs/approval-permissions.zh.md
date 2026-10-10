# Bridge 工具审批与权限体系（现状）

> 这份文档写的是**现在代码里实际怎么做**。改审批/权限相关代码或 `.env*` 之前先读它。
> 当前采用**纯规则档**（第 6 节）：只靠 claude 原生 allow/deny 规则，不接 Jev。
> Jev 自动分诊的设计方案已**暂缓**，见 [jev-approval-triage-design.zh.md](jev-approval-triage-design.zh.md)。

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
注意 `Bash(git:*)` 是按前缀匹配的，`git push` 和 `git reset --hard` 也会被它放行。第 6 节的规则档把它换成了逐个子命令。
HAL 的 `/etc/agent-bridge/bridge.env` 现在是 `CLAUDE_PERMISSION_ALLOW=["Bash","Bash(git:*)",…]`：整个 `Bash` 工具都放行，没有 deny，所以 HAL 上的 Bash 从不弹审批，也不受第 6 节规则约束。

claude 进程还会读取所在机器的 `~/.claude/settings.json`（Bridge 没有传 `--setting-sources`），里面的 allow 规则同样生效。deny 规则不管来自哪里，都优先于任何 allow；env 文件里没法写 `ask` 规则。
规则写法（claude 2.1.286 上实测）：`Bash(前缀:*)` 要求前缀后面是词边界，所以 `git clean -f:*` 匹配不到 `git clean -fdx`；需要在中间放通配时用 `*` 写法，例如 `Bash(git push * --force*)`。`cd dir && git …` 这种写法 claude 自己一律要求审批，不管 allow 怎么配。

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
- MCP 工具和工作区外的文件编辑不受第 6 节规则影响，仍然每次弹审批。

## 6. 纯规则档（clown 2026-10 拍板，Kanban t_55b7dbf9）

只改 Bridge env 文件里的 `CLAUDE_PERMISSION_ALLOW` / `CLAUDE_PERMISSION_DENY`，不改代码，也不接 Jev。规则全文在 [`deploy/claude-permissions.env`](../deploy/claude-permissions.env)，目标是 dev-wsl 的 `.env.bridge`。

**放行（allow）**：只读和常规操作。
- git：去掉 `Bash(git:*)`，改成逐个子命令：status/log/diff/show/blame/grep/describe/rev-parse/ls-files、只读形式的 `git branch`、`git remote -v`、fetch、add、commit、`pull --ff-only`；另外放行 `git -C <dir>` 形式的 status/log/diff/show/rev-parse，因为 `cd dir && git …` 必定弹审批。
- 查进程、文件、服务、日志：ps、pgrep、stat、find、ss、df、du、free、uptime、which、jq、journalctl，以及 `systemctl [--user]` 的 status/show/cat/list-units/list-timers/is-*。
- 跑测试：`python[3] -m unittest`（包括 `PYTHONPATH=… ` 开头的写法）、pytest、`pnpm test`、`pnpm typecheck`、`pnpm exec tsc --noEmit`。注意跑测试会执行仓库里的代码。
- Windows 只读查询：`powercfg.exe /q`、`/query`、`/requests`、`/a`、`/l`、`/getactivescheme`。
- curl **不放行**：前缀规则分不清 GET 和 POST。

**拒绝（deny）**：直接拦下，不问人。只用于两类：一是不可逆、而且人想做可以自己做；二是只能靠 deny 盖过全局 `settings.json` 里宽 allow 的情况。
- `git reset --hard`、`git clean -f…`、强推（`push -f`、`--force`、`--force-with-lease`、`+refspec`）：会丢工作区改动或改写远端历史。AGENTS.md 本来就不允许没有明确要求的强推。
- 带 `-delete` / `-exec` / `-execdir` / `-ok` 的 find：放行 `find:*` 的代价。不加这几条的话，`find -exec rm` 会被静默放行。被拒后 agent 会立刻收到提示，可以改用 Grep 工具或 `| xargs`（后者会弹审批）。
- `journalctl --vacuum` / `--rotate` / `--flush`：放行 `journalctl:*` 的代价。
- 重启或停止 `agent-bridge*` / `agent-control-plane*`：会打断自己所在的会话和正在等待的审批。部署应该走自更新或 `deploy.sh`。
- `docker rm/rmi/stop/restart/kill/run/exec`、`compose down`、各种 prune：全局 `settings.json` 里有 `Bash(docker run *)` 这类宽 allow，只有 deny 能盖过它。等 clown 清理了全局文件里的这些条目，可以把它们从 deny 移走，改为问人。

**问人（ask）**：没写进 allow 的命令，Bridge 在 `readonly` 档下会弹审批，所以这里靠“不写进 allow”来实现。
- `git push`（不强推）：是正常交付步骤，但人要看推到哪里。用 deny 会让 agent 无法按 AGENTS.md 推送。
- `rm -rf`：前缀规则分不清是工作区内还是工作区外，用 deny 会连正常清理也挡掉。
- 其他服务的重启/停止、`systemctl daemon-reload`、装包（`pnpm/npm install`、`pip install`、`apt`、`sudo`）、`git checkout/switch/restore/stash/rebase/merge`、`git branch -D`、sqlite3 写操作：有正当用途，需要人判断。
- 已知例外：全局 `settings.json` 里的 `Bash(git checkout *)` 和几条一次性的 sqlite3 DELETE/UPDATE 精确命令仍会直接放行。这些要等 clown 清理那个文件时一起处理，规则档不去碰它。

**预期效果**：以 14 分钟会话约 27 次审批为基准，Bash 只读查询、跑测试、git 读和提交不再弹审批，估计会降到 **6~10 次**。剩下的是 MCP 工具、工作区外编辑、push/重启/装包这些真正需要判断的操作。MCP 调用占比越高，降幅越小；要更准的数，得拿上线后的审批记录来数。

**生效与验证**：
1. env 文件只在 Bridge 启动时读取，claude 的启动参数也只在会话进程启动时传入。所以改完要重启加载 `.env.bridge` 的那个 user unit。已经在跑的 claude 子进程沿用旧规则，直到空闲回收（默认 5 分钟）或 Bridge 重启。
2. 用 `ps -o args= -C claude`（或 `/proc/<pid>/cmdline`）看新会话的 claude 进程，确认带上了新的 `--allowedTools` 和 `--disallowedTools`。
3. 在新会话里依次试 `ps aux`、`git status`、`python3 -m unittest -h`：应该不弹审批。`git push --dry-run`：应该弹审批。`git reset --hard`：应该立即返回 “Permission … has been denied”，不弹审批。
4. 观察一段和基准差不多的会话，数 Matrix 线程或 `/api/v1/approvals` 里的审批次数，再和 27 比。

回滚：恢复原来的 `CLAUDE_PERMISSION_ALLOW`，删掉 `CLAUDE_PERMISSION_DENY`，再重启同一个 unit。
