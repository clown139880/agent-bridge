# 设计：跨 Agent 的房间/项目作用域记忆（OMA 格式 + deathnote 子目录）

- 状态：设计稿，未实现（Kanban t_878c7584）。本文不改任何代码或配置。
- 关联材料：[conversation-memory-design.zh.md](conversation-memory-design.zh.md)（中央对话检索设计）、[conversation-memory-operations.zh.md](conversation-memory-operations.zh.md)（已落地的只读 MCP）。
- 审阅基线：agent-bridge `0.6.85`；Hermes `v2026.8.19-14230-g532f83aaf1`（`/root/.hermes/hermes-agent`）；笔记库 `/root/deathnote`。

## 0. 结论先行

1. **自建一层薄的记忆服务，不引入第三方后端。** 记忆以 OMA 风格的 Markdown/YAML 文件为唯一事实源，放在 `/root/deathnote/agent-memory/`。Control Plane 是唯一写入方，用 MCP 工具对外提供读写。Hermes 用一个很薄的 MemoryProvider 插件接入，再关掉内置的 MEMORY.md/USER.md。
2. **「房间」和「项目」统一成一个概念：作用域（scope）。** 一个 scope 是 `agent-memory/scopes/<slug>/` 下的一个目录。它的 `scope.md` 列出绑定了哪些 Matrix 房间（可细到 thread）、哪些仓库（即 agent-bridge 的 `project_identity`）、哪些机器目录。Hermes 用 `chat_id` 解析 scope，Bridge 会话用仓库或机器目录解析 scope，两边最后落到同一个目录。
3. **三层分工不变，只补上中间一层。** 仓库（代码、AGENTS.md、git）仍是项目现状的权威来源。新增的 scope 记忆只存少量、长期有效的方向性事实。中央对话档案（已有的 `conversation_*` MCP）仍负责证据和精确回溯。记忆条目可以引用对话档案的 `e:<id>` 指针，但不复制原文。
4. **全部本地运行。** 只依赖 Node（Control Plane 已有）和 Python3 + PyYAML（HAL 上已有，Python 3.13.5）。不需要模型、向量库或外部服务。唯一的网络动作是 deathnote 已有的 cron 推送到自建 Gitea。

需要你拍板的事项集中在 §9。

## 1. 现状审阅（事实）

### 1.1 Hermes 记忆现状

| 项 | 事实 |
| --- | --- |
| 默认 profile | `~/.hermes/memories/MEMORY.md`（3496 字节）和 `USER.md`（3123 字节）；`memory_enabled: true`、`user_profile_enabled: true`、`write_approval: false`、`provider: ''`，上限分别为 2200 和 1375 字符 |
| dorothy profile | 有独立的 MEMORY/USER，`write_approval: true`。SOUL.md 规定私密、角色扮演或亲密内容**不得**写进 memory 工具，只能存进角色卡的私密文件 |
| Provider 接口 | `agent/memory_provider.py`。查找顺序依次是：内置 `plugins/memory/<name>/`、`$HERMES_HOME/plugins/<name>/`、项目目录（需开关）、entry point。同名时内置优先 |
| 初始化身份 | `agent_init._memory_provider_init_kwargs` 会传入 `session_id, platform, hermes_home, agent_context(primary/cron/subagent), cwd, agent_identity(profile)`，以及 `user_id, user_name, chat_id, chat_name, chat_type, thread_id, gateway_session_key`（若存在） |
| 注入位置 | `system_prompt_block()` 在构建 agent 时进入缓存的 system prompt。`prefetch()` 的结果包在 `<memory-context>` 里，**追加到当前这轮的 user 消息**（`turn_context.compose_user_api_content`）。之后每轮原样重放，不影响 prompt 缓存前缀 |
| 内置 provider 可参考 | mem0、honcho、hindsight 等已经在 `plugins/memory/` 下，可以照着写 |
| 依赖 MEMORY.md 的地方 | dorothy 的 SOUL.md（Memory Classification 一节）、`hermes-agent`/`hermes-gateway-config` 等技能文字。切换时要一起改文字 |
| 上游 `memory.authoritative_source: obsidian` | 本机版本**没有**（源码里找不到 `authoritative_source`）。本设计不依赖它 |

MEMORY.md 里已经有这样的分工原则：「会话原记录留在中心数据库，项目状态留项目/AGENTS.md/git，技能版本化；用户画像按 agent 分开」。另外，USER.md 最后一条记录了你此前的倾向：「一个 profile + 社区成熟记忆后端（chat_id 作房间键），偏好 Mem0 或 Honcho，不自己造轮子；对系统提示词过大敏感」。这和本卡的需求 2（以 OMA 纯文件为事实源）有冲突，见 §9 决策 D1。

### 1.2 Matrix 房间

`~/.hermes/channel_directory.json` 中默认 profile 现有 4 个房间：一个未命名 DM、「旅游助手」、「管家」，以及 group 房间 `akasha`（auto_thread 开启，已有 32 个 topic thread）。所以房间粒度和 thread 粒度都需要支持，默认按房间。

### 1.3 deathnote 笔记库

