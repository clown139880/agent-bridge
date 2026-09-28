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

Windows（普通用户权限，从 Bridge 的 `current` release 运行，计划任务随 release 更新）：

```powershell
& "<InstallRoot>\current\deploy\windows-native\browser\install-browser-task.ps1"
schtasks /Run /TN "Agent Bridge Browser"
npm install -g agent-browser@0.38.1
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agent-browser" | Out-Null
'{"cdp":"9222","pinTab":true}' | Set-Content "$env:USERPROFILE\.agent-browser\config.json"
# skill：用 junction（无需管理员）指向 release 里的 shared-skills/browser
cmd /c mklink /J "$env:USERPROFILE\.claude\skills\browser" "<InstallRoot>\current\shared-skills\browser"
cmd /c mklink /J "$env:USERPROFILE\.codex\skills\browser" "<InstallRoot>\current\shared-skills\browser"
```

WSL：

```bash
systemctl --user link ~/.local/share/agent-bridge/current/deploy/systemd/agent-bridge-cdp-relay.service
systemctl --user daemon-reload && systemctl --user enable --now agent-bridge-cdp-relay.service
npm install -g agent-browser@0.38.1        # 或装到用户 prefix
mkdir -p ~/.agent-browser && echo '{"cdp":"9222","pinTab":true}' > ~/.agent-browser/config.json
ln -s ~/.local/share/agent-bridge/current/shared-skills/browser ~/.claude/skills/browser
ln -s ~/.local/share/agent-bridge/current/shared-skills/browser ~/.codex/skills/browser
```

两侧 Bridge 环境文件加 `BRIDGE_BROWSER_CDP_CONFIGURED=true`。

## 选型实测（2026-09-28，Chrome 153，agent-browser 0.38.1）

- 中转：WSL 经中转的 `/json/version` 返回 `ws://127.0.0.1:9222/...`；50 次 CDP 往返约 42ms（小于 1ms/次，另有每连接约 0.1s 的 node.exe 启动开销），两个客户端并发正常。
- agent-browser：WSL 两个会话（`--session` + `--pin-tab`）并发打开不同页面，各自绑定独立标签页、互不串扰；Windows 原生同样可用。`close` 只断开会话，共享 Chrome 和标签页保留，因此 skill 要求结束时 `tab close` 关闭自己的标签页。
- `~/.agent-browser/config.json` 设 `cdp`/`pinTab` 后，每条命令都会重新附着共享浏览器；在沙箱中 daemon 随命令退出后，下一条命令仍能回到同一个绑定标签页。
- Codex 沙箱：
  - WSL（Linux 沙箱，默认 workspace-write 无网络）：连不上 `127.0.0.1:9222`，且 agent-browser 的 socket 目录 `/run/user/<uid>/agent-browser` 只读。需要 `sandbox_workspace_write.network_access=true` 且把该目录加入 `sandbox_workspace_write.writable_roots`，或者逐条命令申请提权。
  - Windows（`[windows] sandbox = "elevated"`）：默认 workspace-write 下即可访问回环并运行 agent-browser。
- browser-harness 未深入实测：它需要 Python 3.12 + uv 工具链，且官方说明一个 daemon 只有一个“当前标签页”，多 Agent 并发需自行串行；agent-browser 的按会话绑定标签页已满足需求。

## 安全

- DevTools 端口没有认证，本机任何进程都能控制这个浏览器。只绑定回环，不做 portproxy，不在该 profile 里保存个人账号。
- 付款、发消息、修改账号设置、输入凭据等操作由 skill 要求 Agent 先征得用户同意。
