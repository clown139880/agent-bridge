import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  matrixHomeserver: required("MATRIX_HOMESERVER"),
  matrixUserId: required("MATRIX_USER_ID"),
  matrixPassword: required("MATRIX_PASSWORD"),
  matrixRoomId: process.env.MATRIX_ROOM_ID,
  matrixRoomName: process.env.MATRIX_ROOM_NAME ?? "Agent Control",
  matrixAllowedUserId: process.env.MATRIX_ALLOWED_USER_ID,
  databasePath: process.env.DATABASE_PATH ?? "./data/control-plane.sqlite",
  host: process.env.CONTROL_HOST ?? "0.0.0.0",
  port: Number(process.env.CONTROL_PORT ?? "8787"),
  publicWsUrl: process.env.CONTROL_PUBLIC_WS_URL,
  bridgeToken: process.env.BRIDGE_TOKEN,
};
