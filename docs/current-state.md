# Agent Bridge 当前事实基线

更新日期：2026-09-14

代码基线：`e9f80d7`（`agent-bridge-external-session-source`）

版本：Agent Bridge `0.6.40`；DSH Agent Control plugin `0.1.27`

本文只描述当前代码定义的生产路径。较早的 UI 复用轮次、重构提案和方案评估保留为历史材料，不能作为当前架构说明。

## 当前产品形态

Agent Bridge 由三条协作路径组成：

1. **Bridge / Control Plane**：每台 Bridge 连接本机 Codex App Server，并可管理 Claude Code adapter；Control Plane 提供认证的 REST、SSE、Worker API、可靠 action 和 SQLite 投影。
2. **DSH 原生会话接入**：DSH Host 将 Bridge conversation 物化为原生 Agent、Session 和 Workspace 记录；原生 Sessions 树、Conversation、Composer、审批和问题界面负责展示与交互。
3. **Hermes Kanban**：插件提供独立的管理 overlay 和受权限约束的 model tools；Hermes 仍是 task 生命周期的权威，session 同步不会自动推进卡片。

Windows Bridge 把 `CODEX_COMMAND` 视为 Codex Desktop 内容寻址安装目录的提示。它在新 conversation 和空闲 session 的新 turn 前选择语义版本最高且包含 `codex.exe`、`codex-code-mode-host.exe`、`codex-command-runner.exe` 的完整 runtime。若 runtime 变化，Bridge 会让原 action 保持 accepted，等待自己管理的活动 turn、审批、输入和 RPC 清空，只轮换其持有的 App Server 子进程，再恢复 thread inventory 并继续原 action。多个调用共享同一次切换；未知进程占用 App Server 端口时不会被终止。Control Plane 接受有总时限的 `action.progress` lease，避免安全排空期间把 action 提前判为超时。

DSH 中已经没有第二套 Bridge session browser、conversation renderer 或 composer。2026-09-08 至 09-10 使用的
`ExternalSessionBrowser`、`ExternalConversationSurface` 和 `ExternalComposer` 路径已经删除。

## DSH 数据与执行路径

```text
Control Plane workers/sessions/events
  -> AgentBridgeImportTarget（5 秒可中止 reconciliation）
  -> 稳定 native id、历史投影、workspace attachment
  -> DSH AgentRegistry + Session persistence
  -> DSH 原生 Sessions 树和 Conversation

DSH 原生 Composer
  -> AgentBridgeLlmAdapter
  -> Bridge submit_turn / interrupt / approval / user input
  -> 远端 Codex 或 Claude
  -> Bridge events 投影回 DSH 原生 session history
```

首次发现会话时，Host 以最多四个并发任务读取 Control Plane 保留的分页历史；之后依据 session 元数据和事件 cursor 增量补齐。原生 turn 运行时，后台历史同步暂停，避免与 DSH Session 的非重入 append 生命周期竞争。当前原生投影使用定时 reconciliation 和 turn 内 action/history 轮询，不使用旧 Client `SessionStore` 的 snapshot + SSE 展示路径。

## 已落地能力

- 同一棵 DSH 原生 Sessions 树同时展示本地 DSH 与 Bridge conversation。
- Bridge session 使用 Control Plane origin + session id 派生的稳定 native id，避免与本地 DSH/Codex id 冲突。
- 用户/助手消息、远端命令、工具和文件活动投影为 DSH 原生 session events；远端工具只展示，不在 Host 本地执行。
- 原生 Composer 可创建/续写 Bridge turn、steer 活动 turn、带期望 turn id 中断，并转发 model/reasoning effort（仅新 turn）。
- 原生 approval/user-question 服务承接 Bridge 待处理交互；提交前重新校验 pending 状态。
- 原生图片附件经过 DSH attachment store、Host RPC 和 Control Plane 内容寻址存储转发给 Codex/Claude；支持纯图片消息。
- 目录新建入口会列出该目录可用的本地 DSH 与 Bridge execution source；Host 在创建前重新验证来源。
- 同一机器和远端路径产生的多个 presentation workspace 在客户端目录中合并展示，但底层 session identity、cwd 和执行绑定不变；不同机器的相同路径保持分离。
- 导入标题优先使用远端有效标题或首条用户消息；用户在 DSH 中显式重命名后，reconciliation 不会覆盖该标题。
- 原生行菜单保留 rename、fork、archive，并增加删除：Bridge session 经可靠 action 等待 owning adapter 确认（Codex 调用 `thread/delete`，Claude 遗忘 Bridge session）；本地 DSH session 使用持久逻辑删除并保留底层日志和 fork lineage。
- Control Plane 可永久移除离线 worker 及其投影；在线 worker 不允许删除，完整 inventory 会清理已经消失的活动 turn 和待处理交互。

## 当前边界

- DSH provider 的模型目录目前只有 `remote`（跟随远端 session）；尚未把 worker-specific model catalog 映射为原生 DSH provider catalog。
- 附件转发目前只接受 PNG、JPEG、WebP 和 GIF，单图最大 15 MB、每条消息最多 8 张；任意文件仍不支持。
- Secret user input 不通过远程非秘密 UI 转发，会明确失败并要求在可信本地界面处理。
- 历史完整度受 Control Plane 保留窗口和上游能力限制；Codex Desktop rollout 仍只有 terminal-only 历史。
- command output 最多保留 64 KiB，file changes 最多 200 项。图片已有受认证的 blob endpoint，但通用产物存储尚未实现。
- 本地 DSH 删除是逻辑删除，不删除原始 JSONL；Bridge 删除在 owning adapter 确认后才清理投影。Codex 是上游永久 thread 删除，Claude 当前是 Bridge 侧遗忘。
- Control Plane 当前为单实例。

## 版本与兼容事实

- 发布版本的权威来源是根 `package.json`。内部 workspace package 仍保留 `0.6.0`，不代表当前发布版本。
- 插件目标运行时是 TokensCowork 内置 DSH `0.1.3-alpha.1`；开发依赖主要使用 npm 已发布的 `0.1.2-rc.1`，因此类型检查不能替代已安装 runtime 验证。
- `scripts/verify-runtime.cjs` 使用已安装 Electron/ASAR 和隔离临时目录验证真实 DSH 服务契约。
- 插件发布只 bump `integrations/dsh-agent-control/package.json`，不会触发 Bridge 或 Control Plane 部署。

## 文档导航

- 当前 DSH provider 契约与限制：[`integrations/dsh-agent-control/docs/bridge-conversation-provider.md`](../integrations/dsh-agent-control/docs/bridge-conversation-provider.md)
- Agent Control HTTP/SSE 契约：[`agent-control-api.md`](agent-control-api.md)
- 旧 External UI 迭代记录：[`dsh-session-ui-design.zh.md`](dsh-session-ui-design.zh.md)（历史）
- 旧 client refactor 探索：[`bridge-session-refactor.md`](../integrations/dsh-agent-control/docs/bridge-session-refactor.md)（历史）
- dsh-session-hub 调研：[`dsh-session-hub-evaluation.md`](../integrations/dsh-agent-control/docs/dsh-session-hub-evaluation.md)（历史研究及后续结果）
