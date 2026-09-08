# DSH 外部会话浏览与详情复用方案

日期：2026-09-07，更新于 2026-09-09。状态：统一 DSH/Bridge session 体验已成为后续主线。

## 后续迭代顺序（2026-09-09）

总目标：让 Bridge session 成为 DSH session 的另一种数据源。会话浏览器、Conversation、Chat、Composer
和交互组件由 DSH 提供；Bridge 只负责数据投影、能力声明、实时同步和动作适配。后续不再以复制 DSH
外观的方式扩展 Bridge 专属 UI。

1. **收口已上线基线。** 把当前直接从工作树构建并部署的 Host、Client、Control Plane、Bridge 和文档
   整理为可从 Git 重建的提交。当前阶段暂停测试，以 `pnpm build` 编译通过作为验收；相应地收紧类型
   边界，优先使用 DSH 导出的公共类型和当前 Codex App Server 生成的协议类型，减少手写 shadow
   interface、`unknown as` 和非穷尽事件分支。
2. **统一待处理交互。** 将 Bridge approval、user input 和错误状态投影到 DSH 原生交互卡片，保留
   Bridge 的 CAS、幂等和 capability 语义，不继续维护平行的 Bridge 卡片样式。
3. **用 SSE 优化实时体验。** 以 snapshot + cursor 建立无竞态初始状态，由 DSH Host 持有 Control
   Plane 凭据和 SSE 连接，向 Client 转发类型化增量事件；SessionStore 负责重放、去重、顺序合并和
   断线续传。现有轮询仅作为能力缺失或连续重连失败时的降级路径。
4. **对齐 DSH 输入框。** 先贯通 reasoning effort，使 DSH ModelSelect 的实际选择进入 Bridge 和
   Codex turn；再扩展 target-neutral attachment contract，复用 DSH 的附件选择、预览、删除、发送
   状态与快捷键，不在 Bridge 中仿制一套输入框。
5. **持续统一其余 session 体验。** 后续按差异逐项收敛标题、行菜单、空/加载状态、快捷键、滚动、
   消息和工具展示。功能只有在 DSH 与 Bridge session 共用同一个公共 surface 或 renderer 时才视为
   真正完成。

删除语义固定为真实 Codex 删除：UI 动作通过 Control Plane 和 Bridge 调用 Codex App Server
`thread/delete`；只有上游确认成功后才清理 Control Plane 投影并写 tombstone。失败时保留 session
及错误状态。由于 Codex 会同时删除该 thread 派生的后代 thread，确认界面必须明确提示这一影响。

本阶段刻意不优先安排全文搜索、跨来源手动排序持久化或通用运维增强；它们不能阻塞上述统一体验主线。

## 本轮执行记录（2026-09-09）

步骤 1 已完成：已上线但未提交的工作由 `e7455c9` 收为可复现基线。此前“功能已上线、工作树仍不干净”
是因为 DSH 插件从未提交源码直接生成 `lib` 并复制到运行 profile，Windows Bridge 也直接运行工作区源码；
部署链不要求 Git commit。真实会话删除随后由 `7ecf953` 完成：Control Plane 的可靠异步 action 最终调用
Codex `thread/delete`，收到上游确认后才清理投影并保留幂等回执。

步骤 2 正在执行：产品 assembly 为 DSH resident Approval、User Questions 和 Chat error renderer 提供
target-neutral external surface。Bridge 只投影请求数据、choices、questions、错误和动作回调；approval 保留
`allow`、`deny`、`allow-session` 动态能力，user input 保留多题导航、原生选项/自定义答案、焦点和滚动行为。
Bridge 尚未提供的整组取消与跳过能力由 surface 显式禁用，secret input 仍要求在可信本地 agent UI 中处理。
旧版 DSH 没有这些 external exports 时继续使用现有兼容卡片。当前验收只运行 build/typecheck，不运行测试。

## 第十二轮：运行中主操作与模型控件 seat（2026-09-08，已部署）

`ExternalComposer` 增加 `running/onStop`。运行中的普通 Bridge 会话在空草稿时，原生蓝色主按钮显示 Stop 并调用带 `expectedTurnId` 的 `interrupt_turn`；输入文字后同一按钮恢复 Send，通过现有 auto/steer 提交。兼容 textarea 路径也保持同样行为，详情菜单中的 Interrupt 继续作为次级入口。

组件同时公开 `modelControl` seat，位置与 DSH InputBar 的 `conversation.input.model` 一致，位于 trailing 区、主按钮之前。该 seat 只接收渲染节点，不预设 Agent Bridge 尚在开发中的 model ID、inventory、session override 或 action schema；后端能力稳定后，插件只需依据 capability 注入选择器和状态适配。

产品提交为 `7676780`；完整 Windows 构建通过，安装包 SHA256 为 `DC0C95682CD201992B4DF3DE65D1EDB6AB8C0471CA84FC28071568BFFAC164C7`。插件 42 项测试通过、1 项跳过，typecheck/lint/build 通过；实际部署 bundle SHA256 为 `F63F0874E339BC58F5558BE92F0230A9F1DC25A48FF2752F40F9070C2767017D`，最终部署前备份为 `20260908-132432-769`。客户端已重新安装、重启并监听 `127.0.0.1:43120`。

## 第十一轮：原生 Lexical 输入框（2026-09-08，已部署）

产品构建层在 DSH `0.1.3-alpha.1` 的 staging 产物中公开 `ExternalComposer`。它直接复用 InputBar 内部的 Lexical `ComposerContentEditable`、PlainText 与 history 注册、IME/Enter/Shift+Enter/paste keymap、placeholder、发送按钮和完整 CSS module，只把 `value/onChange/onSubmit/disabled/busy` 注入给外部会话适配器。Bridge 不创建或伪造 DSH Session，提交仍通过 `submit_turn` 或 active turn steer 语义发送。

Agent Control 的 `SessionComposer` 运行时优先消费 `ExternalComposer`，旧 DSH 仍保留 textarea 兼容路径。当前原生层为纯文本能力：文件粘贴不会冒充已上传附件，slash command、`@` 引用、权限、模型和 context meter 尚未接入；这些能力需要先扩展 target-neutral capability，再连接 Bridge 对应端点。

产品提交为 `3ddadc3`；完整 Windows 构建通过，安装包 SHA256 为 `B37E3FDD9F078306D815732BB69EBF60C75BB8C75AAA12A90B3CE932C2DD543F`。ASAR 已确认包含 `ExternalComposer` 定义和公开导出，客户端已安装并重启。插件 41 项测试通过、1 项跳过，typecheck/lint/build 通过；实际部署 bundle SHA256 为 `C60E4AA73AA545D745EDB6D12475EFB3B309D00379A243195F4A1ECC6F475AC5`，部署前备份为 `20260908-130143-281`。

## 第十轮：共享原生 ComposerSurface（2026-09-08，已部署）

产品提交 `b570d60` 在构建层从实际安装的 DSH `0.1.3-alpha.1` 提取并公开 `ComposerSurface`，同时让原生 InputBar 自身改用该组件。Bridge 输入区增加与 InputBar root 相同的 seat，并停止覆盖原生 card 的背景、圆角、阴影和最大宽度，因此两边共享同一 React 表面组件及 CSS module。

