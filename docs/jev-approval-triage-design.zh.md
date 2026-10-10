# 设计：用 Jev 自动分诊工具审批（哪些人工、哪些放行）

- 状态：**设计稿，未实现**（Kanban t_57698007）。本文不改任何代码或配置。
- 权限体系现状：[approval-permissions.zh.md](approval-permissions.zh.md)。读本文前先读它。
- 参考实现：`/root/projects/call-bridge` 的查证路由（`search_router.py`、`hermes_delegation.py`、`config.py`）。

## 0. 目标与非目标

**目标**：把只读查询、常规的工作区内操作、跑测试这类可逆的低危审批自动放行。人工只看真正需要判断的那 3~4 次，不再是现在的 27 次。

**非目标**：
- Jev **不替代**任何权限校验。claude 原生 deny/allow、acceptEdits、Bridge 的 readonly 集合全部原样保留，Jev 只在它们之后、人工之前加一层**粗过滤**。
- Jev **永不拒绝**。它只有两个出口：`auto_allow` 和 `human`（交给人，和现在一样）。拒绝只能由人或代码规则做出。
- **不限制** agent 的写法。多条命令写成一行是高效做法，不拦也不惩罚；分类器负责把它拆开来判断（§3.2）。

## 1. call-bridge 是怎么接入 Jev 的（照这个路子）

| 方面 | call-bridge 现状 | 本设计照搬或调整 |
|---|---|---|
| 端点 | OpenRouter decisions API `https://openrouter.ai/api/alpha/decisions`（`OPENROUTER_DECISIONS_URL`）；请求和返回的格式与 OpenCode Zen `systemone` 相同 | 照搬 |
| 模型 | `typesafe/jev-1.13`（会解析到带日期的快照 `-20260917`），可配置（`PI_OPENROUTER_JEV_MODEL`） | 照搬，变量名用 `APPROVAL_TRIAGE_JEV_MODEL`；审计里记录实际快照 |
| 请求 | `{model, state: <文本>, questions: {needs_search: {type:"noul", instructions, criteria:{true,false}}}}` | 同样的格式，换成审批相关的命题（§4） |
| 返回 | `answers.needs_search.noul` 就是 yes 概率；不是数字 → `error` | 照搬，并加上双命题一致性校验 |
| 判定 | `prob >= threshold(0.6)` | 改成**高阈值单向放行**，详见 §5 |
| 时限 | 总时限 `PI_SEARCH_DEADLINE=3.0s`，期间最多重试 1 次；用 `asyncio.shield` 让迟到的回答在后台完成，保持连接是热的 | 照搬：总时限 2.5s，最多重试 1 次 |
| 失败处理 | 超时或出错 → **回退到原行为**（正则判断 / 不查证） | 超时或出错 → **交给人**（§6） |
| 连接 | 长 keep-alive（120s）加启动预热，因为经代理的冷 TLS 握手要 1–12s | 照搬 |
| Key | `OPENROUTER_API_KEY` 只放在 `/root/.hermes/.env`（与 Hermes 共用），repo 里的 `.env` 不放 key | 复用同一个 key 源，但**只读取这一个变量**（§7） |
| 成本和延迟 | 每次约 $0.0000185，热连接约 0.25s | 每天几百次审批，成本可以忽略 |

调研时发现：call-bridge 的 `run/baseline/hermes-*/` 快照目录里有**明文的 OpenRouter key**（`hermes.env`、`dorothy.env`）。本卡没有动它，建议另开一张卡清理并轮换 key。

## 2. 架构与接入点

### 2.1 放在哪一层

审批链路：`claude 原生规则 → Bridge readonly 集合 → approval_request → Control Plane → 人`。

**推荐把 Jev 放在 Control Plane（HAL）的 `handleApprovalRequest` 里，位于"落库"和"通知人"之间。**

