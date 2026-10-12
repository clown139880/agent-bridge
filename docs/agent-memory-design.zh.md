# 设计：跨 Agent 的房间/项目作用域记忆

- 状态：设计稿第 3 版（整合版），Kanban t_878c7584。阶段 0 已上线；阶段 1（`packages/agent-memory` + Control Plane `memory_*` 工具 + `agent-memory` 技能）于 0.6.86 实现，运行说明见 [agent-memory-operations.zh.md](agent-memory-operations.zh.md)。阶段 2 已在 dorothy profile 上线（插件 `integrations/hermes_agent_memory`，2026-10-12）：Dorothy 的 USER.md 迁入 `_global`，她自己的职责规则迁入隐藏作用域 `_agent-dorothy`（只注入给 Dorothy），Navi 日报规则迁入 `crypto`；dorothy-service-policy 放行 7 个 memory_* 工具。2026-10-12 default profile 也已切换：Hermes 的自我规则迁入隐藏作用域 `_agent-hermes`，其余并入 `_global`、`household`、`travel`；旅游助手房间改由 Dorothy 接管，记忆随房间继承。0.6.90 起 SOUL 与角色卡统一为「人设」作用域（`soul.md`，只由人编辑，见运行说明）；0.6.88 增加整句召回（`mode: recall`，关键词无命中时自动退回），插件 0.2.0 在 `prefetch: true` 的作用域（目前是 travel）启用每轮召回。WSL/Windows 上 agent 的写入 token 已签发，需在各机器上安装（HAL 无法直连）。角色卡私密记忆仍留在各角色卡技能的 references 里，未迁移。
- 关联：[conversation-memory-design.zh.md](conversation-memory-design.zh.md)、[conversation-memory-operations.zh.md](conversation-memory-operations.zh.md)。
- 基线：agent-bridge `0.6.85`；Hermes `v2026.8.19-14230-g532f83aaf1`；笔记库 `/root/deathnote`；格式参考 OMA v4.1（`jrcruciani/obsidian-memory-for-ai@f87548a`，仅作参考，不依赖）。

## 0. 一页结论

- **记忆是什么**：存在 `/root/deathnote/agent-memory/` 下的 Markdown 文件。每个房间或项目一个目录，叫作用域（scope）。另有一个 `_global`，存所有 agent 共用的、关于你本人和环境的记忆。
- **格式**：吸收 OMA v4.1 的一个子集。一条事实一个文件，frontmatter 就是结构；改值时旧值另存，可以查当时的值；进展用只追加的事件记录；开局注入的核心记忆由程序在字符预算内确定性地生成。
- **代码**：在 agent-bridge 的 `packages/agent-memory` 里用 TypeScript 按规范重写这个子集。**不复制 OMA 源码**，因为 OMA 没有许可证，而 agent-bridge 是公开仓库。之后不再跟随 OMA 项目。
- **谁来写**：Control Plane 是唯一写入方，通过已有的 `/mcp` 提供 `memory_*` 工具。Hermes 和 Dorothy 用一个薄的 MemoryProvider 插件接入，同时关掉内置的 MEMORY.md/USER.md。Bridge 下的 Codex/Claude/pi 用 MCP 配置加共享技能接入。
- **跨房间**：任何房间的记忆都能搜索，也能像加载技能一样在本次对话中**临时加载**。
- **同步**：修好 deathnote 的自动提交脚本，再加一个 Syncthing 冲突处理器。有事要你处理时，通过 Hermes webhook 发到 Hermes 私聊。
- **依赖**：全部在本地运行，不需要模型、向量库或外部 SaaS。

## 1. 已定决策

