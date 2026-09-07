import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const matrixEnabled = process.env.MATRIX_ENABLED !== "false";
const workerApiEnabled = process.env.WORKER_API_ENABLED === "true";
const controlApiReadToken = process.env.CONTROL_API_READ_TOKEN;
const controlApiWriteToken = process.env.CONTROL_API_WRITE_TOKEN;
const duration = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of milliseconds`);
  return value;
};
const bridgeLatestVersion = process.env.BRIDGE_LATEST_VERSION;
const bridgeUpdateSource = process.env.BRIDGE_UPDATE_SOURCE;
if (Boolean(bridgeLatestVersion) !== Boolean(bridgeUpdateSource)) {
  throw new Error("BRIDGE_LATEST_VERSION and BRIDGE_UPDATE_SOURCE must be configured together");
}
if (bridgeLatestVersion && !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(bridgeLatestVersion)) {
  throw new Error("BRIDGE_LATEST_VERSION must be a semantic version");
}
const bridgeUpdatePublishedAt = process.env.BRIDGE_UPDATE_PUBLISHED_AT
  ? Date.parse(process.env.BRIDGE_UPDATE_PUBLISHED_AT)
  : undefined;
if (bridgeUpdatePublishedAt !== undefined && !Number.isFinite(bridgeUpdatePublishedAt)) {
  throw new Error("BRIDGE_UPDATE_PUBLISHED_AT must be an ISO-8601 timestamp");
}

export const config = {
  matrixEnabled,
  matrixHomeserver: matrixEnabled ? required("MATRIX_HOMESERVER") : "",
  matrixUserId: matrixEnabled ? required("MATRIX_USER_ID") : "",
  matrixPassword: matrixEnabled ? required("MATRIX_PASSWORD") : "",
  matrixRoomId: process.env.MATRIX_ROOM_ID,
  matrixRoomName: process.env.MATRIX_ROOM_NAME ?? "Agent Control",
  matrixAllowedUserId: process.env.MATRIX_ALLOWED_USER_ID,
  databasePath: process.env.DATABASE_PATH ?? "./data/control-plane.sqlite",
  host: process.env.CONTROL_HOST ?? "0.0.0.0",
  port: Number(process.env.CONTROL_PORT ?? "8787"),
  publicWsUrl: process.env.CONTROL_PUBLIC_WS_URL,
  bridgeToken: process.env.BRIDGE_TOKEN,
  workerApiEnabled,
  workerApiToken: workerApiEnabled ? required("WORKER_API_TOKEN") : undefined,
  controlApiReadToken,
  controlApiWriteToken,
  retention: {
    sessionEventsMs: duration("CONTROL_SESSION_EVENT_RETENTION_MS", 30 * 86_400_000),
    streamEventsMs: duration("CONTROL_STREAM_RETENTION_MS", 7 * 86_400_000),
    actionsMs: duration("CONTROL_ACTION_RETENTION_MS", 86_400_000),
  },
  sse: {
    keepaliveMs: duration("CONTROL_SSE_KEEPALIVE_MS", 15_000),
    pollMs: duration("CONTROL_SSE_POLL_MS", 250),
    maxBackpressure: Math.max(1, Number(process.env.CONTROL_SSE_MAX_BACKPRESSURE ?? "3")),
    actionTimeoutMs: duration("CONTROL_ACTION_TIMEOUT_MS", 30_000),
  },
  bridgeUpdate: bridgeLatestVersion && bridgeUpdateSource ? {
    latestVersion: bridgeLatestVersion,
    source: bridgeUpdateSource,
    publishedAt: bridgeUpdatePublishedAt,
  } : undefined,
};
