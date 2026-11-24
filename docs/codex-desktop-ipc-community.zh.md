# Codex Desktop 26.1117 移除 follower IPC：现状与同类项目

调研日期：2026-11-24。本页只记录公开信息，便于跟踪上游进展和借鉴同类项目的做法。

## 发生了什么

Codex Desktop 26.1117（现运行在 ChatGPT 桌面应用内，Windows 主进程为 `ChatGPT.exe`）不再启动 IPC router：Windows 的 `\\.\pipe\codex-ipc` 与 macOS/Linux 的 `<CODEX_HOME>/ipc/ipc.sock` 都无人监听，程序包里已找不到 `thread-owner-discovery`、`thread-follower-*`、`thread-stream-state-changed`。最后确认可用的版本是 26.1111。

Desktop 的 app-server 改为私有 stdio，不监听任何端口。Bridge 找不到桌面所有者时回退到自己的 App Server `thread/resume`，桌面打开过的会话因此报 `thread-store conflict: thread … already has an active writer`。写锁是 `<CODEX_HOME>/thread-writer-locks/<thread>.lock` 上的排他锁；Windows 上桌面打开过的会话要从托盘彻底退出才释放（openai/codex#37450）。Bridge 新建的会话不受影响。

上游没有维护者回复，也没有替代接口：

