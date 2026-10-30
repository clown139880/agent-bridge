import assert from "node:assert/strict";
import test from "node:test";
import { MatrixConnector } from "../apps/matrix-connector/src/connector.js";
import { ControlError } from "../apps/matrix-connector/src/control.js";
import { command, withoutMention } from "../apps/matrix-connector/src/render.js";

const config = { homeserver: "https://m.example", userId: "@bot:example.org", allowedUsers: ["@me:example.org"],
  controlUrl: "http://cp", controlToken: "t", stateFile: "/dev/null" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function harness() {
  const sent: Array<{ roomId: string; type: string; content: any; eventId: string }> = [];
  const calls: Array<{ method: string; path: string; body?: any; key?: string }> = [];
  const sessions = new Map<string, { activeTurnId: string | null }>();
  const bindings = new Map<string, string | null>();
  let created = 0, eventIds = 0;
  const matrix = { async send(roomId: string, type: string, content: any) { const eventId = `$out${++eventIds}`; sent.push({ roomId, type, content, eventId }); return eventId; },
    async typing() {}, async download() { return Buffer.from("png"); } };
  const control = {
    async call(method: string, path: string, body?: any, key?: string) {
      calls.push({ method, path, body, key });
      const conversation = /^\/conversations\/matrix\/([^/?]+)(?:\?threadId=(.*))?$/.exec(path);
      if (conversation && method === "GET") {
        const threadId = decodeURIComponent(conversation[2] ?? "");
        return { sessionId: bindings.get(threadId) ?? null, agent: "pi", scope: { id: "repo-app", title: "App" },
          target: { workerId: "pi@hal", workspace: "/root/app" } };
      }
      if (conversation && method === "PUT") { bindings.set(body.threadId, body.sessionId); return { agent: body.agent ?? "pi" }; }
      if (path === "/sessions") { const id = `s${++created}`; sessions.set(id, { activeTurnId: "t1" }); return { status: "succeeded", sessionId: id }; }
      const session = /^\/sessions\/([^/]+)(?:\/(turns|interrupt))?$/.exec(path);
      if (session && !session[2]) return { ...sessions.get(session[1]!) };
      if (session?.[2] === "interrupt") { sessions.get(session[1]!)!.activeTurnId = null; return { status: "succeeded" }; }
      if (session?.[2] === "turns") {
        if (sessions.get(session[1]!)!.activeTurnId) throw new ControlError(409, "turn_already_active", "busy");
        sessions.get(session[1]!)!.activeTurnId = "t2"; return { status: "succeeded" };
      }
      if (path === "/attachments") return { id: "att1", size: 3 };
      return { status: "succeeded" };
    },
    async settle(action: any) { return action; },
  };
  const connector = new MatrixConnector(config, matrix as any, control as any) as any;
  const text = (body: string, extra: any = {}, sender = "@me:example.org") =>
    connector.receive("!room:example.org", { event_id: `$in${++eventIds}`, sender, type: "m.room.message", content: { msgtype: "m.text", body, ...extra } });
  return { connector, sent, calls, sessions, bindings, text };
}

test("commands and mention text parse like the client sends them", () => {
  assert.deepEqual(command("!new claude"), { name: "new", args: ["claude"] });
  assert.deepEqual(command("/bind repo-app hal:/root/app"), { name: "bind", args: ["repo-app", "hal:/root/app"] });
  assert.equal(command("new idea"), undefined);
  assert.equal(withoutMention("Megumi: 看一下", "@bot:example.org", "Megumi"), "看一下");
});

test("a room keeps one session; a new message stops its running turn first; others are ignored", async () => {
  const h = harness();
  h.text("第一条"); await tick();
  const create = h.calls.find((call) => call.path === "/sessions")!;
  assert.deepEqual(create.body, { workerId: "pi@hal", workspace: "/root/app", input: "第一条", memoryScope: "repo-app" });
  assert.equal(h.bindings.get(""), "s1");

  h.text("写错了，改成这个"); await tick();
  const order = h.calls.filter((call) => call.method === "POST").map((call) => call.path);
  assert.deepEqual(order, ["/sessions", "/sessions/s1/interrupt", "/sessions/s1/turns"]);
  assert.equal(h.calls.find((call) => call.path === "/sessions/s1/turns")!.body.input, "写错了，改成这个");

  h.text("别人的消息", {}, "@stranger:example.org"); await tick();
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 3);
});

test("@ in the main timeline opens a parallel session answered in a thread; output goes only to the bound place", async () => {
  const h = harness();
  h.text("主线"); await tick();
  h.text("@bot:example.org 另起一个", { "m.mentions": { user_ids: ["@bot:example.org"] } }); await tick();
  const threadId = [...h.bindings.keys()].find((id) => id !== "")!;
  assert.equal(h.bindings.get(threadId), "s2"); assert.equal(h.bindings.get(""), "s1");
  assert.equal(h.calls.filter((call) => call.path === "/sessions")[1]!.body.input, "另起一个");

  const event = (sessionId: string, type: string, payload: any) => h.connector.project({ cursor: "c", type: "session.event.appended", sessionId,
    data: { type, turnId: "t", payload } });
  event("s2", "message.completed", { role: "assistant", text: "线程里的答复" });
  event("s2", "turn.completed", {});
  event("unbound", "turn.completed", { summary: "不该出现" });
  await tick();
  const replies = h.sent.filter((item) => item.type === "m.room.message");
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.content.body, "线程里的答复");
  assert.equal(replies[0]!.content["m.relates_to"].event_id, threadId);
});

test("an approval is asked in its conversation and answered with the offered option by reaction", async () => {
  const h = harness();
  h.text("开始"); await tick();
  h.connector.project({ cursor: "c", type: "approval.upserted", sessionId: "s1",
    data: { id: "ap1", status: "pending", summary: "Run ls", choices: ["allow", "deny"] } });
  await tick();
  const prompt = h.sent.find((item) => item.content.body?.includes("Run ls"))!;
  assert.match(prompt.content.body, /1️⃣ 允许/);
  const promptId = prompt.eventId;
  h.connector.receive("!room:example.org", { event_id: "$r1", sender: "@me:example.org", type: "m.reaction",
    content: { "m.relates_to": { rel_type: "m.annotation", event_id: promptId, key: "2️⃣" } } });
  await tick();
  const decision = h.calls.find((call) => call.path === "/approvals/ap1/decision")!;
  assert.deepEqual(decision.body, { choice: "deny" });
  assert.equal(h.calls.filter((call) => call.path.endsWith("/turns")).length, 0, "an answer is not a new task");
});

test("attachments wait for the next text and go with it", async () => {
  const h = harness();
  h.connector.receive("!room:example.org", { event_id: "$img", sender: "@me:example.org", type: "m.room.message",
    content: { msgtype: "m.image", body: "a.png", url: "mxc://example.org/a", info: { mimetype: "image/png" } } });
  await tick();
  assert.equal(h.calls.filter((call) => call.path === "/sessions").length, 0);
  h.text("看看这张图"); await tick();
  assert.deepEqual(h.calls.find((call) => call.path === "/sessions")!.body.attachments, [{ id: "att1", filename: "a.png", mimeType: "image/png", size: 3 }]);
});