| 项 | 事实 |
| --- | --- |
| 位置/远端 | `/root/deathnote`，`origin = https://gitea.zeta.uniclown.com:8443/clown139880/deathnote.git` |
| 结构 | PARA：`0. 周期笔记`、`1. 项目`（含 `BBB-Agent Bridge`、`Hermes-私人助理` 等）、`2. 领域`、`3. 资源`、`4. 存档`、`5. 表达`，共约 1000 个 md 文件 |
| 同步 | **Syncthing 和 git 同时在用**（有 `.stfolder`，已出现 `*.sync-conflict-*` 文件）。Obsidian 配置在 `.obsidian`（git 忽略） |
| 自动提交 | Hermes cron `deathnote-auto-commit-push`（每 30 分钟，`~/.hermes/scripts/deathnote-auto-commit-push.sh`）执行 `git add -A && commit && push origin HEAD` |
| ⚠ 脚本缺陷 1 | 用 `git diff --quiet && git diff --cached --quiet` 判断「无变化」，这个判断看不到**未跟踪文件**。只新增文件、没改已有文件时，永远不会提交。现在工作树里就有一批未跟踪的笔记，原因正是这个。新建的记忆文件都会落进这个坑 |
| ⚠ 脚本缺陷 2 | `date '%Y-%m-%d %H:%M:%S'` 少了 `+`，所以提交信息只剩 `chore: auto commit` |
| 现有约定 | MEMORY.md 写着「知识库 /root/deathnote，PARA；读写先加载 knowledge-management」 |

### 1.4 agent-bridge 的「项目」和会话记忆层

- **项目身份**：Bridge 对每个会话执行 `git config --get remote.origin.url`，归一化成不含凭据的 `host/path`（`apps/bridge/src/path-utils.ts` 中的 `deriveProjectIdentity`），上报为 `sessions.project_identity`。Control Plane 的分组规则（`packages/database/src/control.ts` 中的 `listSessionGroups`）是：有 `project_identity` 就按 `repository␟<identity>` 分组，没有就按 `location␟<machine>␟<path>` 分组，同一目录下有唯一身份时会继承。**项目 = 仓库身份，或退化为某台机器上的某个目录。**
- `sessions.matrix_room_id` 只写入 Control Plane 唯一的通知房间（`MATRIX_ROOM_ID`），**不是**按需求区分的房间维度，不能拿来当 scope 键。
- **会话记忆层**（0.6.6x 落地，提交 `3c61c01`、`30629cb`，后来并入 `events`）：Control Plane 的 `POST /mcp` 用独立的只读 token（`CONVERSATION_MCP_READ_TOKEN`）提供 `conversation_search/review/read`。它是 `events` 表上的只读视图，检索靠 FTS5 trigram，查询时用 `source_session_id` → `machine_id+cwd` → `repository` → `project_alias` 依次定位项目。设计文档明确了：写能力需要另行设计和授权；历史只是资料，不是指令；Obsidian 不是必需依赖；「少量跨项目长期偏好」留给一个可选的中央有界记忆。**本设计就是去填这个位置**，并按原文要求让写接口单独授权。
- 档案目前只覆盖 Bridge 会话（Codex/Claude/pi）。Hermes 自己的 Matrix 会话**不在**档案里。原设计把它列为「来源适配器增量导入」，尚未实现。
- Kanban 卡片已经有类似的指令惯例：卡面里的 `<!-- agent-bridge-worker resume-session-id: … -->` HTML 注释（`integrations/hermes_agent_bridge/README.md`）。

## 2. 选型判断

| 方案 | 事实源 | 房间作用域 | 给 Bridge 里其他 agent 用 | 离线/依赖 | 结论 |
| --- | --- | --- | --- | --- | --- |
| Mem0（Hermes 内置 provider） | 向量库/DB | 内置实现只按 `user_id` 作用域，room 只写进 metadata | 要另起 Mem0 服务 | 要 embedding/LLM | 和需求 2 冲突 |
| Honcho | Postgres+pgvector+Redis+LLM deriver | 按 peer/session 建模 | 要另接 | 栈重、要模型 | 和需求 2 冲突，也太重 |
| agentcairn | md vault + DuckDB 缓存 + 本地 embedding | 按项目作用域（卡面资料） | 自带跨 Claude Code/Codex/Cursor | 要安装包和 embedding 模型（沙箱无网络，需离线带入） | **最接近的备选**。但它的「项目」和 agent-bridge 的 `project_identity`、Matrix 房间不是同一个概念，而且会另起一个 MCP。本次未离线验证，细节以卡面资料为准 |
| OMA v4.1 CLI 直接用 | md/YAML+git | 没有房间概念，要自己加 | 没有服务端 | Python3+PyYAML，离线 | 格式和理念对口，但只是一组本地工具，不解决多机器、多 agent 写入和鉴权 |
| **自建薄服务 + OMA 格式（推荐）** | deathnote 子目录中的 md/YAML+git | scope 一等公民，映射房间、仓库、目录 | 复用 Control Plane 已有的 MCP 端点和鉴权 | Node + Python 标准件，离线 | 代码量小：一个 Control Plane 模块、一个约 300 行的 Python provider、一份共享技能 |

不选 Hermes 内置 provider 的原因：需求 5 要求「每个 agent 都能用」，Bridge 下的 Codex/Claude/pi 跑在 HAL、WSL、Windows 上，Hermes 插件进不了它们的进程。真正共享的入口只能放在中心，也就是 Control Plane。Hermes 只是其中一个客户端。