本轮插件仍由 textarea 管理文字和 Bridge 提交；完整插件检查为 41 项通过、1 项跳过。实际部署 bundle SHA256 为 `72871F7179C5BE2B57441E086B13ED0629664BEF74C925EB030667D8DA4D5E28`，部署前备份为 `20260908-123839-518`。

## 第八轮：Composer 组件复用切口（2026-09-08，已部署）

在 DSH `0.1.3-alpha.1` 源码中新增公开 `ComposerSurface`。该组件只持有 InputBar 的卡片表面、主题 class 和 `data-composer-card` 契约，不依赖 Session ID、Lexical 草稿、队列或提交策略；原生 InputBar 已改为使用该组件。Bridge Composer 通过 `@deepseek-ai/dsh-client-ui-conversation/client` 优先消费同一导出，并保留旧版兼容 surface。

第八轮当时安装的旧桌面 conversation 尚未包含该导出，因此实际界面暂走兼容 surface；后续客户端对齐到 DSH `0.1.3-alpha.1` 后，这项限制已由第十轮消除。插件 manifest 已声明 conversation 注入和兼容 peer 范围，测试/预览通过同形 shim 避免在 DSH 模块加载器启动前执行浏览器 bundle。

验证：插件 41 项测试通过、1 项跳过，typecheck/lint/build 通过；DSH InputBar 与 skeleton 定向测试共 97 项通过，`ui-conversation` host/client 包成功构建。首次运行上游单包构建前缺少生成类型，补齐官方 Host 类型生成后单包构建成功；全仓 Host bundle 仍报告仓库根 `lib/types/{index,invariant,startup}.js` 缺失，与本次组件改动无关。兼容插件已在实际 DSH 加载并完成只读视觉验证，没有向真实会话发送消息。最终客户端 SHA256 为 `21C5757B663DAB8C528B785E905E2497AF89C85AF18F97A6105F11CB87C1053C`，最终部署前备份为 `20260908-111949-189`。

## 第七轮：使用 DSH 会话布局契约（2026-09-08，已部署）

Bridge 详情移除独立的第二层工具栏，把来源、标题、状态、会话操作、刷新和返回合并进一个会话头。进入 Bridge 时若 DSH 侧栏处于收起状态，会自动展开一次，避免列表只剩一个 B 图标；用户仍可在进入后正常控制侧栏。

正文、用户气泡和输入区改为直接消费 DSH ConversationRoot/InputBar 发布的宽度、侧边留白、输入背景、气泡背景、边框层级、阴影、正文大小和业务主色变量。用户消息采用原生 70.2% 宽度比例、右对齐与 22px 圆角；输入区采用原生的 content+32px 关系、22px 圆角、34px 发送按钮和单行起步高度。空的 turn.started 与无摘要的 turn.completed 在普通阅读模式中隐藏，Raw events 仍保留全部原始事件；时间默认弱化，悬停或键盘聚焦时显示。

这些变量来自 DSH 的公共布局契约，因此 DSH 对相同 token 和宽度轴的调整会同步影响 Bridge。完整 Lexical 编辑器仍绑定原生 session、queue、attachments 与 submission policy，不能直接接收 Bridge 数据；后续真正的组件级融合需要 DSH 对外导出纯展示的 composer shell 或增加外部 InputTarget 适配点。

验证：41 项测试通过、1 项跳过，typecheck/lint/build 通过；实际 DSH 服务验证了新版会话头、正文、输入区和收起侧栏进入 Bridge 后自动展开，没有向真实会话发送测试消息。最终客户端 SHA256 为 `669C68A699465BCA6D64C74CDC4C9F61394B7F702ABB931E07D90B516766D681`，安装与 HTTP 返回包一致；最终部署前备份为 `20260908-105853-025`。

## 第六轮：发送回归与 Kanban 可见性（2026-09-08，已部署）

第五轮替换为 DSH Button 时遗漏了显式 type="submit"；该公共组件默认 type="button"，导致 Send 点击不触发表单提交。本轮修复 Send、Create task、Comment、Submit answers，并用真实公共 Button 验证项目新建→输入→点击发送→消息进入历史→草稿清空。后台详情刷新不再阻断已有有效会话的发送；不可用状态仍显示明确提示并保留草稿。

输入区提取为 SessionComposer，输入文字与正文共用对齐轴，采用上下分层的编辑区和操作栏、自动高度、圆形发送按钮。Enter 发送，Shift+Enter 换行，IME 确认不误发。复用仍限于公共 Button、主题和字号等基础层；DSH 的完整 Lexical InputBar 绑定原生 session/queue/actions，尚未共享。下一步需要在 DSH 提取可注入数据和操作的 composer 展示接口。

侧栏底部恢复明确的 Kanban 快捷入口，看板直接请求 kanban/list，不再等待 Bridge overview。真实看板有 17 个任务且都在 Done，之前被前面的七个空列推到屏外；现在默认隐藏空列，可勾选 Show empty columns 展开。修复任务卡片受 Button 默认高度挤压的问题，创建和评论失败显示在当前操作界面。

验证：40 项测试通过、1 项跳过，typecheck/lint/build 通过；最后的评论错误处理与空看板提示微调后构建通过。模拟浏览器完成新建和发送全流程；实际 DSH 服务验证 17 个任务可见及新版输入区展示，没有向真实 agent 发送测试消息。客户端 SHA256 为 `1E203C30A0BAD80AB60E6B2B46A7F01EF8B597ACC8E487DAE5C0B16CE1BAE039`，已核对安装文件和 HTTP 返回包；第六轮初次更新前备份 `20260908-103850-964`，最终微调备份 `20260908-104018-997`，均位于 desktop profile 的 deploy-backups/agent-control。

## 第五轮：DSH 风格对齐与项目新建（2026-09-08，已部署）

采用已发布的 DSH Button、MarkdownText、TerminalBlock；详情使用 DSH 主题和内容字号变量，正文和输入框共用宽度轴。助手消息不再绘制独立卡片，回合 ID 只在 Raw events 中显示。最终实际服务测量正文左边界 440px、输入文字区域 441px（1px 边框差），无 dialog。

项目行的＋以及详情页 New conversation 使用已有 create_session RPC，只传 workerId 和该项目完整 workspace，创建空对话。依据在线状态与 session-actions 能力禁用不可用入口，提交前刷新 worker 状态，跟踪 accepted→succeeded/failed，防止重复点击；创建确认后自动打开，若已切换到其他会话则提供显式 Open conversation。模拟环境验证了指定目录创建与自动打开，真实环境只验证展示，未为测试创建真实对话或发送消息。

排序默认按创建时间，新旧项目按组内最新匹配会话排序；可选更新时间，同时间时按创建时间打破平局。已确认 backend 的 markMachineOffline 将 updated_at 写为当前时间，upsertSession 又使用 MAX，导致旧项目出现“新更新时间”。本轮没有伪造最后对话活动时间，也没有修改远端数据库；当前排序仅覆盖已加载页，后续需要增加独立 activityAt 并贯通 Host/服务端分页排序。

