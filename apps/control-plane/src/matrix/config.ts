import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MatrixTarget { workerId: string; workspace: string; model?: string }
export interface MatrixRoomConfig {
  roomId: string;
  scopeId: string;
  users: string[];
  requireMention?: boolean;
  defaultTarget: string;
  targets: Record<string, MatrixTarget>;
}
export interface MatrixConfig {
  homeserver: string;
  userId: string;
  accessToken?: string;
  password?: string;
  deviceId?: string;
  stateFile: string;
  controlCenterUrl?: string;
  rooms: MatrixRoomConfig[];
}

export function matrixConfig(env: NodeJS.ProcessEnv, databasePath: string): MatrixConfig | undefined {
  if (env.MATRIX_ENABLED !== "true") return undefined;
  if (!env.MATRIX_CONFIG_FILE) throw new Error("MATRIX_ENABLED requires MATRIX_CONFIG_FILE (explicit room/project/worker bindings)");
  const document = JSON.parse(readFileSync(env.MATRIX_CONFIG_FILE, "utf8")) as { rooms?: MatrixRoomConfig[]; controlCenterUrl?: string };
  const homeserver = env.MATRIX_HOMESERVER, userId = env.MATRIX_USER_ID;
  if (!homeserver || !/^https?:\/\//.test(homeserver) || !userId?.startsWith("@")) throw new Error("Invalid Matrix homeserver or user ID");
  const rooms = document.rooms;
  if (!Array.isArray(rooms) || !rooms.length) throw new Error("Matrix requires at least one configured room");
  const ids = new Set<string>();
  for (const room of rooms) {
    if (!room.roomId?.startsWith("!") || ids.has(room.roomId) || !/^[a-z0-9_-]+$/.test(room.scopeId)
      || !Array.isArray(room.users) || !room.users.length || room.users.some(user => !/^@[^:]+:.+/.test(user))
      || !room.targets?.[room.defaultTarget]) throw new Error("Invalid or duplicate Matrix room configuration");
    ids.add(room.roomId);
    for (const [name, target] of Object.entries(room.targets)) {
      if (!/^[a-z][a-z0-9_-]*$/.test(name) || !/^(codex|claude|pi|grok)@.+/.test(target.workerId) || !target.workspace?.trim())
        throw new Error("Invalid Matrix worker target");
    }
  }
  return { homeserver: homeserver.replace(/\/$/, ""), userId, accessToken: env.MATRIX_ACCESS_TOKEN,
    password: env.MATRIX_PASSWORD, deviceId: env.MATRIX_DEVICE_ID,
    stateFile: env.MATRIX_STATE_FILE ?? join(dirname(databasePath), "matrix-device.json"),
    controlCenterUrl: document.controlCenterUrl, rooms };
}
