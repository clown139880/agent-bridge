import { BridgeClient } from "./client.js";
import { config } from "./config.js";

const client = new BridgeClient({
  url: config.controlUrl,
  token: config.bridgeToken,
  machineId: config.machineId,
  machineName: config.machineName,
  hostname: config.hostname,
  platform: config.platform,
  providers: config.providers,
  command: config.codexCommand,
  appServerUrl: config.appServerUrl,
  manageAppServer: config.manageAppServer,
  desktopHome: config.desktopHome,
  desktopScanIntervalMs: config.desktopScanIntervalMs,
  desktopReplayExisting: config.desktopReplayExisting,
  claudeCommand: config.claudeCommand,
  claudeHome: config.claudeHome,
  claudeScanExisting: config.claudeScanExisting,
  allowedRoots: config.allowedRoots,
  reconnectMs: config.reconnectMs,
  version: config.version,
  updateEnabled: config.updateEnabled,
  updateSource: config.updateSource,
  updateSourceRef: config.updateSourceRef,
  updateInstallRoot: config.updateInstallRoot,
  updateCurrentLink: config.updateCurrentLink,
  updateStatePath: config.updateStatePath,
  actionCachePath: config.actionCachePath,
  actionCacheTtlMs: config.actionCacheTtlMs,
  drainFile: config.drainFile,
  updatePackageManager: config.updatePackageManager,
  updateRestartExecutable: config.updateRestartExecutable,
  updateRestartArgs: config.updateRestartArgs,
});
client.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    client.stop();
    process.exit(0);
  });
}