37 项测试通过、1 项 Windows 不适用测试跳过，typecheck/lint/build 通过；新增项目创建、异步失败、防重复和排序回归。最终客户端 hash `FBB57C54E4251BE9E08554F490E66AD48801C62DCBC8917C69B2D0A28F1A5054`，实际服务返回包已校验；第五轮开始前备份为 `20260908-102203-132`，后续微调备份为 `20260908-102416-145`。

复用边界：主题、字号与公共组件更新可共同生效，宽度布局适配仍由插件持有；完整原生阅读器/浏览器的上游共享提取仍未完成，不能承诺所有 DSH UI 优化自动覆盖 Bridge。

## 第四轮：主界面集成（已部署）

- 使用已发布的 `sidebar.workspaces`、`conversation` 单插槽和 priority/dispose 契约，在 Bridge 模式临时注册展示组件；切回 DSH 时撤销注册，恢复原生组件。没有操作 DOM 或向原生 Session store 写入外部记录。
- 侧栏底部改为 DSH／Bridge 来源切换，Bridge 列表占用正常浏览区域，详情占用中间区域。进入 Bridge 收起原生工具详情栏；原生 selection 改变时退出 Bridge 模式。原生和 Bridge 尚未混合在同一棵树中。
- 列表在 footer 挂载时预加载第一页，详情按选择加载。切换来源保留插件内存中的会话、草稿及偏好；未加入跨重启的列表缓存。高级分组操作收进 View options，目录显示末级名称，悬停保留完整路径。
- 实际本地 DSH 服务端口本轮为 1566。更新脚本改为发现当前 TokensCowork 监听端口，并在写文件前验证服务与构建输出，避免重启换端口后先写入再校验失败。
- 验证：类型检查、lint、构建与 34 项测试通过，1 项 Windows 不适用测试跳过。真实服务的 100+ 会话和正文读取、无弹窗导航、回到原生列表及输入区已通过浏览器验证。桌面也读取到了新版来源切换；桌面自动点击受窗口几何不可用限制，交互验证在同一实际 DSH 服务的浏览器界面完成。
- 一次已运行 Host 的页面重载到 `Bridge · 100+` 可点击实测 690 ms（包含导航与自动点击等待）；不是应用完整冷启动指标，不能据此声称所有启动延迟已解决。
- 当前客户端 SHA256：`0283554AC9D49E1D6807A77644670E3AC5A8F42EF33375D854A79BA15FC723F8`。已核对实际 HTTP 返回包。第四轮初次更新前的旧包备份在 profile 的 `deploy-backups/agent-control/20260908-095827-146`；后续微调备份保留在同目录下。

## 决策

采用“共享展示层、独立会话来源、按能力分发操作”。近期在现有插件里完成 Bridge 数据投影和基础组件复用；中期为 DSH 增加可复用的浏览器、会话阅读器接口，再让原生和外部会话使用同一套界面。

不把外部会话写进 DSH 原生 Session 存储，不全局替换 `ctx.sessions`，不复制整个 `ui-workspace` / `ui-chat` 包。当前公开 API 尚不足以让外部 session 无改动进入完整原生界面，不能把“存在 slot”视为“支持任意数据源”。

## 调研基线与证据

本机实际源码根目录为 `C:/Users/clown/Workspace/tokens_TokensHarness_code/desktop/deepseek-harness`，Git HEAD 为 `d347e703908d0406b7a7ef80e3a0e594d86b2215`，源码版本 `0.1.3-alpha.1`。当前插件依赖 `0.1.2-rc.1`。另读取了 Desktop vendor 中 `0.1.2-rc.1` conversation 包的公开声明，确认该版本也公开组装相关类型，但没有据此假定所有版本接口等价。

下面路径以 DSH 源码根目录为基准：

| 源码位置 | 已确认事实 | 设计含义 |
| --- | --- | --- |
| `packages/client/ui-workspace/src/client/index.ts` | 浏览器通过 slot 注册，注入 search、rename、fork、archive、workspace 操作；公开入口不导出 WorkspaceBrowser 组件 | 不能直接 import 一个完整列表组件接 Bridge |
| `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` | 已实现 workspace/flat、manual/updated、搜索、折叠、拖动，以及状态提示 | 这些通用交互应尽量共享；绑定原生服务的操作需拆开 |
| `packages/client/ui-workspace/src/client/tree.ts` | 树基于 SessionListState、WorkspaceView、pending interaction 派生 | 工作目录字符串不是原生 Workspace 的成员关系 |
| `packages/api/session-controller/src/client/contract/sessions.ts` | list 为只读 Observable；open 要求已知 ID；没有外部 provider 注册入口 | 不能用 create 冒充注册，也不能向原生 store 塞外部行 |
| `packages/client/ui-conversation/src/client/conversation/assembly.ts` | `binding(SessionBinding \| SessionId)` 可消费 binding 的 eventSource，通过其 ctx 管理生命周期 | 可以研究独立阅读器适配；还不能证明完整原生 Chat 可用 |
| `packages/client/ui-chat/src/client/apply.ts` | Chat 同时依赖 sessions、uiSession、uiConversation、remote.session、layout 等 | 组装成功与界面接入成功必须分别验证 |
| `packages/api/session-controller/src/client/contract/events.ts` | 原生事件有 seq/time/data、增量窗口与 assistant settlement 语义 | Bridge 事件不能仅改字段名后当成原生完整日志 |
| `packages/client/ui-primitives/src/index.ts`、`packages/client/web/src/seed.ts` | 基础组件公开导出，且在 Web 静态模块表中 | 是最明确的近期复用入口；仍需对目标版本核对导出 |

当前插件的问题也会影响任何新 UI：

- `src/client/index.tsx` 直接遍历 overview snapshot，缺少 session 分页；Host snapshot 只取 100 条。
- 详情仅请求前 200 个事件。Bridge events 从保留窗口最早处升序返回，这不等于最近 200 条。
- 事件 envelope 使用 `eventId`、`timestamp`，当前 UI 读取 `id`、`createdAt`。
- selected 保存整条对象，刷新后操作可能仍使用旧 activeTurnId；快速切换 session 的响应可能串页。
- 当前没有自动订阅事件；返回 accepted 后还需跟踪 action 结果，不能把请求接收当成执行成功。
- Bridge App Server 历史补水当前取最近 50 turns，部分文本和文件变更会截断。后端能力不足不能由展示组件补出。

## 用户体验

最终入口是同一个会话浏览区，提供全部 / DSH / Bridge 来源筛选。Agent Control 保留机器概览、待处理汇总与 Hermes 看板，并可定位到会话。

### 列表

