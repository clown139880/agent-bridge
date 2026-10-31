# 设计：中央工具库、按作用域置顶与自动审批

状态（2026-10-31）：0.7.45 第 1 期（`/mcp/tools`、登记表）；0.7.46 自动审核（`review` 档交 DeepSeek 审核员）、内置网页搜索、开局列出置顶工具。置顶工具不单独挂载，经 `/mcp/tools` 调用（见 §4.5）。

相关文档：[agent-skills-design.zh.md](agent-skills-design.zh.md)（技能的置顶与搜索，本设计照搬）、[approval-permissions.zh.md](approval-permissions.zh.md)（审批链路现状）、[jev-approval-triage-design.zh.md](jev-approval-triage-design.zh.md)（硬边界清单，本设计沿用）、[agent-dispatch-and-review.zh.md](agent-dispatch-and-review.zh.md) §4（审核员模型）。

## 1. 决定（clown 2026-10-31）

- **置顶按作用域**：每个作用域有自己置顶的工具，开局就挂上、列进提示词。置顶工具的大多数操作不用逐次审批，个别危险操作除外。
- **搜索全开放**：所有工具对所有会话都能搜到、能调用；作用域只决定哪些开局置顶，不限制可见范围。
- **自动审批**：所有工具调用的审批都经过 Agent Bridge，所以可以在人之前加一层自动审核。原生规则已经放行的（只读等）不变；需要审核的，交给一个独立的审核会话，用 DeepSeek / Qwen 这类便宜模型判断。
- **搜索中心化**：网页搜索由 Control Plane 统一提供。后端有原生 DeepSeek 搜索、照搬 Hermes 的免费搜索轮询，最后用浏览器兜底。
- **Home Assistant 用官方 MCP Server 集成**，不另做适配层，沿用现有的 `HASS_URL` / `HASS_TOKEN`。
- **不是所有能力都做成工具**：小红书这类按需使用、步骤多的，写成技能按需读取；TTS 写成直接调接口的技能（`mimo-tts`），不再单独跑服务。
- **审批的目的是减少人工**：登记表里的档位尽量放宽（ComfyUI、打给用户的电话全部免审批；替别的会话答审批归入自动审核），硬边界只留真正不可逆或外发的操作。

## 2. 结构

```text
agent 会话（Claude / Codex / pi，任意机器）
  ├─ 置顶工具：开局直接挂载的 MCP 服务（按房间/会话的作用域）
  └─ /mcp/tools（Control Plane）
       ├─ tool_search(query)       → 全部登记工具的名字、说明、参数
       └─ tool_call(name, args)    → 代为调用上游 MCP；凭据只在 Control Plane
                                       │
                                       ▼
                               审批：规则 → 自动审核会话 → 人
```

### 2.1 登记表（私有仓库 `tools/registry.yaml`）

```yaml
servers:
  comfyui:
    title: ComfyUI 出图与视频
    transport: { command: node, args: [/path/to/comfyui-mcp/dist/index.js] }  # 或 { url: http://… }
    secrets: [COMFY_TOKEN]                 # 名字，值在部署的 secret 文件
    pinned: [velvet-room]                  # 在这些作用域开局置顶
    risk:                                  # 每个工具的默认风险；没写的按 review
      auto: [get_*, list_*, queue, get_history, visualize_workflow]
      review: [save_workflow]
      human: []
```

- `risk` 三档：`auto` 直接放行；`review` 先交自动审核；`human` 一定问人。置顶不改变风险档：置顶的工具多数操作在 `auto`，危险操作仍是 `review` 或 `human`。
- `pinned` 写作用域；`_global` 表示所有会话都置顶。
- 改登记表照常走“agent 提案、人确认”（同定时任务），因为它改的是权限面。

### 2.2 置顶：开局挂载

- 新会话开局时，Control Plane 按会话的记忆作用域算出置顶的服务，随 `create_session` 下发给 Bridge。Bridge 用各 agent 自己的方式挂载：Claude `--mcp-config`、Codex 会话级 `mcp_servers`、pi 由 `agent-bridge-mcp.ts` 扩展注册。
- 置顶服务都由 Control Plane 代理（`/mcp/tools/<server>`），所以各机器不用自己装 ComfyUI MCP 这类本地命令，凭据也不出 HAL。
- 开局提示里列出置顶服务各一行，加一句“其他工具用 `tool_search` 查找”。

