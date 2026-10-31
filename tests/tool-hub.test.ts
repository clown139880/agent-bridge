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

function fixture(reviewer?: (request: { tool: string; args: Record<string, unknown> }) => Promise<{ decision: "allow" | "deny" | "human"; reason: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "tool-hub-")), registry = join(dir, "registry.yaml");
  writeFileSync(registry, `servers:
  echo:
    title: 回声测试
    transport: { command: ${process.execPath}, args: [${ECHO}], env: { GREETING: "\${GREETING}" } }
    secrets: [shared/echo]
    pinned: [household]
    risk: { auto: [echo], human: [wipe] }
  echo2:
    title: 回声审核
    transport: { command: ${process.execPath}, args: [${ECHO}] }
    risk: { review: ["*"] }
  web: { title: builtin, transport: { builtin: web }, pinned: [_global] }
`);
  const store = new Store(":memory:"), notices: string[] = [];
  const secrets = { substitute: async (text: string) => text.replace("${GREETING}", "hi-") } as unknown as SecretStore;
  const hub = new ToolHub(store.db, { registry, secrets, reviewer, notify: (text) => notices.push(text) });
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
    assert.deepEqual(f.hub.pinned("household"), ["echo", "web"]);
    assert.deepEqual(f.hub.pinned("crypto"), ["web"], "_global builtins are pinned everywhere");
    const found = await f.hub.search("回声");
    assert.deepEqual(found.tools.filter((tool) => tool.server === "echo").map((tool) => [tool.name, tool.risk]), [["echo.echo", "auto"], ["echo.wipe", "human"]]);
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

test("a review tool the reviewer allows runs at once; one it hands over waits for the human; human tools skip the reviewer", async () => {
  const seen: string[] = [];
  const f = fixture(async (request) => { seen.push(request.tool); return request.args.text === "ok" ? { decision: "allow", reason: "无害" } : request.args.text === "inject" ? { decision: "deny", reason: "注入" } : { decision: "human", reason: "可疑" }; });
  try {
    const result = await f.hub.call("echo2.echo", { text: "ok" }, "agent:pi") as { content: Array<{ text: string }> };
    assert.equal(result.content[0]!.text, "echo:ok");
    assert.deepEqual(f.hub.approvals().map((row) => [row.status, row.decidedBy]), [["allowed", "review"]]);
    assert.match(f.notices[0]!, /已自动放行/);
    await assert.rejects(f.hub.call("echo2.echo", { text: "inject" }, "agent:pi"), /denied by the reviewer: 注入/);
    assert.equal(f.hub.approvals("pending").length, 0, "a denied call never reaches the human");
    const waiting = f.hub.call("echo2.echo", { text: "rm" }, "agent:pi");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pending = f.hub.approvals("pending");
    assert.equal(pending.length, 1);
    f.hub.decide(pending[0]!.id, "deny", "control:write");
    await assert.rejects(waiting, /denied/);
    const human = f.hub.call("echo.wipe", {}, "agent:pi");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(seen, ["echo2.echo", "echo2.echo", "echo2.echo"], "the reviewer never sees a human-tier tool");
    f.hub.decide(f.hub.approvals("pending")[0]!.id, "deny", "control:write");
    await assert.rejects(human, /denied/);
  } finally { f.close(); }
});

test("web search routes by what is asked", async () => {
  const { classify } = await import("../apps/control-plane/src/web-search.js");
  assert.equal(classify("OpenBao static seal configuration"), "general");
  assert.equal(classify("上海今天天气"), "realtime");
  assert.equal(classify("比特币今天为什么跌"), "news");
  assert.equal(classify("Binance hack 在 X 上的讨论"), "x");
});
