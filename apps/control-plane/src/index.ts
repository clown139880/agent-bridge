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
  controlApiReadToken: config.controlApiReadToken,
  controlApiWriteToken: config.controlApiWriteToken,
  agents: config.agents,
  agentMemory: config.agentMemory,
  conversationSetup: config.conversationSetup,
  memoryReview: config.memoryReview,
  retention: config.retention,
  sse: config.sse,
  bridgeUpdate: config.bridgeUpdate,
  webhook: config.webhook,
  noticeTarget: config.noticeTarget,
  ntfy: config.ntfy,
  messages: config.messages,
});

await control.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void control.stop().then(() => process.exit(0)));
}
process.on("uncaughtException", (error) => log.fatal({ error }, "Uncaught exception"));
process.on("unhandledRejection", (error) => log.fatal({ error }, "Unhandled rejection"));