「自建」的范围要控制住：不做 embedding，不做 LLM 抽取，不做图谱，只做文件读写、作用域解析、确定性检索和 git 提交。OMA 的边界（个人/项目记忆，几百到几千条事实）正好覆盖这里的规模。

## 3. 总览架构

```text
                    Matrix 房间 / thread                 Bridge 会话（Codex / Claude / pi）
                           │                                   │ cwd、project_identity
                           ▼                                   ▼
  Hermes 网关 ── agent-bridge-memory provider        MCP 客户端配置 + 共享技能 agent-memory
   (default / dorothy profile)  │ HTTP（本机）              │ HTTP（远程 MCP）
                                └──────────────┬────────────┘
                                               ▼
                              Control Plane  /mcp（同一端点，按 token 分权）
                               ├─ conversation_*      只读（已有）
                               ├─ memory_* 读          作用域解析 / bootstrap / 检索
                               ├─ memory_* 写          校验 → 原子写文件 → git commit（单写入方）
                               └─ 派生索引            内存中，按 mtime 失效，可随时重建
                                               │
                                               ▼
                    /root/deathnote/agent-memory/   （OMA 风格 md/YAML，唯一事实源）
                                               │
                     deathnote cron：commit + push → Gitea；Syncthing → 其他设备 / Obsidian
```

| 组件 | 职责 | 不负责 |
| --- | --- | --- |
| `agent-memory/` 目录 | 唯一事实源：scope 绑定、事实、提案 | 运行时状态、对话原文、秘密 |
| Control Plane memory 模块 | 唯一写入方；校验 schema、权限、秘密扫描和大小；原子写入；按路径 git commit；作用域解析；bootstrap 组装；确定性检索 | 推送远端（交给已有 cron）、调用模型 |
| Hermes provider | 从 `chat_id/thread_id` 解析 scope，注入 bootstrap，可选按轮召回，把工具调用转发给 Control Plane | 直接写文件、自己维护索引 |
| 共享技能 `agent-memory` | 告诉 Bridge 下的 agent 什么时候读、什么时候写、写什么、不写什么 | 凭据、MCP 注册 |
| 对话档案（已有） | 证据和回溯；记忆条目通过 `e:<id>` 引用它 | 长期事实 |

### 3.1 数据流

**写入**：agent 调用 `memory_write` → Control Plane 用 token 确定调用方身份，从 `scope` 参数或会话上下文解析出 scope → 校验 frontmatter、作用域写权限、秘密和 PII 规则、单条大小 → 拿 vault 写锁 → 先写临时文件再 rename（改值时保留旧值，见 §5.3）→ `git commit -- agent-memory/<path>`，只提交本次涉及的路径，绝不 `add -A` → 刷新索引 → 返回事实 ID 和 commit。Control Plane 不 push，推送交给 cron。

**注入**：会话开始时，Hermes provider 的 `initialize()` 解析 scope，再从 Control Plane 取回 `_global` 和当前 scope 的 bootstrap，拼成 `system_prompt_block()`。Bridge 会话第一阶段靠技能指示 agent 先调 `memory_bootstrap`，第三阶段可以改成 Bridge 在新会话首轮自动附带（§6.3）。

**召回**：可选。`queue_prefetch` 在后台调 `memory_search(query, scope=当前)`，下一轮由 `prefetch()` 取缓存，结果作为 `<memory-context>` 追加进 user 消息。检索是确定性的：先匹配别名/实体/谓词，再做全文关键词匹配，当前 scope 优先，然后 `_global`。

**跨房间查询**：只能显式调用 `memory_search(scope="all" | "<slug>")`。结果都标出来源 scope，**永远不会**自动注入别的 scope 的内容。

## 4. Hermes 接入：完全取代内置记忆

### 4.1 插件形态

- 源码放在本仓库 `integrations/hermes_agent_memory/`（`plugin.yaml` + `__init__.py`，继承 `MemoryProvider`，`name = "agent-bridge-memory"`），安装到 `~/.hermes/plugins/agent-bridge-memory/` 和 `~/.hermes/profiles/dorothy/plugins/agent-bridge-memory/`。名字不能和内置 provider 重名，否则会被内置的覆盖。
- 配置（每个 profile 单独改 `config.yaml`）：

```yaml
memory:
  provider: agent-bridge-memory
  memory_enabled: false        # 摘掉内置的 memory 工具和 MEMORY.md 注入
  user_profile_enabled: false  # 摘掉 USER.md 注入
```

- 连接参数放 `~/.hermes/.env`：`AGENT_MEMORY_URL=http://127.0.0.1:<CP 端口>/mcp`、`AGENT_MEMORY_TOKEN=<该 profile 专用 token>`。

### 4.2 各钩子的实现

