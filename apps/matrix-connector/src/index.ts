import { loadConfig } from "./config.js";
import { MatrixConnector } from "./connector.js";
import { ControlClient } from "./control.js";
import { MatrixClient } from "./matrix.js";

const config = loadConfig();
const connector = new MatrixConnector(config, new MatrixClient(config.homeserver), new ControlClient(config.controlUrl, config.controlToken));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { connector.stop(); process.exit(0); });
await connector.start();