| 主题 | 决定 |
| --- | --- |
| 方案 | 自建薄层，格式用 OMA v4.1 子集；吸收代码，抛弃 OMA 项目本身（2026-10-12） |
| 作用域划分 | 按房间。私聊和 akasha（老房间，将弃用）都算全局。thread 不单独成作用域 |
| Dorothy 的房间 | 私聊 → `_global`；crypto、天鹅绒之馆、惠的电台各自独立；惠的电台同时绑定 `hui-radio-v2` 仓库 |
| 自动建作用域 | 新房间第一次对话就建；没绑定的仓库在第一次写入时建。没用的你自己删 |
| 隐私 | 自建 Gitea + 私有库，不做隐私分级，Dorothy 的私密内容也可以入库。只拦截凭据（token、私钥） |
| 全局记忆 | 「不管在哪个房间都该知道的事」：你是谁、通用偏好、环境、通用经验。Hermes/Dorothy 可以直接写；Bridge 下在仓库里干活的 agent 只读全局，只写自己的项目作用域 |
| 自动行为 | 不把每轮对话写进笔记；会话结束时自动记一条机械交接事件（不用模型）；每轮自动召回先在一个房间试用 |
| 跨房间加载 | 支持，用法和加载技能一样，显式触发 |
| 通知 | Syncthing 冲突和推送失败，通过 Hermes webhook 发到 Hermes 私聊 |
| cron 脚本 | 可以改 |

## 2. 架构

```text
 Matrix 房间 ──chat_id──► Hermes / Dorothy ── agent-bridge-memory 插件 ──┐ HTTP（本机）
 仓库 cwd/remote ───────► Codex / Claude / pi ── MCP 配置 + agent-memory 技能 ──┤ 远程 MCP
                                                                          ▼
                            Control Plane  POST /mcp（按 token 分权）
                              ├─ conversation_*（已有，只读）
                              └─ memory_*  → packages/agent-memory（TS，OMA v4.1 子集）
                                   解析作用域 · 读写校验 · 凭据扫描 · bootstrap · 检索
                                   flock → 原子写入 → git commit -- 本作用域路径
                                                                          │
                       /root/deathnote/agent-memory/   （Markdown，唯一事实源）
                                                                          │
    cron 每 30 分钟（同一把锁）：提交 → 冲突处理 → 提交 → 推送 Gitea；需要你处理时 → webhook → Hermes 私聊
    Syncthing ↔ GQX（可以在 Obsidian 里看、改、删）
```

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `packages/agent-memory` | agent-bridge，TS | 格式读写、校验、bootstrap、检索、作用域解析、git 提交。纯文件，不用 SQLite |
| Control Plane memory MCP | `apps/control-plane` | 鉴权（token → 写入者身份）、工具分发、每个作用域的 bootstrap 缓存文件（供插件在 Control Plane 不可用时读取） |
| Hermes 插件 | `integrations/hermes_agent_memory/`（Python，单独维护版本） | 按 `chat_id` 解析作用域、注入 bootstrap、转发工具调用、会话结束时写交接事件 |
| 共享技能 `agent-memory` | `shared-skills/` | 告诉 Bridge 下的 agent 何时读、何时写、写什么 |
| deathnote 脚本 | `~/.hermes/scripts/` | 提交、冲突处理、推送、webhook 通知 |
| 对话档案 | 已有 | 证据和回溯。记忆可以引用 `session:<id> e:<n>`，但不复制原文 |

## 3. 存储格式（OMA v4.1 子集）

### 3.1 目录

```text
agent-memory/
  README.md                         # 给人看的约定说明
  predicates.yaml                   # 全部作用域共用的类别表（只由人改）
  scopes/
    _global/
      scope.md                      # 绑定和元数据（见 §4）
      entities.md                   # 本作用域的主题声明和别名（Control Plane 自动维护，人也可以改）
      facts/<主题>/<类别>.md         # 当前值
      facts/<主题>/<类别>/<日期>.md   # 被替换的旧值
      events/<日期>/<id>.md          # 只追加的进展和交接
    travel/  household/  crypto/  …
```

