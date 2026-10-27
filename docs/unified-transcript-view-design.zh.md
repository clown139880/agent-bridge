# 统一对话视图接口：设计与核对结论

日期：2026-10-27。状态：0.7.25 实施（服务端视图、Control Center、DSH 插件 0.3.0 面板），见文末“实施记录”。后续用户已确认：DSH 保留侧栏轻量目录，正文改用 Bridge 独立实时视图，不再复制全量历史到原生 session。

用户要求 claude@hal 设计，由 Codex 对照代码核对。设计会话：
`claude-1e4fc611-8cd1-4c3b-9bad-4c7f940304b7`。
基线为 `e9ceba3`（DSH 插件 0.2.13），含 `d267352` 的 Control Center 展示改动。
本文整合 Claude 两版方案与 Codex 的评审修订；存在差异时以本文约束为准。
这是设计文档，不代表接口、数据库迁移或客户端功能已发布。

## 决定与范围

采用服务端统一投影：共享纯投影模块生成轮次、段、消息和工具步骤，Control Plane 提供快照和 SSE 更新，客户端只处理渲染及本地适配。
原始事件接口保留。共享库仅用于实现与测试，不要求多个客户端分别升级算法才能得到一致结果。
服务端投影也需要带版本号；它不会自动让旧客户端获得新的接口兼容能力。

第一阶段包括：

- `packages/transcript` 的确定性投影规则、真实脱敏回放样例。
- 版本化视图快照、分页、整轮替换增量和删除标记。
- Control Center 接入，可见详情页持续订阅，不因 summary 为 idle 而关闭 SSE。
- 保留现有设备红点及页内新内容计数语义。

第一阶段不包括 DSH 切换、步骤级 patch、跨轮次父任务聚合、服务端已读、跨设备同步已读或思考正文采集。
DSH 在迁移完成前继续使用现有路径；后续独立发布轻量目录与 Bridge 对话视图，替代原生历史投影器。

## 已核对的现状

| 位置 | 事实与影响 |
|---|---|
| `packages/database/src/control.ts:appendSessionEvent` | 按 session/eventId 去重；全局 events.id 单调。新 assistant message.completed 增加 message_count，历史回填也增加。投影写入不得另增计数，不能取消现有递增。 |
| `reconcileReplayedEvent` | 可原地修改事件正文、终态和归属，保留行号和时间。目前只标 session 变化，不重发原始追加事件；新投影必须覆盖此路径。 |
| `sessionEvents` / `sessionEventsTail` | `e:<id>` 为事件分页位置；不是 SSE 续传游标。 |
| `streamPosition` / `streamAfter` | `c:<events>:<changes>` 是两张表的全局高水位。资源变化会压缩为当前状态，并非不可变的所有资源修订日志。 |
| `apps/control-plane/src/api/sse.ts` | 已有 Last-Event-ID、会话过滤、唤醒、keepalive 和背压断线机制，可复用。过滤不改变全局游标语义。 |
| `apps/control-center/src/state.ts` | 红点为 messageCount 减本设备 reads。无基线显示 0；详情页可见时更新已读，不要求滚到底。idle 会触发收尾并关闭流，需要改变。 |
| `apps/control-center/src/main.tsx` | 离底时的“↓N 条新内容”统计新增原始 eventId，和列表红点不同。 |
| `apps/control-center/src/transcript.ts` | 工具当前取最后到达事件，迟到 started 可覆盖 completed；相邻 turnId 分组可能被无 turnId 元数据切开。 |
| DSH `mapping.ts` / `import-target.ts` | 本地日志只能追加；ACK 去重；重启时原生运行时关闭未结束轮次；当前历史同步游标仅在内存。 |

已有复现：外部 Codex 的 summary 为 idle、同一 turnId 已出现 terminal 后，仍继续追加工具和消息。
因此 idle 不能充当完成证据，terminal 也不能作为永久冻结视图的保证。

## 投影规则