```
Bridge(任意机器)                         Control Plane (HAL)
approval_request ──ws──▶ handleApprovalRequest
  (+ 结构化 request 字段)    │ upsertApproval(pending, status=triaging)  ← 不推 Matrix、不出现在 /approvals 列表
                             ▼
                        ① 确定性分类器 (packages/approval-policy)
                           HARD_HUMAN ─────────────────────────────┐
                           GRAY ──▶ ② Jev (≤2.5s, 双命题)          │
                                       auto_allow ──▶ approval_response(allow) 给 Bridge
                                       │              记录 resolver=triage:jev
                                       human/超时/出错/熔断 ─────────┤
                                                                   ▼
                                                    现有流程：status=pending，推 Matrix、DSH、Hermes 转发
```

选这一层的理由：
1. **Key 只在 HAL 一处**，和 call-bridge 一样从 `/root/.hermes/.env` 读取。WSL 和 Windows Bridge 不需要拿到 key，Bridge 也不会把 key 传给它启动的 claude 子进程。
2. **一份策略覆盖所有 Bridge 和所有 provider**：Claude adapter 和 Codex app-server 的审批都从这里经过。
3. **审计集中**：决定写进 controlStore，和人工决定用同一张表。
4. **失败时自然回到旧路**：Control Plane 不可用时，审批本来就到不了人，这和现状一样，没有引入新的失败模式。Jev 不可用时，直接走现有的通知分支。

代价：
- 需要协议**新增一个可选字段**（§2.2）。旧 Bridge 不发这个字段时，Control Plane 拿不到结构化内容，一律当 `human` 处理，所以新旧版本可以混跑。
- 每次审批多一次 ws 往返，大约几十毫秒。

备选方案（不推荐）：放在 Bridge 的 `handleToolPermission`，在 emit 之前判断。好处是不改协议、延迟更低。坏处是三台机器都要放 OpenRouter key，Windows Bridge 还要另走 key 分发；策略也会三处部署、版本各自不同。→ 列为待决 D1。

### 2.2 协议补充（additive）

`ApprovalRequestMessage` 增加一个可选字段：

```ts
request?: {
  provider: "claude" | "codex";
  tool: string;                 // "Bash" / "Edit" / "mcp__x__y" / "commandExecution" ...
  input: Record<string, unknown>; // 截断到 4 KB，Bridge 侧先脱敏
  cwd?: string;
  workspaceRoots: string[];     // cwd + CLAUDE_ADDITIONAL_DIRECTORIES（Codex：sandbox writable roots）
  host: string;                 // machineId 之外再标注一下 OS：linux / wsl / windows
}
```

`summary` 不变，人看到的内容和现在一样。

### 2.3 拦哪些请求

- **只处理会到达人工的请求**。原生 allow、Bridge 的 `READONLY_TOOLS`、`CLAUDE_AUTO_APPROVE_TOOLS`、`allow-session` 已经放行的调用不会产生 `approval_request`，自然**不会喂给 Jev**。
- 第一阶段只处理 Claude 的 `Bash`，以及工作区**外**的 `Edit/Write`（工作区内的编辑已经由 acceptEdits 放行）。
- 第二阶段处理 Codex `commandExecution` 和 MCP 工具（§8）。
- `AskUserQuestion` 和用户输入**永远不进**分诊。
- Bridge 重连时 snapshot 重放的审批（`server.ts` 约 720 行）**跳过分诊直接交给人**。原因是这类审批可能已经等了很久，或者 Control Plane 重启前已经分诊过一半；直接交给人最保守，也不会丢。

## 3. 确定性分类器（硬边界，写在代码里，不靠模型）

放在新包 `packages/approval-policy` 里，是纯函数，有完整的单元测试。它输出三类：

- `HARD_HUMAN`：**无论 Jev 怎么说都交给人**，而且根本不调用 Jev。
- `GRAY`：交给 Jev 判断。
- `UNPARSEABLE`：命令解析不了，交给人（第一阶段）。

### 3.1 HARD_HUMAN 清单（只要有一个片段命中，整条命令就交给人）

