import "dotenv/config";
import { readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { config as loadEnv } from "dotenv";
import { splitAllowedRoots } from "./path-utils.js";

loadEnv({ path: process.env.BRIDGE_ENV_FILE ?? ".env.bridge", override: true, quiet: true });

const packageVersion = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const isWindows = platform() === "win32";
const updateInstallRoot = process.env.BRIDGE_UPDATE_INSTALL_ROOT ?? (isWindows ? `${process.env.LOCALAPPDATA ?? process.cwd()}\\agent-bridge` : "/opt/agent-bridge");
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
  machineId: process.env.MACHINE_ID ?? hostname(),
  machineName: process.env.MACHINE_NAME ?? hostname(),
  hostname: hostname(),
  platform: platform(),
  codexCommand: process.env.CODEX_COMMAND ?? "codex",
  appServerUrl: process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4500",
  manageAppServer: process.env.CODEX_APP_SERVER_MANAGED !== "false",
  desktopHome: process.env.CODEX_DESKTOP_HOME,
  desktopScanIntervalMs: Number(process.env.CODEX_DESKTOP_SCAN_INTERVAL_MS ?? "3000"),
  desktopReplayExisting: process.env.CODEX_DESKTOP_REPLAY_EXISTING === "true",
  allowedRoots: splitAllowedRoots(process.env.BRIDGE_ALLOWED_ROOTS, platform()).length
    ? splitAllowedRoots(process.env.BRIDGE_ALLOWED_ROOTS, platform()) : [process.cwd()],
  reconnectMs: Number(process.env.BRIDGE_RECONNECT_MS ?? "3000"),
  version: process.env.BRIDGE_VERSION ?? packageVersion,
  updateEnabled: process.env.BRIDGE_AUTO_UPDATE === "true",
  updateSource: process.env.BRIDGE_UPDATE_SOURCE,
  updateSourceRef: process.env.BRIDGE_UPDATE_REF ?? "main",
  updateInstallRoot,
  updateCurrentLink: process.env.BRIDGE_UPDATE_CURRENT_LINK ?? `${updateInstallRoot}/current`,
  updateStatePath: process.env.BRIDGE_UPDATE_STATE_PATH ?? `${updateInstallRoot}/update-state.json`,
  actionCachePath: process.env.BRIDGE_ACTION_CACHE_PATH ?? `${updateInstallRoot}/action-cache.json`,
  actionCacheTtlMs: positiveNumber("BRIDGE_ACTION_CACHE_RETENTION_MS", 86_400_000),
  updatePackageManager: process.env.BRIDGE_UPDATE_PACKAGE_MANAGER ?? "pnpm",
  updateRestartExecutable: process.env.BRIDGE_UPDATE_RESTART_EXECUTABLE ?? (isWindows ? "powershell.exe" : "systemctl"),
  updateRestartArgs: jsonStringArray("BRIDGE_UPDATE_RESTART_ARGS", isWindows ? ["-NoProfile", "-File", "restart-bridge.ps1"] : ["--no-block", "restart", "agent-bridge.service"]),
};
