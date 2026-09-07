# Windows-native deployment

Agent Bridge 0.5.2 supports a native Windows worker using the same Windows
Codex Desktop home. Copy `deploy/windows-native.env.example` to
`%LOCALAPPDATA%\agent-bridge\bridge.env`, set `BRIDGE_TOKEN` locally, replace
the `CODEX_COMMAND` placeholder with the verified `codex.exe` path, and run
`deploy/windows-native/install-scheduled-task.ps1` from an elevated PowerShell
only if the normal user task registration is refused.

The task runs at user logon and uses the checked-out NTFS directory. It does
not use WSL, systemd, or a second Codex profile. Windows automatic updates are
disabled because the current updater requires POSIX symlink replacement and
systemd-style restart semantics; deploy controlled releases manually.

The DSH Agent Control plugin is installed into the existing `desktop` profile.
Its Host token belongs in the DSH backend environment as
`AGENT_BRIDGE_CONTROL_TOKEN`; it must not be placed in browser configuration.
When DSH runs on HAL, keep Kanban in HAL's existing Hermes sidecar. Do not
create a Windows Hermes database or a competing DSH Host.
