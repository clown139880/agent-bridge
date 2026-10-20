import pino from "pino";
import { Store } from "@agent-bridge/database";
import { config } from "./config.js";
import { ControlPlane } from "./server.js";

const log = pino({ name: "control-plane-main" });
const store = new Store(config.databasePath);
const control = new ControlPlane(store, {
  version: config.version,
  postDeployDir: config.postDeployDir,
  host: config.host,
  port: config.port,
  bridgeToken: config.bridgeToken,
  workerApiEnabled: config.workerApiEnabled,
  workerApiToken: config.workerApiToken,
  controlApiReadToken: config.controlApiReadToken,
  controlApiWriteToken: config.controlApiWriteToken,
  conversationMemory: config.conversationMemory,
  agentMemory: config.agentMemory,
  retention: config.retention,
  sse: config.sse,
  bridgeUpdate: config.bridgeUpdate,
  webhook: config.webhook,
});

await control.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void control.stop().then(() => process.exit(0)));
}
process.on("uncaughtException", (error) => log.fatal({ error }, "Uncaught exception"));
process.on("unhandledRejection", (error) => log.fatal({ error }, "Unhandled rejection"));
