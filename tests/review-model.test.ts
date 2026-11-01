import assert from "node:assert/strict";
import test from "node:test";
import { reviewModel } from "../apps/control-plane/src/review-model.js";
import type { SecretStore } from "../apps/control-plane/src/secrets.js";

const secrets = { value: async (key: string) => `${key}-value` } as unknown as SecretStore;

test("the reviewer falls back to TokensAPI when DeepSeek fails or gives no verdict", async () => {
  const original = globalThis.fetch, seen: string[] = [];
  let deepseek: () => Response = () => new Response("busy", { status: 503 });
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push(String(url));
    if (String(url).includes("deepseek")) return deepseek();
    assert.equal(JSON.parse(String(init!.body)).model, "qwen3.8-flash-next");
    return Response.json({ choices: [{ message: { content: '{"decision":"allow","reason":"兜底"}' } }] });
  }) as typeof fetch;
  try {
    const model = reviewModel({ secrets, model: "deepseek-flash", fallback: "qwen3.8-flash-next", timeoutMs: 1_000 });
    assert.deepEqual(await model("system", "user"), { decision: "allow", reason: "兜底" });
    deepseek = () => Response.json({ content: [{ type: "text", text: "我觉得可以" }] });
    assert.deepEqual(await model("system", "user"), { decision: "allow", reason: "兜底" }, "a reply with no verdict counts as a failure");
    deepseek = () => Response.json({ content: [{ type: "text", text: '{"decision":"human","reason":"拿不准"}' }] });
    seen.length = 0;
    assert.deepEqual(await model("system", "user"), { decision: "human", reason: "拿不准" });
    assert.equal(seen.length, 1, "a working DeepSeek is the only call");
    deepseek = () => Response.json({ content: [{ type: "text", text: "我觉得可以" }] });
    await assert.rejects(reviewModel({ secrets, model: "deepseek-flash", timeoutMs: 1_000 })("s", "u"), /no verdict/, "without a fallback the failure reaches the caller");
  } finally { globalThis.fetch = original; }
});
