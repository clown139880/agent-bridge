# 交接：统一对话视图与 DSH 虚拟会话（2026-10-30）

原会话：claude@hal `claude-1e4fc611-8cd1-4c3b-9bad-4c7f940304b7`。接手：claude@dev-wsl。
设计约束见 `docs/unified-transcript-view-design.zh.md`，DSH 虚拟会话机制见
`integrations/dsh-agent-control/docs/remote-sessions.md`。部署规则以 `AGENTS.md` 为准。

## 当前状态

- 服务端与 Control Center：根版本 0.7.29，已部署 HAL。
  - 服务端统一投影：`packages/transcript`、`packages/database/src/view.ts`，接口 `/sessions/:id/view`、`/view/changes`、
    `/view/entries/:key`、`/events/:eventId`；`session.updated` 携带 `viewRevision` 作为唯一唤醒。
  - Control Center 详情页用视图渲染，可见即保持订阅（不因 idle 断流）。0.7.27～0.7.29 修了：旧 IndexedDB 缓存崩溃、
    清单上报擦掉 `active_turn_id`、流里 `capabilities: []` 覆盖真实能力导致发送按钮变灰。
- DSH 插件：main 上 0.7.0（`54d8286`），已装到 Windows（构建产物与链接插件 lib 哈希一致）。
  - Bridge 会话以虚拟 ID `bridge-remote-<sha256>` 进入原生侧栏，客户端包装 `remote.session`，插件宿主在内存用
    `readHistory + projectNativeEvents` 生成 DSH 事件，不读写本地会话文件。
  - 已支持：只读历史与实时追加、发送文字和图片（`virtual_prompt` → `submit_turn`，回显按 `source.rpcId` 认领）、
    中断、模型选择（记到下一次发送）、审批和提问（原生卡片，0.7.0）。
  - 性能修复：目录增量（1.43 MB/5s → 375 B）、只重发变化的会话、模型目录包装保持最外层
    （绕开 `@tokens/dsh-model-manager` 0.2.28 在两个 Bridge 会话间的微任务死循环）。
    实测 8 次来回切换 215～297 ms，无卡死。

## 待办（按优先级）

1. ~~审批/提问改用原生 UI~~（插件 0.7.0 已完成，`54d8286`）：会话 waiting 时宿主临时 enter 一个代表 Bridge 的替身 agent，
   经 `approval.request` / `userQuestions.ask` 走原生卡片，答完或会话离开 waiting 即撤下；自绘卡片和导入器里的旧转发已删。
   机制见 `remote-sessions.md`「Approvals and questions (0.7.0)」。已在 TokensCowork 实测原生提问卡和三选项审批卡；
   “在 Control Center 处理后卡片撤下”尚未实测（只有单测）。
2. **停掉旧导入同步（原计划第 3 步）。** `import-target.ts` 的 `refreshAll/materialize/syncHistory` 仍在后台把
   Bridge 会话复制成原生会话（侧栏已隐藏这些副本）。虚拟目录目前取自 `importTarget.catalog()`，需先把目录与导入解耦，
   再停导入；旧原生副本保留不删。
3. 修 `@tokens/dsh-model-manager`（TokensCowork 自带）：`client.js` 约 3322 行激活完成后用旧 sessionId 回查
   `directoryFor`，应先确认仍是当前会话并改用未包装的 resolver。属另一个仓库，需用户同意。
4. 已知限制：运行状态跟随目录（≤5 秒延迟）；DSH 的“文件”附件（receiptId）未支持；
   原地修订后需切换重开会话。

## 操作须知

- 插件只从 dev-wsl 仓库 `/home/clown/Workspace/uctw/agent-bridge` 安装：main 上 `git pull --ff-only` 后
  `pnpm --filter dsh-agent-control-plugin build`，`.env.local` 的 `DSH_PLUGIN_MIRROR` 会同步到
  `C:\Users\clown\.dsh\linked\dsh-agent-control-plugin`；再重启 TokensCowork。不要用 `update-dsh-client.ps1`。
- Windows 仓库 `C:\Users\clown\Workspace\agent-bridge` 是 Windows Bridge 自更新源码，必须停在 main：切到分支会让
  更新 ff 失败并卡在 draining、拒绝新任务。改代码请用独立 worktree 或在 HAL/WSL 进行。
- dev-wsl Bridge 曾停在 0.7.28：modeldeck 会话 `claude-09990def…` 等待审批，Bridge 要等空闲才升级。
- 性能问题先测量再改：以 `--remote-debugging-port=9333` 启动 TokensCowork，用 CDP 点击侧栏、采 CPU profile；
  之前的脚本在 Windows `%TEMP%\dshprof`。结束后不带调试端口正常重启。
- 插件测试：`integrations/dsh-agent-control` 下 `npx tsc -p tsconfig.json --noEmit && npx vitest run`
  （pnpm 版本校验会挡住 `pnpm check` 时直接用 npx）。只改插件只升插件版本，不部署 HAL。