- 没有交易日志、提案、审阅、索引、`_views` 这些目录。git 提交就是交易记录；bootstrap 每次现算，缓存放在 checkout 之外的 `/var/lib/agent-bridge/memory-cache/`。
- 在 GQX 的 Obsidian「排除的文件」里加上 `agent-memory/scopes/*/facts/*/*/`（旧值）。不排除也没关系。

### 3.2 吸收的规则

| 规则 | 说明 |
| --- | --- |
| 一条事实一个文件 | 必填字段 `type: fact, entity, predicate, value, recorded_at`；可选字段 `valid_from, valid_until, supersedes, derived_from, assertion, confidence, pinned, by, status/retracted_at/reason` |
| 主题 × 类别 | 实体就是主题（ASCII slug，在 `entities.md` 里声明中文名和别名），谓词就是类别。每个「主题 + 类别」只有一个当前值 |
| 类别表 | `preference` 偏好、`rule` 约束、`decision` 已定决定、`fact` 客观事实、`lesson` 经验教训、`pointer` 详见某处、`profile` 关于人的信息。只有人能新增 |
| 改值留史 | 旧文件移到 `<类别>/<valid_from 或记录日期>.md`，设置 `valid_until`；新文件通过 `supersedes` 指回旧值。支持查当前值、全部历史、某个日期当时的值 |
| 撤回 | 写墓碑：`status: retracted`、`retracted_at`、`reason`。查询和 bootstrap 不再显示，历史仍然能看到。删除文件只由人做 |
| 事件 | `events/<日期>/<id>.md`，字段为 `summary`（一行）、`occurred_at`、`entities`，正文写细节。只追加 |
| bootstrap | 依次放 `scope.md` 正文、置顶事实、最近事件（默认 10 条，回看 30 天），每条一行、只有内容（0.6.89 起去掉标题、主题标签和统计注释，因为每个字符每轮都要付费）。按 Unicode 字符计算预算，放不下整行就停。输入相同，输出就相同 |
| 检索 | 别名做 NFKD 归一并去掉大小写；排序依次为主题或别名精确命中、frontmatter 命中、正文命中，同分按路径。直接扫文件，规模在几千条以内 |
| 校验 | 未声明的主题或类别、同一槽位出现多个当前值、别名冲突、frontmatter 坏掉：写入前就拒绝；人工改坏的文件读取时跳过，并在 lint 中报告 |
| `value` 写一行 | 细节写进正文 |

和 OMA 文件格式保持兼容（只是它的一个子集），所以以后想用 OMA 的工具查看也行。但实现、测试和演进都归我们自己。

## 4. 作用域、房间映射、跨房间加载

### 4.1 `scope.md`

```yaml
---
type: scope
id: travel
title: 旅游助手
status: active                  # active | provisional（自动建的）| archived
discoverable: true              # false 时：别的房间搜不到，只能显式加载（角色卡这类用）
bindings:
  matrix_rooms: ["!xqSJrhoDJmGaVCdYA5:uniclown.com"]
  repositories: []              # 与 sessions.project_identity 同一归一化规则
  locations: []                 # [{machine, path}]
para_note: ""                   # 可选：指向 PARA 项目笔记的 wikilink
bootstrap_budget: 1500          # _global 用 3600
---
这个方向在做什么（一两句）。
```

**解析顺序**：Matrix 房间（取 `chat_id` 中 `:$` 之前的部分）→ 仓库身份 → 机器 + 目录 → 卡面指令 `<!-- agent-bridge-worker memory-scope: <slug> -->` → `_global`。

- 新房间：自动建 `room-<8位哈希>`，`status: provisional`，`title` 取房间名。
- 没绑定的仓库：第一次写入时建 `repo-<仓库名>`。
- 同一个键出现在两个作用域里：返回冲突和候选列表，不猜。

### 4.2 初始映射

