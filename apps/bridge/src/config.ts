import "dotenv/config";
import { hostname, platform } from "node:os";

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
  allowedRoots: (process.env.BRIDGE_ALLOWED_ROOTS ?? process.cwd()).split(":").filter(Boolean),
  reconnectMs: Number(process.env.BRIDGE_RECONNECT_MS ?? "3000"),
};
