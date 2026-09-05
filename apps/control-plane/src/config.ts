import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const matrixEnabled = process.env.MATRIX_ENABLED !== "false";
const workerApiEnabled = process.env.WORKER_API_ENABLED === "true";
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
  bridgeUpdate: bridgeLatestVersion && bridgeUpdateSource ? {
    latestVersion: bridgeLatestVersion,
    source: bridgeUpdateSource,
    publishedAt: bridgeUpdatePublishedAt,
  } : undefined,
};