### 2.3 搜索：`/mcp/tools`

- `tool_search(query, limit?)`：在全部登记工具里按名字、说明、服务标题做关键词加语义匹配，返回工具名、说明和参数 schema。
- `tool_call(name, args)`：按 `server.tool` 调用，参数按 schema 校验后转发。
- 上游 MCP 的工具清单由 Control Plane 缓存，服务变化时刷新；本地命令型服务按需拉起、空闲退出（与全局 idle-exit 偏好一致）。

## 3. 自动审批

### 3.1 链路

```text
工具调用
  → agent 原生规则（CLAUDE_PERMISSION_* 等，原样保留）
  → Bridge 只读集合（原样保留）
  → Control Plane：
      ① 确定性分类：硬边界 → 人；登记表 risk=auto → 放行；risk=human → 人
      ② 其余（review、未登记的 Bash/编辑/MCP）→ 自动审核会话
      ③ 审核会话：allow → 放行；不确定、拒绝、超时、出错 → 人
```

- 硬边界沿用 [jev-approval-triage-design.zh.md](jev-approval-triage-design.zh.md) §3.1 的 HARD_HUMAN 清单：删除、系统位置、秘密、服务和进程、装包、Git 外发和不可逆操作、跨机、有副作用的网络请求、平台生命周期、数据库写入。这张表只增不减，写在代码里，有测试。
- **自动审核只会放行，不会拒绝**：它没把握就交给人，和现在一样。拒绝只由人或代码规则做出。
- 代理调用（`tool_call`）和直接挂载的置顶工具走同一条链路，不能靠经过代理绕开审批。

### 3.2 审核会话

- 一个长期存在的 pi 会话，作用域 `_reviewer`，模型可配置（`APPROVAL_REVIEW_MODEL`，默认 DeepSeek flash 一档；Qwen 可选）。不挂任何写工具，只读得到提交给它的材料。
- 每次审核提交：工具名、参数（截断、脱敏）、工作目录、发起会话的作用域和最近几条用户消息摘要（判断“是不是用户要的”）。
- 返回结构化结果 `{ verdict: allow | human, reason }`。解析失败视为 `human`。
- 时限 10 秒；超时、模型不可用、连续出错时熔断 10 分钟，熔断期间全部交给人。
- 每次决定都记进审批记录（`resolver=review:<model>`、理由），控制中心审批历史里可见，手机上 silent 提示一条“已自动放行”。
- 与记忆写入审核员（agent-dispatch-and-review §3）是同一类东西，以后可合并成一个审核服务。

### 3.3 范围

- 第一期：MCP 工具（登记表有风险档）和 Claude `Bash`。
- 第二期：Codex `commandExecution`、工作区外编辑。
- `AskUserQuestion` 和用户输入永不进自动审核。Bridge 重连时重放的旧审批直接交给人。

## 4. 中心化网页搜索

在 `/mcp/tools` 内置一个服务 `web`，工具 `web_search(query, kind?)`、`web_fetch(url)`，对所有会话置顶（`_global`），免审批。

**免费优先，按内容路由**。`kind` 可由调用方给出，否则按查询内容判断：

| 内容 | 先用 | 再用 | 依据 |
| --- | --- | --- | --- |
| 一般资料、文档、代码问题 | 免费轮询：ddgs → SearXNG → Brave 免费档（照搬 Hermes 的后端顺序，失败换下一个） | DeepSeek 原生搜索 | 免费够用 |
| 实时短事实（天气、时间、比分、现价） | DeepSeek 原生搜索 | 免费轮询 | call-bridge 已在用：`api.deepseek.com/anthropic/v1/messages`，`web_search_20250305` 工具，`max_uses: 2`，关闭 thinking，只接受真的搜过的回答 |
| 新闻、事件归因 | OpenRouter `exa` | DeepSeek 原生搜索 | 2026-10-21 实测（`todo.zh.md`）：exa 召回最好，$0.015/次 |
| X 实时讨论 | OpenRouter grok + `x_search`（提示里明确“搜 X”并给关键词） | — | 同上实测 |
| 页面内容 | `web_fetch` 直接抓取 | 无头浏览器 | 动态页面、反爬时兜底 |

