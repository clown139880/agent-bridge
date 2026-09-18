import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The fleet version lives in the repo-root package.json (same value BRIDGE_LATEST_VERSION
// tracks). Report it in lifecycle webhooks so the operator sees which control-plane is live.
const controlPlaneVersion = ((): string => {
  try {
    return String(JSON.parse(readFileSync(
      fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")).version ?? "unknown");
  } catch {
    return "unknown";
  }
})();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const matrixEnabled = process.env.MATRIX_ENABLED !== "false";
const workerApiEnabled = process.env.WORKER_API_ENABLED === "true";
const controlApiReadToken = process.env.CONTROL_API_READ_TOKEN;
const controlApiWriteToken = process.env.CONTROL_API_WRITE_TOKEN;
const databasePath = process.env.DATABASE_PATH ?? "./data/control-plane.sqlite";
const duration = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of milliseconds`);
  return value;
};
const bytes = (name: string, fallback: number, minimum: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
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
  version: controlPlaneVersion,
  matrixEnabled,
  matrixHomeserver: matrixEnabled ? required("MATRIX_HOMESERVER") : "",
  matrixUserId: matrixEnabled ? required("MATRIX_USER_ID") : "",
  matrixPassword: matrixEnabled ? required("MATRIX_PASSWORD") : "",
  matrixRoomId: process.env.MATRIX_ROOM_ID,
  matrixRoomName: process.env.MATRIX_ROOM_NAME ?? "Agent Control",
  matrixAllowedUserId: process.env.MATRIX_ALLOWED_USER_ID,
  databasePath,
  host: process.env.CONTROL_HOST ?? "0.0.0.0",
  port: Number(process.env.CONTROL_PORT ?? "8787"),
  publicWsUrl: process.env.CONTROL_PUBLIC_WS_URL,
  bridgeToken: process.env.BRIDGE_TOKEN,
  workerApiEnabled,
  workerApiToken: workerApiEnabled ? required("WORKER_API_TOKEN") : undefined,
  controlApiReadToken,
  controlApiWriteToken,
  conversationMemory: {
    mcpReadToken: process.env.CONVERSATION_MCP_READ_TOKEN,
    objectDir: process.env.CONVERSATION_OBJECT_DIR ?? join(dirname(databasePath), "conversation-objects"),
    hotRetentionMs: duration("CONVERSATION_HOT_RETENTION_MS", 30 * 86_400_000),
    archiveChunkBytes: bytes("CONVERSATION_ARCHIVE_CHUNK_BYTES", 1_048_576, 65_536),
    maxCapacityBytes: bytes("CONVERSATION_TOTAL_CAPACITY_BYTES", 5 * 1024 ** 3, 1_048_576),
    maxMessageBytes: bytes("CONVERSATION_MAX_MESSAGE_BYTES", 1_048_576, 65_536),
  },
  retention: {
    sessionEventsMs: duration("CONTROL_SESSION_EVENT_RETENTION_MS", 30 * 86_400_000),
    streamEventsMs: duration("CONTROL_STREAM_RETENTION_MS", 7 * 86_400_000),
    actionsMs: duration("CONTROL_ACTION_RETENTION_MS", 86_400_000),
    attachmentsMs: duration("CONTROL_ATTACHMENT_RETENTION_MS", 7 * 86_400_000),
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
  // Dorothy bridge-events webhook. Both must be set to enable delivery.
  webhook: process.env.DOROTHY_WEBHOOK_URL && process.env.DOROTHY_WEBHOOK_SECRET ? {
    url: process.env.DOROTHY_WEBHOOK_URL,
    secret: process.env.DOROTHY_WEBHOOK_SECRET,
  } : undefined,
};
