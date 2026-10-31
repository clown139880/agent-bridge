# Bridge 工具审批与权限体系（现状）

> 这份文档写的是**现在代码里实际怎么做**。改审批/权限相关代码或 `.env*` 之前先读它。
> 当前采用**纯规则档**（第 6 节）：只靠 claude 原生 allow/deny 规则，不接 Jev。
> Jev 自动分诊的设计方案已**暂缓**，见 [jev-approval-triage-design.zh.md](jev-approval-triage-design.zh.md)。

一次 Claude 工具调用从发出到执行，依次经过下面几层，**前一层放行或拒绝了，后一层就不会看到它**：

```
claude 进程内（原生权限引擎）          Bridge（claude-adapter）               Control Plane / 人
deny 规则 → allow 规则 → permissionMode ─▶ canCallTool → handleToolPermission ─▶ approval_request ─▶ Control Center / DSH / Hermes（/mcp/bridge）
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
- 例外（2026-10-15，clown 决定）：中央记忆 MCP 服务（0.7 起是 `/mcp/memory`，客户端配置名 `memory`）的全部工具（`history_*`、记忆和技能工具，含写入）由原生规则 `mcp__memory` 放行，不再弹审批。写入都是 Git 提交，可撤回或归档。还没把配置名从 `conversation-memory` 改过来的机器继续靠 `mcp__conversation-memory`，两条规则在 0.8 去掉旧 `/mcp` 前并存。`/mcp/bridge` 的写操作（`create` / `turn` / `approve` / `answer` / `interrupt`）不在例外里，照常弹审批（只读的 `sessions` / `session` / `pending` / `workers` / `wait` 在 HAL 上已放行，见下文）：0.7.12 起所有 agent 都配有 `bridge`，可以跨项目、跨机器调度别的 session，每次调度都要经人允许；派出去的 session 的审批可以由派发它的 agent 回答（clown 2026-10-22 决定）。HAL 写在 `/root/.claude/settings.json` 的 `permissions.allow`（新会话即生效，不必重启 Bridge）；其他机器加在各自的 `~/.claude/settings.json`，或用第 6 节的 env 规则档。
- 审批选项是 `allow` / `deny` / `allow-session` / `allow-always`。`allow-session` 把**工具名**加入 `session.sessionAllowedTools`：点一次之后，本会话里**所有** Bash 都不会再问，不区分具体命令。Control Center 点它不再弹确认框（clown 2026-10-24）。
- `allow-always`（0.7.19 起，“永久允许”，只有 Claude 会话提供）：这台 Bridge 上的所有会话立刻放行这个工具名，并把同名规则追加进那台机器 `~/.claude/settings.json` 的 `permissions.allow`，之后启动的 claude 进程由原生规则放行。撤回就从那里删掉规则（Bridge 内存里的放行到重启为止）。会执行命令或改文件的工具（Bash、Monitor、Edit/Write/MultiEdit/NotebookEdit）不提供这个选项。`/mcp/bridge` 的 `approve` 不接受它：agent 不能替人做永久授权。
- 非 Bash、非文件编辑的工具，审批摘要会带上调用参数（截到 400 字），不再只显示 “X requested”。
- HAL 的 `/root/.claude/settings.json` 另外放行了只读工具 `Read`、`Grep`、`Glob`、`WebFetch`、`WebSearch` 和 `/mcp/bridge` 的只读工具 `mcp__bridge__sessions` / `session` / `pending` / `workers` / `wait`（clown 2026-10-24：读和回顾不需要逐个授权）。`create`、`turn`、`approve`、`answer`、`interrupt` 仍要审批。
- Codex app-server 的审批（`apps/bridge/src/app-server.ts`）由 Codex 自己的 approval policy 决定什么时候请求，Bridge 只负责转发。
  - 转发的请求：命令、文件改动、权限（`item/*/requestApproval`），以及 MCP 工具授权（`mcpServer/elicitation/request`，如 “Allow the memory MCP server to run tool …”）。0.7.30 之前 Bridge 不认 MCP 授权，它只出现在本地 TUI，远端看起来是工具一直在跑。
  - MCP 授权：`allow` 回 `accept`，`allow-session` 回 `accept` + `_meta.persist: "session"`（仅当 Codex 提供），`deny` 回 `decline`；Codex 的 “Always allow” 不经 Bridge 提供。要填表单字段或走 URL 的 elicitation 只能在 Codex 里完成，Bridge 只提供 `deny`。Codex Desktop 跟随会话的 MCP 授权仍需在 Desktop 里答。
  - 问答（`item/tool/requestUserInput`）带 `isBlocking: false` 时不阻塞 turn：会话保持 `active`，不计入 `pendingUserInputCount`，照常可以 steer；问题仍列在 `/user-input`（`blocking: false`），`wait` 只在它到达时返回一次。

## 3. Control Plane 与人工

- `apps/control-plane/src/server.ts` 里的 `handleApprovalRequest` 会落库（controlStore pending），把会话标记成 `blocked`，然后推送给 Control Center 和 DSH。Control Center、DSH 和 API 的 `/api/v1/approvals` 都能作答，通过 `reservePending` 保证只被处理一次。
- Bridge 重连时，会在 snapshot 里重新上报还没处理的审批，所以不会丢请求。

## 4. Hermes 代为审批（`/mcp/bridge`）

- 0.6.96 移除了 Kanban 插件里的审批转发（`approval_relay.py`）。Hermes 现在用 `/mcp/bridge` 的 `wait` 盯住自己派出的 turn：审批到来时 `wait` 返回 `state: "approval"`，Hermes 用 `approve`（`allow` / `deny` / `allow-session`）作答，拿不准的问用户。0.7 之前这套能力由 `abctl` 命令行提供（`wait` 退出码 10）。
- Hermes 不回答时审批保持 pending，不会超时变成 `deny`；Control Center 和 DSH 仍可作答，`reservePending` 保证只处理一次。
- 旧版转发把超时和无法识别的回复映射成 `deny`，排查 0.6.96 之前的 "denied" 时要先区分是不是超时。

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
4. 观察一段和基准差不多的会话，数 `/api/v1/approvals` 里的审批次数，再和 27 比。

回滚：恢复原来的 `CLAUDE_PERMISSION_ALLOW`，删掉 `CLAUDE_PERMISSION_DENY`，再重启同一个 unit。

## 中央工具库（0.7.45）

`/mcp/tools` 的 `tool_search`、`tool_call` 在 HAL 的 Claude `permissions.allow` 里整体放行（`mcp__tools`）。是否要人确认由 Control Plane 按登记表的档位判断：`auto` 直接执行，`review`/`human` 阻塞等人在控制中心首页决定（[tool-hub-design.zh.md](tool-hub-design.zh.md) §4.5）。这一层与 Bridge 的工具审批互不重复。

## 自动审核（0.7.51）

Bridge 报上来的审批（Claude 的 Bash、MCP 工具等），在通知任何人之前先过一道：

1. 硬边界（`apps/control-plane/src/approval-review.ts`）：删除、`git push`/`reset --hard`、改服务和进程、装包、`curl | sh`、读写密钥位置（`/etc/agent-bridge`、`.env`、OpenBao、`/proc/*/environ`、`env`）、部署脚本、`sudo`/`chown`、跨机 ssh/Windows，以及没有 `allow` 选项的请求，直接交给人。
2. 其余交给工具审核员（DeepSeek，`TOOL_REVIEW=off` 关闭）：`allow` 或 `deny` 由 Control Plane 以 `system:review` 身份答复 Bridge，这条审批不进 pending 列表，不推 Matrix 和手机，只发一条 silent notice（“🤖 已自动放行/拒绝”）；`human`、超时或出错照常交给人。
3. 审核在 Bridge 的消息链之外进行，不阻塞该 Bridge 的其他事件。