- 返回统一为 `{title, url, snippet, publishedAt?, source}`；DeepSeek 这类“搜索并回答”的后端另带 `answer` 和引用。
- 同一查询短期缓存；每个后端记录用时、失败率和费用，路由按可用性降级。

## 4.5 第 1 期的实现

- Control Plane 读 `TOOLS_REGISTRY`（私有仓库 `tools/registry.yaml`），文件变化即重新加载；`transport.builtin` 的条目（memory、bridge、web）只登记置顶和档位，不经代理。
- 上游连接按需建立，空闲 10 分钟关闭；工具清单缓存 10 分钟。`${KEY}` 由 `secrets` 列出的 OpenBao 路径填充（[secrets-design.zh.md](secrets-design.zh.md)）。
- `tool_call` 遇到非 `auto` 的工具：写一条 `tool_approvals`，推一条 alert 到 App，调用阻塞到人在控制中心首页允许或拒绝（最多 10 分钟，超时按过期失败）。决定接口 `POST /api/v1/tool-approvals/:id/decision` 只接受 `control:*`。
- HAL 上 Claude、Codex 的 MCP 配置加了 `tools`，Claude 的 `permissions.allow` 放行 `mcp__tools`：档位由 Control Plane 判断，不再让 Claude 自己的审批问第二遍。pi 由 Bridge 加载的扩展注册 `tools_tool_search`、`tools_tool_call`。

## 4.6 0.7.46 的实现

- **自动审核**：`review` 档的调用先交审核员：DeepSeek（Anthropic 兼容端点，`deepseek-flash`，关闭思考，不带任何工具），密钥从 OpenBao `shared/deepseek` 取。只返回 `allow` 或 `human`；`allow` 直接执行并记一条 `decided_by=review` 的记录、推一条 silent 通知到 App；其他结果、超时（15 秒）或出错都交给人。`human` 档不经审核员。实测约 0.6–1 秒，门锁类和带注入文字的参数会交给人。`TOOL_REVIEW=off` 关闭，`TOOL_REVIEW_MODEL` 换模型。
- **网页搜索**：登记表里 `transport.builtin: web` 的条目由 Control Plane 自己实现 `web.web_search`、`web.web_fetch`。免费后端是 Hermes 用的 keyless 端点：Exa MCP、Parallel MCP、Keenable，轮换起点；实时短事实走 DeepSeek 原生搜索；新闻走 OpenRouter exa；X 走 grok-4.3 + `x_search`（约 45 秒）。抓取先用 Keenable 公共抓取，失败再直接请求。浏览器兜底未做。
- **置顶**：会话开局的记忆注入（`/memory/bootstrap`）后面附上本作用域置顶服务的工具名和是否需确认。所有 agent 都经同一个 `/mcp/tools` 调用，所以置顶只影响开局列不列，不另挂 MCP 服务，Bridge 不用改。
- **脱敏**：Control Plane 启动时和每小时读取 OpenBao `kv/shared/*` 的全部值，写入会话事件和 notice 之前把出现的值（12 个字符以上）替换成 `‹secret:路径#名字›`。流式增量和记忆写入不经过这一层。

## 5. 分期

1. **`/mcp/tools` 与登记表**：代理调用、`tool_search`、风险档的确定性分类（auto 放行、human 问人，review 暂时也问人）。先接 comfyui、megumi-radio、Home Assistant 官方 MCP、call-bridge。
2. **置顶下发**：`create_session` 带置顶服务，三种 agent 各自挂载；开局提示列出。
3. **网页搜索服务**：免费轮询加浏览器兜底，再接 DeepSeek 原生搜索和 OpenRouter。
4. **自动审核会话**：review 档改走审核会话，先 MCP 工具，再 Claude Bash。

前两期改 Bridge 的会话启动（下发 MCP 配置），需要升 Bridge 版本；第 3、4 期只改 Control Plane。