1. 所有 ID 以会话为作用域。工具合并键包含 turn、parent、类型和 canonical item，避免跨轮次复用 itemId 时相互覆盖。
2. 展示 ID 与归属分开：优先使用稳定锚事件 eventId；缺少 itemId 时不凭文本盲目合并。历史/实时别名需由明确规则识别。
3. 改归属、合并和拆分不能静默换身份：整轮替换覆盖成员变化，旧轮次提供 tombstone；折叠状态需要迁移时提供显式 alias，拆分是一对多映射。
4. 用户插话形成段，保留原始顺序。无 turnId 的内容可以形成未知段；元数据不会单独拆出内容轮次。
5. 无 turnId 元数据按明确规则归入相邻轮次 notes 或会话 notices。归属调整要同时使旧、新容器失效；notices 自身也有版本和更新协议。
6. 工具终态不能被迟到的 started 降级；同阶段取最新可信修订。跨轮次父任务第一版标为未关联，不做聚合。
7. final 是可修订的展示角色；迟到工具可能把原 final 移回过程区。整轮替换必须同时清除旧 final 指针。
8. closure 区分 terminal、superseded、none；被下一轮取代不等于成功。记录终态之后仍有活动的证据。
9. 不引入按隐式时钟自动计算的 settled/冻结状态。投影结果由输入及版本决定；客户端“多久无活动”提示不得停止订阅或决定 DSH 落盘。
10. session 的 live/activeTurnId 属于资源头，和事件投影分开传输、组合。核查相关写入是否均发布 session.updated，不能漏掉状态更新。

排序第一版沿用存储行号，不在这次改造中悄悄改为时间排序。回填排序是单独的产品决定。
思考阶段可显示，但现有事件没有统一保存可展示思考正文，不从阶段信息编造正文。

## 接口与持久状态（拟议）

- `GET /api/v1/sessions/:id/view`：返回 projectionVersion、viewRevision、orderingEpoch、session、turns、notices、rawHigh、streamCursor、分页信息。
- `/api/v1/stream?sessionId=...&view=1`：复用 SSE，客户端提交独立的视图版本、已应用 viewRevision、rawAfter 及现有 c: 游标。
- 视图 delta：`fromRevision / toRevision / turns / tombstones / notices / invalidated / raw`。
- `turns` 是完整轮次窗口替换，不是步骤 patch；`tombstones` 带删除修订号。
- 超大轮次提供步骤窗口接口；完整原始事件提供受鉴权的 eventId 直读接口，不能假定现有 /events 已支持此能力。

具体查询参数名称、错误码和 SQL migration 在实施时按现有路由约定定稿。
数据库维护会话 view_revision、轮次 dirty/tombstone 修订及必要的索引；无需第一版持久化整份派生视图。
写原始事件、reconcile 和 dirty 标记必须同事务提交。元数据、前驱 superseded、旧/新归属等依赖一起标脏。
缓存至少按会话、投影版本、轮次修订隔离；并有容量限制。未知段的边界变化必须正确标记邻接段，不能仅标当前 turnId。

### 快照、增量与恢复

- 同一读事务取得视图、资源头、viewRevision、rawHigh 和 streamCursor。快照不能先读数据、稍后才取游标。
- c: 只证明普通流位置，不证明视图已经应用。即使 c: 已前进，重连仍按旧 viewRevision 补视图。
- 一帧完整应用后，原子保存视图缓存、viewRevision、rawHigh 和待物化集合；缓存失败时不能持久化一个领先于数据的检查点。
- 版本不匹配、修订号超前、低于保留 floor 或无法有界补齐时返回明确 reset，重新取快照。不修改旧客户端 /events 和 /stream 的行为。
- 第一版整轮 replace；invalidate 只表示内容需重新取得，不等于已得到内容。客户端保留可恢复的 pending 集合，刷新完成前明确标记旧缓存。
- 完整物化后，快照加增量必须等于对应修订的完整投影。包含 invalidated 的中间状态不宣称已满足此等价关系。
- tombstone 保留到声明的 replay floor，裁剪后旧修订强制 reset；不能丢 tombstone 却继续声称支持该区间回放。

### 计数区间与已读

列表红点继续使用既有 messageCount 和设备 reads；不增加服务端已读 API。
页内新内容仍以原始事件身份计数，视图重算和原地修订不算新原始事件。

增量可提供 `raw:{after,through,count}` 或有界原始 eventId 批次，但必须满足：

- through 不超过本地 rawHigh 的完全重复区间忽略。
- 只直接接受 after 等于本地 rawHigh 的连续区间。
- 部分重叠或间断不能直接丢弃后推进高水位；从最后已应用位置请求精确区间，或使用事件身份精确去重。
- 旧页加载不增加新内容计数；用已有事件身份避免跨分页重复。
- 计数应用与相应 rawHigh 原子提交；断线重发不能重复累计。

### 分页与大小