| 钩子 | 行为 |
| --- | --- |
| `is_available` | 只检查 URL/token 是否配置，不连网 |
| `initialize(**kw)` | 用 `platform`、`chat_id`、`thread_id`、`cwd`、`agent_identity`、`agent_context` 调 `memory_resolve_scope`。matrix 平台的房间键是 `chat_id` 去掉 thread 后缀后的 `!room:server`，先查 thread 绑定再查房间绑定；cli 平台按 `cwd` 推导仓库身份。`agent_context` 为 cron 或 subagent 时**只读**。结果缓存在实例上 |
| `system_prompt_block()` | 静态块，依次是：`_global` bootstrap（预算 ≈ 现在 2200+1375 字符，**不增加总量**）、当前 scope bootstrap（默认预算 1500 字符）、约 6 行工具使用说明。会话期间不变 |
| `prefetch` / `queue_prefetch` | 默认**关闭**（见决策 D5）。开启时用 `is_trivial_prompt` 跳过闲聊，每轮上限 800 字符，Control Plane 超时 1.5 秒就返回空 |
| `get_tool_schemas` / `handle_tool_call` | `memory_search`、`memory_get`、`memory_write`、`memory_retract`、`memory_scope`（查看当前 scope 和绑定）。全部转发给 Control Plane，`scope` 参数默认是 initialize 时解析出的当前 scope |
| `sync_turn` | 空实现。不按轮自动抽取 |
| `on_session_end` / `on_pre_compress` | 第一、二阶段空实现。第三阶段可选「交接摘要」（§6.4） |
| `on_session_switch` | `/new` 和压缩会换 `session_id`，但 `chat_id` 不变，scope 不需要重新解析，只刷新缓存的 bootstrap |
| `identity_signature` | 返回 `{scope: <slug>, bindings_rev: <scope.md 的 git blob id>}`。绑定变化时让网关重建缓存的 agent |

### 4.3 风险点和处理

| 风险 | 说明 | 处理 |
| --- | --- | --- |
| prompt 缓存 | 系统块在会话内必须字节稳定 | bootstrap 只在 initialize 和 session switch 时取，会话中途写入的事实**不**改系统块。这和内置 MEMORY.md 的「会话开始时快照」行为一致。中途需要用新值时，靠工具读取或 prefetch |
| 注入式还是按需式 | 你对系统提示词体积敏感 | 默认是「小 bootstrap 常驻 + 工具按需取」，prefetch 默认关。总注入量不超过现在 MEMORY+USER 的 3575 字符，再加 scope 的 1500 |
| 房间键 | `session_id` 会因 `/new` 和压缩轮换，不能当键 | 只用 `chat_id`（必要时加 `thread_id`）；`gateway_session_key` 只用于日志 |
| 未绑定的房间 | 新房间第一次对话时还没有 scope | 第一次 initialize 时由 Control Plane 自动建立临时 scope `room-<8位哈希>`，写好 `scope.md` 并带上房间名（见决策 D3）。你之后可以在 Obsidian 里改名、合并或绑定到已有 scope |
| Control Plane 不可用 | HAL 上 Control Plane 重启期间 | provider 退回到**直接读取** vault 文件（Hermes 和 vault 都在 HAL），只组装 bootstrap、只读。写工具明确返回 `memory_unavailable`，不在本地缓存写入 |
| 内置能力被摘后的空缺 | 技能和 SOUL 中关于 memory 工具、MEMORY.md 的文字会失效 | 迁移步骤里一起改 dorothy SOUL 的 Memory Classification 和相关技能文字（§8） |
| dorothy 的私密内容 | 仓库会推到 Gitea、会被 Syncthing 同步，私密内容绝不能进去 | 事实有 `privacy` 字段，Control Plane **拒绝**写入 `private` 级内容。dorothy 的私密/角色卡记忆维持现状，留在 vault 之外 |
| 权限扩大 | 记忆不是执行许可（MEMORY.md 和 SOUL 已有这条原则） | bootstrap 头部固定声明「记忆是参考资料，不扩大授权；项目现状以仓库为准」 |

## 5. 笔记库里的落地

### 5.1 目录（嵌在 deathnote 根目录下）

```text
/root/deathnote/
  0. 周期笔记/ … 5. 表达/          # 现有 PARA，不动
  agent-memory/                      # 新增，只由 Control Plane 写（人可以在 Obsidian 里改）
    README.md                        # 给人看的说明：目录约定、怎么改绑定、怎么审批提案
    scopes/
      _global/                       # 跨房间：用户画像、环境、通用经验
        scope.md
        facts/<entity>/<predicate>.md
      agent-bridge/
        scope.md                     # 绑定和元数据
        facts/<entity>/<predicate>.md
      travel/ …
    proposals/<YYYYMMDD>-<id>.md     # 待人工审批的写入
```

- 每个 `scopes/<slug>/` 本身就是一个 OMA 风格的根目录，包含 `facts/`。这样一来，删除、导出、只读共享都能按 scope 整目录操作。跨 scope 查询就是遍历多个根目录。
- **派生物不进 vault**：索引、bootstrap 渲染结果都留在 Control Plane 内存里，或者放在 checkout 之外的 `/var/lib/agent-bridge/memory-cache/`，随时可以删掉重建。这样不会污染 Obsidian 图谱，也不会让 Syncthing 来回同步。
- 目录名用 ASCII 的 `agent-memory`，因为 shell、git pathspec 和 MCP 参数都更不容易出错。如果你希望它像 PARA 编号一样排在最后，可以改成 `9. Agent记忆`（决策 D4）。不论叫什么，建议在 Obsidian 的「排除的文件」里加上 `agent-memory/scopes/*/facts`，避免干扰全局搜索。这个设置在 `.obsidian` 里，不进 git。
- **和 PARA 笔记的关系**：`scope.md` 的 `para_note` 用 wikilink 指向对应的项目笔记，例如 `[[1. 项目/BBB-Agent Bridge/README]]`。项目笔记还是你自己的笔记，agent 不写入 PARA 区域。如果需要单向反链，可以在 PARA 笔记里手动加 `[[agent-memory/scopes/agent-bridge/scope]]`。

