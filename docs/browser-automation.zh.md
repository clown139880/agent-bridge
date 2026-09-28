# 共享 Agent 浏览器（Windows + WSL）

同一台 PC 上的 Codex / Claude（无论跑在 Windows 还是 WSL）共用一个 Windows 桌面上的有头 Chrome。用户可以在同一窗口里操作；浏览数据在独立 profile `C:\Tools\agent-bridge\browser\profile`，与用户自己的浏览器隔离。HAL 以后复用同一个 skill，只是连接 HAL 本机浏览器，本文不覆盖。

```
Windows:  Chrome --remote-debugging-port=9222 --user-data-dir=C:\Tools\agent-bridge\browser\profile
            ▲ 127.0.0.1:9222（只绑定回环）
            ├── Windows 上的 agent-browser → 127.0.0.1:9222
            └── node.exe（WSL interop 每连接启动一个，stdio 转发）
                  ▲
WSL:      cdp-relay.mjs 监听 127.0.0.1:9222 ← WSL 里的 agent-browser
```

WSL 保持 NAT 网络。中转不经过网络：`deploy/wsl-browser/cdp-relay.mjs` 为每个连接启动 Windows `node.exe`，由它连接 Windows 回环并通过 stdio 转发。因为 Host 头仍是 `127.0.0.1`，Chrome 返回的 `webSocketDebuggerUrl` 在两侧完全相同，工具配置可以共用。不需要管理员权限、portproxy 或防火墙规则，也不受 WSL NAT 地址变化影响。

## 组成

| 部件 | 位置 |
|---|---|
| Chrome 启动器（已在监听则直接退出） | `deploy/windows-native/browser/start-agent-browser.ps1` |
| 登录时启动的计划任务 `Agent Bridge Browser` | `deploy/windows-native/browser/install-browser-task.ps1` |
| WSL 中转 | `deploy/wsl-browser/cdp-relay.mjs` + `deploy/systemd/agent-bridge-cdp-relay.service`（user unit） |
| Agent 使用说明 | `shared-skills/browser/`（依赖 `browser-cdp`） |
| 操作工具 | [agent-browser](https://github.com/vercel-labs/agent-browser)，WSL 与 Windows 同版本 |
| Bridge 上报 | `BRIDGE_BROWSER_CDP_CONFIGURED=true` → `sharedSkills.browser.dependencies["browser-cdp"]="configured"` |

用户关闭浏览器后不会自动重开；Agent 发现端点不通时运行 `schtasks.exe /Run /TN "Agent Bridge Browser"`（WSL 里也可以直接调用）。

## 安装

Bridge release（`current`）只包含 `apps`、`node_modules`、`package.json`，不含 `deploy/` 和 `shared-skills/`，所以启动脚本、中转和 skill 都不从 release 运行。

Windows（普通用户权限）：

```powershell
# 启动脚本放在 profile 旁边的固定位置，内容取自已推送的 commit（例如 git show <sha>:deploy/windows-native/browser/start-agent-browser.ps1）
#   C:\Tools\agent-bridge\browser\start-agent-browser.ps1
#   C:\Tools\agent-bridge\browser\install-browser-task.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Tools\agent-bridge\browser\install-browser-task.ps1
schtasks /Run /TN "Agent Bridge Browser"
npm install -g agent-browser@0.38.1
# %USERPROFILE%\.agent-browser\config.json 写 {"cdp":"9222","pinTab":true}（仅作兜底；skill 每条命令都显式传 --cdp 9222 --pin-tab）
```

skill 按现有共享 skill 的做法安装为副本：把 `shared-skills/browser` 和 `shared-skills/manifest.json` 复制到 `%USERPROFILE%\.codex\skills\shared-skills\`（即 Bridge 的 `BRIDGE_SHARED_SKILLS_MANIFEST` 所在目录），把 `shared-skills/browser` 复制到 `%USERPROFILE%\.claude\skills\browser`。复制前先与 manifest 比对，发现本地修改就停下报告，不静默覆盖。

WSL：

```bash
# user unit 的 WorkingDirectory 指向含 node_modules 的仓库 checkout（pino 从这里解析）；
# 本机的 unit 副本放在 data/bridge-update/ 下，与 agent-bridge-wsl.service 相同
systemctl --user link <checkout>/data/bridge-update/agent-bridge-cdp-relay.service
systemctl --user daemon-reload && systemctl --user enable --now agent-bridge-cdp-relay.service
npm install -g --prefix ~/.local agent-browser@0.38.1   # 系统 npm prefix 是 /usr；把 ~/.local/bin 加进 .env.bridge 的 PATH
mkdir -p ~/.agent-browser && echo '{"cdp":"9222","pinTab":true}' > ~/.agent-browser/config.json
ln -s <checkout>/shared-skills/browser ~/.claude/skills/browser
ln -s <checkout>/shared-skills/browser ~/.codex/skills/browser
```

两侧 Bridge 环境文件加 `BRIDGE_BROWSER_CDP_CONFIGURED=true`，Bridge 重启后在注册信息里上报。

WSL Codex 的 `~/.codex/config.toml`：

```toml
[sandbox_workspace_write]
network_access = true
writable_roots = ["/run/user/1000/agent-browser"]
```

## 选型实测（2026-09-28，Chrome 153，agent-browser 0.38.1）

- 中转：WSL 经中转的 `/json/version` 返回 `ws://127.0.0.1:9222/...`；50 次 CDP 往返约 42ms（小于 1ms/次，另有每连接约 0.1s 的 node.exe 启动开销），两个客户端并发正常。
- agent-browser：WSL 两个会话（`--session` + `--pin-tab`）并发打开不同页面，各自绑定独立标签页、互不串扰；Windows 原生同样可用。`close` 只断开会话，共享 Chrome 和标签页保留，因此 skill 要求结束时 `tab close` 关闭自己的标签页。
- `~/.agent-browser/config.json` 设 `cdp`/`pinTab` 后，每条命令都会重新附着共享浏览器；在沙箱中 daemon 随命令退出后，下一条命令仍能回到同一个绑定标签页。但 Windows Codex 沙箱里读不到这个配置（未带 `--cdp` 的命令报 `Auto-launch failed`），所以 skill 要求每条命令显式传 `--cdp 9222 --pin-tab`。
- Codex 沙箱：
  - WSL（Linux 沙箱，默认 workspace-write 无网络）：连不上 `127.0.0.1:9222`，且 agent-browser 的 socket 目录 `/run/user/<uid>/agent-browser` 只读。需要 `sandbox_workspace_write.network_access=true` 且把该目录加入 `sandbox_workspace_write.writable_roots`，或者逐条命令申请提权。
  - Windows（`[windows] sandbox = "elevated"`）：默认 workspace-write 下即可访问回环并运行 agent-browser。
- browser-harness 未深入实测：它需要 Python 3.12 + uv 工具链，且官方说明一个 daemon 只有一个“当前标签页”，多 Agent 并发需自行串行；agent-browser 的按会话绑定标签页已满足需求。

## 安全

- DevTools 端口没有认证，本机任何进程都能控制这个浏览器。只绑定回环，不做 portproxy，不在该 profile 里保存个人账号。
- 付款、发消息、修改账号设置、输入凭据等操作由 skill 要求 Agent 先征得用户同意。