分页游标绑定 session、projectionVersion、orderingEpoch、排序锚点。
结构变化（轮次拆分/合并、归属或排序锚点改变）使 epoch 失效，客户端明确重取受影响窗口，不默默跳页。
旧页响应按轮次 rev 与 tombstone 合并，不能复活已经删除的轮次，也不能推进全局 viewRevision/rawHigh 而跳过中间增量。
旧请求必须校验当前页面 generation 和 epoch，过期响应不得合并。
orderingEpoch 持久化；正常向末尾追加新轮次不改变它，避免活跃会话一直翻页失败。
客户端的去重集合与 tombstone 必须有容量上限；达到上限时使旧请求代际失效并重新建立可靠基线，不得静默丢弃待保护的删除标记或输出不准确的条数。

初始字节预算建议：快照默认 1MB、最大 2MB，增量帧 512KB，单轮窗口 256KB，工具预览 2KB（均 UTF-8 字节）。
预算也必须覆盖超长正文、schema 包装与单条异常事件；超限用内容引用和分页，不能依靠截断丢失正文。
超过整轮帧预算时 invalidate 并分窗口加载；reset 不得陷入“重新拉同一份超限快照”的循环。

## DSH：轻量侧栏目录与独立 Bridge 视图（用户已确认）

Bridge 服务端是对话正文的权威来源。DSH 插件不再将正文、工具结果和轮次生命周期复制到原生 session 日志。
侧栏仍然保留，和是否保存全量历史无关。

### 侧栏目录

- 仅同步远端身份、标题、workspace/group/worker 引用、排序时间、运行及待处理状态、messageCount 等列表字段。
- 身份至少包含 Bridge origin 与远端 sessionId，避免不同服务端同名会话冲突；原生会话和 Bridge 目录项使用不同命名空间。
- 置顶、归档、重命名等操作逐项明确服务端或本设备归属，沿用既有语义；不能把“移除目录项”自动变成删除远端历史。
- 列表分页与轻量变化订阅不加载正文，不创建/恢复每个远端会话的原生 agent，不为每个侧栏条目开正文 SSE。
- 点击目录项导航到插件 Bridge 详情路由；保留选中态、前进后退、刷新恢复、工作区分组和设备红点。

### 正文及交互

- 打开时读取统一视图快照，可见时持续 SSE；切换/隐藏时取消对应订阅，回来按版本与游标恢复。
- 网页与插件共享投影协议、客户端数据状态机和可复用的对话展示组件；DSH 主题、布局、导航及 Host RPC 是薄适配层。
- 发送、停止、模型/推理等级、审批、用户问题、附件和新建对话必须通过 Bridge 对应接口完整接入，不能只迁移只读正文。
- 本地待发送消息采用 actionId 等明确关联信息收敛到服务端结果；失败和未知提交状态必须可恢复，避免重复发送。
- 原生 DSH 对话继续使用其原生链路；新 Bridge 视图不再受原生 turn/end、system head 或 V3/V4 正文结构限制。

### 本地存储

- 可丢弃缓存：轻量目录、有限的最近对话窗口、projectionVersion/viewRevision/rawHigh 等恢复位置；失效或删除后可从服务端重建。
- 界面偏好：折叠状态、滚动位置、设备已读基线。草稿和未确定提交的 action 状态单独保存，不能与可丢弃缓存一起清除。
- 缓存限定数量、字节和生命周期，按服务端/认证上下文隔离；登出、切换服务端、权限变化时隔离或清除。恢复位置与缓存内容原子保存。
- 离线显示已缓存范围并明确标记，不暗示本地有全部历史；写操作须说明连接状态。

### 扩展接口与迁移

已在 `src/client/index.tsx` 核实插件能注册 `main`、`sidebar.panellist`，目前 Agent 控制台已使用独立面板。
现有 `WorkspaceController.openLinkedSession` 仍通过 import 创建/打开原生 session；`session-menu.tsx` 只包装原生树，不证明任意远端目录项可直接加入原生树。
因此须先验证侧栏扩展及路由：优先用目录扩展直接显示远端条目；若宿主必须有导航占位，只存身份及最小元数据，点击不得启动原生历史恢复/执行链路。
不把 DOM 拦截或复制全量 session 当作默认解决方案。宿主接口不足时先补明确扩展点。

