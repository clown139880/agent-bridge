# 设计：跨 Agent 的房间/项目作用域记忆（OMA v4.1 + deathnote 子目录）

- 状态：设计稿第 2 版，未实现（Kanban t_878c7584）。本文不改任何代码或配置。
- 关联材料：[conversation-memory-design.zh.md](conversation-memory-design.zh.md)（中央对话检索设计）、[conversation-memory-operations.zh.md](conversation-memory-operations.zh.md)（已落地的只读 MCP）。
- 审阅基线：agent-bridge `0.6.85`；Hermes `v2026.8.19-14230-g532f83aaf1`（`/root/.hermes/hermes-agent`）；笔记库 `/root/deathnote`；OMA `jrcruciani/obsidian-memory-for-ai@f87548a`（2026-09-21，v4.1）。

## 0. 结论先行

1. **直接使用 OMA v4.1 的格式和工具，不自己重写。** 记忆是 `/root/deathnote/agent-memory/` 下的若干个 OMA vault，每个作用域一个。读、写、检索、bootstrap、改值留史，全部调用 OMA 自带的 Python CLI（`--json` 模式）完成。agent-bridge 只补 OMA 明确不做的部分：服务端、鉴权、作用域解析、git 提交、多 vault 汇总。
2. **作用域（scope）统一「房间」和「项目」。** 一个 scope 是一个目录，里面有 `scope.md`（绑定了哪些 Matrix 房间、仓库、机器目录）和一个 OMA `memory/`。私聊和 akasha 这类不分主题的房间落到 `_global`。
3. **Control Plane 是唯一写入方。** 它在已有的 `/mcp` 端点上提供 `memory_*` 工具。Hermes 用一个薄的 MemoryProvider 插件接入，同时关掉内置的 MEMORY.md/USER.md。Bridge 下的 Codex/Claude/pi 通过 MCP 配置加共享技能使用同一套工具。
4. **「新开对话也接得上」靠 OMA 的两样东西：** 置顶事实（pinned facts）放长期结论，事件（events，只追加）记录「最近做到哪里」。OMA 的 bootstrap 会按字符预算把这两样确定性地组装出来，不需要模型。
5. **同时修好 deathnote 的同步链路：** 修 cron 自动提交脚本的两个缺陷，再加一个 Syncthing 冲突处理器。能干净三方合并的 Markdown 冲突自动合并，合并不了的发到 Matrix 由你决定。所有改动先进 git，任何一步都可以找回。

已定的决策见 §1，待定问题见 §11。

## 1. 已定决策（2026-10-12 回复）

| # | 决定 | 对设计的影响 |
| --- | --- | --- |
| D1 | 用本方案。OMA 算是借用社区方案，不算重复造轮子 | §2：OMA 的工具直接调用，不重写；agent-bridge 只写接线层 |
| D2/D3 | 按房间划分。akasha 是老房间，没有特定主题，地位和私聊一样偏全局，之后会弃用 | 私聊和 akasha 映射到 `_global`，不建房间 scope；thread 不单独成 scope（§5.2） |
| D7 | Gitea 是自建的，笔记库是私有的，隐私不是问题，包括 Dorothy 的私密内容 | 取消 `private` 拒写和 PII 分级。秘密扫描（token/私钥）**保留**，因为那是凭据安全问题，不是隐私问题。Dorothy 私密内容能否进 vault 只剩「上下文隔离」这一个顾虑，见 Q2 |
| D8 | 可以改 cron 脚本，最好再有机制帮忙处理 Syncthing 冲突 | §8：新脚本 + 冲突处理器 |
| — | 允许联网查资料和 clone | 已 clone OMA 并实测，结论在 §3 |

## 2. 现状审阅（事实）

### 2.1 Hermes 记忆

| 项 | 事实 |
| --- | --- |
| 内置记忆 | 每个 profile 一份 `memories/MEMORY.md` + `USER.md`。默认 profile 两个文件分别为 3496 和 3123 字节，上限 2200/1375 字符，`write_approval: false`。dorothy 的 `write_approval: true` |
| Provider 接口 | `agent/memory_provider.py`。查找顺序依次是：内置 `plugins/memory/<name>/`、`$HERMES_HOME/plugins/<name>/`、项目目录、entry point。同名时内置优先 |
| 初始化身份 | `agent_init._memory_provider_init_kwargs` 传入 `session_id, platform, hermes_home, agent_context(primary/cron/subagent), cwd, agent_identity(profile)`，以及存在时的 `user_id, chat_id, chat_name, chat_type, thread_id, gateway_session_key` |
| 注入位置 | `system_prompt_block()` 进入缓存的 system prompt。`prefetch()` 的结果包在 `<memory-context>` 里，追加到当前这轮的 user 消息（`turn_context.compose_user_api_content`），之后原样重放，不破坏缓存前缀 |
| 上游 `memory.authoritative_source` | 本机版本没有，本设计不依赖 |
| 依赖内置记忆的文字 | dorothy SOUL.md 的 Memory Classification 一节、`hermes-agent`/`hermes-gateway-config` 等技能。切换时要一起改 |

### 2.2 Matrix 房间

