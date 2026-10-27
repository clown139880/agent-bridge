# Windows Codex Desktop 会话控制

从 0.7.22 起，原生 Windows 默认开启 `CODEX_DESKTOP_IPC`。Bridge 先查询桌面会话的所有者；桌面持有的会话通过 `codex-ipc` 命名管道发送追加、steer、中断和审批/问题回答，不再用第二个 App Server 的 `thread/resume` 争抢 writer。快照与增量补丁转换为原有 Bridge 事件。非 Windows 和独立 CLI 会话保留 App Server 路径。

新建会话通过桌面的 App Tools 管道调用 `create_thread`。需要桌面已运行、当前工作区已加入桌面项目、该工作区有一个可用的桌面会话作为调用上下文；缺少上下文或项目时使用独立 App Server 创建。没有 prompt/附件的空会话也使用独立 App Server。项目记忆以首轮上下文提供，桌面接口不接受独立的 developerInstructions。所有实际发送仍检查 `BRIDGE_ALLOWED_ROOTS`。

## 图片和文件

- Control Center 支持最多 8 个附件、每个最多 15 MB：PNG/JPEG/WebP/GIF、PDF、文本/Markdown/CSV/JSON、ZIP、Office 文档和无 MIME 的普通文件。
- 已有会话的图片以原生 image 输入传递，追加和 steer 都保留图片。
- 其他文件经认证从控制面下载，按内容 SHA-256 保存到用户目录 `.cache/agent-bridge/attachments`，由模型工具读取。文件格式能否解析取决于模型可用工具；上传 ZIP 不自动解压或执行。
- 桌面新建接口只接受文本，因此首轮所有附件先保存为本地文件，提示模型使用文件/图片工具读取；后续图片使用原生输入。受限工具环境下，本地文件读取可能需要用户批准。
- 缓存不自动清理，以免破坏等待执行的轮次；确认相关会话不再需要附件后可手动清理。此功能不改动 DSH 插件的附件选择器，也不扩展其他 agent 的文件格式能力。

## 断线与兼容性

0.7.24 起，允许目录中的仓库所注册的 linked worktree 也可使用。Bridge 验证 `.git` 指针、主仓库的 `worktrees` 注册目录和反向 `gitdir` 指针；不会整体放行 `.codex/worktrees`。桌面会话切换到 worktree 后，以桌面快照中的实际路径校验和更新发现信息。

已由本进程识别为桌面所有的会话，桌面断线后保持归属，不自动切换 writer。快照版本不兼容或缺少快照时拒绝发送。补丁序号不连续会重新订阅完整快照。写入后断线/超时报告 `desktop_outcome_unknown`，禁止自动重发；先查看会话，确认结果后再决定下一步。桌面会话删除暂需在 Codex Desktop 中操作。

这是桌面的内部 IPC 协议，当前验证版本为 Windows Codex 26.1021.3705.0，快照版本 11。桌面升级后应验证兼容性；`CODEX_DESKTOP_IPC=false` 可关闭此路由，但旧 App Server 仍无法写入桌面持有的会话。

## 验证

`tests/desktop-ipc.test.ts` 覆盖分片帧、断线不重发、帧大小限制、补丁、图片/steer/中断、审批及问题回答、快照重同步和附件路径。配合 Codex/Control Center/API 回归测试。真实桌面验证包括同一会话识别左右色块图片、读取文本附件、新建首轮附件、继续同一会话；完整适配器在不可连接的 App Server 地址下仍成功新建和追加。