| 类别 | 例子 |
|---|---|
| 删除、覆盖 | `rm`（第一阶段所有 rm，见 D3）、`rmdir`、`shred`、`truncate`、`find … -delete/-exec rm`、`dd`、`mkfs`；`mv`/`cp` 的目标在工作区外 |
| 系统敏感位置 | 写入或修改 `/etc`、`/usr`、`/boot`、`/var/lib`、`~/.ssh`、`~/.claude*`、`~/.hermes`、`~/.codex`、systemd 单元、`crontab`；`chmod`/`chown`/`chattr`；`sudo`/`su` |
| 秘密 | 读写 `.env*`、`*.pem`、`*.key`、`id_*`、`credentials*`、`/etc/agent-bridge/*`；`printenv`/`env`（输出整个环境）；命令里出现 token 形态的字符串（脱敏规则命中即算） |
| 服务和进程 | `systemctl`（只读的 `status`/`is-active`/`show` 除外）、`service`、`kill`/`pkill`/`killall`、`reboot`/`shutdown`、`docker`/`podman` 的变更子命令、`deploy/**` 脚本 |
| 装包和依赖变更 | `apt`/`dnf`、`pip install/uninstall`、`npm/pnpm/yarn add/install/remove/update/-g`、`cargo install`、`curl … \| sh` |
| Git 不可逆或外发 | `push`、`reset --hard`、`clean -f`、`checkout -- .`/`restore`、`rebase`、`branch -D`、`tag -d`、`stash drop/clear`、`filter-*`、`update-ref`、`gc --prune` |
| 远程和跨机 | `ssh`/`scp`/`rsync` 到别的主机；任何**写到 Windows 或在 Windows 上执行**的操作：`/mnt/c/**`、`powershell.exe`、`cmd.exe`、`wsl.exe`、Windows 路径；`host=windows` 的 Bridge 上的写操作 |
| 有副作用的网络请求 | `curl`/`wget`/`http` 带上 `-X POST/PUT/PATCH/DELETE`、`-d`、`--data*`、`-F`、`-T`，包括**真实模型加载的 POST**（modeldeck、GQX 推理服务、TokensAPI 等） |
| 平台生命周期 | `hermes kanban` 的状态变更命令、会话或 run 控制 API（`/api/v1/runs/*` 的写操作）、WoL |
| 数据库 | 对 `*.sqlite`/`*.db` 的写入或 `sqlite3` 非只读调用 |
| 动态代码 | `eval`、`source` 工作区外文件；`bash -c`/`sh -c`/`python -c`/`node -e` 的内联代码会**递归分类**，解析不了的整体判为 HARD_HUMAN |
| 文件工具 | `Edit`/`Write` 的目标在工作区外，并且不在 `/tmp/**`、`$TMPDIR/**` 里 |

这张表是**下限，只增不减**。每增加一条都要带测试用例。

### 3.2 多命令一行：拆开逐段判断，不阻止

- 按 `&&`、`||`、`;`、`|`、换行、`$( )`、反引号、`<( )` 拆成片段（用 shell 语法解析器，例如 `shell-quote` / `bash-parser`，不用正则）。
- 每个片段单独分类。**任意一段是 HARD_HUMAN，整条就是 HARD_HUMAN**。否则整条是 GRAY，带上所有片段一起交给 Jev。
- 重定向 `>`、`>>`、`tee` 的目标路径也要判断：在工作区内是 GRAY，在工作区外是 HARD_HUMAN。
- 命令长短和片段多少**本身不影响判断**。
- heredoc 和复杂引号解析失败时判为 `UNPARSEABLE`，交给人，这和现状一样，不算拦截。shadow 期间统计它的占比，过高就改进解析器。

### 3.3 GRAY 的典型内容（Jev 的发挥空间）

只读查询的组合，例如 `ls`、`cat`、`rg`、`sed -n`、`jq`、`git log/diff/status/show`、`systemctl status`、`journalctl`、`ps`、`curl` GET；跑测试和构建，例如 `pnpm test`、`pytest`、`tsc -b`、`cargo test`；工作区内的 `mkdir`、`touch`、`cp`、`mv`；`git add`、`git commit`、`git fetch`；写 `/tmp`。

已知的残余风险：跑测试或构建会执行仓库里的任意代码。这和 acceptEdits 允许 agent 改代码再运行是同一个信任级别，本设计不扩大它，但要写明。

## 4. Jev 的定位与命题

Jev 是 **System One 决策模型，不是生成模型**：输入一段 `state` 文本加若干命题，只返回 Choice/Score/Noul 及其概率或置信度，**不产出文字**。所以这里只把它当路由器和粗过滤器用。