| profile | 房间 | 按 D2/D3 的初步映射 |
| --- | --- | --- |
| default | 私聊 `!XuCBHkBjswAFS8Bi9V` | `_global` |
| default | akasha `!jFhXT73U0v2nRIZobl`（group，32 个 thread，将弃用） | `_global` |
| default | 旅游助手 `!xqSJrhoDJmGaVCdYA5` | `travel` |
| default | 管家 `!BfI1RVNwlmtwlsY2qO` | `household` |
| dorothy | 私聊 `!tyg8f4Jr4K3PLTAEzM` | `_global`？（Q1） |
| dorothy | crypto `!X3haDL9N99uUtZRkXz` | `crypto`？（Q1） |
| dorothy | 天鹅绒之馆 `!ywJMH2m2AWgURIlNDR` | ？（Q1/Q2） |
| dorothy | 惠的电台 `!akRONzklEOcE1QjfHd` | `hui-radio`？可能同时绑定 `/root/projects/hui-radio-v2`（Q1） |

### 2.3 deathnote 笔记库和同步

| 项 | 事实 |
| --- | --- |
| 位置 | `/root/deathnote`，PARA 结构，约 1000 个 md；`origin` 是自建 Gitea |
| Syncthing | HAL 上原生运行。文件夹 `DeathNote` 是 sendreceive，设备为 hal（`DJ5QH4J`）和 GQX（`OWDMNOW`），`maxConflicts=10`，没开文件版本控制，`.stignore` 排除了 `.git` |
| 冲突现状 | vault 中现有 16 个 `*.sync-conflict-*` 文件（其中 6 个在 `.trash`），git 历史里提交过 26 个。**几乎全部带 `DJ5QH4J`（hal）后缀**。Syncthing 用设备 ID 给「输掉」的那一版命名，所以冲突基本都是：HAL 上 agent 写的版本，输给了 GQX 上 Obsidian 的编辑。GQX 经常休眠，离线期间两边各改各的，重新上线后就冲突了 |
| 自动提交 | Hermes cron `deathnote-auto-commit-push`（每 30 分钟，no_agent 脚本 `~/.hermes/scripts/deathnote-auto-commit-push.sh`），deliver 为 `local` |
| ⚠ 缺陷 1 | 用 `git diff --quiet && git diff --cached --quiet` 判断「没有变化」，这个判断看不到未跟踪文件。只新增文件时，脚本永远不提交。工作树里现在就有一批未跟踪的笔记 |
| ⚠ 缺陷 2 | `date '%Y-%m-%d %H:%M:%S'` 少了 `+`，提交信息只剩 `chore: auto commit` |
| cron 投递 | Hermes cron 支持 `deliver: "matrix:<room_id>"`（现有任务已经在用）。no_agent 脚本输出为空时不发消息 |

### 2.4 agent-bridge 的「项目」和会话记忆层

- **项目身份**：Bridge 把 `remote.origin.url` 归一化成不含凭据的 `host/path`（`apps/bridge/src/path-utils.ts` 中的 `deriveProjectIdentity`），存为 `sessions.project_identity`。Control Plane 在分组时，有身份就按仓库分，没有就按「机器 + 目录」分（`packages/database/src/control.ts` 中的 `listSessionGroups`）。`sessions.matrix_room_id` 只是通知房间，不能当 scope 键。
- **会话记忆层**：`POST /mcp` 用独立的只读 token 提供 `conversation_search/review/read`，底层是 `events` 表上的视图。原设计写明了写能力要另行授权，「少量跨项目长期偏好」留给一个可选的中央有界记忆。本设计就是去填这个位置。档案目前不包含 Hermes 自己的 Matrix 会话。
- Kanban 卡片已经有 `<!-- agent-bridge-worker resume-session-id: … -->` 这种指令惯例（`integrations/hermes_agent_bridge/README.md`）。

## 3. OMA v4.1 实测结论

我把仓库 clone 到 `/root/scratch/memory-research/oma`，在一个临时 vault 里实际跑了写入、改值、事件、检索、bootstrap 和 lint。

