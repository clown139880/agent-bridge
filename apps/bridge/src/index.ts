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
});
client.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    client.stop();
    process.exit(0);
  });
}