**state**（由代码拼出来的结构化文本，不带 agent 的自然语言解释，以减少注入面）：

```
工具: Bash   主机: hal(linux)   工作区: /root/agent-bridge
cwd: /root/agent-bridge
片段:
 1. git status --short
 2. rg -n "approval" apps/bridge/src
 3. pnpm -C apps/bridge test
```

传入前要去掉 shell 注释（`# ...`），因为 agent 可以在注释里写"这是只读安全命令"来诱导模型。

**一次请求里放两个命题**（同一次调用，不增加延迟）：

```jsonc
"questions": {
  "safe_auto": { "type": "noul",
    "instructions": "这条由编程 agent 发起的操作，是否全部属于只读查询、工作区内的常规可逆编辑或运行测试/构建，不会删除数据、不会影响工作区外的系统、服务、远程主机或外部账户？",
    "criteria": { "true": "只读或工作区内可逆的低危操作，可以不经人工直接执行",
                  "false": "有破坏性、不可逆、影响工作区外部或外部系统，或者意图不明" } },
  "needs_human": { "type": "noul",
    "instructions": "一位谨慎的工程师看到这条操作，是否会希望在执行前亲自确认？",
    "criteria": { "true": "需要人工确认", "false": "常规操作，无需打扰" } }
}
```

用两个方向相反的命题，是为了让"高置信但答错"更难同时骗过两个问题。是否再加一个 `type:"choice"` 命题（例如 `{只读, 测试构建, 工作区编辑, 其他}`）只用于统计、不参与决策，留待 Phase 2 看数据再定。Choice/Score 的请求格式 call-bridge 里没有用过，**要先用 OpenRouter decisions 文档和一次实际调用核对**。

## 5. 置信度处理

**高置信不等于正确**。决策规则只朝放行这一个方向开口，两个命题都必须远离 0.5：

```
auto_allow  ⇔  p(safe_auto) ≥ T_allow  且  p(needs_human) ≤ T_human
其他所有情况（包括任一命题接近 0.5、两者矛盾、缺字段）→ human
```

- 初始值 `T_allow = 0.90`、`T_human = 0.10`，比 call-bridge 的 0.6 严得多，因为在这里放错的代价远高于多问一次。
- 这两个值**只是起点，必须用自家数据标定**（Phase 2）：用 shadow 期间收集的审批，配上 clown 的标签（"这次该不该问我"），画出 precision/coverage 曲线。按"自动放行里 clown 认为本该问的比例 ≤ 1%"选阈值。每升级一次 Jev 快照都要重新标定。
- 0.4–0.6 区间**一律交给人**，这一点由上面的规则保证，不需要单独写分支。
- 记录每次的两个概率和最终决策，方便事后画分布、发现漂移。

## 6. Fail-open（任何故障都退回现在的流程）

| 情况 | 结果 |
|---|---|
| Jev 超时（总时限 2.5s，期间最多重试 1 次） | 交给人；迟到的回答在后台完成，只写日志，不执行 |
| HTTP 错误、返回格式不对、key 缺失 | 交给人 |
| 熔断：最近 20 次里错误或超时超过 50% | 10 分钟内跳过 Jev，全部交给人，并在通知房间发一条提示 |
| 旧 Bridge 没有 `request` 字段 | 交给人 |
| 分诊过程中 Control Plane 重启 | pending 已经落库；Bridge 重连后 snapshot 重放，跳过分诊交给人 |
| 分诊期间 Bridge 断线、会话中断 | 和现状一样由 abort 处理（Bridge 侧会 deny 并标记 cancelled） |
| 自动放行发给 Bridge 失败（Bridge 离线） | 把这条 pending 转回人工流程，不丢 |

要求：
- 分诊**绝不产生 deny**。
- 分诊结束后 pending 一定会离开 `triaging` 状态，要么被自动放行，要么变成普通 pending。实现上用 `finally` 保证，并加一个兜底定时器：`triaging` 超过 5 秒就强制转人工。

自动放行永远只发 `allow`（单次），**绝不发 `allow-session`**，不会顺带放开后续同名工具。

