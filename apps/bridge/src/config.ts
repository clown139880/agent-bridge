import "dotenv/config";
import { readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { splitAllowedRoots } from "./path-utils.js";

loadEnv({ path: process.env.BRIDGE_ENV_FILE ?? ".env.bridge", override: true, quiet: true });

const packageVersion = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const isWindows = platform() === "win32";

const updateInstallRoot = process.env.BRIDGE_UPDATE_INSTALL_ROOT ?? (isWindows ? `${process.env.LOCALAPPDATA ?? process.cwd()}\\agent-bridge` : "/opt/agent-bridge");
const updateStoreDir = process.env.BRIDGE_UPDATE_STORE_DIR ?? join(updateInstallRoot, "pnpm-store");
const machineId = process.env.MACHINE_ID ?? hostname();
function positiveNumber(name: string, fallback: number): number {
  const value=Number(process.env[name]??fallback);if(!Number.isFinite(value)||value<=0)throw new Error(`${name} must be positive`);return value;
}

function autoApproveMode(name: string, fallback: "off" | "readonly" | "all"): "off" | "readonly" | "all" {
  const raw = (process.env[name] ?? fallback).trim().toLowerCase();
  if (raw !== "off" && raw !== "readonly" && raw !== "all") throw new Error(`${name} must be one of off|readonly|all`);
  return raw;
}

type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
const PERMISSION_MODES = new Set<ClaudePermissionMode>(["default", "acceptEdits", "plan", "bypassPermissions"]);
function permissionMode(name: string, fallback: ClaudePermissionMode): ClaudePermissionMode {
  const raw = (process.env[name] ?? fallback).trim() as ClaudePermissionMode;
  if (!PERMISSION_MODES.has(raw)) throw new Error(`${name} must be one of ${[...PERMISSION_MODES].join("|")}`);
  return raw;
}

function jsonStringArray(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return value;
}

export const config = {
  controlUrl: process.env.CONTROL_WS_URL ?? "ws://127.0.0.1:8787/bridge",
  bridgeToken: process.env.BRIDGE_TOKEN,
  machineId,
  machineName: process.env.MACHINE_NAME ?? hostname(),
  hostname: hostname(),
  platform: platform(),
  // Which agent backends this bridge runs, e.g. "codex" or "codex,claude".
  providers: (process.env.BRIDGE_PROVIDERS ?? "codex").split(",").map((p) => p.trim()).filter(Boolean),
  // The adapter resolves Desktop's content-addressed runtime immediately before
  // spawn and can rotate it between turns. Keep this configured value as a hint.
  codexCommand: process.env.CODEX_COMMAND ?? "codex",
  appServerUrl: process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4500",
  manageAppServer: process.env.CODEX_APP_SERVER_MANAGED !== "false",
  desktopHome: process.env.CODEX_DESKTOP_HOME,
  desktopScanIntervalMs: Number(process.env.CODEX_DESKTOP_SCAN_INTERVAL_MS ?? "3000"),
  desktopReplayExisting: process.env.CODEX_DESKTOP_REPLAY_EXISTING === "true",
  claudeCommand: process.env.CLAUDE_COMMAND ?? "claude",
  claudeHome: process.env.CLAUDE_HOME ?? `${process.env.HOME ?? ""}/.claude`,
  claudeScanExisting: process.env.CLAUDE_SCAN_EXISTING === "true",
  // Auto-approval for Claude tool calls: off (prompt for everything), readonly
  // (clear non-mutating built-ins), or all (clear everything). CLAUDE_AUTO_APPROVE_TOOLS
  // is a JSON array of extra tool names to always clear, e.g. ["Bash"]. This bridge-side
  // gate only fires for tool calls that Claude's own permission engine leaves unresolved
  // (i.e. it does not short-circuit the native allow/deny rules below).
  claudeAutoApprove: autoApproveMode("CLAUDE_AUTO_APPROVE", "off"),
  claudeAutoApproveTools: jsonStringArray("CLAUDE_AUTO_APPROVE_TOOLS", []),
  // Claude Code native permissions, evaluated inside the claude process BEFORE the
  // bridge auto-approve gate / operator prompt (order: deny → allow → mode → prompt).
  //   CLAUDE_PERMISSION_MODE: default | acceptEdits | plan | bypassPermissions.
  //     acceptEdits auto-accepts file edits inside the workspace (cwd + additional dirs)
  //     while still prompting for edits elsewhere — this is the "workspace-write" ask.
  //     bypassPermissions skips ALL checks (no bridge prompts); use sparingly.
  //   CLAUDE_PERMISSION_ALLOW / _DENY: JSON arrays of tool+specifier rules, e.g.
  //     ["Bash(git:*)","Edit(**)","Read(~/.ssh/**)","WebFetch(domain:example.com)"].
  //     allow → auto-approved (no prompt); deny → blocked outright.
  //   CLAUDE_ADDITIONAL_DIRECTORIES: JSON array of extra trusted dirs (--add-dir),
  //     extending workspace trust beyond cwd for reads and acceptEdits writes.
  claudePermissionMode: permissionMode("CLAUDE_PERMISSION_MODE", "default"),
  claudePermissionAllow: jsonStringArray("CLAUDE_PERMISSION_ALLOW", []),
  claudePermissionDeny: jsonStringArray("CLAUDE_PERMISSION_DENY", []),
  claudeAdditionalDirectories: jsonStringArray("CLAUDE_ADDITIONAL_DIRECTORIES", []),
  // Pi provider (enabled when BRIDGE_PROVIDERS includes "pi"). PI_PROVIDER /
  // PI_MODEL are the provider and model in ~/.pi/agent/models.json (e.g. a
  // tokensapi / OpenAI-compatible relay). PI_SESSION_DIR is optional.
  piCommand: process.env.PI_COMMAND ?? "pi",
  piProvider: process.env.PI_PROVIDER,
  piModel: process.env.PI_MODEL,
  piSessionDir: process.env.PI_SESSION_DIR,
  allowedRoots: splitAllowedRoots(process.env.BRIDGE_ALLOWED_ROOTS, platform()).length
    ? splitAllowedRoots(process.env.BRIDGE_ALLOWED_ROOTS, platform()) : [process.cwd()],
  reconnectMs: Number(process.env.BRIDGE_RECONNECT_MS ?? "3000"),
  version: process.env.BRIDGE_VERSION ?? packageVersion,
  updateEnabled: process.env.BRIDGE_AUTO_UPDATE === "true",
  updateSource: process.env.BRIDGE_UPDATE_SOURCE,
  updateSourceRef: process.env.BRIDGE_UPDATE_REF ?? "main",
  updateInstallRoot,
  updateSourceCheckout: process.env.BRIDGE_UPDATE_SOURCE_CHECKOUT,
  updateStoreDir,
  updateReleaseRetention: positiveNumber("BRIDGE_UPDATE_RELEASE_RETENTION", 2),
  updateCurrentLink: process.env.BRIDGE_UPDATE_CURRENT_LINK ?? `${updateInstallRoot}/current`,
  updateStatePath: process.env.BRIDGE_UPDATE_STATE_PATH ?? `${updateInstallRoot}/update-state.json`,
  actionCachePath: process.env.BRIDGE_ACTION_CACHE_PATH ?? `${updateInstallRoot}/action-cache.json`,
  actionCacheTtlMs: positiveNumber("BRIDGE_ACTION_CACHE_RETENTION_MS", 86_400_000),
  archiveOutboxPath: process.env.BRIDGE_ARCHIVE_OUTBOX_PATH ?? `${updateInstallRoot}/conversation-outbox.json`,
  archiveOutboxLimit: positiveNumber("BRIDGE_ARCHIVE_OUTBOX_LIMIT", 10_000),
  sharedSkillsManifest: process.env.BRIDGE_SHARED_SKILLS_MANIFEST,
  conversationMcpConfigured: process.env.BRIDGE_CONVERSATION_MCP_CONFIGURED === "true",
  drainFile: process.env.BRIDGE_DRAIN_FILE ?? (isWindows ? undefined : `/run/agent-bridge-${machineId}.drain`),
  updatePackageManager: process.env.BRIDGE_UPDATE_PACKAGE_MANAGER ?? "pnpm",
  updateRestartExecutable: process.env.BRIDGE_UPDATE_RESTART_EXECUTABLE ?? (isWindows ? "powershell.exe" : "systemctl"),
  updateRestartArgs: jsonStringArray("BRIDGE_UPDATE_RESTART_ARGS", isWindows ? ["-NoProfile", "-File", "restart-bridge.ps1"] : ["--no-block", "restart", "agent-bridge.service"]),
};