### 5.2 scope 的表达方式：目录为主，绑定写在 frontmatter

```yaml
# agent-memory/scopes/agent-bridge/scope.md
---
type: scope
id: agent-bridge
title: Agent Bridge
aliases: [ab, 桥]
status: active            # active | archived
bindings:
  matrix:
    - room: "!jFhXT73U0v2nRIZobl:uniclown.com"
      thread: "$Y6ko9r4XNT-Av-3W85su6281Oml74KuZb-5hiV9szFs"   # 可选；不写则绑整个房间
  repositories:
    - gitea.zeta.uniclown.com:8443/clown139880/agent-bridge     # 与 sessions.project_identity 同一归一化规则
  locations:
    - { machine: hal, path: /root/agent-bridge }                # 无 git remote 的目录
  kanban_boards: []
para_note: "[[1. 项目/BBB-Agent Bridge/README]]"
bootstrap_budget: 1500
---
一两句这个方向在做什么（人写，也会进 bootstrap）。
```

**解析优先级**（Hermes 和 Bridge 共用一个函数）：thread 绑定 → 房间绑定 → 仓库身份 → 机器+目录 → 卡面指令 `memory-scope:` → 未绑定（Hermes 房间自动建临时 scope，其他情况只用 `_global`）。同一个键绑到多个 scope 时，`memory_resolve_scope` 返回 `conflict`，并列出候选 scope，不会猜。由 lint 报告出来，你来修。

为什么不用标签：标签需要逐条维护，查询要全量扫描，删除或导出也不能按目录整体操作。目录 + 绑定文件既符合「文件系统即索引」，又只需要改一个文件就能重新绑定。

### 5.3 事实文件

格式跟 OMA v4.1 的「一事实一文件、frontmatter 即 schema」走。下面的字段是本设计需要的最小集合。实施第 0 步要拿到 OMA v4.1 源码，核对字段名、时序历史的写法和提案格式，**以 OMA 实际格式为准**再定稿（见 §7 阶段 0）。

```yaml
# agent-memory/scopes/agent-bridge/facts/hal-deploy/preferred-path.md
---
entity: hal-deploy
predicate: preferred-path
value: "HAL 只用 deploy/hal/deploy.sh；不手动重启服务"
valid_from: 2026-10-12
history:                         # 改值时把旧值移到这里（时序事实）
  - { value: "…旧值…", valid_from: 2026-09-01, valid_to: 2026-10-12, by: claude@hal }
by: claude@hal                   # 由 token 身份决定，不信任参数
source: "session:claude-3b9750e3 e:18234"   # 可选，指向对话档案
privacy: normal                  # normal | sensitive（只进 bootstrap 不进 prefetch）；private 一律拒写
confidence: confirmed            # confirmed | stated（用户口述）| inferred
---
（可选）给人看的补充说明。
```

- **撤回不删除**：`memory_retract` 写入 `valid_to` 并保留文件，`--as-of` 查询仍然能看到当时的值。真正删除由人在 Obsidian 或 git 里做。这符合 USER.md「任何删除须明确授权」。
- 秘密扫描：沿用常见 token 和私钥的正则，外加 `.env` 风格的 `KEY=…` 行，命中就拒写。手机号、真实姓名这类 PII 允许出现在 `_global` 的用户画像里（USER.md 现在就有），但标为 `sensitive`，不会进入 prefetch。因为整个库会推到 Gitea，这一点要你确认（决策 D7）。

### 5.4 写入策略

| 目标 | 谁能写 | 方式 |
| --- | --- | --- |
| 当前 scope 的 facts | scope 内会话中的任一已认证 agent | 直接提交（保留历史）。这是「同方向持续迭代」的主要通道 |
| 其他 scope | agent | 生成提案，不直接写 |
| `_global`（画像/环境） | Hermes 默认 profile（与现在 `write_approval: false` 一致）可以直接写；其他身份只能提案 | 见决策 D6 |
| `scope.md` 的绑定 | 只有人（Obsidian 编辑或 Control Plane 管理接口）。agent 只能提案 | 防止 agent 把房间串到别的 scope |
| 提案审批 | 人：在 Obsidian 里把提案的 `status` 改成 `approved`/`rejected`，或调用带 `CONTROL_API_WRITE_TOKEN` 的 REST 接口。Control Plane 读到后应用并提交 | 不能自己审批自己（OMA 角色策略）。agent 用的 memory token 没有审批权限 |

### 5.5 和 Syncthing、cron、人工编辑并存