## 7. 配置与 Key 管理

Control Plane 的 env（`/root/agent-bridge/.env`，不放 secret）：

```
APPROVAL_TRIAGE=off                    # off | shadow | enforce；默认 off
APPROVAL_TRIAGE_JEV_MODEL=typesafe/jev-1.13
APPROVAL_TRIAGE_URL=https://openrouter.ai/api/alpha/decisions
APPROVAL_TRIAGE_DEADLINE_MS=2500
APPROVAL_TRIAGE_RETRIES=1
APPROVAL_TRIAGE_T_ALLOW=0.90
APPROVAL_TRIAGE_T_HUMAN=0.10
APPROVAL_TRIAGE_KEY_FILE=/root/.hermes/.env   # 只从这个文件里取 OPENROUTER_API_KEY
APPROVAL_TRIAGE_SCOPE=["claude:Bash"]         # 分阶段放开
```

Key 的做法（复用 call-bridge 的 key 源，但收得更紧）：
- **复用**：`OPENROUTER_API_KEY` 仍然只存在 `/root/.hermes/.env` 一个地方，和 Hermes、call-bridge 共用。轮换时只改这一处。
- **不把整个 Hermes env 灌进 Control Plane**。call-bridge 的 unit 用 `EnvironmentFile=-/root/.hermes/.env` 整体加载，但 Control Plane 的变量名可能和它冲突（例如 `API_SERVER_KEY`、Matrix 相关变量）。所以由一个小 loader 从 `APPROVAL_TRIAGE_KEY_FILE` **只解析 `OPENROUTER_API_KEY` 这一行**，放在内存里；文件 mtime 变化时重新读取。
- **不暴露**：key 不进 SQLite、不进日志、不进 `/healthz` 或任何 API 返回（只给出 `keyConfigured: true/false`），不发给任何 Bridge，不传进任何子进程环境，也不进 repo（`.env.example` 只放变量名）。
- **发给第三方的内容**：命令文本会经过 OpenRouter。发送前，Bridge 和 Control Plane 两侧都按 token 模式（`sk-…`、`Bearer …`、`password=`、`-u user:pass` 等）脱敏。**只要脱敏命中就直接判为 HARD_HUMAN**，含秘密的命令本来就该人看，于是含秘密的内容根本不会发出去。→ 是否接受把命令发给 OpenRouter，列为待决 D5。

**运行时开关**：AGENTS.md 规定不能手工重启服务，所以要做到不重启也能回滚。模式值存在 controlStore 的 settings 表里，优先级高于 env。可以通过 Matrix 管理命令 `!triage off|shadow|enforce` 或 `POST /api/v1/admin/approval-triage`（需要管理员 principal）切换，切换后立即生效，并在通知房间回执。

## 8. 落地顺序与回滚

| 步骤 | 内容 | 上线条件 | 回滚 |
|---|---|---|---|
| **P0 文档与数据**（本卡及紧随其后） | 写现状文档（本次已完成）；从 controlStore 导出最近的审批记录（summary 和人工 choice），加上那段 27 次审批的会话，由 clown 标注"该不该问"，形成种子集 | — | 不涉及 |
| **P1 shadow** | 协议加 `request` 字段（Bridge 和 Control Plane 升版本）；实现 `packages/approval-policy` 和 Jev 客户端；`APPROVAL_TRIAGE=shadow`：照常交给人，同时记录分类器和 Jev 的结论 | 单元测试覆盖 §3.1 每一类和 §6 每种故障；离线回放种子集，HARD_HUMAN 漏判为 0 | 运行时切到 `off`；或者回退 commit 后走 deploy.sh。shadow 不改变任何审批行为 |
| **P2 标定** | 积累 1~2 周 shadow 数据，标定 T_allow/T_human，输出报告：覆盖率（能省掉多少次打扰）和误放率；统计 UNPARSEABLE 占比 | 误放率 ≤ 1%，并且误放的都是 clown 认可的"无所谓"类；clown 拍板 | 不涉及（只是离线分析） |
| **P3 enforce（窄）** | 只对一台 Bridge（噪声最大的 WSL Claude）、只对 `claude:Bash` 开启；每次自动放行在会话流里留 `approval.auto_resolved` 事件，通知房间每天发一次摘要 | P2 通过 | `!triage shadow` 立即生效；熔断自动兜底 |
| **P4 扩面** | 依次加入工作区外 Edit/Write → Codex commandExecution → MCP 工具（先把只读 MCP 工具加进确定性白名单，剩下的才进 GRAY） | 每扩一项重复 P1→P3 的 shadow 加标定 | 从 `APPROVAL_TRIAGE_SCOPE` 里去掉该项 |