- 默认按工作空间分组，组内最近活动优先；保留平铺与手动排序选择。
- 行展示标题、状态、来源/机器、最近活动时间；工作目录放在组标题或悬停详情中。
- 待审批、待输入提供快捷筛选及计数，不在用户阅读时强制把整棵树重排。
- 置顶、折叠、手动排序、已读位置属于视图偏好；不自动解释为源端归档或 Workspace 变更。
- 初期搜索标题与路径，明确搜索范围；正文搜索只有在 provider 提供搜索能力后启用，不能以当前缓存冒充全量搜索。
- 列表为空、首次加载、已断开且保留缓存、分页未完成分别展示。

身份使用结构化 `{ providerId, sessionId }`，其中 providerId 标识一个配置的 Bridge 连接或 DSH 来源；workerId 是执行位置元数据。需要序列化时使用明确编码，避免分隔符碰撞。

默认工作空间分组键为 `{ providerId, workerId, canonicalWorkspacePath }`。路径规范化遵循源机器平台，不能把 Linux 大小写规则改成 Windows。跨机器同名项目可由用户显式映射到一个逻辑项目；显示名相同不自动合并。

### 详情

正文按 turn 显示用户消息、助手消息和可折叠执行过程；右侧按需打开命令输出、文件变更和关联任务。原始事件作为调试视图保留，不作为默认阅读内容。

| Bridge 数据 | 默认呈现 | 限制 |
| --- | --- | --- |
| `message.completed` | 按 role 展示文本/Markdown | 不伪造缺失的推理、token、request 信息 |
| `command.completed` | 命令摘要、退出码、折叠输出 | 只有 completed 时不伪造执行中时长 |
| `file_change.completed` | 文件列表、可用的变更内容 | 没有 patch 时不显示虚构 diff |
| turn terminal | 回合完成/失败/中断状态 | 状态与最后一条 assistant 消息分开处理 |
| approval / user input | 当前待办卡片与历史记录 | 操作以 pending endpoint 的当前事实为准 |
| 未知事件 | 简短类型提示、展开原始内容 | 未知数据不使整个会话无法阅读 |

输入框继续使用 Bridge 的 start/steer/interrupt；以 capability 控制可用功能。文件打开必须面向对应 worker，不能把远端绝对路径交给本机默认文件打开器。原生 fork、rename、archive、上传附件等没有适配时不显示。

## 架构与接口

数据链路：Bridge REST/SSE → Host AgentControlService → 同源 RPC/通知 → BridgeSessionStore → 视图投影 → 共享浏览器/阅读器。

### 插件内部先建立的边界

1. `session-store.ts`：列表分页、选择引用、每会话事件窗口、请求代次、action 状态、订阅生命周期。
2. `session-projection.ts`：真实字段校验、标题/工作空间映射、事件去重和 turn/item 聚合；保留原始事件引用。
3. `session-actions.ts`：声明 capability，集中处理操作、expectedTurnId、执行回执、冲突后的刷新。
4. `session-view-state.ts`：按配置来源隔离的偏好存储；不保存消息正文；存储不可用时退回内存。
5. `dsh-ui-adapter.ts`：唯一接触 DSH 展示契约的边界，版本差异集中在这里。

以上是拟新增文件，不是现有接口。视图模型独立于 DSH 原生 Session JSONL 格式，使适配层可替换。

### 建议给 DSH 补的两个展示扩展点

**浏览器：分离浏览器视图与原生会话控制器。** 原生 ui-workspace 保留自己的服务适配器；共享视图接收行/组快照、当前选择、偏好存储以及按行 capability 提供的操作。新增外部来源注册机制由浏览器导航层管理，不扩大原生 Session 存储的职责。

建议的最小契约包括 provider 身份、可订阅的列表页状态、加载下一页、可选搜索、open 回调、可选行操作。统一导航保存带 provider 的选择；选中 DSH 行调用原生 sessions.open，选中 Bridge 行切到外部详情。切回时保留原生草稿与视图状态。

**阅读器：分离只读内容呈现与原生会话命令。** 把 Chat 的消息、工具、滚动/折叠能力提取到数据驱动阅读器，显式接收内容源、历史加载、文件/附件解析和可选操作；原生 Chat 用自己的适配器，Bridge 用自己的投影。通过公开展示包或服务/slot 暴露，不能绕过 Web 模块加载器导入动态客户端包内部组件。

先支持消息和命令两种内容，确认边界后再扩展 diff、图片、回合导航。原生 Trajectory 的 request/prompt inspection 无对应数据，留在 DSH 原生会话中。

`uiConversation.binding(customBinding)` 是实验候选，不是默认方案：需要验证完整 SessionBinding、scope 生命周期、Chat hooks、原生操作隔离和实际事件语义。若要伪造 SessionFace 或大量原生内部事件才能显示基础内容，应停止这条路径，采用阅读器提取。

这些 DSH 扩展目前不存在。源码仓库将 upstream 作为只读子模块，本轮方案不修改它；后续共享接口可在独立 upstream 开发 checkout 中实现，经过测试发布后再更新 pin。当前插件开发不依赖先完成这项上游变更。

## 事件同步与操作正确性

- 每个会话独立缓存，选择仅保存 SessionRef。操作时读取最新快照中的 activeTurnId。
- 切换详情取消旧请求或以请求代次丢弃旧响应；错误、草稿、滚动位置按会话隔离。
- 列表使用 `/sessions` 分页，overview 只服务概览。刷新不是丢弃当前选择和已加载页。
- 当前 events API 的 `after` 表示向后读取更新事件。初次读取从保留窗口最早处逐页推进，展示“正在加载可用记录”。不能把它直接接到原生向上加载更早历史。
- 对长会话，建议 Bridge 后续提供明确的 tail/before 查询与保留范围元数据，再做首屏最近消息和向上加载；这是后端新增工作。
- 先按 eventId 去重；同一 item 的补水/实时观察如可能有不同 eventId，再按 session/turn/item/type 的语义身份合并，不能只凭相同文本删除消息。
- cursor 是 opaque，不解析数值、不按字符串排序。历史 cursor 与全局 SSE cursor 分开保存。
- Host 每个 Bridge 连接一条共享 SSE，以 snapshot 的 streamCursor 接增量；处理重复投递、断线重放和 410 后重新建立基线。数据完整应用后才推进 checkpoint。
- 未完成 SSE 时可先使用受可见性控制的增量轮询；轮询也遵循相同 store 边界和卸载清理。
- History completeness、保留窗口、上游截断分别表达。API 没有充分元数据时显示“可用历史”，不承诺完整。
- 写请求 accepted 后显示处理中并跟踪 action；失败保留可重试内容。期望 turn 冲突后刷新并显示原因，不盲目向新 turn 重放输入。

## 分阶段交付与验收

### P0：固定契约与最小验证

在当前插件增加独立实验入口/构建配置，生产默认保持当前入口。先核对 `0.1.2-rc.1` 的 primitives 导出，使用真实 Web ModuleLoader 测试一条 Markdown 消息和一条命令卡片，确认主题、静态模块身份和卸载。

同步增加真实 envelope 的 mock fixtures：多工作空间、相同标题、待审批、空事件、未知类型、两页历史、迟到命令结果。不触发真实用户会话操作。若实验采用较新 DSH，另建隔离 profile/依赖环境，不让当前锁文件混入两套 DSH 核心版本。

