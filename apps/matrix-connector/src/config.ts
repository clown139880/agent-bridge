export interface ConnectorConfig {
  homeserver: string;
  userId: string;
  accessToken?: string;
  password?: string;
  /** Only these people's messages are acted on; everyone else in a room is ignored. */
  allowedUsers: string[];
  controlUrl: string;
  controlToken: string;
  stateFile: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const homeserver = need("MATRIX_HOMESERVER").replace(/\/$/, ""), userId = need("MATRIX_USER_ID");
  if (!/^https?:\/\//.test(homeserver) || !/^@[^:]+:.+/.test(userId)) throw new Error("invalid MATRIX_HOMESERVER or MATRIX_USER_ID");
  const allowedUsers = (env.MATRIX_ALLOWED_USERS ?? env.MATRIX_ALLOWED_USER_ID ?? "").split(",").map((user) => user.trim()).filter(Boolean);
  if (!allowedUsers.length || allowedUsers.some((user) => !/^@[^:]+:.+/.test(user))) throw new Error("MATRIX_ALLOWED_USERS must list Matrix user ids");
  if (!env.MATRIX_ACCESS_TOKEN && !env.MATRIX_PASSWORD) throw new Error("MATRIX_ACCESS_TOKEN or MATRIX_PASSWORD is required");
  return {
    homeserver, userId, allowedUsers,
    accessToken: env.MATRIX_ACCESS_TOKEN || undefined, password: env.MATRIX_PASSWORD || undefined,
    controlUrl: (env.AGENT_BRIDGE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, ""),
    controlToken: need("AGENT_BRIDGE_TOKEN"),
    stateFile: env.MATRIX_CONNECTOR_STATE ?? "/var/lib/agent-bridge/matrix-connector.json",
  };
}