- **单写入方加 git 锁**：Control Plane 写 vault 时拿 `flock /run/lock/deathnote-git.lock`。cron 脚本也要改成先拿同一把锁再 `git add`（脚本在 Hermes 目录下，不在本仓库，要你同意后再改；决策 D8）。即使脚本不改，Control Plane 也只提交自己的路径，并在遇到 `index.lock` 时重试，不会和 `add -A` 互相破坏，最坏情况只是同一批改动被 cron 一起提交。
- **必须修好 cron 脚本的两个缺陷**（§1.3）。否则新的记忆文件在 Control Plane 提交之外永远不会进 git，人在 Obsidian 里新建的提案也一样。这是阶段 0 的前置条件。
- **人工编辑也是合法写入**：Control Plane 不在内存里保存权威状态，每次读取都按 mtime 检查文件。人在 Obsidian 里改了某个事实，下一次 bootstrap 就会生效。frontmatter 写坏的文件会被跳过，并在 lint 中报告，不会拖垮整个服务。
- **Syncthing 冲突**：对 `agent-memory/**` 下出现的 `*.sync-conflict-*`，lint 会报告，`memory_resolve_scope` 返回 `warnings`。Control Plane 不会自动合并，交给人处理。

## 6. 与 agent-bridge 整合

### 6.1 房间 ≈ 项目的映射

agent-bridge 现在的「项目」就是 `project_identity`（或机器+目录），本设计没有发明第三套身份。scope 只是在这之上加的一层**命名的、可绑定多个键的集合**：

```text
scope "agent-bridge" ── matrix room/thread（Hermes 侧）
                     ├─ repository gitea…/agent-bridge（Bridge 侧，跨机器）
                     └─ location hal:/root/agent-bridge（无 remote 时）
```

于是同一个方向会自然汇合：在 Matrix「akasha / Agent Bridge thread」里和 Hermes 聊，在 HAL 上 `/root/agent-bridge` 跑 claude 卡片，在 WSL 上用 Codex 改同一个仓库，读写的都是 `scopes/agent-bridge/`。

Kanban 卡片：Hermes 从某个房间创建卡片时，在卡面写入 `<!-- agent-bridge-worker memory-scope: <slug> -->`，和 `resume-session-id` 用同一种指令格式。supervisor 解析后把它放进派发参数，Control Plane 把它记成会话的 scope 提示。卡片里没有这条指令时，按 worker 的工作目录用仓库身份解析。

### 6.2 MCP 接口

接口挂在已有的 `POST /mcp`（`apps/control-plane/src/memory-mcp.ts`）上，`tools/list` 按 token 权限返回不同的工具集：

| token | 来源 | 工具 |
| --- | --- | --- |
| `CONVERSATION_MCP_READ_TOKEN`（已有） | 不变 | `conversation_*`，再加只读的 `memory_resolve_scope/bootstrap/search/get` |
| `AGENT_MEMORY_TOKENS`（新增，`name:token` 列表，例如 `hermes-default:…,dorothy:…,claude@hal:…,codex@wsl:…`） | 每个客户端一枚，放各端本机秘密配置，不进 git 和 prompt | 上面这些，加上 `memory_write/retract/propose`；`by` 字段取 token 的名字 |
| `CONTROL_API_WRITE_TOKEN`（已有） | 人/管理端 | REST：`GET/POST /api/v1/memory/proposals/:id/{approve,reject}`、`GET /api/v1/memory/lint` |

工具契约（拟议）：

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `memory_resolve_scope` | `platform`，以及 `room_id`/`thread_id`/`source_session_id`/`machine_id+cwd`/`repository`/`scope_hint` 中的若干项 | `scope`、命中的绑定、`conflict` 候选、`warnings` |
| `memory_bootstrap` | `scope`、`budget` | 渲染好的 `_global`+scope 核心事实（按 confidence 和最近更新时间排序截断），附截断标记，以及（第三阶段）该 scope 最近的 Bridge 会话指针 |
| `memory_search` | `query`、`scope`（`current`/`global`/`all`/`<slug>`）、`as_of`、`limit` | 事实列表，带 scope、路径、valid 区间、来源 |
| `memory_get` | `scope`、`entity`、`predicate`、`history?` | 单个事实，含历史 |
| `memory_write` | `scope`、`entity`、`predicate`、`value`、`note?`、`source?`、`privacy?`、`confidence?` | 写入的路径、commit，或者在无权直写时返回 `proposal_id` |
| `memory_retract` | `scope`、`entity`、`predicate`、`reason` | 同上 |
| `memory_propose` | 同 write，外加 `target`（scope 绑定修改等） | `proposal_id` |

远程 MCP 读不到调用方的 cwd，所以沿用原设计的规则：调用方自己取 cwd 和 Git remote，显式传入。共享连接上不保存「当前 scope」。

### 6.3 Bridge 下各 agent 的接入