P1 及以后的步骤会改动 Control Plane 和协议，按 AGENTS.md 要提升根 `package.json` 版本，并通过 `deploy/hal/deploy.sh` 部署；WSL 和 Windows Bridge 通过自更新器升级。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| Jev 高置信误判，放行了不该放的操作 | 硬边界清单兜住所有不可逆类别，Jev 最坏只会错放 GRAY 类；双命题加高阈值；shadow 标定；每日摘要可以事后复查 |
| 提示注入（agent 在命令或注释里诱导模型） | 去掉注释；state 只放解析后的片段；硬规则先于模型执行，模型能放行的上限由代码决定 |
| 解析器被绕过（变量拼接、别名、`$IFS` 等） | 含变量展开的命令名、`eval`、间接执行一律判为 UNPARSEABLE 或 HARD_HUMAN；用模糊测试覆盖 |
| 延迟让 agent 变慢 | Jev 热连接约 0.25s；总时限 2.5s。即使最坏情况，也比人工响应（约 30s）快得多 |
| 隐私：命令文本外发 | 脱敏命中直接交给人；待决 D5 |
| 模型快照变化 | 模型名可以固定到带日期的快照；升级前重新跑标定集 |
| 自动放行后人对正在发生什么失去感知 | 会话流事件加每日摘要；DSH 上用不同样式显示"已自动放行" |

## 10. 需要 clown 拍板的决策

| # | 问题 | 推荐 |
|---|---|---|
| D1 | Jev 放在 Control Plane（key 只在 HAL）还是 Bridge（延迟低，但 key 要分发到三台机器）？ | Control Plane |
| D2 | 全部由只读命令组成的一行命令，是否由确定性分类器直接放行、不调用 Jev（相当于扩展白名单）？ | 是，但先在 shadow 里观察；它也算放宽策略，需要拍板 |
| D3 | 工作区内的 `rm`（不带 `-r`、文件被 git 跟踪）是 GRAY 还是 HARD_HUMAN？ | 第一阶段 HARD_HUMAN，看数据再放 |
| D4 | Key 的读取方式：从 `/root/.hermes/.env` 只读一个变量，或者单独建 `/etc/agent-bridge/jev.env`（0600），或者整体 `EnvironmentFile`？ | 只读一个变量 |
| D5 | 能否接受把（已脱敏的）命令文本发给 OpenRouter？ | 可以，含秘密的命令不发 |
| D6 | 初始阈值 0.90/0.10，以及"误放率 ≤ 1%"的上线门槛 | 按这个，等 P2 数据出来再定 |
| D7 | `git commit` 和不带写参数的 `curl` GET 归入 GRAY 吗？ | 是 |
| D8（相关，另开卡） | 人工的 `allow-session` 现在按工具名整体放行，要不要收窄到"同一命令前缀"？ | 收窄 |
| D9（相关，另开卡） | `CLAUDE_PERMISSION_ALLOW` 里的 `Bash(git:*)` 会放行 `git push` 和 `reset --hard`，要不要改成具体的只读子命令？ | 改，和本设计的 Git 硬边界保持一致 |
| D10（相关，另开卡） | `approval_relay` 超时 = deny，要不要改成"超时后保持 pending、不作答"，让人回来还能批？ | 改成保持 pending，同时给 agent 一个可识别的"等待中"状态 |
| D11 | 自动放行的通知：完全静默只发每日摘要，还是每次发一条低优先级消息？ | 每日摘要，DSH 上可见 |
| D12 | 第一阶段范围：只做 Claude Bash，还是同时做 Codex？ | 只做 Claude Bash |
