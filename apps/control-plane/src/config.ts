import "dotenv/config";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
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

const workerApiEnabled = process.env.WORKER_API_ENABLED === "true";
const controlApiReadToken = process.env.CONTROL_API_READ_TOKEN;
const controlApiWriteToken = process.env.CONTROL_API_WRITE_TOKEN;
const databasePath = process.env.DATABASE_PATH ?? "./data/control-plane.sqlite";
const duration = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of milliseconds`);
  return value;
};
const bridgeUpdateSource = process.env.BRIDGE_UPDATE_SOURCE;
// The fleet is offered the version this control-plane was deployed from, so a deploy
// never needs an .env edit. BRIDGE_LATEST_VERSION remains as an explicit override.
if (process.env.BRIDGE_LATEST_VERSION && !bridgeUpdateSource) {
  throw new Error("BRIDGE_LATEST_VERSION requires BRIDGE_UPDATE_SOURCE");
}
const bridgeLatestVersion = process.env.BRIDGE_LATEST_VERSION
  || (bridgeUpdateSource && controlPlaneVersion !== "unknown" ? controlPlaneVersion : undefined);
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
  databasePath,
  // deploy/hal/deploy.sh writes post-deploy intents beside the database (outside the checkout).
  postDeployDir: process.env.POST_DEPLOY_DIR ?? join(dirname(databasePath), "post-deploy"),
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
  },
  agentMemory: agentMemoryConfig(),
  retention: {
    actionsMs: duration("CONTROL_ACTION_RETENTION_MS", 86_400_000),
    attachmentsMs: duration("CONTROL_ATTACHMENT_RETENTION_MS", 7 * 86_400_000),
  },
  sse: {
    keepaliveMs: duration("CONTROL_SSE_KEEPALIVE_MS", 15_000),
    // Writes wake streams immediately; the poll only bounds a missed wakeup.
    pollMs: duration("CONTROL_SSE_POLL_MS", 2_000),
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

/** Cross-agent memory (docs/agent-memory-design.zh.md); disabled unless AGENT_MEMORY_VAULT is set. */
function agentMemoryConfig() {
  const vault = process.env.AGENT_MEMORY_VAULT;
  if (!vault) return undefined;
  // AGENT_MEMORY_TOKENS: comma-separated name:token[:agent|project]; repo-bound agents default to project.
  const writers = (process.env.AGENT_MEMORY_TOKENS ?? "").split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const [name, token, role = "project"] = item.split(":");
    if (!name || !token || token.length < 16 || (role !== "agent" && role !== "project")) {
      throw new Error("AGENT_MEMORY_TOKENS entries must be name:token[:agent|project] with tokens of at least 16 characters");
    }
    return { name, token, role: role as "agent" | "project" };
  });
  return {
    vault,
    root: process.env.AGENT_MEMORY_ROOT ?? "agent-memory",
    lockPath: process.env.AGENT_MEMORY_LOCK,
    cacheDir: process.env.AGENT_MEMORY_CACHE_DIR ?? join(dirname(databasePath), "memory-cache"),
    writers,
    skills: agentSkillsConfig(),
  };
}

/** Shared skill library (docs/agent-skills-design.zh.md); needs agent memory (its writers) and AGENT_SKILLS_REPO. */
function agentSkillsConfig() {
  const repo = process.env.AGENT_SKILLS_REPO;
  if (!repo) return undefined;
  return {
    repo,
    lockPath: process.env.AGENT_SKILLS_LOCK,
    archiveDir: process.env.AGENT_SKILLS_ARCHIVE_DIR ?? join(dirname(databasePath), "skills-archive"),
    push: process.env.AGENT_SKILLS_PUSH !== "false",
  };
}