- **第一阶段（零代码改 Bridge）**：各端在 MCP 客户端配置中加上 `AGENT_MEMORY_TOKENS` 中属于自己的那枚 token，并通过 `shared-skills/manifest.json` 安装新的共享技能 `agent-memory`。技能约定：开始一个有实质内容的任务时，用 cwd 和 remote 调一次 `memory_bootstrap`；形成了方向性决定、偏好、已确认的约束时，写入当前 scope；**不要**写代码事实、AGENTS.md 已有的规则、一次性状态或秘密。
- **第三阶段（可选，更可靠）**：Bridge 在**新建会话**的第一轮，把 `memory_bootstrap` 结果当作开发者说明附加进去。Bridge 知道 `project_identity`，Control Plane 能解析 scope。这需要分别确认 Codex App Server 和 Claude adapter 有没有可用的附加说明入口（`apps/bridge/src/app-server.ts`、`claude/claude-adapter.ts` 现在没有这样的参数），涉及 protocol 和 Bridge 版本升级。只对新会话生效，不改续写中的会话，以保持 prompt 缓存。

### 6.4 「新开对话也保持上下文」的来源

| 来源 | 内容 | 阶段 |
| --- | --- | --- |
| `scope.md` 正文和核心事实 | 这个方向是什么，关键约束和偏好 | 1 |
| 约定谓词 `<scope>/focus/current` 和 `<scope>/focus/open-questions` | 当前在推进什么、还有什么没定。由 agent 在完成一段实质工作后用 `memory_write` 更新，属于时序事实，旧值保留 | 2（靠技能和提示词约束） |
| 最近会话指针 | 绑定到该 scope 的仓库或目录最近 N 个 Bridge 会话的标题、时间、`session_id`，从 `sessions` 表确定性查出。需要细节时用 `conversation_review` | 3 |
| Hermes Matrix 会话 | 目前不在中央档案。scope 内的回溯先靠 Hermes 自带的 `session_search`（按 `chat_id`） | 依赖原设计中的 Hermes 来源适配器，单独立项 |
| 交接摘要 | `on_session_end`/`on_pre_compress` 用 Hermes 辅助模型生成一段交接摘要，写进 `focus/handoff` | 3，可选；需要模型调用，见决策 D9 |

## 7. 分阶段实施

每个阶段都可以单独验收和回滚。涉及 Control Plane 和 protocol 的阶段按 AGENTS.md 升级根版本，并用 `deploy/hal/deploy.sh` 部署。Hermes 插件和技能的变更不触发 Bridge 或 Control Plane 部署。

**阶段 0：前置（不改运行行为）**

1. 修 `deathnote-auto-commit-push.sh` 的两个缺陷，加上共享 flock（需你同意，D8）。
2. 把 OMA v4.1 源码作为离线制品带进来：在有网络的机器上 clone 到自建 Gitea 镜像，HAL 从镜像拉取，**不在运行时下载**。核对事实文件、时序历史和提案的格式，把 §5.3 定稿。OMA 的 `lint`/评测工具可以作为离线校验器使用，但不作为运行时依赖。还要确认它的许可证允许这样用。
3. 在 deathnote 建立 `agent-memory/README.md`、`scopes/_global/scope.md`，以及几个 scope 草稿（按 4 个现有房间加 agent-bridge 仓库）。绑定先由你确认。

**阶段 1：Control Plane 读写服务 + Bridge agent 通过技能使用**

- `packages/database` 旁边新建 `packages/agent-memory`（纯文件读写、解析、索引，不碰 SQLite），由 `apps/control-plane` 挂到 `/mcp` 和 REST 上。新增 env：`AGENT_MEMORY_VAULT=/root/deathnote`、`AGENT_MEMORY_ROOT=agent-memory`、`AGENT_MEMORY_TOKENS`。未配置时整体关闭，现有行为不变。
- 测试：解析优先级和冲突、时序改值、拒写 private 和秘密、只提交自己的路径、`index.lock` 重试、损坏的 frontmatter 会被跳过、sync-conflict 能被报告、人工编辑后按 mtime 失效。
- 共享技能 `agent-memory` 和 MCP 客户端配置。验收：WSL 上的 Codex 和 HAL 上的 claude 对同一个仓库能读到对方写入的 scope 事实。

**阶段 2：Hermes provider 取代内置记忆**

- 写 `integrations/hermes_agent_memory/`，先在 **dorothy 以外的一个测试 profile** 上试，再切默认 profile，最后切 dorothy。
- 迁移 MEMORY/USER（§8），修改 dorothy SOUL 和相关技能文字。
- 验收：同一个房间 `/new` 之后，bootstrap 中仍然有该 scope 的 focus；不同房间之间互相看不到对方 scope 的内容；对比切换前后的系统提示词字符数；Control Plane 停掉时 bootstrap 仍能从文件读出，写入会明确报错。

**阶段 3：增强（每项单独决定）**

Bridge 新会话自动注入 bootstrap；bootstrap 附带最近会话指针；交接摘要；prefetch 召回；Hermes Matrix 会话导入中央档案。

## 8. 迁移、备份与回滚

### 8.1 迁移现有 MEMORY.md / USER.md

1. 先把两个 profile 的 `memories/` 原样备份到 `~/.hermes/backups/memories-pre-agent-memory-<date>/`（checkout 之外）。
2. 一个脚本把 `§` 分隔的条目逐条读出来，生成**提案**，不直接落事实。每条都给出建议的 scope（大多数是 `_global`；Immich、call_bridge、IMAP 这类经验可能更适合放进各自领域的 scope，或者按 MEMORY.md 自己的原则移进技能 references）、entity 和 predicate。
3. 你在 Obsidian 里批量审批。拿不准的条目保留为 `_global`。
4. USER.md 里重复的条目（真实姓名/电话出现了两次）合并成一个事实。privacy 标记见 D7。
5. dorothy 的 MEMORY/USER 单独迁移；任何疑似私密的内容都不迁，留在原处。
6. 迁移后旧文件不删，在切换配置后保留至少 30 天。

