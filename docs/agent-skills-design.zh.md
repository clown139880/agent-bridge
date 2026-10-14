# 设计：按作用域组织的共享技能库（agent-skills）

- 状态：设计稿第 1 版（2026-10-14）。内容整理已完成，接入尚未实现。决定和进展记录在 agent-memory 的 `repo-agent-bridge` 作用域（主题 `agent-skills`）。
- 关联：[agent-memory-design.zh.md](agent-memory-design.zh.md)（作用域、写入方、Hermes 插件）、[agent-memory-operations.zh.md](agent-memory-operations.zh.md)。
- 基线：agent-bridge `0.6.92`；Hermes `647115b12d`；技能库 `clown139880/agent-skills`（私有 Gitea，HAL checkout `/root/agent-skills`）。

## 0. 一页结论

- **问题**：Hermes 在系统提示词里列出所有技能。Dorothy 的技能列表约 11.5k 字符，占她系统提示词的大头（约 58%），而她多数时候在某个专项房间里工作，用不到大部分技能。这些技能大多是 agent 自己沉淀的，本质上是记忆，却没有作用域、没有版本管理，也不受我们控制。
- **做法**：所有自建技能放进一个私有 git 仓库，按 agent-memory 的作用域组织；Control Plane 是唯一写入方；Hermes 插件接管三个技能工具，并按当前作用域生成技能列表。
- **结果**：Dorothy 在房间里只看到 `_global`、`_agent-dorothy` 和本房间的技能；Hermes 能搜索和加载全部；技能的每次修改都有 git 记录，写入经过凭据扫描。
- **不做**：不改 Hermes 核心代码；不接管 Hermes 自带和 hub 安装的技能；项目型知识不做成技能，放回项目仓库。

## 1. 已定决策

| 主题 | 决定 |
| --- | --- |
| 存放位置 | 所有自建技能（Hermes、Dorothy 沉淀的，以及原 agent-bridge `shared-skills`）放进一个私有仓库，不拆分、不进 deathnote 笔记库（笔记库里不放代码） |
| 组织方式 | `scopes/<scope>/<category>/<skill>/`，作用域与 agent-memory 同名 |
| 可见性 | Dorothy：`_global`、`_agent-dorothy`、当前房间；Hermes：能搜索、加载全部，提示词只列自己的、`_global` 和当前房间的 |
| 写入 | 经 Control Plane（加锁、一次写入一次提交、凭据扫描、记录写入者、删除改为归档） |
| shared-skills | 复制进 `scopes/_global/agent-bridge/`，各 agent 用这里的版本；开源仓库保留副本 |
| 自带和 hub 技能 | 留在 Hermes 原处，由 Hermes 更新；以后再考虑由技能库自己管理公开技能的安装和更新 |
| 项目知识 | 不做成技能：开发资料放项目仓库 `docs/`，技能只留操作手册（例：惠的电台 → `hui-radio-ops`；YD-ZS → 项目 `AGENTS.md`，不留技能） |
| AIGC | 合并为 `velvet-room/aigc/aigc-studio`，以后整体抽成项目；未定事项在其 `REVIEW.md` |
| 凭据 | 默认不进仓库，放 profile `.env` 或 `/root/.local/state/.cache/`（`secret-exec`）。clown 明确允许写在技能里的例外：公开客户端常量、小度 Cookie、aria2 secret、Prowlarr key、ComfyUI 回调 token |

## 2. 现状（整理完成后）

- 原有 Hermes 82 个、Dorothy 105 个技能（含自带和 hub 23 个）。整理后技能库 80 个技能，约 3.5MB（原约 32MB）。
- 作用域分布：`_global` 39、`_agent-hermes` 16、`_agent-dorothy` 13；房间作用域各 1 个（`velvet-room` 的 aigc-studio，以及 `hui-radio`、`household`、`crypto`、`travel`）；`card-*` 5 个。
- Hermes 和 Dorothy 目前仍在用原技能目录；技能库还没有接入。