| 项 | 实测结果 | 对设计的影响 |
| --- | --- | --- |
| 运行依赖 | Python3 + PyYAML（HAL 已有）。不用模型，不连网 | 本地即可运行 |
| 速度 | 在 46 个文件的示例 vault 上，`lint --strict` 0.16 秒，`search`/`bootstrap` 约 0.1 秒 | Control Plane 每次请求起一个子进程完全可以接受 |
| vault 根目录 | Python 工具都以 **cwd** 为 vault 根（`root = Path.cwd()`）。`query.sh` 则用脚本自身位置推导根目录 | 共用一份工具，以 `cwd=<scope 目录>` 调用 `python3 <oma>/tools/*.py`（实测可行），不调用 `query.sh` |
| 布局 | `memory/{entities.md, schema/, facts/<entity>/<predicate>.md, events/<date>/<id>.md, _transactions/, _proposals/, _reviews/, _staging/, _views/, _indexes/}` | 每个 scope 目录就是一个 OMA vault |
| 实体和谓词要预先声明 | 写入未声明的实体或谓词时，事务在提交前的 lint 就失败（`unknown entity` / `unknown predicate`）。**事务不能声明实体或谓词**，那属于 schema 改动 | Control Plane 自己维护 `entities.md`（写入时自动声明本 scope 的新实体）。谓词用一套固定的小词表（§5.3） |
| 一个槽位一个当前值 | `(entity, predicate)` 只能有一个当前事实 | 实体当「主题」，谓词当「类别」，例如 `facts/reply-style/preference.md` |
| 改值留史 | `supersede_fact` 把旧值移到 `facts/<e>/<p>/<日期>.md`，新文件通过 `supersedes` 指回旧值；`--history` 能看到全部历史 | 直接使用 |
| 撤回 | v4.1 拒绝 `archive_fact`（「v4.1 retains history; use supersede_fact」）。撤回只能手写墓碑：`status: retracted` + `retracted_at` + `reason`，**事务里没有对应操作** | Control Plane 自己写墓碑，再跑 lint 校验 |
| 失败的事务 | 失败后会留下 `memory/_staging/<txn>/`，需要 `transact.py recover --yes` 清理 | Control Plane 每次写入前先执行 recover |
| git | OMA 只读 `git rev-parse HEAD`（用于可选的 `expected_revision`），**自己从不 commit** | 提交由 Control Plane 做。不用 `expected_revision`，因为 cron 和人工提交也会移动 deathnote 的 HEAD |
| bootstrap | 默认章节依次是 pinned_facts、recent_decisions、active_entities、recent_events，预算按 Unicode 字符计算，超出就整条截止。**没置顶的事实不会出现在 bootstrap 里** | 核心事实写入时设 `pinned`；「最近做到哪里」写成事件 |
| 中文 | 中文子串检索（「大白话」）能命中；别名「施彬滨」能解析到实体 `simon` | 可以用 |
| 多行值 | 能存，但 bootstrap 渲染时会断行 | 约定 `value` 只写一行，细节写进正文 |
| 交易日志 | 每次写入都在 `_transactions/` 多出一个 md 回执 | 文件会持续增多，在 Obsidian 里排除这个目录（§5.1） |
| 许可证 | **仓库里没有 LICENSE 文件**，GitHub API 显示 `license: null`。174 star，10 fork，单人维护，2026-03 创建 | 不把 OMA 代码放进 agent-bridge 仓库；在私有 vault 里固定一个版本供自己使用（§5.1）。见 Q9 |
| 范围 | OMA 明确**不做**服务、daemon、MCP 服务器、多用户、分布式锁。角色和 trust 只是「本地协作约定，不是鉴权边界」 | 鉴权、单写入方和服务端由 Control Plane 负责，正好补上这一块 |

## 4. 总览架构

```text
   Matrix 房间                                        Bridge 会话（Codex / Claude / pi）
       │ chat_id                                             │ cwd、project_identity
       ▼                                                     ▼
 Hermes 网关 ── agent-bridge-memory provider          MCP 配置 + 共享技能 agent-memory
 (default / dorothy)        │ HTTP（本机）                    │ HTTP（远程 MCP）
                            └──────────────┬──────────────────┘
                                           ▼
                       Control Plane /mcp（按 token 分权）
                        ├─ conversation_*            只读（已有）
                        ├─ memory_* 读               作用域解析 → OMA query_impl.py
                        ├─ memory_* 写               鉴权、声明实体、秘密扫描 → OMA transact.py
                        │                            → flock → git commit -- <scope 路径>
                        └─ 跨 scope 汇总             逐个 vault 查询后合并
                                           │ 子进程，cwd = scopes/<slug>
                                           ▼
          /root/deathnote/agent-memory/   每个 scope 一个 OMA v4.1 vault（唯一事实源）
                                           │
           cron（每 30 分钟，持同一把锁）：提交 → 处理 Syncthing 冲突 → 提交 → 推送 Gitea
           Syncthing ↔ GQX（Obsidian 中可以阅读、编辑、审批提案）
```

| 组件 | 职责 | 不负责 |
| --- | --- | --- |
| OMA 工具（固定版本，不修改） | 事实、事件的读写和校验；改值留史；检索；bootstrap；提案和审阅 | 鉴权、作用域、git 提交 |
| Control Plane memory 模块 | 唯一写入方；token → OMA `agent_id`；作用域解析；维护 `entities.md` 和墓碑；秘密扫描；按路径 git 提交；汇总 `_global` 和当前 scope；跨 scope 检索 | 推送、模型调用、重写 OMA 逻辑 |
| Hermes provider | 用 `chat_id` 解析 scope，注入 bootstrap，转发工具调用；Control Plane 不可用时直接调本地 OMA 只读 | 写文件 |
| 共享技能 `agent-memory` | 告诉 Bridge 下的 agent 何时读、何时写、写什么 | 凭据、MCP 注册 |
| deathnote cron + 冲突处理器 | 提交、合并冲突、推送、通知 | 记忆语义 |
| 对话档案（已有） | 证据和回溯；事件或事实可以在 `derived_from` 或正文里引用 `session:<id> e:<n>` | 长期事实 |

### 4.1 数据流

- **写事实**：`memory_write(topic, kind, value, pin?)` → Control Plane 用 token 映射出 `agent_id`，解析 scope，校验写权限和秘密 → 拿 vault 锁 → 在 scope 目录执行 `transact.py recover --yes` → 主题是新的就先在 `entities.md` 里声明 → `transact.py begin/add(create_fact 或 supersede_fact)/commit --json --yes` → `git commit -- agent-memory/scopes/<slug>`，只提交本 scope 的路径 → 返回路径和 commit。
- **记进展**：`memory_log(summary, body?, topics?)` → OMA `create_event`（只追加），之后进入 bootstrap 的 recent_events。
- **注入**：会话开始时，Control Plane 分别在 `_global` 和当前 scope 运行 `query_impl.py --json bootstrap`，各自受自己的 `bootstrap.yaml` 预算约束，拼好交给 Hermes 的 `system_prompt_block()`，或者 Bridge agent 的 `memory_bootstrap` 调用。
- **检索**：`query_impl.py --json search <词>`，先查当前 scope，再查 `_global`。`scope=all` 时遍历所有 vault，结果标出来源 scope。
- **跨房间**：只有显式调用才会跨，跨 scope 的内容永远不会自动注入。

