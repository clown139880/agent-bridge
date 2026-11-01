import assert from "node:assert/strict";
import test from "node:test";
import { reviewModel } from "../apps/control-plane/src/review-model.js";
import type { SecretStore } from "../apps/control-plane/src/secrets.js";

const secrets = { value: async (key: string) => `${key}-value` } as unknown as SecretStore;
const reply = (content: string) => Response.json({ choices: [{ message: { content } }] });

test("the reviewer asks its TokensAPI model, then the fallback when it fails or gives no verdict", async () => {
  const original = globalThis.fetch, asked: string[] = [];
  let main: () => Response = () => new Response("busy", { status: 503 });
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url), "https://tokensapi.ai/v1/chat/completions");
    assert.equal((init!.headers as Record<string, string>).authorization, "Bearer TOKENSAPI_API_KEY-value");
    const model = JSON.parse(String(init!.body)).model as string;
    asked.push(model);
    return model === "deepseek-v4-flash" ? main() : reply('\n\n{"decision":"allow","reason":"兜底"}');
  }) as typeof fetch;
  try {
    const model = reviewModel({ secrets, model: "deepseek-v4-flash", fallback: "qwen3.8-flash-next", timeoutMs: 1_000 });
    assert.deepEqual(await model("system", "user"), { decision: "allow", reason: "兜底" });
    main = () => reply("我觉得可以");
    assert.deepEqual(await model("system", "user"), { decision: "allow", reason: "兜底" }, "a reply with no verdict counts as a failure");
    main = () => reply('{"decision":"human","reason":"拿不准"}');
    asked.length = 0;
    assert.deepEqual(await model("system", "user"), { decision: "human", reason: "拿不准" });
    assert.deepEqual(asked, ["deepseek-v4-flash"], "a working main model is the only call");
    main = () => reply("我觉得可以");
    await assert.rejects(reviewModel({ secrets, model: "deepseek-v4-flash", timeoutMs: 1_000 })("s", "u"), /no verdict/, "without a fallback the failure reaches the caller");
  } finally { globalThis.fetch = original; }
});