通过标准：浏览器加载无缺失模块、已知来源不会调用原生 remote.session、快速切换不串消息、未知事件可查看。纯类型检查或服务组装测试不能替代这个验证。

### P1：可交付的外部会话体验

先完成 store/projection/action 边界和真实分页，再替换 JSON 默认详情。复用 DSH primitives，加入有限的 workspace/flat、updated 排序与折叠；不在当前插件扩写一套完整拖拽/正文搜索系统。

通过标准：超过 100 个 sessions 和 200 个 events 不静默消失；刷新后的操作使用当前 turn；正常对话可读；待办可处理；处理失败与断线清楚可见。此阶段仍在 Agent Control 中，但其数据层可直接供后续统一入口使用。

### P2：共享阅读器与浏览器

先提取阅读器并迁移原生 Chat 的基础消息/命令消费方，证明原生行为不回退；再提取浏览器并接入 DSH/Bridge 两个来源。把现在插件中的有限分组视图替换掉，不留下两份长期演化的分组实现。

通过标准：DSH 原生消息/命令的现有验证通过；Bridge 可在统一列表被检索/选择；两个来源 ID 相同不碰撞；原生草稿、滚动与返回导航保留；未支持操作不出现。

### P3：丰富内容与持续同步

完成共享 Host SSE、尾部历史接口（若长会话需要）、虚拟列表、远端文件/图片能力和逻辑项目映射。按实际后端数据接入 diff，不一次承诺所有原生诊断视图。

重点回归：SSE 重放与 cursor 失效、历史补水/实时重复、turn 结束后的迟到 item、快速切换、插件卸载、worker 离线、操作回执失败、历史截断。浏览器验收覆盖展开/折叠、滚动锚定、主题和键盘操作。

## 本轮交付范围

本轮完成源码与发布包声明调研、当前插件缺口检查及本设计文档。未修改插件运行逻辑、未启动 GUI、未执行真实会话操作，也未运行或宣称上述实验已通过。

优先级：数据正确性与基础详情 → 共享阅读器 → 统一浏览器 → 高级排序和跨机器项目组织。这样每一步都有可用成果，同时把最容易重复建设的复杂交互留给共享层。

## 第一轮实施记录（2026-09-07）

已在当前插件落地 P1 的基础部分：独立 session store/projection、列表和事件继续分页、工作空间/平铺分组、已加载标题/路径搜索、待处理筛选；详情复用 `0.1.2-rc.1` 的 MarkdownText 与 TerminalBlock，展示文件变更、回合状态、未知事件及原始数据。

状态层按会话保存草稿/事件/回执，隔离迟到响应；刷新后读取当前 turn，接受与执行成功分开；读取分页 pending 请求，可见时轮询当前会话与已接受 action。修正 mock 的 sessionId/updatedAt 字段，并加入 202 个真实格式事件的分页样例。

验证包括插件类型检查、lint、构建、store/真实 DSH 组件测试，以及浏览器中的构建产物 mock smoke（Markdown/终端展开、200→202 事件续页、离线禁用、草稿切换、mock 发送与审批回执）。预览仅模拟 slot 和静态模块宿主，尚不等于真实 DSH profile 或 live Bridge 验证。

尚未完成：统一原生导航、提取共享 Workspace/Chat 阅读器、Host SSE、跨刷新视图偏好、历史尾部查询与长列表虚拟化。当前分组与详情仍位于 Agent Control overlay，避免将这一轮描述为原生会话接入完成。
# 第二、三轮实际部署记录（2026-09-08）

第二轮加入侧边栏 Bridge sessions 快捷入口、共享会话状态、置顶与分组偏好持久化、按事件恢复阅读位置，以及首条／最近已加载记录跳转。terminal-only 来源的回合摘要默认使用 Markdown 展开。真实 DSH 服务验证了 100+ 会话和当前任务的三条回合摘要。

第三轮增加可见分组的批量折叠／展开、筛选后会话与分组计数，以及清除筛选、展开当前分组并滚动定位的 Locate current。同步修正异步列表到达或置顶改变分组时的当前分组展开逻辑。

两轮均已通过客户端更新脚本安装到现有 desktop profile，并核对 DSH HTTP 实际返回的包哈希。桌面窗口已确认显示 `Session UI · Round 3`。第二轮备份为 `20260908-000652-105`，第三轮备份为 `20260908-001013-736`；均位于该 profile 的 `deploy-backups/agent-control`。

验证：33 项测试通过，1 项 Windows 不适用的 Hermes sidecar 测试跳过；类型检查、lint、构建通过。浏览器验证了侧栏直达、置顶持久化、关闭重开后的阅读位置、批量折叠和筛选后的定位。真实会话只做读取验证。上游 primitives 缺少 source map 的提示不影响运行。

边界：尚未抽取上游原生 session 浏览器或接入原生 session tree。快捷入口仅复用 sidebar slot，正文复用 DSH primitives。偏好存于浏览器 origin；历史分页中的锚点需要对应页面加载后恢复。每个后续阶段继续采用实现、验证、安装到实际 DSH、记录备份的流程。
# Round 9：以 TokensCowork 0.4.3 / DSH 0.1.3-alpha.1 为新基线

客户端已升级为 TokensCowork `0.4.3`，内置 DSH conversation 包经 ASAR 核验为 `0.1.3-alpha.1`。Agent Control 的 DSH UI peer 范围同步提升为 `>=0.1.3-alpha.1 <0.2.0`；开发构建继续使用已公开的 `0.1.2-rc.1` 包，因为 npm registry 没有发布 alpha.1，产品自身通过 vendor tarball 提供该版本。

详情页去掉常驻的技术工具条：标题栏只保留会话名称、项目路径、状态、项目新建和刷新，Interrupt、返回 DSH、history completeness 与 Raw events 收进动作菜单。阅读器移除 First/Latest 双按钮，仅当用户离开底部时显示悬浮 Latest。输入框提示也缩短，正文、标题和 composer 形成一条连续的 DSH 会话阅读轴。

Windows 更新器已适配 0.4.3 的本地 HTTP 认证：只从 TokensCowork 进程持有的唯一 loopback listener 中识别服务，开放模式继续校验 HTTP bundle 哈希，返回 403 的认证模式校验安装文件哈希并要求重启加载。本轮 41 项测试通过、1 项跳过，typecheck、lint、build 均通过；最终安装 bundle SHA256 为 `12971B9436245AB1E1FC9256036EE230921FE59E6746E1F97F22FA681E6E971D`，首次部署备份为 `20260908-121655-571`。

# Round 13：接入 Agent Bridge 每回合模型选择

Agent Bridge 已快进到 `1291a61 feat: support per-turn Codex model selection`。上游协议允许 `create_session` 和 `submit_turn` 携带可选 `model`，但活动 turn 的 steer 不允许切换模型；当前没有模型列表接口，provider 仍由 worker 的 `config.toml` 决定。因此插件在 DSH `ExternalComposer.modelControl` 插槽中提供紧凑的模型 ID 输入，空值使用 Codex 默认模型，并在存在 `activeTurnId` 时禁用控件。