| profile | 房间 | 作用域 |
| --- | --- | --- |
| default | 私聊、akasha | `_global` |
| default | 旅游助手 | `travel` |
| default | 管家 | `household` |
| dorothy | 私聊 | `_global` |
| dorothy | crypto | `crypto` |
| dorothy | 天鹅绒之馆 | `velvet-room` |
| dorothy | 惠的电台 | `hui-radio`（同时绑定 `hui-radio-v2` 仓库） |

### 4.3 跨房间：搜索和加载

- `memory_search(scope="all" | "<slug>")`：结果标注来源作用域；不包含 `discoverable: false` 的作用域。
- `memory_load(scope)`：把那个作用域的 bootstrap 作为**工具返回**放进当前对话，本次对话内有效，新开对话后就没了。不进系统提示词，所以不影响缓存。之后对这个作用域的写入要显式指定 `scope`。
- 加载由你说一句或 agent 提议触发，并在回复中说明。角色卡私密记忆这类场景：在卡对应的技能里写一句「加载 `card-<名字>`」，加载卡的时候顺带加载它的记忆，正好和技能的工作方式一致。

## 5. 写入权限

| 写入方 | `_global` | 当前作用域 | 已加载的其他作用域 | `scope.md` 绑定和类别表 |
| --- | --- | --- | --- | --- |
| Hermes、Dorothy | 可以 | 可以 | 可以（显式指定 `scope`） | 只有人改 |
| Bridge 下的 agent | 只读 | 可以（它的项目作用域） | 可以 | 只有人改 |

没有提案审批流程，你在 Obsidian 里能看到全部内容，也能直接改或删。凭据扫描命中就拒写。每次写入都是一次 git 提交，写入者记在 `by` 字段。

## 6. Hermes 接入：完全取代内置记忆

- 插件 `agent-bridge-memory`，装到 `~/.hermes/plugins/` 和 `profiles/dorothy/plugins/`。配置：

```yaml
memory:
  provider: agent-bridge-memory
  memory_enabled: false
  user_profile_enabled: false
```

- `.env`：`AGENT_MEMORY_URL`，以及每个 profile 各自的 `AGENT_MEMORY_TOKEN`。

| 钩子 | 行为 |
| --- | --- |
| `initialize` | 用 `chat_id`、`platform`、`cwd`、`agent_context` 解析作用域。cron 和 subagent 只读 |
| `system_prompt_block` | `_global` bootstrap（3600 字符，约等于现在 MEMORY+USER 的总量）+ 当前作用域 bootstrap（1500 字符；私聊没有这一段）+ 约 6 行使用说明。会话内不变 |
| 工具 | `memory_search/get/write/log/retract/load/scope` |
| `prefetch` | 默认关；先在一个房间开启试用。每轮最多 5 条、800 字符、1.5 秒超时 |
| `sync_turn` | 空实现，不把每轮写进笔记 |
| `on_session_end` | 至少 3 轮的会话，记一条机械交接事件：首句 + 最后一条回复的摘要，不用模型。私聊里落到 `_global` |
| `identity_signature` | `{scope, scope.md 的 blob}`。绑定变化时让网关重建缓存的 agent |
| Control Plane 不可用 | 读取缓存的 bootstrap 文件；写入报 `memory_unavailable` |

同时要改的文字：dorothy SOUL.md 的 Memory Classification 一节，以及提到 MEMORY.md 或 memory 工具的技能。

## 7. Bridge 下的 agent

- **MCP**：沿用 `POST /mcp`。新增 `AGENT_MEMORY_TOKENS`（`名字:token` 列表），持有者可以用写工具；已有的只读 token 能用读工具；人用 `CONTROL_API_WRITE_TOKEN` 调 lint 等管理接口。调用方要自己传 cwd 和 remote，共享连接上不保存「当前作用域」。
- **技能 `agent-memory`**：开始任务时调一次 `memory_bootstrap`；形成决定或偏好时 `memory_write`；完成一段工作时 `memory_log`。不写代码事实、AGENTS.md 里已有的规则、一次性状态或秘密。
- **Kanban**：Hermes 从房间建卡时，在卡面写入 `memory-scope` 指令；supervisor 把它放进派发参数。
- **以后可选**：Bridge 在新会话首轮自动附带 bootstrap。需要先确认 Codex App Server 和 Claude adapter 有没有附加说明的入口（现在没有）。

