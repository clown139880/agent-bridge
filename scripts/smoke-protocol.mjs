import WebSocket from "ws";

const url = process.env.CONTROL_WS_URL ?? "ws://127.0.0.1:8787/bridge";
const socket = new WebSocket(url);
const timeout = setTimeout(() => {
  console.error("Timed out waiting for registration");
  process.exit(1);
}, 5000);
socket.on("open", () => socket.send(JSON.stringify({
  type: "register",
  machineId: "smoke-test",
  name: "smoke-test",
  hostname: "localhost",
  platform: process.platform,
  capabilities: ["smoke"],
  token: process.env.BRIDGE_TOKEN,
})));
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === "registered") {
    clearTimeout(timeout);
    console.log("Bridge protocol smoke test passed");
    socket.close();
  }
});
socket.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error.message);
  process.exit(1);
});