模型输入与消息草稿一样按 session 隔离。提交新 turn 时，非空模型 ID 写入 `submit_turn.model`；steer 时仅发送 `expectedTurnId` 并省略模型，避免触发 `model_not_applicable`。项目中的新会话仍可先创建空 thread，再在第一条消息中选择模型；在 Bridge 提供模型 inventory 前不伪造下拉选项。

验证覆盖 session 切换后的模型隔离、新 turn 携带模型、活动 turn 自动省略模型、原生 composer 插槽渲染及 mock 页面发送。插件检查为 43 项通过、1 项 Windows 不适用项跳过，typecheck、lint、build 通过。Round 13 已部署到 desktop profile 并重启 TokensCowork；bundle SHA256 为 `2791D04749BE55B3DE5757F88A0FE686A0AAC4F39292B45B935FF0720833C9B7`，备份为 `20260908-150057-351`，DSH 服务恢复监听 `127.0.0.1:43120`。

# Round 14：原生 ModelSelect 与 ContextMeter

Round 13 的模型文本框已移除。TokensCowork 产品运行时现在公开 DSH 自己的 `ModelSelect`，Bridge 插件只实现同形 directory adapter：worker 的 Codex App Server 通过官方 `model/list` 返回目录，Control Plane 转发该目录，插件提供可订阅快照与选择动作。模型按钮、两级菜单框架、键盘行为、加载和错误状态均由 DSH 原生组件渲染；模型目录在详情打开时预取。活动 turn 继续锁定选择，新 turn 将选中的 model 写入请求。

Codex App Server 的 `thread/tokenUsage/updated` 同步投影为 `context.updated`。Bridge 只为已完成工作区 discovery 的线程发布该事件，避免未知线程破坏 Control Plane 的 session 外键；详情取最新用量并交给 `ExternalComposer`，后者在 DSH 原生 trailing 区渲染 `ContextMeter`。状态事件不进入正常聊天正文。

本轮以 TokensCowork `0.4.5`、Tokens UI `0.2.19`、DSH `0.1.3-alpha.1` 构建并安装。真实 Control Plane 模型接口返回 6 个模型，默认模型为 `gpt-6-astra`；本机 Bridge 和远端 Control Plane 均已重启。Agent Bridge 后端测试 58 项通过、4 项跳过，插件 44 项通过、1 项跳过；产品 market 253 项通过、desktop 245 项通过，Windows 安装包验证通过。部署时发现旧更新器只替换浏览器 bundle，导致 Host 将 `models` 拒绝为未知操作；现已补入 Host 白名单，并让更新器原子部署 Host 与 Client。最终 Client SHA256 为 `04909DDC2CA9D1504FB3D5F74A9D0FCC45FF453C2A9D6072BC778FA351A3AA9C`，Host SHA256 为 `6C4EFE2A92B10BC33AD557CDEB716E2895D362F6BD5F10C4BF3929DDD33508B7`，备份为 `20260908-160057-211`，DSH 服务监听 `127.0.0.1:43120`。

当前原生复用边界覆盖 composer 编辑器、模型选择、上下文表与主操作。Bridge 的消息阅读器和会话标题区仍是外部数据视图；下一轮应把这两个区域收敛到 DSH 公共 Conversation 展示契约，使普通 session 与 Bridge session 共享同一套布局和后续 UI 优化。

# Round 15：共享 Provider 目录、项目摘要与最新消息首屏

Round 14 的原生 `ModelSelect` 外壳保留，目录来源改为 DSH Host 的 `remote.session.modelCatalog()`。因此选择器现在展示 DSH 当前配置的全部 provider 和模型，包括第三方及 OpenAI-compatible 模型；Bridge 只保存选中的 model ID，并在下一次新 turn 中传给共享 provider。当前 Bridge 协议尚未携带 reasoning effort，adapter 暂不向原生组件暴露 effort 选项，避免出现只改 UI、不影响请求的假状态。Codex App Server 的 `/workers/:id/models` 接口保留作兼容与诊断，不再作为生产选择器目录。

项目组默认收敛为工作摘要：只显示 active、等待审批、等待输入、报错、当前选中和置顶会话。每个项目保留总数，并通过 `Show N older conversations` 临时展开历史；搜索、Needs attention 和平铺模式仍显示全部匹配结果。含活动或待处理会话的项目优先，其余项目按所选时间排序，避免一个项目的几十条旧记录挡住下一个项目的当前会话。

Control Plane 增加 `GET /sessions/:id/events?tail=true&before=<cursor>`。首屏从保留历史尾部读取最近 200 条，结果仍按时间正序交给阅读器；`Load earlier messages` 使用 opaque cursor 向前翻页并 prepend。SessionStore 按会话保留已加载页，切换会话不会清空；轮询、手动刷新和 action 完成只合并最新尾页。阅读器首次打开滚到最新位置，prepend 时按最早已显示事件维持视口锚点。

验证覆盖 DSH 多 provider catalog、第三方 model ID 提交、尾部分页无重复且输出正序、203 条事件的 200+3 向前分页、项目旧会话默认省略与展开。全仓测试 58 项通过、4 项跳过；插件测试 45 项通过、1 项跳过。

# Round 16：共享 DSH Conversation 结构层

TokensCowork 的 Conversation runtime 现在公开 `ExternalConversationSurface`。它直接使用 DSH 原生 Conversation 的根节点、标题栏、正文、滚动容器、sticky composer seat、内容宽度观测和左右拖拽宽度手柄。Bridge 详情只提供标题、动作、timeline、composer 和滚动回调，因此以后修改 DSH 的这一层布局和样式时，普通会话与 Bridge 会话会同时生效。

完整 `ConversationRoot` 仍依赖原生 `SessionBinding`、scope、slot 和 projection，Bridge 不伪造这些内部对象。`SessionReader` 改为可绑定由共享 surface 持有的滚动容器，继续负责按会话缓存、首次定位最新内容、向上 prepend 历史时保持视口锚点，以及离开底部后显示 Latest。旧版产品缺少新导出时仍保留兼容 fallback。

本轮产品以 TokensCowork `0.4.5` 构建并静默安装，安装包 SHA256 为 `E7BAD517E773A4DC4E38BC7141FB264C988B0EB495D655ABFFCFFF75FE8D57B1`。Agent Control 最终部署后的 Client SHA256 为 `64AE13DAF1B344C437D43A8A7755FE9C51FDF3F56F70AD19BA482B6E692D271F`，Host SHA256 为 `6DB998D5D2FBC5DB818062C76365F655A3A739C0C2C73058203634D55B87C525`，备份位于 `20260908-175314-461`。客户端已重启并恢复监听 `127.0.0.1:43120`。

下一阶段继续收敛内容层：为 DSH 提取稳定的消息、命令和文件变更展示契约，让原生与 Bridge timeline 共享 renderer；随后统一侧边栏 session browser 的数据源接口，消除现在 Bridge 自有的行、分组和筛选 UI。

# Round 17：共享 DSH Chat 内容 renderer

