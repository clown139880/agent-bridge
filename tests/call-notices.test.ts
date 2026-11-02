import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import test from "node:test";
import { AgentControlStore, Store } from "../packages/database/src/index.js";
import { CallNotices, spoken } from "../apps/control-plane/src/call-notices.js";

test("a notice to call:<who> rings that person once; failures retry, then tell the operator; stale ones are skipped", async () => {
  const path = join(tmpdir(), `calls-${randomUUID()}.sqlite`), store = new Store(path), control = new AgentControlStore(store.db);
  const placed: any[] = [], told: string[] = [];
  let fail = false, now = Date.now();
  const calls = new CallNotices(control, async (args) => { if (fail) throw new Error("call-bridge down"); placed.push(args); return {}; }, (text) => told.push(text), () => now);
  try {
    const ok = control.createNotice({ connector: "call", roomId: "simon", threadId: "", text: "**Crypto 周报**\n详见 https://x.example/a", level: "notice", source: "automation" });
    await calls.tick(); await calls.tick();
    assert.deepEqual(placed.map((a) => [a.to, a.mode, a.message, a.idempotency_key]), [["simon", "notify", "Crypto 周报 详见", `notice:${ok.id}`]], "placed once, read without markup or links");
    assert.ok(control.notices({ connector: "call", limit: 5 })[0]!.deliveredAt);

    fail = true;
    control.createNotice({ connector: "call", roomId: "simon", threadId: "", text: "第二条", level: "notice", source: "automation" });
    for (let i = 0; i < 3; i++) await calls.tick();
    assert.equal(told.length, 1); assert.match(told[0]!, /没打通给 simon/);
    assert.equal(control.notices({ connector: "call", undelivered: true, limit: 5 }).length, 0);

    control.createNotice({ connector: "call", roomId: "simon", threadId: "", text: "旧的", level: "notice", source: "automation" });
    now += 60 * 60_000; fail = false; await calls.tick();
    assert.equal(placed.length, 1, "half an hour late is not worth a call");
  } finally { store.db.close(); rmSync(path, { force: true }); }
  assert.equal(spoken("a".repeat(400)).length, 302);
});
