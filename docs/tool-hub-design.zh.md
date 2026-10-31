# 设计：中央工具库、按作用域置顶与自动审批

状态：设计稿，未实现（2026-10-31）。本仓库只写机制；具体有哪些工具、怎么分配，放在私有 agent-skills 仓库的 `tools/registry.yaml`。

相关文档：[agent-skills-design.zh.md](agent-skills-design.zh.md)（技能的置顶与搜索，本设计照搬）、[approval-permissions.zh.md](approval-permissions.zh.md)（审批链路现状）、[jev-approval-triage-design.zh.md](jev-approval-triage-design.zh.md)（硬边界清单，本设计沿用）、[agent-dispatch-and-review.zh.md](agent-dispatch-and-review.zh.md) §4（审核员模型）。

## 1. 决定（clown 2026-10-31）

- **置顶按作用域**：每个作用域有自己置顶的工具，开局就挂上、列进提示词。置顶工具的大多数操作不用逐次审批，个别危险操作除外。
- **搜索全开放**：所有工具对所有会话都能搜到、能调用；作用域只决定哪些开局置顶，不限制可见范围。
- **自动审批**：所有工具调用的审批都经过 Agent Bridge，所以可以在人之前加一层自动审核。原生规则已经放行的（只读等）不变；需要审核的，交给一个独立的审核会话，用 DeepSeek / Qwen 这类便宜模型判断。
- **搜索中心化**：网页搜索由 Control Plane 统一提供。后端有原生 DeepSeek 搜索、照搬 Hermes 的免费搜索轮询，最后用浏览器兜底。
- **Home Assistant 用官方 MCP Server 集成**，不另做适配层。

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
      review: [enqueue_workflow, upload_image, save_workflow]
      human: [clear_vram]
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

在 `/mcp/tools` 内置一个服务 `web`，工具 `web_search(query, engine?)`、`web_fetch(url)`，对所有会话置顶（`_global`）。

| 后端 | 用途 | 说明 |
| --- | --- | --- |
| DeepSeek 原生搜索 | 默认的“搜索并总结” | 待实测接口和费用 |
| 免费轮询 | 默认的“只要结果列表” | 照搬 Hermes 的后端：ddgs、SearXNG、Brave 免费档；按可用性轮询，失败换下一个 |
| OpenRouter（exa / x_search） | 新闻、X 实时讨论 | 已实测（`todo.zh.md`），按需付费，显式 `engine` 选用 |
| 浏览器 | 兜底：动态页面、反爬 | 无头浏览器抓取，`web_fetch` 失败时用 |

结果统一为 `{title, url, snippet, publishedAt?, source}`，同一查询短期缓存。

## 5. 分期

1. **`/mcp/tools` 与登记表**：代理调用、`tool_search`、风险档的确定性分类（auto 放行、human 问人，review 暂时也问人）。先接 comfyui、megumi-radio、Home Assistant 官方 MCP、call-bridge。
2. **置顶下发**：`create_session` 带置顶服务，三种 agent 各自挂载；开局提示列出。
3. **网页搜索服务**：免费轮询加浏览器兜底，再接 DeepSeek 原生搜索和 OpenRouter。
4. **自动审核会话**：review 档改走审核会话，先 MCP 工具，再 Claude Bash。

前两期改 Bridge 的会话启动（下发 MCP 配置），需要升 Bridge 版本；第 3、4 期只改 Control Plane。
