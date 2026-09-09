import "dotenv/config";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { hostname, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import { splitAllowedRoots } from "./path-utils.js";

loadEnv({ path: process.env.BRIDGE_ENV_FILE ?? ".env.bridge", override: true, quiet: true });

const packageVersion = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const isWindows = platform() === "win32";

function resolveCodexCommand(value: string): string {
  if (!isWindows || basename(value).toLowerCase() !== "codex.exe") return value;
  if (existsSync(join(dirname(value), "codex-code-mode-host.exe"))) return value;

  // A self-updated Bridge may carry a pinned codex.exe in its runtime directory
  // without the companion code-mode host. Fall back to the complete native
  // Codex installation so App Server tools can spawn their host process.
  const installRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin")
    : undefined;
  if (!installRoot || !existsSync(installRoot)) return value;
  const candidates = readdirSync(installRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(installRoot, entry.name))
    .filter((directory) => existsSync(join(directory, "codex.exe")) && existsSync(join(directory, "codex-code-mode-host.exe")))
    .sort((left, right) => {
      try { return statSync(right).mtimeMs - statSync(left).mtimeMs; } catch { return 0; }
    });
  return candidates.length ? join(candidates[0]!, "codex.exe") : value;
}

const updateInstallRoot = process.env.BRIDGE_UPDATE_INSTALL_ROOT ?? (isWindows ? `${process.env.LOCALAPPDATA ?? process.cwd()}\\agent-bridge` : "/opt/agent-bridge");
const updateStoreDir = process.env.BRIDGE_UPDATE_STORE_DIR ?? join(updateInstallRoot, "pnpm-store");
const machineId = process.env.MACHINE_ID ?? hostname();
function positiveNumber(name: string, fallback: number): number {
  const value=Number(process.env[name]??fallback);if(!Number.isFinite(value)||value<=0)throw new Error(`${name} must be positive`);return value;
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
  codexCommand: resolveCodexCommand(process.env.CODEX_COMMAND ?? "codex"),
  appServerUrl: process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4500",
  manageAppServer: process.env.CODEX_APP_SERVER_MANAGED !== "false",
  desktopHome: process.env.CODEX_DESKTOP_HOME,
  desktopScanIntervalMs: Number(process.env.CODEX_DESKTOP_SCAN_INTERVAL_MS ?? "3000"),
  desktopReplayExisting: process.env.CODEX_DESKTOP_REPLAY_EXISTING === "true",
  claudeCommand: process.env.CLAUDE_COMMAND ?? "claude",
  claudeHome: process.env.CLAUDE_HOME ?? `${process.env.HOME ?? ""}/.claude`,
  claudeScanExisting: process.env.CLAUDE_SCAN_EXISTING === "true",
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
  drainFile: process.env.BRIDGE_DRAIN_FILE ?? (isWindows ? undefined : `/run/agent-bridge-${machineId}.drain`),
  updatePackageManager: process.env.BRIDGE_UPDATE_PACKAGE_MANAGER ?? "pnpm",
  updateRestartExecutable: process.env.BRIDGE_UPDATE_RESTART_EXECUTABLE ?? (isWindows ? "powershell.exe" : "systemctl"),
  updateRestartArgs: jsonStringArray("BRIDGE_UPDATE_RESTART_ARGS", isWindows ? ["-NoProfile", "-File", "restart-bridge.ps1"] : ["--no-block", "restart", "agent-bridge.service"]),
};