## 3. 技能库仓库

```text
/root/agent-skills/
  README.md                         # 约定与外部来源登记
  scopes/<scope>/<category>/<skill>/
    SKILL.md                        # frontmatter: name, description, version, metadata
    references/  scripts/  templates/  agents/
```

- 每个技能目录下只有一个 `SKILL.md`；子目录里不能再出现 `SKILL.md`（Hermes 会当成独立技能）。大的合集用 `references/<分区>/GUIDE.md`。
- frontmatter 新增 `metadata.agent_skills`：
  - `sources`：原技能 id（迁移来源）。
  - `slash: true`：需要 `/名字` 斜杠命令（目前是 5 个角色卡加载器）。
  - `upstream`（可选）：外部来源和版本，供以后的安装和更新使用。
- 脚本在 HAL 的 checkout 里原地执行，用绝对路径 `/root/agent-skills/scopes/...` 引用。
- 推送到 Gitea 由写入流程完成（见 §5），失败不阻塞写入，由下一次写入或定时任务补推。

## 4. 作用域与可见性

作用域解析复用 agent-memory（房间 → 仓库 → 机器加目录 → 卡面指令 → `_global`）。每个 agent 的可见集合：

| agent | 列进提示词 | 能加载 |
| --- | --- | --- |
| Dorothy | `_global` + `_agent-dorothy` + 当前作用域 | 同左 |
| Hermes | `_global` + `_agent-hermes` + 当前作用域 | 全部作用域 |
| Bridge 下的 Codex/Claude（以后） | `_global` + 项目作用域 | 同左 |

- 私聊的当前作用域是 `_global`，不额外列房间技能。
- 角色卡 `card-*` 不列进提示词，只通过斜杠命令或 `memory_load` 进入。
- 提示词里每个技能一行（名字 + 描述），在一个字符预算内按作用域优先级截断；超出部分给一行「另有 N 个技能，用 `skills_list` 查找」。

## 5. Control Plane 技能模块

在 `packages/agent-memory` 旁新增技能模块（或同包内的 `skills.ts`），由 Control Plane 的 `/mcp` 暴露：

| 工具 | 说明 | 权限 |
| --- | --- | --- |
| `skill_index` | 按调用方身份和作用域返回可见技能的名字、描述、作用域 | 读 |
| `skill_search` | 按名字、描述、正文关键词搜索，结果标注作用域 | 读 |
| `skill_view` | 读 `SKILL.md` 或某个附属文件，返回技能目录的绝对路径和文件列表 | 读 |
| `skill_write` | 新建技能或整文件写入（含附属文件），默认写到调用方的当前作用域 | 写 |
| `skill_patch` | 按「旧文本 → 新文本」修补，语义与 Hermes `skill_manage(action=patch)` 一致 | 写 |
| `skill_archive` | 删除改为归档：移到仓库外的归档目录并在提交信息里记录 | 写 |
| `skill_move` | 在作用域之间移动（例如提到 `_global`） | 写 |

- **鉴权**：沿用 `AGENT_MEMORY_TOKENS`。写入者身份取自 token；`agent` 角色可写任何作用域，`project` 角色只写项目作用域。
- **写入流程**：`flock` → 校验（frontmatter、单 `SKILL.md`、路径不越界）→ 凭据扫描（允许清单之外的命中就拒写）→ 写文件 → `git commit -- <技能路径>`（作者 `agent-skills (<写入者>)`）→ 异步 `git push`。
- **配置**：`AGENT_SKILLS_REPO`（未设置则整个模块关闭）、`AGENT_SKILLS_LOCK`。

## 6. Hermes 接入

在现有插件 `integrations/hermes_agent_memory` 中扩展，不改 Hermes 核心：