### 8.2 和会话记忆层的关系

不迁移任何数据。对话档案仍在 Control Plane 的 `events` 表里，scope 记忆通过 `source` 指针引用它。删除会话时（`30629cb` 的完全清除）不会联动删除记忆，但被引用的指针会失效：`memory_get` 返回 `source_status: gone`，不会报错。

### 8.3 备份

- 事实源本来就在 git 里：每次写入是一个提交，cron 推到 Gitea，Syncthing 再同步一份到其他设备。
- 派生缓存不需要备份。Control Plane 的 SQLite 备份规则不变（在线 backup API，放在 checkout 之外）。
- 提案、绑定和事实都是文本文件，恢复用 `git revert` 或 checkout 某个历史版本即可。

### 8.4 回滚

| 层 | 回滚方式 |
| --- | --- |
| Hermes | `memory.provider: ''`，`memory_enabled`/`user_profile_enabled` 改回 `true`，重启网关，旧 MEMORY/USER 原样生效 |
| Bridge agent | 删掉 MCP 配置里的 memory token，卸载技能 |
| Control Plane | 去掉 `AGENT_MEMORY_*` env，模块就整体关闭；或者回退到上一个版本 |
| 数据 | `git revert` 记忆相关的提交；最坏情况整体删除 `agent-memory/` 目录，不影响 PARA 笔记 |

## 9. 决策点清单

| # | 问题 | 选项 | 建议 |
| --- | --- | --- | --- |
| D1 | USER.md 记录过你倾向「Mem0/Honcho，不造轮子」，本卡要求 OMA 纯文件。以哪个为准？ | a 本设计（自建薄层 + OMA 格式）／b 先离线评估 agentcairn，再决定是否用它当 Hermes provider，同时让 Control Plane 只读它的 vault ／c Mem0 | a。需要写的只是一层很薄的接线，本身不重；Mem0/Honcho 和需求 2 冲突 |
| D2 | scope 粒度 | 默认按房间；thread 只在显式绑定后单独成 scope ／ 每个 thread 都独立成 scope | 默认按房间。akasha 有 32 个 thread，全部独立会碎片化 |
| D3 | 未绑定的房间 | 自动建临时 scope `room-<hash>` ／ 只用 `_global`，等你绑定 | 自动建临时 scope（房间少，便于新开对话就有记忆） |
| D4 | 子目录名 | `agent-memory/` ／ `9. Agent记忆/` ／ 其他 | `agent-memory/` |
| D5 | 每轮 prefetch 召回 | 默认关 ／ 默认开（800 字符） | 先关，第二阶段之后看效果再开 |
| D6 | `_global` 谁能直接写 | 只有 Hermes 默认 profile 可直写、其余提案 ／ 全部提案 ／ 全部直写 | 前者，和现在的 `write_approval` 设置一致 |
| D7 | 真实姓名、电话这类 PII 是否允许进入会推到 Gitea 的 vault | 允许，但标 `sensitive` ／ 不进 vault，留在 Hermes 本地 | 需要你决定；本设计默认前者 |
| D8 | 是否允许修改 Hermes 的 deathnote cron 脚本（修缺陷、加锁） | 是 ／ 否 | 是；不修的话新文件不会被提交 |
| D9 | 交接摘要是否使用模型 | 不用（agent 自己写 focus）／ 用 Hermes 辅助模型 | 先不用 |
| D10 | Hermes 插件的版本放在哪里 | 和 `hermes_agent_bridge` 一样在自己的 `plugin.yaml` 里单独维护，不升级根版本 ／ 跟根版本走 | 单独维护；只有 Control Plane 和 protocol 的变化才升级根版本 |

## 10. 依赖清单

| 部分 | 依赖 | 本地可跑 | 说明 |
| --- | --- | --- | --- |
| 事实源 | 文件系统 + git | 是 | deathnote 已有 |
| Control Plane memory 模块 | Node（已有），YAML 解析库 | 是 | workspace 目前**没有** YAML 依赖。两种做法：一是只支持本设计用到的 frontmatter 子集，自己写一个解析器，不新增依赖；二是在有网络的开发机上加依赖并提交 lockfile。不论哪种，HAL 部署都不能联网下载 |
| Hermes provider | Python 3.13 + 标准库 `urllib` + PyYAML（HAL 已有） | 是 | 退回读文件时要用 PyYAML |
| OMA 工具 | Python3 + PyYAML | 是 | 离线制品，可选，只用于校验和评测 |
| 推送到 Gitea | 自建 Gitea（`gitea.zeta.uniclown.com`） | 局域网/自建 | 已有 cron 负责；推送失败不影响本地读写 |
| Syncthing / Obsidian | 已有 | 是 | 非必需；只影响人能不能在其他设备上看和改 |
| 模型、向量库、外部 SaaS | 无 | — | 只有决策 D9 选「用模型」时，才会用到 Hermes 已配置的辅助模型 |