## 5. 笔记库落地

### 5.1 目录

```text
/root/deathnote/
  0. 周期笔记/ … 5. 表达/           # 现有 PARA，不动
  agent-memory/
    README.md                         # 给人看：约定、如何绑定、如何审批
    _oma/                             # OMA v4.1 工具，固定在 f87548a，只放 tools/ 和 SPEC，不修改
    _template/memory/schema/          # 所有 scope 共用的 schema 母版（谓词词表、roles、bootstrap 预算）
    scopes/
      _global/                        # 用户画像、环境、通用经验；私聊和 akasha 写到这里
        scope.md
        memory/…                      # 标准 OMA vault
      travel/
        scope.md
        memory/…
      household/ …
```

- **新建 scope** 时，从 `_template` 复制 schema。修改词表只改 `_template`，然后由 Control Plane 的 `memory_admin sync-schema`（人工触发）同步到各个 scope，并一次性提交。不用符号链接，因为 Syncthing 在 Windows 上处理符号链接不可靠。
- **派生文件**：OMA 的 `_views/`、`_indexes/` 可以随时重建。为了不让 Syncthing 来回同步，也不在 git 里制造噪音，把 `agent-memory/**/_views/`、`_indexes/`、`_staging/` 加进 deathnote 的 `.gitignore` 和 `.stignore`。查询时 OMA 会在缺少派生文件时直接扫描原始文件，实测结果一致。
- **Obsidian**：在「排除的文件」里加 `agent-memory/_oma`、`agent-memory/**/_transactions`、`_staging`。这项设置在 `.obsidian` 里，不进 git，需要在 GQX 上手动设一次。
- **和 PARA 的关系**：`scope.md` 用 `para_note: "[[1. 项目/…]]"` 指向对应的项目笔记。agent 不写 PARA 区域，PARA 仍然是你的笔记。

### 5.2 scope 绑定

```yaml
# agent-memory/scopes/travel/scope.md   （放在 scope 根目录，OMA 不会读它）
---
type: scope
id: travel
title: 旅游助手
status: active                 # active | archived
profiles: [default]            # 哪些 Hermes profile 可以在这里写（Bridge agent 另由 token 决定）
bindings:
  matrix_rooms: ["!xqSJrhoDJmGaVCdYA5:uniclown.com"]
  repositories: []             # 与 sessions.project_identity 同一归一化规则
  locations: []                # [{machine: hal, path: /root/projects/xxx}]
para_note: "[[1. 项目/…]]"
---
这个方向在做什么（一两句，人写）。
```

**解析顺序**（Hermes 和 Bridge 共用一个函数）：Matrix 房间 → 仓库身份 → 机器 + 目录 → 卡面指令 `memory-scope:` → 落到 `_global`。

- 房间键取 `chat_id` 中 `:$` 之前的部分，所以 akasha 下的 thread 都归到房间本身，也就是 `_global`。
- `_global` 的 `scope.md` 显式列出私聊和 akasha 两个房间，表示这是有意的映射，不是漏了绑定。
- 同一个键出现在两个 scope 里时返回 `conflict` 和候选列表，不猜，由 lint 报告给你。
- **新房间**第一次对话时，自动建一个临时 scope `room-<8位哈希>`，`title` 取房间名，`status: provisional`。你在 Obsidian 里改名、合并，或者把房间挪进 `_global` 的绑定即可。理由是新房间通常就代表一个新方向。见 Q3。

### 5.3 记忆的写法：主题 × 类别

OMA 要求每个 `(实体, 谓词)` 只有一个当前值，而且两者都要预先声明。所以约定：**实体 = 主题**（ASCII 短横线 slug，同时声明中文显示名和别名），**谓词 = 下面这套固定的类别**：

| 谓词 | 含义 | 例子（实体/谓词 = 值） |
| --- | --- | --- |
| `preference` | 偏好 | `reply-style/preference` = 默认文字回复，解释用大白话和比喻 |
| `rule` | 必须遵守的约束 | `deletion/rule` = 任何删除须明确授权，授权不扩大 |
| `decision` | 已经定下的决定 | `memory-backend/decision` = 用 OMA v4.1 + Control Plane 单写入方 |
| `fact` | 环境、配置位置等客观事实 | `immich/fact` = compose 在 /root/immich，API 127.0.0.1:2283 |
| `lesson` | 踩过的坑和修法 | `netease-imap/lesson` = SELECT 前先发 IMAP ID 命令 |
| `pointer` | 详细内容在哪里（技能、文档、笔记） | `homelab-ops/pointer` = 见技能 homelab-services |
| `profile` | 关于人的稳定信息 | `simon/profile` = 住杭州，一家三口 |

- 想记的东西超出这些类别时，用 `memory_propose` 提议新增谓词，审批后改 `_template` 并同步。
- 长期结论写成置顶事实。默认置顶，agent 可以传 `pin=false` 表示只供检索、不进 bootstrap。
- 进展、交接、「这次聊到哪了」写成事件（`memory_log`）。事件只追加、不修改，会以「日期 + 一行摘要」出现在 bootstrap 的 recent_events 里。
- `value` 只写一行，细节写进正文。可以在 `derived_from` 或正文里引用对话档案 `session:<id> e:<n>`。