1. **接管工具**：用 `ctx.register_tool(..., override=True)` 覆盖 `skills_list`、`skill_view`、`skill_manage`，转发到 §5 的工具。需要在 profile 配置里打开 `plugins.entries.<插件>.allow_tool_override: true`。`skill_manage` 的各个动作映射到 `skill_write` / `skill_patch` / `skill_archive`。后台 review 子进程也走这些工具，因此自动沉淀的新技能直接进当前作用域。
2. **技能列表**：插件的 `system_prompt_block` 在记忆块后附上按 §4 生成的技能列表（会话内不变，不影响提示词缓存）。Hermes 原生列表只剩本地的自带和 hub 技能。
3. **斜杠命令**（2026-10-14 实验确认）：插件注册的命令只会把文字回给用户，不能把技能交给 agent。因此为 `slash: true` 的技能在 profile 的本地技能目录生成**跳转桩**：
   ```yaml
   ---
   name: negumi
   description: "<同原技能>"
   metadata:
     hermes:
       requires_tools: [agent_skills_slash_stub]   # 让 Hermes 原生列表隐藏它
   ---
   调用 skill_view(name="negumi") 加载完整技能并照做。
   ```
   实验结果：跳转桩不出现在提示词的技能列表里，`/negumi` 照常可用，调用时 agent 收到的就是这句指令。跳转桩由同步程序生成，不手工维护。
4. **本地技能目录**：切换时把已迁移的技能移出（备份到 `~/.hermes/backups/`），只留自带、hub 技能和跳转桩。Hermes 的 curator 不再管理已迁移的技能（归档由 `skill_archive` 负责）。
5. **Control Plane 不可用时**：技能列表读插件的本地缓存；`skill_view` 退回只读 checkout；写入报错。

## 7. Bridge 下的 agent（后续阶段）

- 远程 agent 通过 MCP 的 `skill_index` / `skill_view` 按需读取纯文本技能。
- 带脚本的技能需要本地副本：由 Bridge 拉取 agent-skills，按作用域装进 `~/.codex/skills`、`~/.claude/skills`，并沿用现有的安装状态上报（`BRIDGE_SHARED_SKILLS_MANIFEST`）。

## 8. 实施与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 1 Control Plane | 技能模块 + MCP 工具 + 测试；升级根版本；`deploy/hal/deploy.sh` | 测试覆盖：可见性、写入提交只含本技能路径、凭据拒写、单 `SKILL.md` 校验、patch 语义、归档、锁竞争 |
| 2 插件 | 接管三个工具、技能列表注入、跳转桩同步 | 插件测试；在一个测试 profile 上验证三个工具、`/negumi`、后台 review 新建技能落到正确作用域 |
| 3 试点 | 先切 Dorothy 的一个房间（jmyd 或惠的电台） | 切换前后各量一次系统提示词 token 数；房间内能用、能沉淀、能斜杠加载 |
| 4 全面切换 | Dorothy 全部房间，再 Hermes | 原技能目录只剩自带、hub 和跳转桩；token 对比报告 |
| 5 Bridge agent | §7 | 另行决定 |

**回滚**：去掉 `allow_tool_override` 并从备份恢复本地技能目录；Control Plane 去掉 `AGENT_SKILLS_REPO` 即关闭模块。

## 9. 风险与待验证

| # | 事项 | 处理 |
| --- | --- | --- |
| 1 | 覆盖后的工具处理函数怎样拿到当前会话的作用域（工具是进程级注册，多个房间并发） | 实现前确认 handler 收到的 `session_id`/`task_id`，由插件维护会话 → 作用域映射 |
| 2 | `skill_manage(action=patch)` 的模糊匹配等细节要与 Hermes 一致，否则模型会用错 | 照 Hermes 实现和测试用例对齐 |
| 3 | `skill_view` 原生支持的模板变量、环境变量声明 | 现存技能里几乎没用（Dorothy 2 个、Hermes 5 个声明环境变量，0 个用模板变量），只实现用到的部分 |
| 4 | Hermes 升级后自带技能可能和技能库同名 | 同名时以技能库为准，在插件日志里提示 |
| 5 | 技能使用统计 | 第一版不做；以后由 `skill_view` 记录 |