迁移先做单个 Bridge 会话的侧栏到独立视图闭环，再覆盖所有交互与缓存。
通过验证后停止对应来源的旧 import/syncHistory 全量写入，避免两条链路同时运行和重复条目。
已有 V3/V4 历史原件保留；旧 nativeId 可映射至新远端路由，不批量删除或覆盖旧数据。
清理本地旧副本另行处理。新旧客户端混写仍不作兼容保证；旧客户端继续写旧文件时，独立视图不会读取那些文件作为正文来源。

此前关于原生日志 append/flush/checkpoint/deferred 的设计，仅作为过渡链路的风险约束，不再作为最终架构目标。

## 发布与验收

先完成投影金标、后端快照/增量协议和 CC 切换，再接入 DSH 轻量目录及独立视图；可提前验证 DSH 扩展接口以发现宿主限制。
可以先用新模块做对照验证，但不把临时客户端投影作为长期双份规则。
新共享包及数据库改动需要根版本升级和全量部署；不能承诺 `--frontend-only`，该脚本明确排除 packages 变更。
DSH 后续改动仅升插件版本，按 Windows 插件发布流程安装与校验，不在 HAL 安装插件。
认证沿用现有 read 权限与单租户边界，不混入新的 principal 拒绝规则或用户体系。

必须覆盖的验收：

1. completed 先到、started 后到；跨轮重复 itemId；历史/实时别名；用户插话与无 turn 元数据。
2. reconcile 改归属/终态/正文，迟到工具改变 final，轮次拆分合并与删除。
3. 快照期间并发写入；c: 已推进但视图未应用就断线；raw 区间重叠/间断。
4. 页请求在 epoch 改变后返回；旧页不得复活 tombstone 或吞掉增量；超大单轮不丢内容。
5. idle 之后同 turnId 继续追加，可见详情页持续订阅并及时显示；隐藏恢复正确补齐。
6. 红点无基线为 0、设备互不影响、可见即已读；投影重算不加计数，原始回填沿用原规则。
7. 视图版本升级、保留 floor、缓存失效、背压重连、reset 有界且可收敛。
8. DSH 验证侧栏分页及点击路由、工作区分组、刷新恢复、未读及操作语义；侧栏同步不加载完整正文或启动原生 agent。
9. DSH 独立视图完整支持发送/停止/模型/审批/提问/附件；切换时没有串流或重复发送，缓存失效可重建，草稿和未知提交不丢失。
10. 新视图运行期间不再向对应 Bridge 原生 session 追加正文；旧历史保留、旧链接可达、重复目录项可控；普通 DSH 原生对话不受影响。

评审结论：架构方向通过；上述恢复、分页、计数和 DSH 边界是实施约束，不得省略后再声称两端完全统一。

## 实施记录（0.7.25 / DSH 插件 0.3.0）

实施时把增量协议收敛为“SSE 只唤醒、内容由客户端拉取”，上文约束均满足，具体取舍：

- 视图键在写入时确定并存于 `events.view_key`（`t:` 轮次、`o:` 无 turnId 内容段、`n:` 无 turnId 提示；
  其余无 turnId 元数据不进视图）。元数据不切断内容段，也不依附前后轮次，因此没有 notes 依赖。
- 每次写入或原地修订推进 `sessions.view_revision`，并在 `view_dirty` 记下受影响条目（含被新轮次取代的上一轮）。
  修订改变条目归属时推进 `ordering_epoch`。投影在读取时计算，不持久化派生视图。
- 不新增 SSE 帧：`session.updated` 携带 `viewRevision`，客户端据此请求 `view/changes`；断线重连后无条件拉一次。
  changes 以完整修订为界分批，`hasMore=false` 即与该修订的完整投影一致；不存在 invalidated 中间态，
  超大条目以窗口加 `itemsBefore` 与按 eventId 直读覆盖。
- `raw` 计数由服务端按客户端提交的 `rawAfter` 精确计算，一问一答，不需要区间对齐。
- Control Center 可见详情页始终保持订阅，不再因 idle 关流；红点、`markRead`、“↓N”语义不变。
- DSH 插件在“Agent 控制台”面板内直接渲染 Bridge 视图（不创建原生 session、不读原生历史），
  发送、中断、审批与提问走 Bridge 接口。原生导入链路暂时保留：Desktop 宿主没有可供插件切换主面板
  或向原生侧栏添加非原生条目的接口，侧栏点击直达插件视图需在 Windows Desktop 上验证扩展点后再切换，
  届时停止对应 import/syncHistory。
