import pino from "pino";
import { Store } from "@agent-bridge/database";
import { config } from "./config.js";
import { MatrixGateway } from "./matrix.js";
import { ControlPlane } from "./server.js";

const log = pino({ name: "control-plane-main" });
const store = new Store(config.databasePath);
let control!: ControlPlane;
const matrix = new MatrixGateway({
  homeserver: config.matrixHomeserver,
  userId: config.matrixUserId,
  password: config.matrixPassword,
  roomId: config.matrixRoomId,
  roomName: config.matrixRoomName,
  allowedUserId: config.matrixAllowedUserId,
}, {
  onRoomMessage: (body) => control.onRoomMessage(body),
  onThreadMessage: (roomId, threadId, body) => control.onThreadMessage(roomId, threadId, body),
  onReaction: (targetEventId, key) => control.onReaction(targetEventId, key),
});
control = new ControlPlane(store, matrix, {
  host: config.host,
  port: config.port,
  bridgeToken: config.bridgeToken,
});

await control.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void control.stop().then(() => process.exit(0)));
}
process.on("uncaughtException", (error) => log.fatal({ error }, "Uncaught exception"));
process.on("unhandledRejection", (error) => log.fatal({ error }, "Unhandled rejection"));
