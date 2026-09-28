---
name: browser
description: Drive the shared, visible agent browser (isolated Chrome profile on the Windows desktop) with agent-browser over CDP at http://127.0.0.1:9222, from both WSL and native Windows. Use for opening pages, reading them, clicking, typing, and checking web UIs. Do not use it for the user's personal browser.
---

# Shared agent browser

One headed Chrome on the Windows desktop is shared by every agent on this PC and by the user, who may be working in the same window. Its profile (`C:\Tools\agent-bridge\browser\profile`) is isolated from the user's own browser. The endpoint is `http://127.0.0.1:9222` from both Windows and WSL; in WSL a relay (`agent-bridge-cdp-relay.service`) forwards it to Windows.

## Check and start

1. `curl -s -m 3 http://127.0.0.1:9222/json/version` must return `webSocketDebuggerUrl`.
2. If it does not, start the browser with `schtasks.exe /Run /TN "Agent Bridge Browser"` (works from WSL too), wait a few seconds, and check again. In WSL, if Windows answers but WSL does not, report that the relay service is down; do not start another browser or change networking.

## Drive it with agent-browser

Pass `--cdp 9222 --pin-tab` on every command. Sandboxes may not see `~/.agent-browser/config.json`, and without `--cdp` agent-browser tries to launch its own Chrome ("Auto-launch failed"). Always pass your own `--session <name>`, unique to this task (for example the project plus a short purpose), and reuse it for every command in the task.

```bash
agent-browser --cdp 9222 --pin-tab --session <name> open https://example.com    # binds the session to its own new tab
agent-browser --cdp 9222 --pin-tab --session <name> snapshot -i                 # interactive elements with refs (@e1, @e2 ...)
agent-browser --cdp 9222 --pin-tab --session <name> click @e2
agent-browser --cdp 9222 --pin-tab --session <name> fill @e3 "text"
agent-browser --cdp 9222 --pin-tab --session <name> get title
agent-browser --cdp 9222 --pin-tab --session <name> screenshot page.png         # only when the text snapshot is not enough
agent-browser --cdp 9222 --pin-tab --session <name> tab close                   # when finished: close only your own tab
```

Prefer `snapshot -i` over screenshots. Re-snapshot after navigation or page changes before using refs again. If a command reports `tab_gone`, the user closed your tab; open a new one with `tab new <url>` instead of taking over another tab.

## Rules

- Work only in your session's tab. Never switch to, read, close, or navigate tabs you did not open; they may belong to the user or another agent.
- Do not bring the window to the foreground or activate tabs; the user may be typing elsewhere.
- `agent-browser close` only detaches your session; the shared browser keeps running. Never kill Chrome or launch a second browser with the same profile.
- Ask the user before payments, purchases, sending messages, submitting forms with external effects, changing account settings, or entering credentials. Logins the user performed in this profile may be reused, but never export cookies or storage state.
- DevTools on this port has no authentication. Do not save personal credentials in this profile.
- In the Codex sandbox, the commands above need loopback network access and a writable agent-browser socket directory; if they fail with a network or read-only socket error, request escalation for that command rather than changing the browser setup.
