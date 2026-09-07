import pino from "pino";
import { Store } from "@agent-bridge/database";
import { config } from "./config.js";
import { MatrixGateway, NoopMatrixGateway } from "./matrix.js";
import { ControlPlane } from "./server.js";

const log = pino({ name: "control-plane-main" });
const store = new Store(config.databasePath);
let control!: ControlPlane;
const callbacks = {
  onRoomMessage: (body: string, sender: string, eventId: string) => control.onRoomMessage(body, sender, eventId),
  onThreadMessage: (roomId: string, threadId: string, body: string) => control.onThreadMessage(roomId, threadId, body),
  onReaction: (targetEventId: string, key: string, sender: string) => control.onReaction(targetEventId, key, sender),
};
const matrix = config.matrixEnabled ? new MatrixGateway({
  homeserver: config.matrixHomeserver,
  userId: config.matrixUserId,
  password: config.matrixPassword,
  roomId: config.matrixRoomId,
  roomName: config.matrixRoomName,
  allowedUserId: config.matrixAllowedUserId,
}, callbacks) : new NoopMatrixGateway();
control = new ControlPlane(store, matrix, {
  host: config.host,
  port: config.port,
  bridgeToken: config.bridgeToken,
  workerApiEnabled: config.workerApiEnabled,
  workerApiToken: config.workerApiToken,
  controlApiReadToken: config.controlApiReadToken,
  controlApiWriteToken: config.controlApiWriteToken,
  retention: config.retention,
  sse: config.sse,
  bridgeUpdate: config.bridgeUpdate,
});

await control.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void control.stop().then(() => process.exit(0)));
}
process.on("uncaughtException", (error) => log.fatal({ error }, "Uncaught exception"));
process.on("unhandledRejection", (error) => log.fatal({ error }, "Unhandled rejection"));
