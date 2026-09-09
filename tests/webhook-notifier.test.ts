import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import test from "node:test";
import { WebhookNotifier } from "../apps/control-plane/src/webhook.js";

const SECRET = "r2h9lWr2uIx5MeWjTSs8fFsA-H70PGLZLdblRjCPeAY";

test("WebhookNotifier signs bridge events with the GitHub-style HMAC scheme", async () => {
  let resolveCaptured!: (value: { headers: IncomingMessage["headers"]; body: string }) => void;
  const captured = new Promise<{ headers: IncomingMessage["headers"]; body: string }>((resolve) => { resolveCaptured = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    response.writeHead(202).end('{"status":"accepted"}');
    resolveCaptured({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const notifier = new WebhookNotifier({ url: `http://127.0.0.1:${port}/webhooks/bridge-events`, secret: SECRET });
    assert.equal(notifier.enabled, true);
    notifier.notify({ type: "bridge_update.status", machine_id: "dev-wsl", phase: "completed",
      current_version: "0.6.20", latest_version: "0.6.21", updatable: true });
    const { headers, body } = await captured;

    const signature = headers["x-hub-signature-256"];
    const expected = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    assert.equal(signature, expected, "signature must be sha256=HMAC over the raw body");

    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(parsed.type, "bridge_update.status");
    assert.equal(parsed.machine_id, "dev-wsl");
    assert.equal(parsed.phase, "completed");
  } finally {
    server.close();
  }
});

test("WebhookNotifier is a no-op when unconfigured", async () => {
  const notifier = new WebhookNotifier(undefined);
  assert.equal(notifier.enabled, false);
  // Must not throw even though no url/secret is set.
  notifier.notify({ type: "bridge.offline", machine_id: "dev-wsl" });
});
