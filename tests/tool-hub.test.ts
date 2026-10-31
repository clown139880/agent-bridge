import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../packages/database/src/index.js";
import { ToolHub, riskOf } from "../apps/control-plane/src/tools.js";
import type { SecretStore } from "../apps/control-plane/src/secrets.js";

const ECHO = fileURLToPath(new URL("./fixtures/echo-mcp.mjs", import.meta.url));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tool-hub-")), registry = join(dir, "registry.yaml");
  writeFileSync(registry, `servers:
  echo:
    title: 回声测试
    transport: { command: ${process.execPath}, args: [${ECHO}], env: { GREETING: "\${GREETING}" } }
    secrets: [shared/echo]
    pinned: [household]
    risk: { auto: [echo], human: [wipe] }
  web: { title: builtin, transport: { builtin: web }, pinned: [_global] }
`);
  const store = new Store(":memory:"), notices: string[] = [];
  const secrets = { substitute: async (text: string) => text.replace("${GREETING}", "hi-") } as unknown as SecretStore;
  const hub = new ToolHub(store.db, { registry, secrets, notify: (text) => notices.push(text) });
  return { hub, notices, close: () => { hub.stop(); store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("risk tiers: the strictest matching pattern wins; an unlisted tool needs review", () => {
  const server = { title: "x", transport: {}, risk: { auto: ["get_*", "*"], human: ["clear_vram"] } };
  assert.equal(riskOf(server, "get_image"), "auto");
  assert.equal(riskOf(server, "clear_vram"), "human");
  assert.equal(riskOf({ title: "x", transport: {} }, "anything"), "review");
});

test("the library searches every server, fills secrets into the launch, and runs an auto tool at once", async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.hub.pinned("household"), ["echo"]);
    assert.deepEqual(f.hub.pinned("crypto"), []);
    const found = await f.hub.search("回声");
    assert.deepEqual(found.tools.map((tool) => [tool.name, tool.risk]), [["echo.echo", "auto"], ["echo.wipe", "human"]]);
    const result = await f.hub.call("echo.echo", { text: "你好" }, "agent:pi") as { content: Array<{ text: string }> };
    assert.equal(result.content[0]!.text, "hi-echo:你好");
    await assert.rejects(f.hub.call("nope.x", {}, "agent:pi"), /unknown tool/);
  } finally { f.close(); }
});

test("a tool that needs approval waits for the human, then runs or fails with the decision", async () => {
  const f = fixture();
  try {
    const waiting = f.hub.call("echo.wipe", {}, "agent:pi");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [pending] = f.hub.approvals("pending");
    assert.equal(pending?.tool, "echo.wipe"); assert.equal(pending?.caller, "agent:pi");
    assert.match(f.notices[0]!, /工具调用待你确认：echo.wipe/);
    f.hub.decide(pending!.id, "allow", "control:write");
    const result = await waiting as { content: Array<{ text: string }> };
    assert.equal(result.content[0]!.text, "hi-wipe:");
    const denied = f.hub.call("echo.wipe", {}, "agent:pi");
    await new Promise((resolve) => setTimeout(resolve, 50));
    f.hub.decide(f.hub.approvals("pending")[0]!.id, "deny", "control:write", "不要");
    await assert.rejects(denied, /denied: 不要/);
    assert.throws(() => f.hub.decide(pending!.id, "allow", "control:write"), /allowed/);
  } finally { f.close(); }
});