- [openai/codex#62712](https://github.com/openai/codex/issues/62712)：Windows 26.1117 上 `codex-ipc` 消失（bug，open）。
- [openai/codex#62919](https://github.com/openai/codex/issues/62919)：请求给伴随客户端的受支持本地接口（订阅状态、按 request id 审批、中断、`turn/start`/`turn/steer`），建议可选的每用户私有 pipe/socket。最值得跟踪。
- [openai/codex#61773](https://github.com/openai/codex/issues/61773)、[#61734](https://github.com/openai/codex/issues/61734)：向已有桌面会话投递消息的正式 API。
- [openai/codex#41014](https://github.com/openai/codex/issues/41014)：设了 `CODEX_APP_SERVER_USE_LOCAL_DAEMON` 后 Desktop 仍启动私有 stdio app-server。

## 社区的几条路

| 路线 | 能做什么 | 代表项目 | 局限 |
|---|---|---|---|
| 把 Desktop 重定向到共享 app-server | 完整控制，单一 writer | HyperNeo（macOS）、cola（Windows，26.1029 验证） | 未文档化，需要由启动器带环境变量拉起 Desktop |
| `codex queue` 排队后唤醒 | 向空闲会话投递消息 | firejune/AgentBridge、Synloq、bailong 桌宠 | 不能 steer、审批、中断，没有状态订阅；接受不等于执行 |
| lifecycle hooks / 读 rollout 日志 | 观察进度，提醒审批 | codex-pacer | 不能发送 |
| 桌面会话只读降级 | 保留历史与状态 | persona、codex-mobile-bridge | 不能发送 |
| 只管理自己持有的会话 | 完整控制 | cc-connect、OpenClaw、super-one、各 Telegram 桥 | 与桌面共享 `CODEX_HOME` 时撞写锁；cc-connect 用隔离 `CODEX_HOME` 规避，代价是侧栏互不可见 |
| CDP 驱动 Desktop 渲染进程 | 在 UI 里输入、读状态 | toolittlecakes/codex-telegram-bridge | 依赖私有 DOM，UI 改版即坏 |

### 共享 app-server 重定向

Desktop 的连接逻辑是 `CODEX_APP_SERVER_FORCE_CLI !== "1"` 时取 `process.env.CODEX_APP_SERVER_WS_URL ?? hostConfig.websocket_url`。在 Windows 26.1117.4957.0 的 `app.asar` 中已核实这段代码仍在，且没有排除 win32。`CODEX_APP_SERVER_USE_LOCAL_DAEMON` 分支则明确排除 win32。

- HyperNeo（[#11359](https://github.com/lsm/HyperNeo/pull/11359)、[#11367](https://github.com/lsm/HyperNeo/pull/11367)、设计 [#11430](https://github.com/lsm/HyperNeo/pull/11430)，仅 macOS）：`codex app-server daemon start`，本地 TCP 转发 `127.0.0.1:47912/rpc?token=…` 到 `~/.codex/app-server-control/app-server-control.sock`，`launchctl setenv CODEX_APP_SERVER_WS_URL` 后重启 Desktop。客户端用 `ws+unix://<sock>:/` 连接。IPC 返回 ENOENT/ECONNREFUSED 时改走共享 server；新会话也建在共享 server 上，Desktop 才会收到 `thread/started` 并显示在侧栏。
- [SXongin/cola#986](https://github.com/SXongin/cola/issues/986)（Windows，ChatGPT 26.1029 + CLI 0.166 验证，未在 26.1117 复验）：daemon 加 `127.0.0.1:4500` 到 `%CODEX_HOME%\app-server-control\app-server-control.sock` 的转发，从 `Get-AppxPackage OpenAI.Codex` 的 `app` 目录带 `CODEX_APP_SERVER_WS_URL` 启动 `ChatGPT.exe`（开始菜单启动不继承该变量）。之后 Desktop 不再有内置 app-server 子进程，第二个客户端完成了真实 turn。Desktop 正在运行 turn 时，另一个进程 `thread/resume` 仍报 active writer，只有同一 server 内的多连接能共享。
- 已知 Windows 坑：socket 路径受 `sun_path` 长度限制，需要非提权令牌，WSL DrvFS home 会被拒（openai/codex#24090、#50608）。

## 项目清单

已核实指读到了项目页面或源码；未注明的条目来自搜索摘要。

| 项目 | 做什么 | 原接入方式 | 对 26.1117 的应对 | 进度 |
|---|---|---|---|---|
| [lsm/HyperNeo](https://github.com/lsm/HyperNeo) | 本地 daemon + 浏览器 UI 驱动多种 agent | `ipc.sock` follower | 回退到重定向后的共享 app-server（已核实源码） | 已合入 dev，仅 macOS |
| [nwverse/persona](https://github.com/nwverse/persona) | 自托管 SuperAgent hub（Go） | desktop bus | 桌面会话只读（[#13205](https://github.com/nwverse/persona/pull/13205)）；之后允许接管空闲且无主的会话 | 已合入，macOS |
| [firejune/AgentBridge](https://github.com/firejune/AgentBridge) | 同机 Claude/Codex/Antigravity 会话互发消息 | IPC 注入 | 改走 `codex queue`（`thread/queue/add`）加 queue wake（[#156](https://github.com/firejune/AgentBridge/issues/156)）；归档改为会话自行归档 | 已关闭，近几日很活跃，macOS/Unix |
| [try2love/codex-mobile-bridge](https://github.com/try2love/codex-mobile-bridge) | 手机经网关读写 PC 的 Codex Desktop 会话 | IPC | Windows 26.1117 上桌面会话只读，返回 409 `desktop_unavailable`（[#254](https://github.com/try2love/codex-mobile-bridge/issues/254)）；临时办法是降级到 26.1111 | open |
| [anywhere-labs/Agents-Anywhere](https://github.com/anywhere-labs/Agents-Anywhere) | 跨设备 agent 工作台，约 3.7k star | IPC owner/follower，含 Windows 管道 | 未见针对性修复，似在转 ACP 路线（推断） | 很活跃 |
| [Emanuele-web04/remodex](https://github.com/Emanuele-web04/remodex) | iPhone + 本机 bridge，约 3.4k star | 自起 app-server，加 IPC live sync，无 router 时自起兼容 router | 未见回应，实际影响未验证 | 活跃 |
| [RyanZhangNTU/codex-pacer](https://github.com/RyanZhangNTU/codex-pacer) | 任务进度与额度伴随显示 | IPC | 改用 Codex hooks，移除 Remote Control 功能（[#275](https://github.com/RyanZhangNTU/codex-pacer/issues/275)） | 当天修复，只读 |
| [OBenner/synloq](https://github.com/OBenner/synloq) | 多角色协作 relay，每个角色一个 Desktop 会话 | `codex queue` nudger | 不受影响；作者提了 #61773 | alpha |
| [Joseph-Blue/bailong-desktop-pet-mac-swift](https://github.com/Joseph-Blue/bailong-desktop-pet-mac-swift/issues/2) | macOS 桌宠，回复和审批 | IPC | 临时用 CLI 排队；维护者称找到新入口并在修 | open |
| [LeonKohli/claude-uds-bridge](https://github.com/LeonKohli/claude-uds-bridge) | Codex 与 Claude Code 互发消息 | 共享 daemon 为主，IPC 兜底 | 0.2.2 只做诊断：报告无 receiver 的原因，不发送（[#7](https://github.com/LeonKohli/claude-uds-bridge/pull/7)） | 已发布，macOS/Linux |
| [KongXiangning/TermLink](https://github.com/KongXiangning/TermLink) | 移动端优先的 AI 终端工作区 | pipe follower | 在 #62712 确认复现，无修复 | 个人项目 |
| SUDO（ggl003614-tech） | USB 硬件控制器：听写、批准、中断 | IPC follower | 提了 #62919，等官方接口 | 硬件原型，无公开仓库 |
| [Elgato ChatGPT & Codex 插件](https://marketplace.elgato.com/product/chatgpt-codex-fb6a7052-2b1a-4500-ba2a-13996edf0b47) | Stream Deck 控制 ChatGPT/Codex | `codex-ipc` | 认不出 App（[openai/codex#63132](https://github.com/openai/codex/issues/63132)），未见修复 | 官方插件 |
| [chenhg5/cc-connect](https://github.com/chenhg5/cc-connect) | 本地 agent 接入飞书、钉钉、Telegram 等，约 16.5k star | `exec resume` / app-server | 与 IPC 无关；写锁冲突（[#1909](https://github.com/chenhg5/cc-connect/issues/1909)）用隔离 `CODEX_HOME` 规避 | 很活跃 |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | agent 网关 | 自带 stdio app-server | 不碰 Desktop；修复了自身第二个 app-server 的写锁冲突 | 已修复 |
| [WHQ25/super-one](https://github.com/WHQ25/super-one) | 多 harness 桌面应用 | 自起 app-server | 孤儿 app-server 占写锁（[#77](https://github.com/WHQ25/super-one/issues/77)） | open |
| [toolittlecakes/codex-telegram-bridge](https://github.com/toolittlecakes/codex-telegram-bridge) | Telegram 驱动 Codex.app | CDP 操作渲染进程 DOM | 不依赖 IPC | 单用户 |

还有一批 Telegram 桥（codex-tg-sync、dispatch-codex、telegram-codex-app-bridge、threadBridge、codex-questions-bridge 等）只管理 app-server 持有的会话，不涉及 Desktop 会话。OpenAI 官方的 Remote Control 走自家 relay，没有给第三方的接口，且同样受写锁约束。

## 对 Agent Bridge 的意义

- 目前没有任何项目在 26.1117 上恢复对“桌面已打开会话”的完整控制。
- 最接近完整的是共享 app-server 重定向：Bridge 本身已运行 `codex app-server --listen`，如果 Desktop 也连到同一个 server，就只有一个 writer。这需要在 Windows 26.1117 上实测，并且要接受“由我们带环境变量启动 Desktop”和接口未文档化的风险。
- 退而求其次：冲突时明确报错（会话被 Codex App 占用），或用 `codex queue` 向空闲的桌面会话投递消息。