### 5.4 写入权限

| 目标 | 谁 | 方式 |
| --- | --- | --- |
| 当前 scope | 在该 scope 的会话中、通过认证的 agent | 直接写（OMA 事务 + git 提交） |
| `_global` | Hermes/Dorothy 直接写；Bridge agent 提案（Q4） | — |
| 别的 scope | agent | 只能提案（OMA `propose.py`，进 `memory/_proposals/`） |
| 新增谓词、`scope.md` 绑定 | 只有人可以改；agent 只能提案 | 防止 agent 把房间串到别的 scope |
| 审批提案 | 人：用 Control Plane 的管理接口（带 `CONTROL_API_WRITE_TOKEN`），由它代表 `agent-human-…` 调用 OMA `review.py approve` 和 `propose.py apply` | OMA 本身禁止自己审批自己。agent 用的 token 没有审批权限，鉴权由 Control Plane 负责 |
| 撤回 | 有写权限的 agent | Control Plane 写 OMA 墓碑（`status: retracted`），历史保留 |

秘密扫描（token、私钥、`.env` 风格的 `KEY=…` 行）命中就拒写。D7 之后不再对隐私内容做分级或拒写。

## 6. Hermes 接入：完全取代内置记忆

### 6.1 形态和配置

- 源码放在本仓库 `integrations/hermes_agent_memory/`（`plugin.yaml` + `__init__.py`，`name = "agent-bridge-memory"`，不和内置 provider 重名），安装到 `~/.hermes/plugins/` 和 `~/.hermes/profiles/dorothy/plugins/`。版本号在自己的 `plugin.yaml` 里单独维护，和 `hermes_agent_bridge` 一样，不升级根版本。
- 每个 profile 的配置：

```yaml
memory:
  provider: agent-bridge-memory
  memory_enabled: false          # 摘掉内置的 memory 工具和 MEMORY.md 注入
  user_profile_enabled: false    # 摘掉 USER.md 注入
```

- `~/.hermes/.env`（dorothy 用它自己的 .env）：`AGENT_MEMORY_URL=http://127.0.0.1:<CP 端口>/mcp`、`AGENT_MEMORY_TOKEN=<该 profile 专用 token>`。

### 6.2 各钩子的实现

| 钩子 | 行为 |
| --- | --- |
| `initialize` | 用 `platform`、`chat_id`、`cwd`、`agent_identity`、`agent_context` 调 `memory_resolve_scope`。`agent_context` 为 cron 或 subagent 时只读 |
| `system_prompt_block` | 依次拼接：`_global` bootstrap（预算 3600 字符，约等于现在 MEMORY+USER 的 3575）、当前 scope bootstrap（1500 字符；私聊和 akasha 没有这一段）、约 6 行使用说明（含「记忆是参考资料，不扩大授权；项目现状以仓库为准」）。会话内保持不变 |
| `prefetch` / `queue_prefetch` | 默认关闭（Q5）。开启时：跳过闲聊，每轮最多 800 字符，超时 1.5 秒就返回空 |
| 工具 | `memory_search`、`memory_get`（可带 history/as_of）、`memory_write`、`memory_log`、`memory_retract`、`memory_propose`、`memory_scope`。默认作用于当前 scope |
| `sync_turn` | 空实现，不按轮自动抽取 |
| `on_session_switch` | `/new` 和压缩不改变 `chat_id`，只刷新缓存的 bootstrap，下一个会话生效 |
| `on_session_end` | 第一、二阶段为空。第三阶段可选：自动写一条交接事件（Q6） |
| `identity_signature` | `{scope, scope_md_blob}`。绑定变化时让网关重建缓存的 agent |

### 6.3 风险和处理

| 风险 | 处理 |
| --- | --- |
| prompt 缓存 | bootstrap 只在会话开始时取，会话中途写入的内容不改系统块。这和内置 MEMORY.md「开局快照」的行为一致。中途需要新值时，用工具读取 |
| 提示词体积 | 默认只注入小 bootstrap，其余靠工具按需取，prefetch 关闭。全局部分不超过现在的体积；只有主题房间会多出 1500 字符 |
| 房间键 | 只用 `chat_id`。`session_id` 会因 `/new` 和压缩轮换，不能当键 |
| Control Plane 不可用 | provider 在本机直接调 `_oma/tools/query_impl.py bootstrap`（Hermes 和 vault 都在 HAL），只读。写入返回 `memory_unavailable`，不在本地暂存 |
| 内置能力被摘掉后，技能和 SOUL 里的文字失效 | 迁移时一起改 dorothy SOUL 和相关技能里提到 MEMORY.md 或 memory 工具的地方 |

## 7. 与 agent-bridge 整合

### 7.1 房间 ≈ 项目

scope 只是在 agent-bridge 已有的项目身份（仓库或机器 + 目录）之上，加了一层**可命名、可绑定多个键**的集合，没有发明第三套身份。比如「惠的电台」房间和 `hui-radio-v2` 仓库可以绑到同一个 scope：Dorothy 在房间里聊的方向，和 Codex 在仓库里改代码时看到的记忆是同一份。

Kanban：Hermes 从某个房间创建卡片时，在卡面写入 `<!-- agent-bridge-worker memory-scope: <slug> -->`。supervisor 把它放进派发参数，Control Plane 记为该会话的 scope 提示。卡面没有这条指令时，按工作目录用仓库身份解析。

### 7.2 MCP 接口