TokensCowork 的 Chat runtime 新增窄的 `ExternalChatEvent` 契约。Bridge timeline 只投影用户消息、助手消息、命令和文件变更四种目标无关事件；实际展示分别复用 DSH 的 `UserStyleBubble`、`AssistantMarkdown`、`GenericCommandCard` 和 `DiffBlock`。旧产品缺少该导出时继续使用兼容 renderer，未知事件仍可展开查看，避免插件伪造完整 `SessionBinding` 或复制 Chat 内部状态机。

预览验证覆盖原生 Markdown 标题、列表、代码块和表格，命令与文件变更折叠行，以及 200 条最新事件首屏和向上补页后的滚动锚点。模型控件继续读取 DSH 共享 provider 目录；同时修复 directory adapter 将 `store.subscribe` 裸传后丢失实例上下文的问题。预览入口改为可观测的动态启动流程，后续上游包变动会直接显示加载错误，不再留下无信息白屏。

产品 market 253 项通过、9 项跳过，desktop 245 项通过；Agent Bridge 后端 58 项通过、4 项跳过，插件 45 项通过、1 项跳过，typecheck、lint、build 与 `git diff --check` 通过。TokensCowork `0.4.5` Windows 安装包 SHA256 为 `7B1973AA4486375D6C07D9AB5B778470A4E309D6FA1079268F215E73822CB988`，安装程序版本为 `0.4.5.0`。最终部署 Client SHA256 为 `467A68C1B148D8A8A70AE08834B2591E3A9C9C84CA698634FCF958AB014D114D`，Host SHA256 为 `6DB998D5D2FBC5DB818062C76365F655A3A739C0C2C73058203634D55B87C525`，备份位于 `20260908-182910-393`。客户端已重启并恢复监听 `127.0.0.1:43120`。

下一阶段统一 DSH 与 Bridge 的 sidebar session browser 数据源和行／分组 renderer，使两类会话共享项目折叠、排序、搜索、选中态和新建入口；Bridge 只保留来源能力差异，继续减少独立 UI。

# Round 18：共享 DSH Workspace 会话浏览器

TokensCowork 的 Workspace runtime 新增 `ExternalSessionBrowser`。它直接复用 DSH 的 `ProjectRowItem`、`SessionNodeItem`、状态点、相对时间、折叠箭头和 session overflow 控件；Bridge 只提供项目组、会话摘要、当前选中项及 toggle/create/open/show-more/pin 动作。项目默认摘要仍只显示 active、待审批、待输入、错误、当前和置顶会话，展开历史后由同一个 DSH overflow 控件收回。新建入口也进入共享项目头，离线 worker 不显示可用的新建动作。

插件 manifest 现在随 Host 与 Client bundle 一起原子部署。此前 profile 中的旧 manifest 只声明 layout/renderer/sidebar，依赖运行时偶然已加载的模块；本轮明确注入 chat、conversation、model-selection 和 workspace，消除加载顺序隐患。旧产品缺少 `ExternalSessionBrowser` 时仍回退到原有列表，便于跨版本部署。

产品 market 253 项通过、9 项跳过，desktop 245 项通过，Windows package verifier 确认 16,547 个 ASAR 条目和 102 个 unpacked 条目。TokensCowork `0.4.5` 安装包 SHA256 为 `CCBC37E1EC4318FE128E097923DD1D785BD0D29C01B2F11E8EEDF83A3C9E7331`，安装后可执行文件 SHA256 为 `858A85B363E58FCC3990C0253CE83C98FB5B69858C340D9D13ED03C4B7D5DA05`。最终插件 Client SHA256 为 `275449D9D16E87934B6BD716E46A5FFCE4946F095D65BDA19E0B501303CCC7C2`，Host SHA256 为 `6DB998D5D2FBC5DB818062C76365F655A3A739C0C2C73058203634D55B87C525`，manifest SHA256 为 `B79E9DFD2E5D2725ABCFED6C1D02CDB94FE6A51749A9328F33A800B04915004A`，备份位于 `20260908-185759-288`。客户端已重启并恢复监听 `127.0.0.1:43120`。

下一阶段把顶部搜索与 view-options 也收进 Workspace 公共 surface，并让 DSH/Bridge 两个数据源在同一个浏览器实例中混排，而不是继续使用来源切换按钮。完成后侧栏将只剩一个会话浏览器，来源差异只体现在小型 badge 和能力菜单。

# Round 19：DSH 模型目录与尾部历史语义

Bridge composer 的模型目录现在严格来自 DSH Host 的 `session.modelCatalog()`。插件不再在 DSH catalog 缺失或失败时回退到 Codex `model/list`，因此不会把仅含 ChatGPT/Codex 模型的目录伪装成共享 provider 列表；加载失败会留在 DSH 原生 `ModelSelect` 的错误与重试界面。目录投影保留 provider 分组、第三方 model ID、描述和 reasoning effort 元数据，同一份成功 catalog 也会在不同 Bridge worker 会话间复用。

项目与会话默认改为按最近活动排序，并用新的本地视图状态版本迁移旧的创建时间默认值。项目摘要只展示 active、待审批、待输入、错误、当前选中与置顶会话，其余会话进入原生 `Show N more sessions`；搜索或显式展开时仍能查看全部。详情首次请求事件尾页并自动定位底部，滚动到顶部会向前分页且 prepend 后保持阅读位置；`SessionStore` 在当前 DSH 生命周期中缓存各会话已加载的事件、cursor 和草稿，重新点回同一会话不会重复从第一页加载。

Agent Bridge 后端 58 项通过、4 项跳过；插件 47 项通过、1 项跳过，typecheck、lint、build 与 `git diff --check` 通过。最终部署 Client SHA256 为 `F540B15345A2311FF477E83F59658F06E4C4589EE726A0823C1B12B03ECDC830`，Host SHA256 为 `6DB998D5D2FBC5DB818062C76365F655A3A739C0C2C73058203634D55B87C525`，manifest SHA256 为 `B79E9DFD2E5D2725ABCFED6C1D02CDB94FE6A51749A9328F33A800B04915004A`，备份位于 `20260908-191446-944`。TokensCowork 已重启并恢复监听 `127.0.0.1:43120`。

下一阶段继续原定融合路线：让一个 Workspace browser 同时投影 DSH 与 Bridge 会话，移除侧栏底部的来源切换；点击 DSH 行恢复原生 conversation，点击 Bridge 行挂载共享 Bridge conversation surface。

# Round 20：统一 DSH 与 Bridge 会话浏览器

侧栏现在始终挂载一个 `ExternalSessionBrowser`，同时订阅 DSH `sessions`／`workspaces` 服务和 Bridge `SessionStore`。同一路径的两类会话进入同一个项目组，UI identity 分别使用 `dsh:<id>` 与 `bridge:<id>`，因此相同原始 session ID 不会碰撞。点击 DSH 行会先卸载 Bridge conversation shadow 再调用原生 `sessions.open()`；点击 Bridge 行只替换 conversation seat，侧栏本身不再切换或重建。底部 DSH／Bridge 来源开关已经删除。

