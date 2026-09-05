import { BridgeClient } from "./client.js";
import { config } from "./config.js";

const client = new BridgeClient({
  url: config.controlUrl,
  token: config.bridgeToken,
  machineId: config.machineId,
  machineName: config.machineName,
  hostname: config.hostname,
  platform: config.platform,
  command: config.codexCommand,
  appServerUrl: config.appServerUrl,
  manageAppServer: config.manageAppServer,
  desktopHome: config.desktopHome,
  desktopScanIntervalMs: config.desktopScanIntervalMs,
  desktopReplayExisting: config.desktopReplayExisting,
  allowedRoots: config.allowedRoots,
  reconnectMs: config.reconnectMs,
  version: config.version,
  updateEnabled: config.updateEnabled,
  updateSource: config.updateSource,
  updateSourceRef: config.updateSourceRef,
  updateCheckIntervalMs: config.updateCheckIntervalMs,
  updateInstallRoot: config.updateInstallRoot,
  updateCurrentLink: config.updateCurrentLink,
  updateStatePath: config.updateStatePath,
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