## 8. deathnote 同步

### 8.1 提交脚本（替换 `deathnote-auto-commit-push.sh`）

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /root/deathnote
exec 9>/run/lock/deathnote-git.lock; flock -w 120 9      # 与 Control Plane 共用
commit_all() { [ -n "$(git status --porcelain)" ] || return 0
  git add -A; git diff --cached --quiet || git commit -q -m "$1"; }
commit_all "chore: auto commit $(date '+%F %T')"          # 修好「只新增文件不提交」和日期格式
python3 ~/.hermes/scripts/deathnote-sync-conflicts.py --apply --notify
commit_all "chore: resolve sync conflicts $(date '+%F %T')"
git push -q origin HEAD || python3 ~/.hermes/scripts/deathnote-sync-conflicts.py --notify-push-failure
```

### 8.2 冲突处理器

| 情况 | 动作 |
| --- | --- |
| 副本和原文件内容相同 | 删除副本（上一步已经提交进 git，可以找回） |
| `.md` 能干净三方合并 | base 取冲突时间之前最后一次提交的版本，执行 `git merge-file`，写回原文件并删除副本。如果在 `agent-memory/` 下，合并后还要通过校验，不通过就退回、改为通知 |
| 合并有冲突、原文件不存在、canvas/excalidraw/二进制文件 | 不动，通知你 |
| `.trash` 里的冲突副本 | 只统计数量 |

通知：Hermes webhook 订阅 `deathnote-sync`（`deliver_only`，profile default，`deliver_extra.chat_id = !XuCBHkBjswAFS8Bi9V`，写法同现有的 `engine-notify`）。脚本用 `X-Hub-Signature-256` 签名后 POST 到 `127.0.0.1:8644`。报告内容没变就不再重发（上次发送内容的哈希存在 `~/.hermes/state/deathnote-sync-conflicts.last`）。之后你可以在 Hermes 私聊里说「保留 GQX 版」之类的话来处理。

运行模式：`~/.hermes/state/deathnote-sync-conflicts.mode` 不存在时只出预案（dry run）；你确认预案后，在这个文件里写入 `--apply`，之后才真正改动文件。`.excalidraw.md` 是绘图数据，不按文本合并。查找合并基准时会跟踪改名（`git log --follow`），所以挪到 `4. 存档` 的笔记也能找到。

**阶段 0 状态（2026-10-12）**：新脚本和 webhook 已上线；首次运行提交了此前积压的 73 个未跟踪文件和 `agent-memory/` 骨架，已推送到 Gitea；冲突预案已发到 Hermes 私聊。预案内容：1 个可以自动合并，9 个需要你决定，`.trash` 里另有 6 个。其中 `4. 存档/BBB-南疆亲子游` 整个目录以前从未进过 git，所以找不到合并基准。脚本的原版本备份在 `~/.hermes/backups/`。

## 9. 实施阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 0 同步链路 | 新提交脚本；冲突处理器（先 dry-run）；webhook 订阅；建 `agent-memory/` 骨架和 §4.2 的作用域 | 现有未提交的文件都已提交；冲突预案发到私聊；骨架在 GQX 的 Obsidian 里能看到 |
| 1 记忆核心 + Bridge | `packages/agent-memory`（TS）+ Control Plane MCP 工具 + 技能。升级根版本，用 `deploy/hal/deploy.sh` 部署 | 测试覆盖：解析顺序、改值留史、按日期查值、墓碑、bootstrap 输出确定且不超预算、中文和别名检索、凭据拒写、只提交本作用域路径、锁竞争、人工改坏的文件被跳过。WSL 上的 Codex 和 HAL 上的 claude 能读到对方写入的内容 |
| 2 Hermes 替换 | 插件；迁移 MEMORY/USER；改 SOUL 和技能文字。先在测试 profile 上试，再切 default，最后切 dorothy | 旅游助手 `/new` 后仍有该房间的记忆；私聊看不到 travel；对比切换前后的提示词字符数；Control Plane 停掉时仍能读出 bootstrap |
| 3 增强 | 在一个房间试用 prefetch；Bridge 新会话自动注入；Hermes 会话导入中央档案 | 各项单独决定 |

## 10. 迁移与回滚

- **MEMORY/USER**：先把两个 profile 的 `memories/` 原样备份到 `~/.hermes/backups/`。脚本按 `§` 拆成条目，分配到对应作用域（画像和偏好 → `_global`；高原反应、出行 → `travel`；打针提醒 → `household`；Immich、IMAP、call_bridge → `_global/lesson`，技能里已有的改成 `pointer`），重复条目合并。直接写入，在私聊里给你一份摘要，没用的你自己删。旧文件保留 30 天。
- **角色卡私密记忆**（`references/intimate-memory.md`）：迁到 `card-<名字>` 作用域（`discoverable: false`），并在卡对应的技能里加上加载它的那句话。
- **会话记忆层**：不迁移。记忆只引用它。
- **回滚**：
  - Hermes：`provider: ''`，两个 enabled 改回 `true`，重启网关。
  - Bridge：删掉 memory token，卸载技能。
  - Control Plane：去掉 `AGENT_MEMORY_*` 即整体关闭。
  - 数据：`git revert`，最坏情况整个删除 `agent-memory/`。
  - cron：换回原脚本。

## 11. 未落实事项

| # | 事项 | 当前处理 |
| --- | --- | --- |
| 1 | `packages/agent-memory` 需要一个 YAML 解析库 | 计划新增 npm 依赖 `yaml`（ISC 许可，无其他依赖），lockfile 一起提交 |
| 2 | 角色卡记忆的加载方式 | 先用「技能里写一句加载」。如果你想让「某个房间默认加载某张卡」，在 `scope.md` 里加一个 `autoload: [card-…]` 即可 |
| 3 | `_global` 的 3600 字符预算是否够用 | 迁移后看实际的 bootstrap 再调整 |
| 4 | prefetch 试用哪个房间 | 待定 |
| 5 | Hermes 自己的 Matrix 会话不在中央档案里 | 不影响本方案。交接事件已经覆盖「新开对话接得上」；导入档案单独立项 |
| 6 | 阶段 0 第一次提交会把当前未跟踪的文件（含冲突副本、一个 `.ps1`）一起推到 Gitea | 阶段 0 开始前确认 |
| 7 | GQX 上 Obsidian 的排除设置 | 只能在 GQX 上手动设，可选 |

## 附：为什么不用 OMA 项目本身或 basic-memory

- **OMA**：174 star，单人维护，**没有许可证**，大约两个月一个大版本（v3 在 5/11，v4 在 7/1，v4.1 在 9/21）。实测它的工具：未声明的主题或类别会被拒、改值留史可用、中文和别名检索可用、bootstrap 只收置顶事实和事件、自身从不 git commit。我们只吸收它的格式规则（§3.2），实现自己写。
- **basic-memory**（4.1k star，AGPL）：有官方 Hermes 插件，但它最成熟的是外壳（MCP 服务、客户端插件、SQLite 和向量索引、文件监听），约 13 万行。我们需要的房间作用域、单写入方、鉴权、git 提交和冲突处理，它都没有，还得去迁就它的写入路径。
- 实测记录在 `/root/scratch/memory-research/`（HAL 本机，不入库）。