统一列表沿用上一轮的摘要规则：active、待处理、当前和置顶行直接显示，其余行进入项目的原生 overflow。搜索同时匹配两类会话的标题、项目路径和来源。原生 Workspace 的新建按钮继续调用 `sessions.create({ workspaceId })`；Bridge-only 项目调用 Bridge 创建动作，成功后直接打开新会话。没有 Workspace 归属的原生会话保留在 `Other conversations` 组。TokensCowork 的共享 row contract 新增可选 `source` 和 `pinnable`，由原生 `SessionNodeItem` 旁显示轻量来源标签，DSH 行不会出现无效的 Bridge pin。

验证覆盖混合项目、DSH／Bridge 原始 ID 冲突、两种点击路由、来源开关移除以及 DSH 行无 pin。插件 48 项通过、1 项跳过；产品 Market 253 项通过、9 项跳过，Desktop 245 项通过，runtime closure、品牌和 Windows package verifier 均通过。安装包 SHA256 为 `04C232698F9C662151BABA5477FBC058BA6B71040D8EADED1993E0A32CE5B2D6`，安装后可执行文件 SHA256 为 `DD4D3BA11FE18B141F5B629AC7D5A6671F7EF57552896308CFD474A18D202910`。最终插件 Client SHA256 为 `A0559B5C9FAA832CE4DF0E2E7DE9F5365919FC8EE1DB9105669203D9BC87E5D7`，Host SHA256 为 `6DB998D5D2FBC5DB818062C76365F655A3A739C0C2C73058203634D55B87C525`，备份位于 `20260908-210735-106`。TokensCowork 已重启并监听 `127.0.0.1:43120`，启动日志未出现 Agent Control、shared runtime 或 Bridge operation 错误。

下一阶段把统一列表顶部的搜索与 view options 也下沉到 Workspace 公共 surface，并处理完整的原生搜索、归档／重命名能力映射；conversation 侧继续把 Bridge pending approval、user input 和错误状态接入 DSH 原生交互卡片。

# Round 21：原生 Workspace 搜索与视图菜单

统一浏览器顶部已经移入 DSH Workspace 的共享 surface。`ExternalSessionBrowser` 现在直接渲染 DSH 原生 section header、可展开搜索框和 `ViewOptionsMenu`；插件只传入受控的 query、分组方式与排序方式，不再维护自己的标题或搜索输入框。`workspace`／`flat` 会同时重排 DSH 与 Bridge 会话，`updated` 会按最近活动排序；`manual` 保留原生 Workspace 顺序，并在各来源已有顺序上做近似合并，暂不承诺跨来源拖拽顺序持久化。

搜索会同时过滤已加载的 DSH 与 Bridge 标题、路径和来源元数据。项目摘要仍只直接显示 active、待处理、当前与置顶会话，旧会话通过原生 `Show N more sessions` 展开。详情继续从事件尾部读取最近 200 条并定位最新内容，向上滚动加载更早历史；各会话的事件页、cursor 和草稿保留在同一个 `SessionStore` 生命周期中。模型选择继续复用 DSH 原生 `ModelSelect`，目录严格来自 `session.modelCatalog()`，因此第三方 provider 模型不会被 Codex 的 ChatGPT 模型目录覆盖。

插件 typecheck、lint、build 通过，测试为 48 项通过、1 项跳过；产品 Market 253 项通过、9 项跳过，Desktop 245 项通过，runtime closure、品牌和 Windows package verifier 均通过。安装包 SHA256 为 `C4AA8A06311C8D301649FBA0F779A17862A356CEE1B6374150BCD77233EAD6A6`，安装后可执行文件 SHA256 为 `5A5CF7A0F8548E590DD2DEF4B01614B8DA83DCBFD30ADBF6EB4E9BF71C5B477A`。最终插件 Client SHA256 为 `2B04E971144EB5D9220D620F340BC95EFEA186C3F93032CC2F94E05B4BEB2037`，Host SHA256 为 `6DB998D5D2FBC5DB818062C76365F655A3A739C0C2C73058203634D55B87C525`，manifest SHA256 为 `B79E9DFD2E5D2725ABCFED6C1D02CDB94FE6A51749A9328F33A800B04915004A`，备份位于 `20260908-212243-658`。TokensCowork 已重启并监听 `127.0.0.1:43120`，启动日志未出现 Agent Control、shared runtime、模型操作或未知 Bridge operation 错误。

下一阶段把搜索从已加载元数据扩展到 DSH 原生内容搜索，并把重命名、归档等来源支持的操作映射到共享行菜单；conversation 侧优先复用 DSH 的 approval、user input 和错误交互卡片，继续减少 Bridge 专属 UI。

## Round 21 可见性修复：真实侧栏崩溃

用户在真实客户端中指出 Bridge sessions 从 Round 20 起完全不可见。此前验收把 mock preview 中的混合列表、安装哈希和“启动日志无错误”组合成了错误的可见性结论；这些证据没有覆盖真实 profile 的 client apply 顺序，也没有证明 renderer 中已经注册统一侧栏。

最初发现 Agent Control 的 client `apply()` 会读取 `sessions` 与 `workspaces` 服务，但导出的 Cordis `inject` 遗漏了这两个依赖。补齐依赖是正确的生命周期约束，却不是列表消失的最终根因；补齐并部署后，真实客户端仍然没有 Bridge 行。

通过用户提供的真实兼容模式页面读取浏览器控制台后，确认 `BridgeSidebar` 已经注册并当选，但 `UnifiedSessions` 将 DSH controller 的 `list.getSnapshot` 裸传给 `useSyncExternalStore`。真实 controller 的该方法依赖实例字段 `refreshSnapshot`，失去 `this` 后抛出 `TypeError`；DSH slot error boundary 按设计让崩溃 occupant abdicate，于是原生 WorkspaceBrowser 接管，看起来像 Bridge 从未注册。mock 的箭头函数不依赖 `this`，因此没有覆盖这个错误。

最终修复使用稳定闭包调用 `source.subscribe()` 和 `source.getSnapshot()`，保留 DSH observable 的 receiver，并把 UI 测试改为与真实 controller 相同的 `this.refreshSnapshot` 形式。插件检查为 49 项通过、1 项跳过。修复部署后的真实页面已直接显示 Bridge 会话、项目摘要和“展开其余会话”；点击 Bridge 行会选中该行并挂载 Bridge conversation。Client SHA256 为 `84471E6A727B2440DFFF20E73BFF1A242CD020DB4C55919F1087EC9F2505FE0F`，Host SHA256 为 `6DB998D5D2FBC5DB818062C76365F655A3A739C0C2C73058203634D55B87C525`，备份位于 `20260908-220152-593`。重启使旧兼容模式 token 失效，因此该浏览器页中的详情 RPC 最终返回 403；列表可见性、行点击和 conversation 挂载已经在真实 renderer 验证，详情数据加载需要用重启后生成的新兼容模式链接复验。

后续每轮“真实验收”必须读取页面 console，并包含用户 profile 中的实际 Bridge 行可见性与交互；mock preview、哈希和无错误日志只能作为辅助证据。