接口挂在已有的 `POST /mcp`（`apps/control-plane/src/memory-mcp.ts`）上，`tools/list` 按 token 权限返回不同的工具集。

| token | 工具 |
| --- | --- |
| `CONVERSATION_MCP_READ_TOKEN`（已有） | `conversation_*`，加上只读的 `memory_resolve_scope/bootstrap/search/get` |
| `AGENT_MEMORY_TOKENS`（新增，`名字:token` 列表；每个名字对应 roles.yaml 中的一个 OMA `agent_id`） | 读工具，加上 `memory_write/log/retract/propose` |
| `CONTROL_API_WRITE_TOKEN`（已有，人用） | REST：提案列表、审批、驳回；`lint`；`sync-schema` |

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `memory_resolve_scope` | `platform`，加上 `room_id`/`source_session_id`/`machine_id+cwd`/`repository`/`scope_hint` 中的若干项 | `scope`、命中的绑定、`conflict` 候选、`warnings`（含 sync-conflict 文件） |
| `memory_bootstrap` | `scope` | `_global` 和该 scope 的 OMA bootstrap 原文，以及各自的字符统计 |
| `memory_search` | `query`、`scope`（`current`/`global`/`all`/`<slug>`）、`limit` | OMA search 结果，加上 scope 标注 |
| `memory_get` | `scope`、`topic`、`kind`、`history?`、`as_of?` | OMA facts 结果 |
| `memory_write` | `scope?`、`topic`、`topic_display?`、`kind`、`value`、`body?`、`pin?`、`derived_from?` | 路径和 commit；无权直写时返回 `proposal_id` |
| `memory_log` | `scope?`、`summary`、`body?`、`topics?` | 事件路径和 commit |
| `memory_retract` | `scope?`、`topic`、`kind`、`reason` | 同上 |
| `memory_propose` | 同 write，或者 `{target: predicate | binding, …}` | `proposal_id` |

远程 MCP 读不到调用方的 cwd，沿用原设计的规则：调用方自己取 cwd 和 remote，显式传入。共享连接上不保存「当前 scope」。

### 7.3 Bridge 下的 agent 怎么用

- **阶段 1（不改 Bridge 代码）**：各端在 MCP 配置里加上自己的 memory token，并通过 `shared-skills/manifest.json` 安装 `agent-memory` 技能。技能约定：
  - 开始实质任务时，带上 cwd 和 remote 调一次 `memory_bootstrap`。
  - 形成决定或偏好时，用 `memory_write`。
  - 完成一段工作时，用 `memory_log` 记一行进展。
  - 不要写代码事实、AGENTS.md 里已有的规则、一次性状态或秘密。
- **阶段 3（可选）**：Bridge 在新会话首轮自动附带 bootstrap。需要先确认 Codex App Server 和 Claude adapter 有没有附加说明的入口，现在的代码里没有，这会涉及 protocol 和版本升级。

### 7.4 「新开对话也接得上」

| 来源 | 内容 | 阶段 |
| --- | --- | --- |
| 置顶事实 | 方向、约束、偏好、已定决定 | 1 |
| 事件 recent_events | 最近 N 条进展摘要（`bootstrap.yaml`：`recent_events: 10`，`lookback_days: 30`） | 1，由 agent 用 `memory_log` 写 |
| `scope.md` 正文 | 这个方向在做什么 | 1 |
| 最近 Bridge 会话指针 | 该 scope 绑定的仓库最近的会话标题和 `session_id`，细节用 `conversation_review` 取 | 3 |
| Hermes 自己的 Matrix 会话 | 暂时靠 Hermes 自带的 `session_search`；导入中央档案需要单独立项 | — |
| 自动交接事件 | `on_session_end` 用辅助模型写一条摘要 | 3，可选（Q6） |

## 8. deathnote 同步：cron 修复和 Syncthing 冲突处理

### 8.1 新的提交脚本（替换 `~/.hermes/scripts/deathnote-auto-commit-push.sh`）

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /root/deathnote
exec 9>/run/lock/deathnote-git.lock
flock -w 120 9                                     # 与 Control Plane 写记忆共用同一把锁
commit_all() {
  [ -n "$(git status --porcelain)" ] || return 0   # 能看到未跟踪文件（修缺陷 1）
  git add -A
  git diff --cached --quiet || git commit -q -m "$1"
}
commit_all "chore: auto commit $(date '+%F %T')"   # 修缺陷 2；冲突副本也先进 git，后面可以找回
python3 ~/.hermes/scripts/deathnote-sync-conflicts.py --apply   # 只在有事要报告时输出
commit_all "chore: resolve sync conflicts $(date '+%F %T')"
git push -q origin HEAD
```

cron 任务的 `deliver` 从 `local` 改成 `matrix:<通知房间>`（Q7）。脚本没输出就不发消息，有冲突报告或 push 失败时才会发。

### 8.2 冲突处理器 `deathnote-sync-conflicts.py`

处理 `*.sync-conflict-YYYYMMDD-HHMMSS-<设备>.*`，跳过 `.git`。`.trash` 中的冲突副本只统计数量，不处理。

| 情况 | 动作 |
| --- | --- |
| 副本和原文件内容相同 | 删除副本（它已经在上一步提交进 git，可以找回） |
| 原文件已不存在 | 不动，报告 |
| `.md` 文本 | 三方合并：base 取 git 中「冲突时间之前最后一次提交」的原文件版本（`git log -1 --before=<时间> -- <原文件>`），ours 是当前原文件，theirs 是副本，执行 `git merge-file -p`。**干净合并**就写回原文件、删除副本，并在报告中列出；**有冲突**就两边都不动，报告里附上差异摘要 |
| `.canvas`、`.excalidraw` 等 JSON 或二进制文件 | 不自动处理，只报告（按行合并 JSON 可能会把文件弄坏） |
| `agent-memory/` 下的文件 | 也走上面的规则。合并后对所在 scope 跑一次 OMA lint，失败就退回合并前的版本，改为报告 |

**报告格式**（发到 Matrix）：已自动合并 N 个（列出路径），需要你决定 M 个（路径和一两行差异摘要），`.trash` 中还有 K 个。需要你决定的冲突，可以在 Matrix 里让 Hermes 处理：「保留 HAL 版 / 保留 GQX 版 / 按某某合并」。配一个小技能 `deathnote-conflicts`，提供列出、查看差异、按你的指示落地三个动作。落地后由下一次 cron 提交。

**首次运行**先用 `--dry-run`，把现有 16 个冲突的处理预案发给你，你确认后再加 `--apply`。

### 8.3 从源头减少冲突

- 记忆写入都走 Control Plane（单写入方），而且大多是新建文件，和你在 GQX 上编辑同一个文件的机会很少。
- 主要的冲突来源是 HAL 上的 agent 直接改 PARA 笔记，同时 GQX 离线期间你也改了同一篇。可以建议 knowledge-management 技能在改已有笔记之前先检查 Syncthing 状态。HAL 的 Syncthing REST API 在 `:8384` 上，用 `GET /rest/db/status?folder=DeathNote` 可以看到 GQX 是否在线、有没有待同步的改动。GQX 不在线时只追加、不改写，或者改成写一份「待合并」笔记。这条只是建议，不在本设计实施范围内（Q8）。
- Syncthing 的 `maxConflicts=10` 保持不变，因为设成 0 会直接丢掉一方的修改。

## 9. 分阶段实施

涉及 Control Plane 和 protocol 的阶段按 AGENTS.md 升级根版本，用 `deploy/hal/deploy.sh` 部署。Hermes 插件、技能和 deathnote 脚本的改动不触发 Bridge 或 Control Plane 部署。

**阶段 0：同步链路和骨架（不改 agent 行为）**

1. 新 cron 脚本 + 冲突处理器。先 `--dry-run` 把现有冲突的预案发给你；确认后切到 `--apply`，并把 deliver 改为 Matrix。
2. 在 `agent-memory/_oma/` 放入固定在 `f87548a` 的 OMA 工具。建立 `_template`（谓词词表、roles.yaml、bootstrap 预算）、`_global`、`travel`、`household`，以及 Dorothy 房间对应的 scope（按 Q1）。修改 `.gitignore` 和 `.stignore`。
3. 验收：`lint --strict` 全部通过；手工用 OMA CLI 写一条、改一次值、记一个事件、跑一次 bootstrap；Syncthing 同步到 GQX 后能在 Obsidian 里看到。

**阶段 1：Control Plane memory 模块 + Bridge agent**

- 新增 `packages/agent-memory`：调用 OMA 子进程、解析 scope、维护 entities 和墓碑、做秘密扫描、在锁内 git 提交。env：`AGENT_MEMORY_VAULT=/root/deathnote`、`AGENT_MEMORY_ROOT=agent-memory`、`AGENT_MEMORY_TOKENS`、`AGENT_MEMORY_PYTHON=python3`。没配置时整体关闭。
- 测试：解析顺序和冲突；新主题自动声明；改值留史；墓碑；失败事务被 recover；只提交本 scope 路径；锁竞争；人工编辑后立即生效（OMA 每次都读文件）；秘密拒写。
- 共享技能 `agent-memory`。验收：WSL 上的 Codex 和 HAL 上的 claude 能读到对方在同一个仓库 scope 里写的内容。

**阶段 2：Hermes provider 替换内置记忆**

- 先在一个测试 profile 上试，再切 default，最后切 dorothy。
- 迁移 MEMORY/USER（§10.1），修改 SOUL 和技能文字。
- 验收：在旅游助手里 `/new` 之后，bootstrap 中仍有 travel 的置顶事实和最近事件；私聊里看不到 travel 的内容；对比切换前后系统提示词的字符数；Control Plane 停掉时 bootstrap 仍然能读出来，写入会明确报错。

**阶段 3：增强（每项单独决定）**

自动交接事件、prefetch、Bridge 新会话自动注入、最近会话指针、Hermes 会话导入中央档案、知识管理技能接入 Syncthing 状态检查。

## 10. 迁移、备份与回滚

### 10.1 迁移 MEMORY/USER

1. 原样备份两个 profile 的 `memories/` 到 `~/.hermes/backups/memories-pre-agent-memory-<日期>/`。
2. 一个脚本把以 `§` 分隔的条目转成「主题 × 类别」的**提案**，并给出建议的 scope 和 topic：
   - 画像类和偏好类 → `_global`。
   - 旅行相关的条目（孩子的高原反应、一家三口出行）→ `travel`。
   - 打针提醒相关 → `household`。
   - Immich、IMAP、call_bridge 这类经验 → `_global/lesson`。如果技能里已经有同样内容，改成 `pointer`。
3. USER.md 中重复的条目（姓名和电话出现了两次）合并成 `simon/profile` 一条。
4. 你在 Obsidian 里或通过管理接口批量审批，审批通过后由 OMA 应用。
5. dorothy 的 MEMORY/USER 单独迁移。角色卡私密记忆按 Q2 处理。
6. 旧文件保留，切换后至少 30 天不删。

### 10.2 会话记忆层

不迁移任何数据。对话档案仍在 Control Plane 的 `events` 表里，记忆通过 `session:<id> e:<n>` 引用它。会话被彻底删除后，引用会失效，`memory_get` 原样返回引用并标注 `source_status: gone`。

### 10.3 备份和回滚

| 层 | 备份 | 回滚 |
| --- | --- | --- |
| 记忆数据 | 每次写入是一次 git 提交；cron 推到 Gitea；Syncthing 再复制一份到 GQX | `git revert` 相关提交；最坏情况删掉整个 `agent-memory/`，不影响 PARA |
| Hermes | 旧 MEMORY/USER 原样保留 | 把 `memory.provider` 设为 `''`，两个 enabled 改回 `true`，重启网关 |
| Bridge agent | — | 删除 MCP 配置里的 memory token，卸载技能 |
| Control Plane | SQLite 备份规则不变 | 去掉 `AGENT_MEMORY_*` 即整体关闭；或者回退版本 |
| cron 脚本 | 替换前备份原脚本 | 换回原脚本即可（原来的两个缺陷会回来） |

## 11. 待定问题

| # | 问题 | 我的建议 |
| --- | --- | --- |
| Q1 | Dorothy 的 4 个房间怎么映射？她的私聊按 `_global` 处理吗？「惠的电台」是否和 `/root/projects/hui-radio-v2` 仓库绑到同一个 scope？crypto 和天鹅绒之馆各自独立吗？ | 私聊 → `_global`；其余 3 个各自独立；惠的电台绑定该仓库 |
| Q2 | `_global` 由所有 agent 共用，还是按 agent 分开？MEMORY.md 现在写的是「用户画像按 agent 分开」。另外，Dorothy 的角色卡私密记忆以前只在加载角色卡时进入上下文，迁移后怎么放？ | 用户画像（关于你的事实）全体共用一份 `_global`；每个 agent 的自我设定（例如「Hermes 自画像保持女性」）放进各自的 `_agent-hermes`、`_agent-dorothy`，只注入给自己。角色卡私密记忆建一个 `_card-<名字>` scope，只在加载角色卡时读取，不进入 bootstrap |
| Q3 | 新房间第一次对话时自动建临时 scope `room-<哈希>`，还是先落 `_global` 等你绑定？Bridge 遇到没绑定的仓库，是在第一次写入时自动建 `repo-<名字>`，还是只读 `_global`？ | 新房间自动建；没绑定的仓库在第一次写入时自动建（只读时不建） |
| Q4 | `_global` 谁能直接写？ | Hermes 和 Dorothy 直接写，Bridge 下的 agent 只能提案（它们写的大多是项目相关内容） |
| Q5 | 每轮 prefetch 召回默认开还是关？ | 先关，阶段 2 之后看实际效果再决定 |
| Q6 | 会话结束时是否用辅助模型自动写一条交接事件？ | 先不做，靠 agent 主动调用 `memory_log` |
| Q7 | Syncthing 冲突报告和 push 失败发到哪个 Matrix 房间？ | 默认 profile 的私聊 |
| Q8 | 冲突处理：干净三方合并的 `.md` 自动合并并删除副本（副本已在 git 中），可以吗？要不要顺便让 knowledge-management 技能在 GQX 离线时避免改写已有笔记？ | 自动合并可以，删除可以从 git 找回；技能调整放到阶段 3 |
| Q9 | OMA 仓库没有许可证。在私有 vault 里固定一份工具自用，可以接受吗？要不要去 GitHub 开 issue 请作者补一个许可证？开 issue 是公开行为，需要你同意 | 自用可以；开 issue 由你决定 |
| Q10 | 阶段 0（新 cron 脚本 + 冲突处理器 dry-run + vault 骨架）现在就开始做吗？ | 是。它不改变任何 agent 的行为，而且能先把冲突和未提交文件的问题解决掉 |

## 12. 依赖

| 部分 | 依赖 | 本地可跑 |
| --- | --- | --- |
| 事实源和工具 | 文件系统、git、Python3 + PyYAML、OMA 工具（固定版本，放在 vault 里） | 是 |
| Control Plane 模块 | Node（已有）；通过子进程调用 Python；不新增 npm 依赖（YAML 读写交给 OMA，`scope.md` 只读一小段 frontmatter 子集） | 是 |
| Hermes provider | Python 标准库 `urllib`；退回本地读取时调用 OMA | 是 |
| 冲突处理器 | Python3、git（`merge-file`） | 是 |
| 推送 | 自建 Gitea | 局域网 |
| Syncthing / Obsidian | 已有 | 是，非必需 |
| 模型、向量库、外部 SaaS | 无（只有 Q6 选「用模型」时才会用到 Hermes 已配置的辅助模型） | — |

## 附：参考

- OMA：<https://github.com/jrcruciani/obsidian-memory-for-ai>（`SPEC-v4.1.md`、`examples/v4.1-minimal-vault/`）
- 社区中把 Obsidian/Markdown 作为 Hermes 记忆的实践，见卡面背景资料 B 节（obsidian-hermes-memory、hermes-brain-template、obsidian-memory-architecture、agent-memory-wiki），以及 agentcairn：<https://github.com/ccf/agentcairn>（Apache-2.0）
